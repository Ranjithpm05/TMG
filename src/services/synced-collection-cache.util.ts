import {
  CollectionReference,
  QueryConstraint,
  QueryDocumentSnapshot,
  Timestamp,
  orderBy,
  query,
  where,
} from '@angular/fire/firestore';
import { getCountFromServer } from './firestore-reads';
import { Observable, ReplaySubject } from 'rxjs';
import { fetchAllDocs } from './firestore-pagination.util';
import { recordCacheSync } from './firestore-read-meter';
import { backgroundRetryDelayMs, isTransientFirestoreError } from './firestore-health';

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

export const SYNC_CACHE_VERSION = 1;
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
  /**
   * For caches of a SUBSET of the collection (a date range, one client…):
   * the client-side twin of the `where` filters in `constraints`. The delta
   * query sees every changed doc in the collection, so this decides which of
   * them belong in (or must leave) the cached list — it must match exactly
   * what the server query returns, or the count() check forces full reloads.
   */
  matches?: (doc: QueryDocumentSnapshot) => boolean;
  /** Runs on docs fresh from Firestore (full load or delta) — e.g. self-heal writes. */
  afterFetch?: (items: T[]) => Promise<void>;
  /** A persisted snapshot older than this is discarded and fully reloaded — a safety net for writes that bypassed updatedAt. */
  maxSnapshotAgeMs?: number;
}

