import {
  CollectionReference,
  DocumentSnapshot,
  QueryConstraint,
  QueryDocumentSnapshot,
  Timestamp,
  doc,
  limit,
  orderBy,
  query,
  startAfter,
  where,
} from '@angular/fire/firestore';
import { getCountFromServer, getDoc, getDocs } from './firestore-reads';
import { Observable, ReplaySubject } from 'rxjs';
import { fetchAllDocs, syncPageSize } from './firestore-pagination.util';
import { recordCacheSync } from './firestore-read-meter';
import {
  Change,
  FullLoadLog,
  FullLoadProgress,
  FullLoadStore,
  SYNC_CURSOR_LOST,
  backoffDelayMs,
  classifyError,
  createLimiter,
  errorCode,
  mergeChanges,
  runResumableFullLoad,
  withTimeout,
} from './sync.engine';
import { registerRetry, reportSync } from './sync-status';

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
 *
 * Full downloads (a device's first visit, or a failed count check) go through
 * sync.engine.ts's runResumableFullLoad(): small pages, each persisted to
 * IndexedDB as it lands, resumed after the last good page on failure or app
 * restart, with an updatedAt anchor + catch-up delta so docs written during
 * the download aren't missed. At most two full downloads run at once per tab
 * (limiter), one per collection across tabs (Web Locks), and background retries are
 * bounded — after MAX_BACKGROUND_ATTEMPTS the sync is marked failed in
 * sync-status.ts and resumes on Retry / reconnect instead of looping.
 */

/** Background re-runs of a failed load before it is marked failed (each run already retries its pages — see PAGE_RETRY_POLICY). */
const MAX_BACKGROUND_ATTEMPTS = 3;
/** At most 2 full downloads at once: never the old everything-at-once burst, but a slow inventory download can't block a small date-range list either. */
const fullLoadLimiter = createLimiter(2);
/** A page (500 docs ≈ 0.5 MB) lands in 1–3 s, ~10 s on slow 3G; an offline SDK or a dead mobile connection can leave a request pending forever. */
const REQUEST_TIMEOUT_MS = 30_000;

type PlainTimestamp = { seconds: number; nanoseconds: number };

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
  /** The list last written to IndexedDB — skips re-serializing a list the full download already persisted. */
  private persistedItems: T[] | null = null;

  constructor(private readonly opts: SyncedCollectionOptions<T>) {}

  /** True when this device holds a saved copy — lets read-only displays avoid triggering a first full download. */
  async hasLocalCopy(): Promise<boolean> {
    await this.loadFromStorageOnce();
    return !!this.current?.length;
  }

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
   * inventory docs). The load is re-run in the background a bounded number of
   * times (pages already downloaded are kept, so a re-run resumes rather than
   * restarts); after that the sync is marked failed in the sync bar and
   * resumes on Retry / reconnect. Screens without a saved copy keep their
   * loading state, with the sync bar saying why.
   */
  private load(subject: ReplaySubject<T[]>, attempt: number, servedFallback: boolean): void {
    const key = this.opts.storageKey;
    this.resolve()
      .then((items) => {
        // Delivered even if invalidate() replaced this subject mid-load —
        // its subscribers are still waiting on it.
        if (this.subject === subject) this.resolved = true;
        this.freshSubjects.add(subject);
        subject.next(items);
        reportSync(key, { state: 'ok', synced: true });
      })
      .catch((err) => {
        const saved = this.current?.length ? this.current : null;
        if (saved && !servedFallback) {
          subject.next(saved);
          servedFallback = true;
        }
        const kind = classifyError(err);
        const code = errorCode(err);

        if (kind === 'permanent') {
          // Not something waiting fixes (permission denied, missing index) —
          // surface it, settle subscribers, and let the next get$() try again.
          console.error(`[sync] ${key}: load failed permanently (${code}) — not retrying`, err);
          reportSync(key, { state: 'failed', errorCode: code, servingSavedCopy: !!saved });
          registerRetry(key, () => this.get$());
          this.freshSubjects.add(subject);
          subject.next(saved ?? []);
          if (this.subject === subject) this.subject = null;
          return;
        }

        if (attempt + 1 >= MAX_BACKGROUND_ATTEMPTS) {
          console.warn(`[sync] ${key}: giving up after ${attempt + 1} attempts (last error ${code}) — ${saved ? `showing the ${saved.length} records saved on this device` : 'nothing saved on this device yet'}; downloaded pages are kept and Retry resumes from the last one`);
          reportSync(key, { state: 'failed', errorCode: code, servingSavedCopy: !!saved });
          registerRetry(key, () => {
            if (this.subject === subject) {
              reportSync(key, { state: 'retrying' });
              this.load(subject, 0, servedFallback);
            } else {
              this.forwardToSuccessor(subject, servedFallback);
            }
          });
          return;
        }

        // Quota refusals back off much longer than network blips.
        const delayMs = kind === 'quota' ? backoffDelayMs(attempt, 60_000, 300_000) : backoffDelayMs(attempt, 10_000, 120_000);
        reportSync(key, { state: 'retrying', errorCode: code, servingSavedCopy: !!saved });
        console.warn(`[sync] ${key}: Firestore ${code} — ${saved ? `showing the ${saved.length} records saved on this device` : 'nothing saved on this device yet'}; background attempt ${attempt + 2}/${MAX_BACKGROUND_ATTEMPTS} in ${Math.round(delayMs / 1000)}s`);
        setTimeout(() => {
          if (this.subject === subject) {
            this.load(subject, attempt + 1, servedFallback);
          } else {
            this.forwardToSuccessor(subject, servedFallback);
          }
        }, delayMs);
      });
  }

  /** Superseded by invalidate() while waiting — forward the newer load's results to this subject's subscribers instead of leaving them stuck. */
  private forwardToSuccessor(subject: ReplaySubject<T[]>, servedFallback: boolean): void {
    if (servedFallback) return;
    this.get$();
    const successor = this.subject!;
    successor.subscribe((items) => {
      if (this.freshSubjects.has(successor)) this.freshSubjects.add(subject);
      subject.next(items);
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
    const reason = this.fullReason();
    const items = reason === null ? await this.deltaSync() : await this.exclusiveFullLoad(reason, true);
    this.current = items;
    this.scheduleStorageWrite(0);
    return items;
  }

  private fullReason(): string | null {
    const maxAge = this.opts.maxSnapshotAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    return this.current === null ? 'no local copy on this device yet'
      : this.current.length === 0 ? 'local copy is empty'
      : this.cursor === null ? 'no cached doc has an updatedAt field, so delta sync is impossible — EVERY sync of this cache is a full reload'
      : Date.now() - this.fullLoadedAt >= maxAge ? 'local copy older than the weekly safety resync'
      : null;
  }

  /**
   * At most two full downloads at once in this tab (limiter), one per
   * collection across tabs (Web Locks). Whoever waited re-checks IndexedDB first: if
   * another tab finished the same download meanwhile, it adopts that copy and
   * only delta-syncs instead of downloading the collection again.
   */
  private exclusiveFullLoad(reason: string, allowAdopt: boolean): Promise<T[]> {
    const key = this.opts.storageKey;
    return fullLoadLimiter(() => withCrossTabLock(`tmg-sync:${key}`, async () => {
      if (allowAdopt) {
        const maxAge = this.opts.maxSnapshotAgeMs ?? 7 * 24 * 60 * 60 * 1000;
        const fresh = await readSnapshot<T>(key);
        if (fresh && fresh.items.length && fresh.cursor && fresh.fullLoadedAt > this.fullLoadedAt && Date.now() - fresh.fullLoadedAt < maxAge) {
          console.info(`[sync] ${key}: another tab finished the full download — adopting its ${fresh.items.length} records`);
          this.current = fresh.items;
          this.cursor = fresh.cursor;
          this.fullLoadedAt = fresh.fullLoadedAt;
          this.persistedItems = fresh.items;
          return this.deltaSync(true, true);
        }
      }
      return this.fullLoad(reason);
    }));
  }

  private async fullLoad(reason: string, restartedAfterLostCursor = false): Promise<T[]> {
    const key = this.opts.storageKey;
    const pageSize = syncPageSize();
    const t0 = Date.now();
    // Last doc of the previous page in THIS run — the startAfter() cursor
    // without an extra read. After a restart only its id survives, and the
    // doc is re-read once (1 read) to rebuild the cursor.
    let lastSnap: DocumentSnapshot | null = null;
    let committed: T[] | null = null;
    reportSync(key, { state: 'syncing', pages: 0, docs: 0 });
    console.info(`[sync] ${key}: full download — ${reason}; ${pageSize} docs/page`);

    try {
      const result = await runResumableFullLoad<T, PlainTimestamp>({
        key,
        querySig: `${SYNC_CACHE_VERSION}:${key}`,
        pageSize,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        getId: (x) => x.id!,
        fetchAnchor: async () => {
          const snap = await getDocs(query(this.opts.collectionRef, orderBy('updatedAt', 'desc'), limit(1)));
          const ts = snap.docs[0]?.get('updatedAt');
          return ts instanceof Timestamp ? toPlain(ts) : null;
        },
        fetchPage: async (lastId, size) => {
          let cursorSnap = lastSnap && lastSnap.id === lastId ? lastSnap : null;
          if (lastId && !cursorSnap) {
            const resumed = await getDoc(doc(this.opts.collectionRef, lastId));
            if (!resumed.exists()) throw Object.assign(new Error('resume point was deleted'), { code: SYNC_CURSOR_LOST });
            cursorSnap = resumed;
          }
          const snap = await getDocs(query(
            this.opts.collectionRef,
            ...this.opts.constraints,
            ...(cursorSnap ? [startAfter(cursorSnap)] : []),
            limit(size),
          ));
          if (snap.docs.length) lastSnap = snap.docs[snap.docs.length - 1];
          return { items: snap.docs.map((d) => this.opts.mapDoc(d)), lastId: lastSnap?.id ?? lastId };
        },
        fetchChangedSince: async (anchor) => {
          const { changes, max } = await this.fetchChangedSince(fromPlain(anchor));
          return { changes, maxAnchor: max ? toPlain(max) : null };
        },
        store: progressStore<T>(key),
        log: (e) => {
          logFullLoad(e);
          if (e.event === 'retry') reportSync(key, { state: 'retrying', errorCode: e.code });
          else if (e.event === 'page') reportSync(key, { state: 'syncing' });
        },
        onProgress: ({ pages, docs }) => reportSync(key, { state: 'syncing', pages, docs }),
        commit: async (items, cursor) => {
          const final = this.sorted(this.applyPendingPatches(items, new Set(items.map((x) => x.id!))));
          this.cursor = cursor ? fromPlain(cursor) : null;
          this.fullLoadedAt = Date.now();
          committed = final;
          if (final.length) {
            await writeSnapshot(key, this.snapshotOf(final));
            this.persistedItems = final;
          }
        },
      });
      recordCacheSync(key, 'full', `${result.items.length} docs — ${result.pagesFetched} pages fetched, ${result.pagesResumed} resumed, ${result.catchUpDocs} caught up, ${Math.round((Date.now() - t0) / 1000)}s (${reason})`);
      await this.opts.afterFetch?.(committed!);
      return committed!;
    } catch (err) {
      if (errorCode(err) === SYNC_CURSOR_LOST && !restartedAfterLostCursor) {
        console.warn(`[sync] ${key}: saved resume point no longer exists — restarting the download`);
        await progressStore<T>(key).clear();
        return this.fullLoad(reason, true);
      }
      throw err;
    }
  }

  /** Every doc with updatedAt >= since (paged), marked by whether it belongs in this list, and the newest updatedAt seen. */
  private async fetchChangedSince(since: Timestamp): Promise<{ changes: Change<T>[]; max: Timestamp | null }> {
    let max: Timestamp | null = since;
    const required = this.opts.requiredField;
    const matches = this.opts.matches;
    const changes = await fetchAllDocs(
      this.opts.collectionRef,
      [where('updatedAt', '>=', since), orderBy('updatedAt', 'asc')],
      (d) => {
        max = maxTimestamp(max, d.get('updatedAt'));
        return {
          item: this.opts.mapDoc(d),
          included: (!required || d.get(required) !== undefined) && (!matches || matches(d)),
        };
      }
    );
    return { changes, max };
  }

  private async deltaSync(recheckOnMismatch = true, insideFullLoadLock = false): Promise<T[]> {
    const [{ changes, max }, serverCount] = await withTimeout(Promise.all([
      this.fetchChangedSince(this.cursor!),
      getCountFromServer(query(this.opts.collectionRef, ...this.opts.constraints)).then((s) => s.data().count),
    ]), REQUEST_TIMEOUT_MS * 2);

    const freshItems = changes.filter((c) => c.included).map((c) => c.item);
    await this.opts.afterFetch?.(freshItems);

    const merged = mergeChanges(this.current!, changes, (x) => x.id!);

    if (merged.length !== serverCount && recheckOnMismatch) {
      // The delta query and count() run in parallel, so a doc created or
      // updated in between (another device scanning/saving) makes them
      // disagree for a moment. Re-check once — one more delta + count, a
      // handful of reads — before paying a full reload (~11k for inventory).
      return this.deltaSync(false, insideFullLoadLock);
    }
    if (merged.length !== serverCount) {
      // Something was deleted (or created without updatedAt) outside this
      // tab — the only case that still needs the whole collection.
      const reason = `count check failed: ${merged.length} cached vs ${serverCount} on server — a doc was deleted elsewhere, or written without updatedAt`;
      return insideFullLoadLock ? this.fullLoad(reason) : this.exclusiveFullLoad(reason, false);
    }
    recordCacheSync(this.opts.storageKey, 'delta', `${changes.length} changed docs`);

    this.cursor = max;
    const fetchedIds = new Set(changes.map((c) => c.item.id!));
    return this.sorted(this.applyPendingPatches(merged, fetchedIds));
  }

  private snapshotOf(items: T[]): StoredSnapshot {
    return {
      version: SYNC_CACHE_VERSION,
      savedAt: Date.now(),
      fullLoadedAt: this.fullLoadedAt,
      cursor: this.cursor ? toPlain(this.cursor) : null,
      itemsJson: JSON.stringify(items),
    };
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
      // Already persisted by the full download's commit step.
      if (this.current === this.persistedItems) return;
      const items = this.current;
      void writeSnapshot(this.opts.storageKey, this.snapshotOf(items)).then(() => { this.persistedItems = items; });
    }, delayMs);
  }
}

