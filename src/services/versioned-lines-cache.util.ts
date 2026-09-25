import { Timestamp } from '@angular/fire/firestore';
import { pruneStoredEntries, readStoredEntry, writeStoredEntry } from './synced-collection-cache.util';

/**
 * Per-device cache for a parent document's `lines` subcollection, keyed by
 * the PARENT's updatedAt.
 *
 * Reports' dispatch fan-out used to read every line of every in-scope Pick
 * List and Packing List on every report screen visit — thousands of reads
 * per visit on a normal month, repeated for each of the 12 report screens.
 * Every write that changes line content (scans, edits, packing, deletes,
 * status recalcs) also stamps the parent's updatedAt in the same
 * batch/transaction, so an unchanged parent updatedAt means unchanged lines,
 * and those lines are served from here instead of Firestore.
 *
 * NOT valid for callers that need claim fields (claimedByUserId/claimExpiresAt):
 * claim/heartbeat writes touch only the line, not the parent. The parent
 * passed in must come from a fresh server read, or the cache can only be as
 * fresh as that stale parent.
 */
export class VersionedLinesCache<T> {
  private readonly memory = new Map<string, { tag: string; items: T[] }>();
  private readonly inFlight = new Map<string, Promise<T[]>>();

  constructor(private readonly keyPrefix: string) {
    schedulePrune();
  }

  async get(parentId: string, parentUpdatedAt: unknown, load: () => Promise<T[]>): Promise<T[]> {
    const tag = timestampTag(parentUpdatedAt);
    // No usable version (legacy parent without updatedAt) — can't prove freshness.
    if (!tag) return load();

    const hit = this.memory.get(parentId);
    if (hit?.tag === tag) return hit.items;

    const flightKey = `${parentId}@${tag}`;
    const pending = this.inFlight.get(flightKey);
    if (pending) return pending;

    const promise = (async () => {
      const storageKey = `${LINES_KEY_PREFIX}${this.keyPrefix}:${parentId}`;
      const stored = await readStoredEntry<T[]>(storageKey);
      if (stored?.tag === tag && Array.isArray(stored.items)) {
        this.memory.set(parentId, { tag, items: stored.items });
        return stored.items;
      }
      const items = await load();
      this.memory.set(parentId, { tag, items });
      void writeStoredEntry(storageKey, tag, items);
      return items;
    })().finally(() => this.inFlight.delete(flightKey));

    this.inFlight.set(flightKey, promise);
    return promise;
  }
}

const LINES_KEY_PREFIX = 'lines:';
const LINES_ENTRY_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;
let pruneScheduled = false;

function timestampTag(value: unknown): string | null {
  if (value instanceof Timestamp) return `${value.seconds}.${value.nanoseconds}`;
  const raw = value as { seconds?: unknown; nanoseconds?: unknown } | null;
  if (raw && typeof raw.seconds === 'number' && typeof raw.nanoseconds === 'number') return `${raw.seconds}.${raw.nanoseconds}`;
  return null;
}

function schedulePrune(): void {
  if (pruneScheduled) return;
  pruneScheduled = true;
  setTimeout(() => void pruneStoredEntries(LINES_KEY_PREFIX, LINES_ENTRY_MAX_AGE_MS), 20000);
}
