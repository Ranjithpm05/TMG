import { Observable, ReplaySubject } from 'rxjs';

/**
 * Full-collection cache with an in-place patch escape hatch. Behaves like the
 * app's existing `from(fetchAllDocs(...)).pipe(shareReplay(1))` + nulling
 * pattern (get$/invalidate), but adds patchOne() so a write whose new value
 * is already known (e.g. a single-unit scan transaction) can update the live
 * cache directly instead of forcing every subscriber to re-download the
 * entire collection on the next read.
 *
 * Optional storageKey/ttlMs persists the loaded snapshot to localStorage
 * (short TTL, unlike PersistentCollectionCache's 20 min default) so a fresh
 * page load/reload within the TTL skips the full Firestore re-fetch too —
 * without this, a large collection (e.g. ~11k-doc inventory) costs a full
 * re-download on every reload even though the in-memory cache already
 * avoided re-fetching on in-app navigation. Bounded to a few minutes so
 * warehouse-floor screens don't run on badly stale stock for long; patchOne()
 * writes through to storage under the *original* load's timestamp (not a
 * refreshed one), so the TTL clock isn't reset by a steady stream of scans.
 */
export class PatchableCollectionCache<T extends { id?: string }> {
  private subject: ReplaySubject<T[]> | null = null;
  private current: T[] | null = null;
  private loadedAt: number | null = null;

  constructor(
    private readonly loader: () => Promise<T[]>,
    private readonly storageKey?: string,
    private readonly ttlMs: number = 5 * 60 * 1000
  ) {}

  get$(): Observable<T[]> {
    if (!this.subject) {
      const subject = new ReplaySubject<T[]>(1);
      this.subject = subject;

      const cached = this.readFromStorage();
      if (cached) {
        this.current = cached.items;
        this.loadedAt = cached.savedAt;
        subject.next(cached.items);
      } else {
        this.loader()
          .then((items) => {
            this.current = items;
            this.loadedAt = Date.now();
            this.writeToStorage(items, this.loadedAt);
            subject.next(items);
          })
          .catch((err) => {
            // A hard subject.error() here used to kill this Observable for
            // good — Angular's toSignal() re-throws that on the next signal
            // read, breaking rendering for every already-open screen (e.g.
            // Dashboard) until a full page reload, even after the underlying
            // Firestore issue (e.g. a transient resource-exhausted) clears.
            // Degrade to last-known data instead — a stale/expired storage
            // snapshot beats a permanently broken screen — while still
            // nulling `subject` so the *next* get$() call (new component
            // instance, or a manual retry) attempts a fresh load rather than
            // being stuck serving this fallback forever.
            console.error('PatchableCollectionCache load failed, serving fallback', err);
            const fallback = this.current ?? this.readFromStorage(true)?.items ?? [];
            this.current = fallback;
            subject.next(fallback);
            this.subject = null;
          });
      }
    }
    return this.subject.asObservable();
  }

  /** Drops the in-memory value and, if configured, the persisted snapshot — the next get$() does a full Firestore reload. */
  invalidate(): void {
    this.subject = null;
    this.current = null;
    this.loadedAt = null;
    this.clearStorage();
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
    if (this.loadedAt !== null) this.writeToStorage(this.current, this.loadedAt);
  }

  private readFromStorage(ignoreTtl = false): { items: T[]; savedAt: number } | null {
    if (!this.storageKey) return null;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { savedAt?: number; items?: T[] };
      if (typeof parsed?.savedAt !== 'number' || !Array.isArray(parsed.items)) return null;
      // ignoreTtl: a load-failure fallback prefers stale data over none —
      // the normal (non-fallback) path below never passes this, so a fresh
      // load still only ever serves storage within the configured TTL.
      if (!ignoreTtl && Date.now() - parsed.savedAt > this.ttlMs) return null;
      return { items: parsed.items, savedAt: parsed.savedAt };
    } catch {
      // Corrupt entry, storage unavailable (private browsing), or quota
      // issue — fall through to a normal Firestore load.
      return null;
    }
  }

  private writeToStorage(items: T[], savedAt: number): void {
    if (!this.storageKey) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ savedAt, items }));
    } catch {
      // localStorage full/unavailable — purely a cold-start optimization, the
      // in-memory cache still works fine without it.
    }
  }

  private clearStorage(): void {
    if (!this.storageKey) return;
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      // ignore
    }
  }
}
