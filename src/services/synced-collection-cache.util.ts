import {
  CollectionReference,
  QueryConstraint,
  QueryDocumentSnapshot,
  Timestamp,
  getCountFromServer,
  orderBy,
  query,
  where,
} from '@angular/fire/firestore';
import { Observable, ReplaySubject } from 'rxjs';
import { fetchAllDocs } from './firestore-pagination.util';

/**
 * Full-collection cache that downloads a collection ONCE per device and from
 * then on only fetches documents changed since the last sync — the fix for
 * the 1.7M reads/day Firestore bill.
 *
 * Why the previous PatchableCollectionCache/PersistentCollectionCache pair
 * still burned so many reads:
 *  - Every invalidate() (called after almost every write in the app — DC,
 *    invoice, dispatch info, QC, carton seal, SO status sync, GRN approval…)
 *    dropped the whole list, so the next screen visit re-downloaded the ENTIRE
 *    collection (inventory alone is ~11k docs = ~11k billed reads).
 *  - The 3–5 min TTLs expired constantly on screens left open all day.
 *  - The "persisted" snapshot lived in localStorage, which browsers cap at
 *    ~5 MB per origin for ALL keys combined. Inventory + designs + sales
 *    orders + pick/packing lists + DCs + invoices are far beyond that, and
 *    setItem()'s QuotaExceededError was swallowed — so on real data the
 *    cold-start cache silently never stored and every reload/new tab paid a
 *    full re-download of every collection it touched.
 *
 * This cache instead:
 *  - Stores the snapshot in IndexedDB (hundreds of MB available).
 *  - Resolves a stale/cold cache with a DELTA query —
 *    where('updatedAt', '>=', lastSeenUpdatedAt) — so a sync costs one read
 *    per changed document, not one per document in the collection. Every
 *    app write path stamps updatedAt: serverTimestamp(), which is what makes
 *    this safe; `>=` (not `>`) plus id-dedupe covers writes that share the
 *    exact cursor timestamp.
 *  - Detects deletions made elsewhere with a count() aggregation (billed at
 *    1 read per 1000 docs, i.e. ~12 reads for inventory) and only falls back
 *    to a full reload when the local and server counts disagree.
 *  - Keeps the old contract callers rely on: get$() emits once per load
 *    cycle (LoadingService counters in the screens count emissions),
 *    invalidate() makes the NEXT get$() fetch fresh data, patchOne() updates
 *    the live list in place after a known write.
 *
 * Writes made outside the app (the admin scripts in /scripts, console edits)
 * that don't stamp updatedAt are invisible to the delta query — bump
 * SYNC_CACHE_VERSION after running one to force a single full resync.
 */

const SYNC_CACHE_VERSION = 1;
const DB_NAME = 'tmg-sync-cache';
const STORE_NAME = 'snapshots';
const TIMESTAMP_JSON_TYPE = 'firestore/timestamp/1.0';

export interface SyncedCollectionOptions<T> {
  /** IndexedDB key — unique per collection. */
  storageKey: string;
  collectionRef: CollectionReference;
  /** Constraints of the full load. Also used for the count() check, so they must describe exactly what the cached list contains. */
  constraints: QueryConstraint[];
  mapDoc: (doc: QueryDocumentSnapshot) => T;
  /** Client-side order restored after merging delta docs — should mirror the orderBy in `constraints`. */
  compare?: (a: T, b: T) => number;
  /** Set to the orderBy field of `constraints`: Firestore omits docs missing it from the full query, so delta docs missing it are dropped too, keeping local and server counts comparable. */
  requiredField?: string;
  /** Runs on docs fresh from Firestore (full load or delta) — e.g. self-heal writes. */
  afterFetch?: (items: T[]) => Promise<void>;
  /** A persisted snapshot older than this is discarded and fully reloaded — a safety net for writes that bypassed updatedAt. */
  maxSnapshotAgeMs?: number;
}

interface StoredSnapshot {
  version: number;
  fullLoadedAt: number;
  cursor: { seconds: number; nanoseconds: number } | null;
  itemsJson: string;
}

