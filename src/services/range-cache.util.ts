import { Observable, from, of } from 'rxjs';
import { catchError, shareReplay } from 'rxjs/operators';

/**
 * Shared helper for the Map<key, Observable>-backed date-range caches used by
 * SalesOrderService/GoodsInwardService/PickListService/PackingListService/
 * DeliveryChallanService/InvoiceService's getXInRange() methods (Dashboard's
 * date-filtered reads).
 *
 * A bare `from(fetch()).pipe(shareReplay(1))` caches a REJECTED fetch (e.g. a
 * transient Firestore resource-exhausted) just as permanently as a
 * successful one — every later call for the exact same (start, end) key
 * replays that same error forever rather than retrying, and Angular's
 * toSignal() re-throws it on the next signal read, breaking rendering for
 * whatever screen is subscribed (Dashboard) until a full page reload even
 * after the underlying Firestore issue clears. This evicts the failed key so
 * the next call for it gets a fresh attempt, and resolves to an empty array
 * instead of propagating the error so the current subscriber degrades to
 * "no data for this range" rather than a broken screen.
 */
export function cachedRangeQuery<T>(
  cache: Map<string, Observable<T[]>>,
  key: string,
  maxEntries: number,
  fetch: () => Promise<T[]>
): Observable<T[]> {
  let cached = cache.get(key);
  if (!cached) {
    if (cache.size >= maxEntries) cache.clear();
    cached = from(fetch()).pipe(
      catchError((err) => {
        console.error('cachedRangeQuery load failed, serving empty result', err);
        cache.delete(key);
        return of([] as T[]);
      }),
      shareReplay(1)
    );
    cache.set(key, cached);
  }
  return cached;
}