function toPlain(ts: Timestamp): PlainTimestamp {
  return { seconds: ts.seconds, nanoseconds: ts.nanoseconds };
}

function fromPlain(ts: PlainTimestamp): Timestamp {
  return new Timestamp(ts.seconds, ts.nanoseconds);
}

/** Runs `fn` holding a named Web Lock (one holder across all tabs of this origin); runs it directly where Web Locks don't exist. */
function withCrossTabLock<R>(name: string, fn: () => Promise<R>): Promise<R> {
  const locks = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { locks?: { request: (name: string, cb: () => Promise<R>) => Promise<R> } }).locks
    : undefined;
  return locks?.request ? locks.request(name, fn) : fn();
}

function logFullLoad(e: FullLoadLog): void {
  switch (e.event) {
    case 'start':
      console.info(`[sync] ${e.key}: download started (page size ${e.pageSize})`);
      break;
    case 'resume':
      console.info(`[sync] ${e.key}: resuming after page ${e.page} (${e.totalDocs} docs already saved on this device, cursor ${e.cursor})`);
      break;
    case 'restart':
      console.info(`[sync] ${e.key}: saved download progress discarded — ${e.reason}`);
      break;
    case 'page':
      console.info(`[sync] ${e.key}: page ${e.page} — ${e.docs} docs (page size ${e.pageSize}), ${e.totalDocs} saved so far, cursor ${e.cursor}`);
      break;
    case 'retry':
      console.warn(`[sync] ${e.key}: page ${e.page} failed (${e.code}) — retry ${e.attempt}/${(e.maxAttempts ?? 1) - 1} in ${((e.delayMs ?? 0) / 1000).toFixed(1)}s`);
      break;
    case 'catch-up':
      console.info(`[sync] ${e.key}: ${e.docs} docs written during the download picked up`);
      break;
    case 'done':
      console.info(`[sync] ${e.key}: download complete — ${e.totalDocs} docs in ${e.page} pages`);
      break;
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

// Every cached screen awaits IndexedDB BEFORE its first Firestore query, so a
// request that never settles stalls the screen on its loading state forever.
// Mobile browsers do exactly that: iOS Safari / WKWebView (WebKit bug 226547)
// and some Android in-app browsers can leave indexedDB.open() — or a get() on
// a connection the OS dropped while the tab was backgrounded — without ever
// firing success/error/blocked. Each step therefore gives up after a timeout
// and the cache carries on without the local copy (straight to Firestore).
const IDB_OPEN_TIMEOUT_MS = 3000;
const IDB_READ_TIMEOUT_MS = 5000;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let settled = false;
      const settle = (db: IDBDatabase | null) => {
        if (settled) {
          // Open finished after we already gave up — don't leak the connection.
          db?.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (db) {
          // The OS can close the connection under us (backgrounded tab on
          // iOS) — reopen on next use instead of reusing a dead handle.
          db.onclose = () => { dbPromise = null; };
          db.onversionchange = () => { db.close(); dbPromise = null; };
        }
        resolve(db);
      };
      const timer = setTimeout(() => {
        console.warn(`[sync] IndexedDB did not open within ${IDB_OPEN_TIMEOUT_MS / 1000}s — continuing without the local copy`);
        settle(null);
      }, IDB_OPEN_TIMEOUT_MS);
      try {
        if (typeof indexedDB === 'undefined') return settle(null);
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
        request.onsuccess = () => settle(request.result);
        request.onerror = () => settle(null);
        request.onblocked = () => settle(null);
      } catch {
        settle(null);
      }
    });
  }
  return dbPromise;
}

