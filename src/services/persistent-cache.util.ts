import { Observable, ReplaySubject } from 'rxjs';

/**
 * Full-collection cache like PatchableCollectionCache, but also persists the
 * last-loaded snapshot to localStorage with a TTL. A fresh browser tab/reload
 * can then render instantly from the persisted snapshot and skip a full
 * Firestore re-fetch entirely, instead of re-running fetchAllDocs() on every
 * login/refresh (part of the same read-quota fix as PatchableCollectionCache
 * — see project memory).
 *
 * Meant for slow-changing master data (clients, designs, transports — things
 * that rarely change intra-day and aren't sensitive), using a long (20 min)
 * TTL. Fast-changing warehouse-floor data (inventory, pick lists, packing
 * lists) uses PatchableCollectionCache's own much shorter opt-in TTL instead
 * (see InventoryService) so a stale snapshot can't linger anywhere near this
 * long. NOT used for anything carrying credentials (e.g. users'
 * passwordHash), since localStorage is plaintext and readable by any script
 * on the page.
 */
export class PersistentCollectionCache<T> {
  private subject: ReplaySubject<T[]> | null = null;
  private current: T[] | null = null;

  constructor(
    private readonly storageKey: string,
    private readonly loader: () => Promise<T[]>,
    private readonly ttlMs: number = 20 * 60 * 1000
  ) {}

  get$(): Observable<T[]> {
    if (!this.subject) {
      const subject = new ReplaySubject<T[]>(1);
      this.subject = subject;

      const cached = this.readFromStorage();
      if (cached) {
        this.current = cached;
        subject.next(cached);
      } else {
        this.loader()
          .then((items) => {
            this.current = items;
            // Never persist an empty result (same rule as
            // PatchableCollectionCache) — it's far more likely a transient
            // bad read than truth, and caching it would serve an empty list
            // (e.g. no designs → every MRP resolving to ₹0) for the whole TTL.
            if (items.length > 0) this.writeToStorage(items);
            else this.clearStorage();
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
            console.error('PersistentCollectionCache load failed, serving fallback', err);
            const fallback = this.current ?? this.readFromStorage(true) ?? [];
            this.current = fallback;
            subject.next(fallback);
            this.subject = null;
          });
      }
    }
    return this.subject.asObservable();
  }

  /** Drops both the in-memory value and the persisted snapshot — the next get$() does a full Firestore reload. */
  invalidate(): void {
    this.subject = null;
    this.current = null;
    this.clearStorage();
  }

  private readFromStorage(ignoreTtl = false): T[] | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { savedAt?: number; items?: T[] };
      if (typeof parsed?.savedAt !== 'number' || !Array.isArray(parsed.items)) return null;
      // ignoreTtl: a load-failure fallback prefers stale data over none —
      // the normal (non-fallback) path above never passes this, so a fresh
      // load still only ever serves storage within the configured TTL.
      if (!ignoreTtl && Date.now() - parsed.savedAt > this.ttlMs) return null;
      return parsed.items;
    } catch {
      // Corrupt entry, storage unavailable (private browsing), or quota
      // issue — fall through to a normal Firestore load.
      return null;
    }
  }

  private writeToStorage(items: T[]): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ savedAt: Date.now(), items }));
    } catch {
      // localStorage full/unavailable — purely a cold-start optimization, the
      // in-memory cache still works fine without it.
    }
  }

  private clearStorage(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      // ignore
    }
  }
}