interface StoredSnapshot {
  version: number;
  /** When this entry was last written — lets pruneStoredEntries() drop entries nobody uses any more. */
  savedAt?: number;
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
  /** Subjects that have emitted a real (synced) list, as opposed to only a saved fallback copy. */
  private readonly freshSubjects = new WeakSet<ReplaySubject<T[]>>();
  private storageLoad: Promise<void> | null = null;
  private pendingPatches = new Map<string, T>();
  private storageWriteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SyncedCollectionOptions<T>) {}

  get$(): Observable<T[]> {
    if (!this.subject) {
      const subject = new ReplaySubject<T[]>(1);
      this.subject = subject;
      this.resolved = false;
      this.load(subject, 0, false);
    }
    return this.subject.asObservable();
  }

  /**
   * Loads into `subject`, never erroring it (toSignal() would re-throw on the
   * next read and break the screen). When Firestore refuses the request
   * (quota exceeded / unreachable) the subject gets the copy saved on this
   * device if there is one — never a made-up empty list, which screens would
   * show as "no data" and actions would treat as truth (₹0 MRPs, duplicate
   * inventory docs) — and the load is retried in the background until it
   * succeeds, at which point the same subject emits the fresh list. Screens
   * without a saved copy simply keep their loading state until then.
   */
  private load(subject: ReplaySubject<T[]>, attempt: number, servedFallback: boolean): void {
    this.resolve()
      .then((items) => {
        // Delivered even if invalidate() replaced this subject mid-load —
        // its subscribers are still waiting on it.
        if (this.subject === subject) this.resolved = true;
        this.freshSubjects.add(subject);
        subject.next(items);
      })
      .catch((err) => {
        const saved = this.current?.length ? this.current : null;
        if (saved && !servedFallback) {
          subject.next(saved);
          servedFallback = true;
        }

        if (!isTransientFirestoreError(err)) {
          // Not something waiting fixes (e.g. a missing index) — surface it,
          // settle subscribers, and let the next get$() try again.
          console.error(`SyncedCollectionCache(${this.opts.storageKey}) load failed`, err);
          this.freshSubjects.add(subject);
          subject.next(saved ?? []);
          if (this.subject === subject) this.subject = null;
          return;
        }

        const delayMs = backgroundRetryDelayMs(attempt);
        const code = (err as { code?: string })?.code ?? 'error';
        console.warn(`[sync] ${this.opts.storageKey}: Firestore ${code} — ${saved ? `showing the ${saved.length} records saved on this device` : 'nothing saved on this device yet, screen stays loading'}; retrying automatically in ${delayMs / 1000}s`);
        setTimeout(() => {
          if (this.subject === subject) {
            this.load(subject, attempt + 1, servedFallback);
          } else if (!servedFallback) {
            // Superseded by invalidate() while waiting — forward the newer
            // load's results to this subject's subscribers instead of leaving
            // them stuck.
            this.get$();
            const successor = this.subject!;
            successor.subscribe((items) => {
              if (this.freshSubjects.has(successor)) this.freshSubjects.add(subject);
              subject.next(items);
            });
          }
        }, delayMs);
      });
  }

  /** Emits what get$() emits (a saved copy while Firestore is refusing requests, then the fresh list) and completes once the list is fresh. */
  getUntilSynced$(): Observable<T[]> {
    return new Observable<T[]>((subscriber) => {
      this.get$();
      const subject = this.subject!;
      return subject.subscribe((items) => {
        subscriber.next(items);
        if (this.freshSubjects.has(subject)) subscriber.complete();
      });
    });
  }

  /**
   * For read-only displays (Dashboard): emits the last-known list from
   * IndexedDB straight away when this device has one, then the synced list
   * once the delta sync finishes, then completes. The page renders instantly
   * from the local copy instead of waiting on the network round trips — and
   * keeps showing it (while retrying) if Firestore is unreachable or over quota.
   */
  getCachedFirst$(): Observable<T[]> {
    return new Observable<T[]>((subscriber) => {
      let emitted = false;
      const sub = this.getUntilSynced$().subscribe({
        next: (items) => {
          emitted = true;
          subscriber.next(items);
        },
        complete: () => subscriber.complete(),
      });
      if (!emitted) {
        void this.loadFromStorageOnce().then(() => {
          if (!emitted && !subscriber.closed && this.current?.length) subscriber.next(this.current);
        });
      }
      return sub;
    });
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

  /** Shared by resolve() and getCachedFirst$() so the (large) IndexedDB snapshot is parsed at most once. */
  private loadFromStorageOnce(): Promise<void> {
    this.storageLoad ??= (async () => {
      if (this.current !== null) return;
      const snapshot = await readSnapshot<T>(this.opts.storageKey);
      if (snapshot && this.current === null) {
        this.current = snapshot.items;
        this.cursor = snapshot.cursor;
        this.fullLoadedAt = snapshot.fullLoadedAt;
      }
    })();
    return this.storageLoad;
  }

  private async resolve(): Promise<T[]> {
    await this.loadFromStorageOnce();

    const maxAge = this.opts.maxSnapshotAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    const fullReason = this.current === null ? 'no local copy on this device yet'
      : this.current.length === 0 ? 'local copy is empty'
      : this.cursor === null ? 'no cached doc has an updatedAt field, so delta sync is impossible — EVERY sync of this cache is a full reload'
      : Date.now() - this.fullLoadedAt >= maxAge ? 'local copy older than the weekly safety resync'
      : null;

    const items = fullReason === null ? await this.deltaSync() : await this.fullLoad(fullReason);
    this.current = items;
    this.scheduleStorageWrite(0);
    return items;
  }

  private async fullLoad(reason: string): Promise<T[]> {
    let maxUpdatedAt: Timestamp | null = null;
    const items = await fetchAllDocs(this.opts.collectionRef, this.opts.constraints, (d) => {
      maxUpdatedAt = maxTimestamp(maxUpdatedAt, d.get('updatedAt'));
      return this.opts.mapDoc(d);
    });
    recordCacheSync(this.opts.storageKey, 'full', `${items.length} docs (${reason})`);
    await this.opts.afterFetch?.(items);

    this.cursor = maxUpdatedAt;
    this.fullLoadedAt = Date.now();
    return this.sorted(this.applyPendingPatches(items, new Set(items.map((x) => x.id!))));
  }

  private async deltaSync(): Promise<T[]> {
    let maxUpdatedAt: Timestamp | null = this.cursor;
    const required = this.opts.requiredField;
    const matches = this.opts.matches;
    const [changed, serverCount] = await Promise.all([
      fetchAllDocs(
        this.opts.collectionRef,
        [where('updatedAt', '>=', this.cursor), orderBy('updatedAt', 'asc')],
        (d) => {
          maxUpdatedAt = maxTimestamp(maxUpdatedAt, d.get('updatedAt'));
          return {
            item: this.opts.mapDoc(d),
            included: (!required || d.get(required) !== undefined) && (!matches || matches(d)),
          };
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
      return this.fullLoad(`count check failed: ${byId.size} cached vs ${serverCount} on server — a doc was deleted elsewhere, or written without updatedAt`);
    }
    recordCacheSync(this.opts.storageKey, 'delta', `${changed.length} changed docs`);

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
        savedAt: Date.now(),
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

interface StoredEntry {
  version: number;
  savedAt: number;
  /** Caller-defined freshness tag (e.g. the parent doc's updatedAt) — a mismatch means "stale, refetch". */
  tag: string;
  itemsJson: string;
}

/** Keyed get for small per-device caches sharing this IndexedDB store (see VersionedLinesCache). Timestamps are revived. */
export async function readStoredEntry<T>(key: string): Promise<{ tag: string; items: T } | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const stored = await new Promise<StoredEntry | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as StoredEntry | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!stored || stored.version !== SYNC_CACHE_VERSION || typeof stored.itemsJson !== 'string') return null;
    return { tag: stored.tag, items: JSON.parse(stored.itemsJson, reviveTimestamps) as T };
  } catch {
    return null;
  }
}

export async function writeStoredEntry(key: string, tag: string, items: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const entry: StoredEntry = { version: SYNC_CACHE_VERSION, savedAt: Date.now(), tag, itemsJson: JSON.stringify(items) };
    db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(entry, key);
  } catch {
    // Storage full/unavailable — purely a read-saving optimization.
  }
}

/** Deletes entries under `prefix` not written for `maxAgeMs` (date-range and per-parent caches otherwise accumulate forever). */
export async function pruneStoredEntries(prefix: string, maxAgeMs: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const cutoff = Date.now() - maxAgeMs;
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const savedAt = Number((cursor.value as { savedAt?: number })?.savedAt) || 0;
      if (savedAt < cutoff) cursor.delete();
      cursor.continue();
    };
  } catch {
    // Best-effort housekeeping.
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