/** One-key get with a timeout — rejects instead of hanging when the browser never answers. */
function getStored<V>(db: IDBDatabase, key: string): Promise<V | undefined> {
  return new Promise<V | undefined>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IndexedDB read timed out')), IDB_READ_TIMEOUT_MS);
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => { clearTimeout(timer); resolve(request.result as V | undefined); };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    tx.onabort = () => { clearTimeout(timer); reject(tx.error); };
  });
}

async function readSnapshot<T>(key: string): Promise<{ items: T[]; cursor: Timestamp | null; fullLoadedAt: number } | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const stored = await getStored<StoredSnapshot>(db, key);
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
  try {
    await putRaw(key, snapshot);
  } catch {
    // Storage full/unavailable — purely a cold-start optimization.
  }
}

const IDB_WRITE_TIMEOUT_MS = 15000;

/** put() that resolves once the transaction has committed (or rejects) — download progress must be on disk before the next page is requested. */
async function putRaw(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IndexedDB write timed out')), IDB_WRITE_TIMEOUT_MS);
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => { clearTimeout(timer); resolve(); };
    tx.onerror = () => { clearTimeout(timer); reject(tx.error); };
    tx.onabort = () => { clearTimeout(timer); reject(tx.error); };
  });
}

async function getRaw<V>(key: string): Promise<V | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  try {
    return await getStored<V>(db, key);
  } catch {
    return undefined;
  }
}