export class SyncedCollectionCache<T extends { id?: string }> {
  private subject: ReplaySubject<T[]> | null = null;
  private current: T[] | null = null;
  private cursor: Timestamp | null = null;
  private fullLoadedAt = 0;
  private resolved = false;
  private triedStorage = false;
  private pendingPatches = new Map<string, T>();
  private storageWriteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SyncedCollectionOptions<T>) {}

  get$(): Observable<T[]> {
    if (!this.subject) {
      const subject = new ReplaySubject<T[]>(1);
      this.subject = subject;
      this.resolved = false;

      this.resolve()
        .then((items) => {
          if (this.subject !== subject) return;
          this.resolved = true;
          subject.next(items);
        })
        .catch((err) => {
          // Degrade to last-known data rather than subject.error() — see the
          // toSignal() note in the old PatchableCollectionCache — and null the
          // subject so the next get$() retries.
          console.error(`SyncedCollectionCache(${this.opts.storageKey}) load failed, serving fallback`, err);
          if (this.subject !== subject) return;
          subject.next(this.current ?? []);
          this.subject = null;
        });
    }
    return this.subject.asObservable();
  }

  /**
   * Marks the cache stale after a write: the next get$() fetches only the
   * docs changed since the last sync (plus a count() check), instead of the
   * old behaviour of re-downloading the whole collection.
   */
  invalidate(): void {
    this.subject = null;
    this.resolved = false;
  }

  /** Replaces (or appends) one item already known from a just-committed write, without a Firestore round-trip. */
  patchOne(item: T): void {
    if (!item.id) return;
    if (!this.resolved || !this.current || !this.subject) {
      // A load is in flight (or none has happened) — re-applied after it
      // resolves if the fetch didn't already return this doc.
      this.pendingPatches.set(item.id, item);
      return;
    }
    const idx = this.current.findIndex((x) => x.id === item.id);
    this.current = idx === -1
      ? this.sorted([...this.current, item])
      : this.current.map((x, i) => (i === idx ? item : x));
    this.subject.next(this.current);
    this.scheduleStorageWrite();
  }

  /** Drops one item after this app deleted it — a delta query can't see deletions, and without this the count() check would force a full reload. */
  removeOne(id: string): void {
    this.pendingPatches.delete(id);
    if (!this.current) return;
    const next = this.current.filter((x) => x.id !== id);
    if (next.length === this.current.length) return;
    this.current = next;
    if (this.resolved && this.subject) this.subject.next(this.current);
    this.scheduleStorageWrite();
  }

  private async resolve(): Promise<T[]> {
    if (this.current === null && !this.triedStorage) {
      this.triedStorage = true;
      const snapshot = await readSnapshot<T>(this.opts.storageKey);
      if (snapshot) {
        this.current = snapshot.items;
        this.cursor = snapshot.cursor;
        this.fullLoadedAt = snapshot.fullLoadedAt;
      }
    }

    const maxAge = this.opts.maxSnapshotAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    const canDelta = this.current !== null && this.current.length > 0 && this.cursor !== null
      && Date.now() - this.fullLoadedAt < maxAge;

    const items = canDelta ? await this.deltaSync() : await this.fullLoad();
    this.current = items;
    this.scheduleStorageWrite(0);
    return items;
  }

  private async fullLoad(): Promise<T[]> {
    let maxUpdatedAt: Timestamp | null = null;
    const items = await fetchAllDocs(this.opts.collectionRef, this.opts.constraints, (d) => {
      maxUpdatedAt = maxTimestamp(maxUpdatedAt, d.get('updatedAt'));
      return this.opts.mapDoc(d);
    });
    await this.opts.afterFetch?.(items);

    this.cursor = maxUpdatedAt;
    this.fullLoadedAt = Date.now();
    return this.sorted(this.applyPendingPatches(items, new Set(items.map((x) => x.id!))));
  }

  private async deltaSync(): Promise<T[]> {
    let maxUpdatedAt: Timestamp | null = this.cursor;
    const required = this.opts.requiredField;
    const [changed, serverCount] = await Promise.all([
      fetchAllDocs(
        this.opts.collectionRef,
        [where('updatedAt', '>=', this.cursor), orderBy('updatedAt', 'asc')],
        (d) => {
          maxUpdatedAt = maxTimestamp(maxUpdatedAt, d.get('updatedAt'));
          return { item: this.opts.mapDoc(d), included: !required || d.get(required) !== undefined };
        }
      ),
      getCountFromServer(query(this.opts.collectionRef, ...this.opts.constraints)).then((s) => s.data().count),
    ]);

    const freshItems = changed.filter((c) => c.included).map((c) => c.item);
    await this.opts.afterFetch?.(freshItems);

    const byId = new Map(this.current!.map((x) => [x.id!, x] as const));
    for (const { item, included } of changed) {
      if (included) byId.set(item.id!, item);
      else byId.delete(item.id!);
    }

    if (byId.size !== serverCount) {
      // Something was deleted (or created without updatedAt) outside this
      // tab — the only case that still needs the whole collection.
      return this.fullLoad();
    }

    this.cursor = maxUpdatedAt;
    const fetchedIds = new Set(changed.map((c) => c.item.id!));
    return this.sorted(this.applyPendingPatches([...byId.values()], fetchedIds));
  }

  private applyPendingPatches(items: T[], fetchedIds: Set<string>): T[] {
    if (!this.pendingPatches.size) return items;
    const byId = new Map(items.map((x) => [x.id!, x] as const));
    for (const [id, patch] of this.pendingPatches) {
      if (!fetchedIds.has(id)) byId.set(id, patch);
    }
    this.pendingPatches.clear();
    return [...byId.values()];
  }

  private sorted(items: T[]): T[] {
    return this.opts.compare ? [...items].sort(this.opts.compare) : items;
  }

  /**
   * Debounced so a scanning burst (one patchOne() per unit on an ~11k-doc
   * list) doesn't re-serialize the whole collection on every scan.
   */
  private scheduleStorageWrite(delayMs = 2000): void {
    if (this.storageWriteTimer !== null) {
      if (delayMs > 0) return;
      clearTimeout(this.storageWriteTimer);
    }
    this.storageWriteTimer = setTimeout(() => {
      this.storageWriteTimer = null;
      // Never persist an empty list — far more likely a transient bad read
      // than truth (same rule as the old caches).
      if (!this.current?.length) return;
      void writeSnapshot(this.opts.storageKey, {
        version: SYNC_CACHE_VERSION,
        fullLoadedAt: this.fullLoadedAt,
        cursor: this.cursor ? { seconds: this.cursor.seconds, nanoseconds: this.cursor.nanoseconds } : null,
        itemsJson: JSON.stringify(this.current),
      });
    }, delayMs);
  }
}

