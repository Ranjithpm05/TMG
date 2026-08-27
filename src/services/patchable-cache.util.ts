import { Observable, ReplaySubject } from 'rxjs';

/**
 * Full-collection cache with an in-place patch escape hatch. Behaves like the
 * app's existing `from(fetchAllDocs(...)).pipe(shareReplay(1))` + nulling
 * pattern (get$/invalidate), but adds patchOne() so a write whose new value
 * is already known (e.g. a single-unit scan transaction) can update the live
 * cache directly instead of forcing every subscriber to re-download the
 * entire collection on the next read.
 */
export class PatchableCollectionCache<T extends { id?: string }> {
  private subject: ReplaySubject<T[]> | null = null;
  private current: T[] | null = null;

  constructor(private readonly loader: () => Promise<T[]>) {}

  get$(): Observable<T[]> {
    if (!this.subject) {
      const subject = new ReplaySubject<T[]>(1);
      this.subject = subject;
      this.loader()
        .then((items) => {
          this.current = items;
          subject.next(items);
        })
        .catch((err) => {
          this.subject = null;
          this.current = null;
          subject.error(err);
        });
    }
    return this.subject.asObservable();
  }

  invalidate(): void {
    this.subject = null;
    this.current = null;
  }

  /**
   * Replaces (or appends, if not present) one item by id and re-emits.
   * No-op if the cache hasn't resolved yet — the in-flight/next get$() load
   * will already reflect this write, since the write always commits before
   * patchOne() is called.
   */
  patchOne(item: T): void {
    if (!this.current || !this.subject) return;
    const idx = this.current.findIndex((x) => x.id === item.id);
    this.current = idx === -1
      ? [...this.current, item]
      : this.current.map((x, i) => (i === idx ? item : x));
    this.subject.next(this.current);
  }
}