/** Deletes every key starting with `prefix`, resolving once committed. */
async function deletePrefix(prefix: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IndexedDB delete timed out')), IDB_WRITE_TIMEOUT_MS);
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
    tx.oncomplete = () => { clearTimeout(timer); resolve(); };
    tx.onerror = () => { clearTimeout(timer); reject(tx.error); };
    tx.onabort = () => { clearTimeout(timer); reject(tx.error); };
  });
}

/**
 * Where an unfinished full download keeps its pages: `<key>::full::meta`
 * (progress + cursor) and one `<key>::full::p<n>` entry per page, so saving a
 * page costs O(page) instead of re-serializing everything downloaded so far.
 * Entries carry savedAt, so pruneStoredEntries() also clears abandoned range ones.
 */
function progressStore<T>(key: string): FullLoadStore<T, PlainTimestamp> {
  const prefix = `${key}::full::`;
  const meta = `${prefix}meta`;
  const page = (i: number) => `${prefix}p${String(i).padStart(5, '0')}`;
  return {
    readProgress: async () => (await getRaw<FullLoadProgress<PlainTimestamp>>(meta)) ?? null,
    writeProgress: (progress) => putRaw(meta, { ...progress, savedAt: Date.now() }),
    writePage: (i, items) => putRaw(page(i), { savedAt: Date.now(), itemsJson: JSON.stringify(items) }),
    readPages: async (count) => {
      const pages: T[][] = [];
      for (let i = 0; i < count; i++) {
        const stored = await getRaw<{ itemsJson?: unknown }>(page(i));
        if (!stored || typeof stored.itemsJson !== 'string') return null;
        const items = JSON.parse(stored.itemsJson, reviveTimestamps);
        if (!Array.isArray(items)) return null;
        pages.push(items as T[]);
      }
      return pages;
    },
    clear: () => deletePrefix(prefix),
  };
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
    const stored = await getStored<StoredEntry>(db, key);
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
