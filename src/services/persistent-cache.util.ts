import { Observable, ReplaySubject } from 'rxjs';

/**
 * Full-collection cache like PatchableCollectionCache, but also persists the
 * last-loaded snapshot to localStorage with a TTL. A fresh browser tab/reload
 * can then render instantly from the persisted snapshot and skip a full
 * Firestore re-fetch entirely, instead of re-running fetchAllDocs() on every
 * login/refresh (part of the same read-quota fix as PatchableCollectionCache
 * — see project memory).
 *
 * Only meant for slow-changing master data (clients, designs, transports —
 * things that rarely change intra-day and aren't sensitive). Deliberately
 * NOT used for fast-changing warehouse-floor data (inventory, pick lists,
 * packing lists) — a stale localStorage snapshot there would show wrong
 * stock/pick-status to other staff until the TTL expires, and NOT used for
 * anything carrying credentials (e.g. users' passwordHash), since
 * localStorage is plaintext and readable by any script on the page.
 */
export class PersistentCollectionCache<T> {
  private subject: ReplaySubject<T[]> | null = null;

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
        subject.next(cached);
      } else {
        this.loader()
          .then((items) => {
            this.writeToStorage(items);
            subject.next(items);
          })
          .catch((err) => {
            this.subject = null;
            subject.error(err);
          });
      }
    }
    return this.subject.asObservable();
  }

  /** Drops both the in-memory value and the persisted snapshot — the next get$() does a full Firestore reload. */
  invalidate(): void {
    this.subject = null;
    this.clearStorage();
  }

  private readFromStorage(): T[] | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { savedAt?: number; items?: T[] };
      if (typeof parsed?.savedAt !== 'number' || !Array.isArray(parsed.items)) return null;
      if (Date.now() - parsed.savedAt > this.ttlMs) return null;
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
