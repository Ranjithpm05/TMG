import { computed, signal } from '@angular/core';

/**
 * What every SyncedCollectionCache is doing right now — drives the sync bar
 * in the app shell (what is downloading, when data was last synced, what
 * failed, and a Retry button). Keys are the caches' storage keys.
 */

export type SyncState = 'syncing' | 'retrying' | 'ok' | 'failed';

export interface SyncStatusEntry {
  key: string;
  label: string;
  state: SyncState;
  /** Full download progress (pages/docs persisted so far) — absent for delta syncs. */
  pages?: number;
  docs?: number;
  /** Last successful sync (ms epoch) — persisted, so it survives reloads. */
  lastSyncedAt: number | null;
  errorCode?: string;
  /** True when the screen is showing the copy saved on this device instead of fresh data. */
  servingSavedCopy?: boolean;
}

const LAST_SYNC_STORAGE_KEY = 'tmg:sync:last';

const entries = signal<Record<string, SyncStatusEntry>>({});
const retryHandlers = new Map<string, () => void>();
let lastSynced: Record<string, number> = readLastSynced();

export const syncStatuses = computed(() => Object.values(entries()));
export const activeSyncs = computed(() => syncStatuses().filter((e) => e.state === 'syncing' || e.state === 'retrying'));
export const failedSyncs = computed(() => syncStatuses().filter((e) => e.state === 'failed'));
/** Oldest "last synced" among the lists in use — what the bar reports as data freshness. */
export const oldestSyncAt = computed(() => {
  const times = syncStatuses().map((e) => e.lastSyncedAt).filter((t): t is number => t !== null);
  return times.length ? Math.min(...times) : null;
});

export function reportSync(key: string, patch: Partial<Omit<SyncStatusEntry, 'key' | 'label' | 'lastSyncedAt'>> & { synced?: boolean }): void {
  const { synced, ...rest } = patch;
  if (synced) {
    lastSynced = { ...lastSynced, [key]: Date.now() };
    writeLastSynced(lastSynced);
  }
  entries.update((all) => {
    const prev = all[key];
    const next: SyncStatusEntry = {
      key,
      label: labelFor(key),
      lastSyncedAt: lastSynced[key] ?? null,
      state: 'syncing',
      ...prev,
      ...rest,
    };
    next.lastSyncedAt = lastSynced[key] ?? null;
    if (next.state === 'ok') {
      delete next.errorCode;
      delete next.pages;
      delete next.docs;
      next.servingSavedCopy = false;
    }
    return { ...all, [key]: next };
  });
}

export function lastSyncedAt(key: string): number | null {
  return lastSynced[key] ?? null;
}

/** Registered by each cache; retryFailedSyncs() resumes the failed ones (their saved pages are kept, so nothing is re-downloaded). */
export function registerRetry(key: string, handler: () => void): void {
  retryHandlers.set(key, handler);
}

export function retryFailedSyncs(): void {
  for (const entry of failedSyncs()) retryHandlers.get(entry.key)?.();
}

// Coming back online: resume failed syncs — throttled, since some browsers
// fire `online` repeatedly on a flaky connection and that must not turn back
// into a retry loop.
const AUTO_RETRY_MIN_INTERVAL_MS = 2 * 60 * 1000;
let lastAutoRetryAt = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (Date.now() - lastAutoRetryAt < AUTO_RETRY_MIN_INTERVAL_MS) return;
    lastAutoRetryAt = Date.now();
    retryFailedSyncs();
  });
}

function labelFor(key: string): string {
  // range:salesOrders:<start>_<end>[_field=value] → "Sales orders (date range)"
  const range = key.startsWith('range:');
  const name = range ? key.split(':')[1] ?? key : key;
  const pretty = LABELS[name] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  return range ? `${pretty} (date range)` : pretty;
}

const LABELS: Record<string, string> = {
  inventory: 'Inventory',
  designs: 'Designs',
  salesOrders: 'Sales orders',
  goodsInwards: 'Goods inward',
  goodsInward: 'Goods inward',
  pickLists: 'Pick lists',
  packingLists: 'Packing lists',
  deliveryChallans: 'Delivery challans',
  invoices: 'Invoices',
  lrEntries: 'LR entries',
};

function readLastSynced(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_SYNC_STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLastSynced(value: Record<string, number>): void {
  // Date-range keys come and go — drop ones not synced for 3 weeks.
  const cutoff = Date.now() - 21 * 24 * 60 * 60 * 1000;
  const kept = Object.fromEntries(Object.entries(value).filter(([, at]) => at >= cutoff));
  try {
    localStorage.setItem(LAST_SYNC_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage unavailable — the bar just won't remember across reloads.
  }
}