/** Newest-first by createdAt — the client-side twin of orderBy('createdAt', 'desc'); a missing/unparseable value sorts as oldest. */
export function byCreatedAtDesc(a: { createdAt?: unknown }, b: { createdAt?: unknown }): number {
  return toMillis(b.createdAt) - toMillis(a.createdAt);
}

function toMillis(value: any): number {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.seconds === 'number') return value.seconds * 1000 + Math.round((value.nanoseconds ?? 0) / 1e6);
  if (value) {
    const parsed = new Date(value).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

// Server timestamps are compared exactly (seconds, then nanoseconds) — the
// delta cursor must never skip a doc because of millisecond rounding.
function maxTimestamp(current: Timestamp | null, value: unknown): Timestamp | null {
  if (!(value instanceof Timestamp)) return current;
  if (!current) return value;
  if (value.seconds !== current.seconds) return value.seconds > current.seconds ? value : current;
  return value.nanoseconds > current.nanoseconds ? value : current;
}

// Timestamp.toJSON() writes {seconds, nanoseconds, type: 'firestore/timestamp/1.0'}
// — revived back into real Timestamps so cached items behave exactly like
// freshly-fetched ones (.toDate()/.toMillis() keep working everywhere).
function reviveTimestamps(_key: string, value: any): any {
  if (value && typeof value === 'object' && value.type === TIMESTAMP_JSON_TYPE
    && typeof value.seconds === 'number' && typeof value.nanoseconds === 'number') {
    return new Timestamp(value.seconds, value.nanoseconds);
  }
  return value;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function readSnapshot<T>(key: string): Promise<{ items: T[]; cursor: Timestamp | null; fullLoadedAt: number } | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const stored = await new Promise<StoredSnapshot | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as StoredSnapshot | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!stored || stored.version !== SYNC_CACHE_VERSION || typeof stored.itemsJson !== 'string') return null;
    const items = JSON.parse(stored.itemsJson, reviveTimestamps) as T[];
    if (!Array.isArray(items)) return null;
    return {
      items,
      cursor: stored.cursor ? new Timestamp(stored.cursor.seconds, stored.cursor.nanoseconds) : null,
      fullLoadedAt: Number(stored.fullLoadedAt) || 0,
    };
  } catch {
    // Corrupt entry or storage unavailable — fall through to a Firestore load.
    return null;
  }
}

async function writeSnapshot(key: string, snapshot: StoredSnapshot): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(snapshot, key);
  } catch {
    // Storage full/unavailable — purely a cold-start optimization.
  }
}

// The old caches' large localStorage snapshots — mostly failed writes, but
// any that did land eat the ~5 MB quota the small master-data caches
// (clients/transports/userGroups) still use. Remove them once.
try {
  for (const name of ['inventory', 'designs', 'salesOrders', 'pickLists', 'packingLists', 'invoices', 'deliveryChallans', 'goodsInwards']) {
    localStorage.removeItem(`tmg:cache:${name}:v1`);
  }
} catch {
  // localStorage unavailable — nothing to clean up.
}
