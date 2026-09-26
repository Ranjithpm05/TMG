import { CollectionReference, QueryDocumentSnapshot, Timestamp, orderBy, where } from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { SyncedCollectionCache, byCreatedAtDesc, pruneStoredEntries } from './synced-collection-cache.util';

/**
 * Shared helper behind SalesOrderService/GoodsInwardService/PickListService/
 * PackingListService/DeliveryChallanService/InvoiceService's getXInRange()
 * methods (Dashboard's and Reports' date-filtered reads).
 *
 * Each (collection, range[, equality filter]) gets its own
 * SyncedCollectionCache — persisted in IndexedDB and refreshed with
 * updatedAt delta queries — instead of the previous in-memory
 * `from(fetch()).pipe(shareReplay(1))` map. That map was empty on every page
 * load/new tab and cleared after every write, so the Dashboard (everyone's
 * landing page) re-read the entire month of sales orders, GRNs, pick lists,
 * packing lists, DCs and invoices on every visit. Now a revisit costs one
 * delta query + one count() per collection.
 *
 * Contract: never errors, and completes once the list is fresh. While
 * Firestore refuses requests it first emits the copy saved on this device (if
 * any) and keeps retrying in the background; the fresh list follows.
 */

export interface RangeQueryOptions<T> {
  cache: Map<string, SyncedCollectionCache<T>>;
  /** Collection name, used in the IndexedDB key. */
  collectionName: string;
  collectionRef: CollectionReference;
  start: Date;
  end: Date;
  /** Optional equality filter on top of the createdAt range (needs a composite index with createdAt). */
  equals?: { field: string; value: string };
  mapDoc: (doc: QueryDocumentSnapshot) => T;
  maxEntries: number;
  /** Emit this device's last-known copy first, then the synced one — for read-only displays. */
  cachedFirst?: boolean;
}

const RANGE_KEY_PREFIX = 'range:';
const RANGE_ENTRY_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;
let pruneScheduled = false;

export function syncedRangeQuery<T extends { id?: string; createdAt?: unknown }>(opts: RangeQueryOptions<T>): Observable<T[]> {
  const equalsKey = opts.equals ? `_${opts.equals.field}=${opts.equals.value}` : '';
  const key = `${opts.start.getTime()}_${opts.end.getTime()}${equalsKey}`;

  let cache = opts.cache.get(key);
  if (!cache) {
    if (opts.cache.size >= opts.maxEntries) opts.cache.clear();
    schedulePrune();

    const startTs = Timestamp.fromDate(opts.start);
    const endTs = Timestamp.fromDate(opts.end);
    const equals = opts.equals;
    cache = new SyncedCollectionCache<T>({
      storageKey: `${RANGE_KEY_PREFIX}${opts.collectionName}:${key}`,
      collectionRef: opts.collectionRef,
      constraints: [
        where('createdAt', '>=', startTs),
        where('createdAt', '<=', endTs),
        ...(equals ? [where(equals.field, '==', equals.value)] : []),
        orderBy('createdAt', 'desc'),
      ],
      // Exact client-side twin of the constraints above: only a real
      // Timestamp createdAt can match a Timestamp range server-side.
      matches: (d) => {
        const createdAt = d.get('createdAt');
        return createdAt instanceof Timestamp
          && compareTimestamps(createdAt, startTs) >= 0
          && compareTimestamps(createdAt, endTs) <= 0
          && (!equals || d.get(equals.field) === equals.value);
      },
      mapDoc: opts.mapDoc,
      compare: byCreatedAtDesc,
    });
    opts.cache.set(key, cache);
  }

  return opts.cachedFirst ? cache.getCachedFirst$() : cache.getUntilSynced$();
}

/** After a write: the next getXInRange() call delta-syncs instead of serving the pre-write list. */
export function invalidateRangeCaches(cache: Map<string, SyncedCollectionCache<any>>): void {
  for (const entry of cache.values()) entry.invalidate();
}

/** After this app deleted a doc: drops it from every cached range, so their count() checks don't force a full range reload. */
export function removeFromRangeCaches(cache: Map<string, SyncedCollectionCache<any>>, id: string): void {
  for (const entry of cache.values()) entry.removeOne(id);
}

function compareTimestamps(a: Timestamp, b: Timestamp): number {
  return a.seconds !== b.seconds ? a.seconds - b.seconds : a.nanoseconds - b.nanoseconds;
}

function schedulePrune(): void {
  if (pruneScheduled) return;
  pruneScheduled = true;
  // Off the startup path — housekeeping for ranges nobody has opened in weeks.
  setTimeout(() => void pruneStoredEntries(RANGE_KEY_PREFIX, RANGE_ENTRY_MAX_AGE_MS), 15000);
}

/**
 * True for a yyyy-mm-dd value whose year is still being typed into a date
 * <input> (the browser emits 0002-…, 0020-…, 0202-… on the way to 2026-…).
 * Date filters feeding syncedRangeQuery() must ignore these: each one is a
 * new range cache whose first load covers almost the entire collection.
 */
export function isPartialYearDate(value: string): boolean {
  const year = Number(String(value ?? '').slice(0, 4));
  return !!value && (!Number.isFinite(year) || year < 2000);
}
