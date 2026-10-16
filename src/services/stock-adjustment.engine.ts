// Business rules for group stock adjustment (stock audit), kept free of Angular and
// Firebase imports so they run unchanged under `node --test` against an in-memory
// store (scripts/tests/stock-adjustment.engine.test.mjs). StockAdjustmentService is
// the Firestore implementation of AdjustmentStore; everything that decides WHAT is
// written lives here.
//
// Completion guarantees (a group can hold ~8k SKUs, far beyond one Firestore
// transaction, so the work is split into chunks):
//  - Each chunk is one transaction: inventory.currentStock := counted qty AND the
//    line's audit fields (previousStock / countedQty / variance / applied) commit
//    together or not at all. previousStock is read inside that same transaction,
//    so a concurrent pick/pack/GRN write makes the transaction retry instead of
//    being silently overwritten with a stale variance.
//  - Every chunk re-checks the session's completionLock, so two devices (or a
//    double click) can never run completion at the same time, and skips lines
//    already marked applied, so nothing is ever applied twice.
//  - If any chunk fails, every line applied so far is reverted (increment(-variance),
//    which keeps any stock movement that happened meanwhile) and the session goes
//    back to 'Counting' — the user sees "no stock was changed". Only if the revert
//    itself cannot reach the server does the session stay 'Completing' (flagged
//    failed); completing again then resumes forward from the un-applied lines.

import type { InventoryItem } from '../models/inventory.model';
import type { ScanStatus, StockAdjustmentLine, StockAdjustmentSession } from '../models/stock-adjustment.model';

export type DocData = Record<string, any>;

/** The subset of a Firestore transaction the engine needs. update() accepts dotted field paths. */
export interface TxLike {
  get(path: string): Promise<DocData | null>;
  set(path: string, data: DocData): void;
  update(path: string, patch: DocData): void;
  delete(path: string): void;
}

export interface AdjustmentStore {
  runTransaction<T>(fn: (tx: TxLike) => Promise<T>): Promise<T>;
  listLines(sessionId: string): Promise<StockAdjustmentLine[]>;
  newSessionId(): string;
  serverTime(): unknown;
  increment(n: number): unknown;
  deleteField(): unknown;
  nowMs(): number;
}

export const STALE_LOCK_MS = 2 * 60 * 1000;
// Per chunk: ≤150 inventory writes + ≤150 line writes + 1 session write — well under
// Firestore's 500-writes-per-transaction limit, and small enough that a busy packing
// floor rarely forces a contention retry.
export const DEFAULT_CHUNK_SIZE = 150;

export const paths = {
  session: (sessionId: string) => `stockAdjustments/${sessionId}`,
  line: (sessionId: string, inventoryId: string) => `stockAdjustments/${sessionId}/lines/${inventoryId}`,
  linesCollection: (sessionId: string) => `stockAdjustments/${sessionId}/lines`,
  inventory: (inventoryId: string) => `inventory/${inventoryId}`,
  lock: (group: string) => `stockAdjustmentLocks/${groupKey(group)}`,
  counter: 'counters/stockAdjustmentCounter',
};

export class StockAdjustmentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'StockAdjustmentError';
  }
}

export function normalizeGroup(group: unknown): string {
  return String(group ?? '').trim();
}

/** Lock doc id for a group — case/whitespace-insensitive and safe for a Firestore id (no '/'). */
export function groupKey(group: string): string {
  return encodeURIComponent(normalizeGroup(group).toUpperCase()) || '_';
}

export function sameGroup(a: unknown, b: unknown): boolean {
  return normalizeGroup(a).toUpperCase() === normalizeGroup(b).toUpperCase();
}

export function normalizeCode(code: unknown): string {
  return String(code ?? '').trim().toUpperCase();
}

// ═════════════════════════════════════════════════════════════════════════════
// Scan validation
// ═════════════════════════════════════════════════════════════════════════════

export function indexByBarcode(items: InventoryItem[]): Map<string, InventoryItem[]> {
  const index = new Map<string, InventoryItem[]>();
  for (const item of items) {
    const key = normalizeCode(item.barcode);
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(item);
    else index.set(key, [item]);
  }
  return index;
}

export type ScanResult =
  | { ok: true; item: InventoryItem }
  | { ok: false; reason: 'empty' | 'unknown' | 'other-group' | 'ambiguous'; message: string };

/** Resolves a scanned barcode / item code to exactly one product of the session's group. */
export function classifyScan(
  rawCode: unknown,
  group: string,
  groupIndex: Map<string, InventoryItem[]>,
  allIndex: Map<string, InventoryItem[]>,
): ScanResult {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'empty', message: 'Empty scan ignored.' };

  const inGroup = groupIndex.get(code) ?? [];
  if (inGroup.length === 1) return { ok: true, item: inGroup[0] };
  if (inGroup.length > 1) {
    return { ok: false, reason: 'ambiguous', message: `Barcode ${code} maps to ${inGroup.length} inventory records — fix the duplicate in inventory before counting it.` };
  }

  const elsewhere = allIndex.get(code) ?? [];
  if (elsewhere.length) {
    const other = elsewhere[0];
    return {
      ok: false, reason: 'other-group',
      message: `${code} (${other.styleNo} · ${other.color} · ${other.size}) belongs to "${normalizeGroup(other.group) || 'no group'}", not "${group}". Not counted.`,
    };
  }
  return { ok: false, reason: 'unknown', message: `Invalid barcode ${code} — not found in inventory. Not counted.` };
}

// ═════════════════════════════════════════════════════════════════════════════
// Scan ledger — local counts with not-yet-saved deltas
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Tracks each product's counted qty as (server-confirmed + pending local delta).
 * Scans are buffered and flushed in batches as increment() writes, so a burst of
 * scanner input costs a handful of writes, never touches inventory, and a failed
 * flush puts its deltas back instead of losing or double-counting them.
 */
export class ScanLedger {
  private confirmed = new Map<string, number>();
  private inflight = new Map<string, number>();
  private pending = new Map<string, number>();

  /** Server values; deltas not yet confirmed (pending or in flight) stay on top of them. */
  load(lines: Pick<StockAdjustmentLine, 'id' | 'scannedQty'>[]): void {
    this.confirmed = new Map(lines.map((l) => [l.id, Math.max(0, Number(l.scannedQty) || 0)]));
  }

  count(id: string): number {
    return (this.confirmed.get(id) ?? 0) + (this.inflight.get(id) ?? 0) + (this.pending.get(id) ?? 0);
  }

  /** Returns the new count, or null when the change is rejected (non-integer, zero, or would go below 0). */
  add(id: string, delta: number): number | null {
    if (!Number.isInteger(delta) || delta === 0) return null;
    const next = this.count(id) + delta;
    if (next < 0) return null;
    addTo(this.pending, id, delta);
    return next;
  }

  /** Products with unsaved changes (pending or in flight). */
  get unsavedCount(): number {
    return new Set([...this.pending.keys(), ...this.inflight.keys()]).size;
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Hands the current deltas to a flush; they still count while in flight, and new scans accumulate separately. */
  takePending(): Map<string, number> {
    const batch = this.pending;
    this.pending = new Map();
    for (const [id, delta] of batch) addTo(this.inflight, id, delta);
    return batch;
  }

  /** The flush was saved. */
  commit(batch: Map<string, number>): void {
    for (const [id, delta] of batch) {
      addTo(this.inflight, id, -delta);
      addTo(this.confirmed, id, delta);
    }
  }

  /** The flush failed — its deltas go back to pending for the next attempt. */
  restore(batch: Map<string, number>): void {
    for (const [id, delta] of batch) {
      addTo(this.inflight, id, -delta);
      addTo(this.pending, id, delta);
    }
  }
}

function addTo(map: Map<string, number>, id: string, delta: number): void {
  const next = (map.get(id) ?? 0) + delta;
  if (next === 0) map.delete(id);
  else map.set(id, next);
}

// ═════════════════════════════════════════════════════════════════════════════
// Rows & summary
// ═════════════════════════════════════════════════════════════════════════════

export interface GroupRow {
  item: InventoryItem;
  existingStock: number;
  /** null = not counted yet. */
  countedQty: number | null;
  variance: number | null;
  status: ScanStatus;
}

export interface CountLike {
  scannedQty: number;
  zeroConfirmed?: boolean;
}

export function rowFor(item: InventoryItem, count: CountLike | undefined): GroupRow {
  const existingStock = Number(item.currentStock) || 0;
  const scanned = Math.max(0, Number(count?.scannedQty) || 0);
  let status: ScanStatus;
  let countedQty: number | null = null;
  if (scanned > 0) { status = 'scanned'; countedQty = scanned; }
  else if (count?.zeroConfirmed) { status = 'zero-confirmed'; countedQty = 0; }
  // Unscanned with book stock (incl. negative book stock) must be scanned or explicitly
  // confirmed as zero — never silently treated as zero.
  else if (existingStock !== 0) status = 'pending';
  else status = 'no-stock';
  return { item, existingStock, countedQty, variance: countedQty === null ? null : countedQty - existingStock, status };
}

export interface CountSummary {
  totalProducts: number;
  scanned: number;
  zeroConfirmed: number;
  pending: number;
  noStock: number;
  varianceProducts: number;
  increaseQty: number;
  decreaseQty: number;
  netVariance: number;
  existingTotal: number;
  scannedUnits: number;
}

export function summarize(rows: GroupRow[]): CountSummary {
  const s: CountSummary = {
    totalProducts: rows.length, scanned: 0, zeroConfirmed: 0, pending: 0, noStock: 0,
    varianceProducts: 0, increaseQty: 0, decreaseQty: 0, netVariance: 0, existingTotal: 0, scannedUnits: 0,
  };
  for (const r of rows) {
    s.existingTotal += r.existingStock;
    if (r.status === 'scanned') { s.scanned++; s.scannedUnits += r.countedQty ?? 0; }
    else if (r.status === 'zero-confirmed') s.zeroConfirmed++;
    else if (r.status === 'pending') s.pending++;
    else s.noStock++;
    if (r.variance) {
      s.varianceProducts++;
      if (r.variance > 0) s.increaseQty += r.variance;
      else s.decreaseQty -= r.variance;
    }
  }
  s.netVariance = s.increaseQty - s.decreaseQty;
  return s;
}

// ═════════════════════════════════════════════════════════════════════════════
// Session lifecycle
// ═════════════════════════════════════════════════════════════════════════════

const isActive = (s: DocData | null) => !!s && (s['status'] === 'Counting' || s['status'] === 'Completing');

export async function startSession(
  store: AdjustmentStore,
  input: { group: string; startedBy: string; totalProducts: number; startStockTotal: number },
): Promise<{ id: string; adjustmentNo: string }> {
  const group = normalizeGroup(input.group);
  if (!group) throw new StockAdjustmentError('invalid-group', 'Select a product group first.');
  const sessionId = store.newSessionId();

  return store.runTransaction(async (tx) => {
    const lockPath = paths.lock(group);
    const lock = await tx.get(lockPath);
    if (lock?.['sessionId']) {
      const active = await tx.get(paths.session(lock['sessionId']));
      if (isActive(active)) {
        throw new StockAdjustmentError('session-active',
          `${active!['adjustmentNo']} (started by ${active!['startedBy'] || 'another user'}) is already counting "${group}". Continue or cancel it first.`);
      }
    }
    const counter = await tx.get(paths.counter);
    const seq = (Number(counter?.['seq']) || 0) + 1;
    const adjustmentNo = `SA-${String(seq).padStart(4, '0')}`;

    const session: Omit<StockAdjustmentSession, 'id'> = {
      adjustmentNo, adjustmentSeq: seq, group, status: 'Counting',
      totalProducts: input.totalProducts, startStockTotal: input.startStockTotal,
      startedBy: input.startedBy, startedAt: store.serverTime(),
      result: { appliedLines: 0, changedLines: 0, increaseQty: 0, decreaseQty: 0 },
      createdAt: store.serverTime(), updatedAt: store.serverTime(),
    };
    tx.set(paths.session(sessionId), session);
    tx.set(lockPath, { sessionId, adjustmentNo, group, startedBy: input.startedBy, startedAt: store.serverTime() });
    tx.set(paths.counter, { seq, updatedAt: store.serverTime() });
    return { id: sessionId, adjustmentNo };
  });
}

export async function cancelSession(store: AdjustmentStore, sessionId: string, cancelledBy: string): Promise<void> {
  await store.runTransaction(async (tx) => {
    const session = await tx.get(paths.session(sessionId));
    if (!session) throw new StockAdjustmentError('not-found', 'Stock adjustment not found.');
    if (session['status'] !== 'Counting') {
      throw new StockAdjustmentError('not-counting', `Only a session that is still counting can be cancelled (this one is ${session['status']}).`);
    }
    const lockPath = paths.lock(session['group']);
    const lock = await tx.get(lockPath);
    tx.update(paths.session(sessionId), {
      status: 'Cancelled', cancelledBy, cancelledAt: store.serverTime(), updatedAt: store.serverTime(),
    });
    if (lock?.['sessionId'] === sessionId) tx.delete(lockPath);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Completion
// ═════════════════════════════════════════════════════════════════════════════

export function isLockStale(session: DocData, nowMs: number): boolean {
  const lock = session['completionLock'];
  if (!lock) return true;
  if (lock.failed) return true;
  return nowMs - (Number(lock.lastProgressMs) || 0) > STALE_LOCK_MS;
}

function assertLock(session: DocData | null, lockId: string): void {
  if (session?.['status'] !== 'Completing' || session['completionLock']?.lockId !== lockId) {
    throw new StockAdjustmentError('lock-lost', 'This completion was taken over by another session — refresh to see its result.');
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const errorText = (err: unknown) => (err as any)?.message ?? String(err);

export interface CompleteOptions {
  sessionId: string;
  completedBy: string;
  /** Current inventory rows of the session's group — used to block completion while any product is still pending. */
  groupItems: InventoryItem[];
  chunkSize?: number;
  rollbackRetries?: number;
  onProgress?: (done: number, total: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type CompleteOutcome =
  | { outcome: 'completed'; result: NonNullable<StockAdjustmentSession['result']> }
  | { outcome: 'already-completed' }
  | { outcome: 'in-progress' };

export async function completeSession(store: AdjustmentStore, opts: CompleteOptions): Promise<CompleteOutcome> {
  const { sessionId } = opts;
  const sessionPath = paths.session(sessionId);
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // 1. Every product with book stock must be counted (scanned or explicitly zero-confirmed).
  const lines = await store.listLines(sessionId);
  const linesById = new Map(lines.map((l) => [l.id, l]));
  const pending = opts.groupItems.map((item) => rowFor(item, linesById.get(item.id!))).filter((r) => r.status === 'pending');
  if (pending.length) {
    throw new StockAdjustmentError('pending-items',
      `${pending.length} product(s) with stock have not been scanned (e.g. ${pending.slice(0, 3).map((r) => r.item.barcode).join(', ')}). ` +
      `Scan them or confirm them as zero before completing.`);
  }

  // 2. Take the completion lock — the guard against double clicks and two devices.
  const lockId = `${store.nowMs()}-${Math.random().toString(36).slice(2)}`;
  const lockOutcome = await store.runTransaction(async (tx) => {
    const session = await tx.get(sessionPath);
    if (!session) throw new StockAdjustmentError('not-found', 'Stock adjustment not found.');
    if (session['status'] === 'Completed') return 'already-completed' as const;
    if (session['status'] === 'Cancelled') throw new StockAdjustmentError('cancelled', 'This stock adjustment was cancelled.');
    if (session['status'] === 'Completing' && !isLockStale(session, store.nowMs())) return 'in-progress' as const;
    tx.update(sessionPath, {
      status: 'Completing',
      completionLock: { lockId, lastProgressMs: store.nowMs() },
      lastError: store.deleteField(),
      updatedAt: store.serverTime(),
    });
    return 'locked' as const;
  });
  if (lockOutcome !== 'locked') return { outcome: lockOutcome };

  // 3. Apply in chunks. Lines already applied by an interrupted earlier attempt are skipped.
  const toApply = lines.filter((l) => !l.applied && ((Number(l.scannedQty) || 0) > 0 || l.zeroConfirmed));
  const chunks = chunk(toApply, chunkSize);
  try {
    for (let c = 0; c < chunks.length; c++) {
      await applyChunk(store, sessionId, lockId, chunks[c]);
      opts.onProgress?.(c + 1, chunks.length);
    }

    const result = await store.runTransaction(async (tx) => {
      const session = await tx.get(sessionPath);
      assertLock(session, lockId);
      const lockPath = paths.lock(session!['group']);
      const lock = await tx.get(lockPath);
      tx.update(sessionPath, {
        status: 'Completed',
        completedBy: opts.completedBy,
        completedAt: store.serverTime(),
        completionLock: store.deleteField(),
        updatedAt: store.serverTime(),
      });
      if (lock?.['sessionId'] === sessionId) tx.delete(lockPath);
      return session!['result'] as NonNullable<StockAdjustmentSession['result']>;
    });
    return { outcome: 'completed', result };
  } catch (err) {
    if (err instanceof StockAdjustmentError && err.code === 'lock-lost') throw err; // the other runner owns the outcome

    const original = errorText(err);
    try {
      await rollbackSession(store, sessionId, lockId, original, opts.rollbackRetries ?? 3, chunkSize, sleep);
    } catch (rollbackErr) {
      await markLockFailed(store, sessionId, lockId, original).catch(() => { /* offline — the lock goes stale on its own */ });
      throw new StockAdjustmentError('rollback-failed',
        `Stock adjustment failed: ${original}. The automatic rollback could not reach the server (${errorText(rollbackErr)}), ` +
        `so some products may already be updated. Click "Complete Stock Adjustment" again to finish — products already updated are never applied twice.`);
    }
    throw new StockAdjustmentError('completion-failed',
      `Stock adjustment failed: ${original}. All inventory changes were rolled back — no stock was changed. Fix the problem and complete again.`);
  }
}

async function applyChunk(store: AdjustmentStore, sessionId: string, lockId: string, lines: StockAdjustmentLine[]): Promise<void> {
  const sessionPath = paths.session(sessionId);
  await store.runTransaction(async (tx) => {
    // All reads first (Firestore requires reads before writes in a transaction).
    const session = await tx.get(sessionPath);
    assertLock(session, lockId);
    const liveLines = await Promise.all(lines.map((l) => tx.get(paths.line(sessionId, l.id))));
    const invDocs = await Promise.all(lines.map((l) => tx.get(paths.inventory(l.id))));

    let applied = 0, changed = 0, increase = 0, decrease = 0;
    lines.forEach((line, i) => {
      const live = liveLines[i];
      if (!live || live['applied']) return;
      const counted = Math.max(0, Number(live['scannedQty']) || 0);
      if (counted === 0 && !live['zeroConfirmed']) return; // un-scanned again on another device since loading
      const inv = invDocs[i];
      if (!inv) {
        throw new StockAdjustmentError('item-missing',
          `Inventory item ${live['barcode']} (${live['styleNo']} · ${live['color']} · ${live['size']}) no longer exists`);
      }
      const previousStock = Number(inv['currentStock']) || 0;
      const variance = counted - previousStock;
      if (variance !== 0) {
        tx.update(paths.inventory(line.id), { currentStock: counted, updatedAt: store.serverTime() });
      }
      tx.update(paths.line(sessionId, line.id), {
        applied: true, previousStock, countedQty: counted, variance,
        appliedAt: store.serverTime(), updatedAt: store.serverTime(),
      });
      applied++;
      if (variance !== 0) changed++;
      if (variance > 0) increase += variance;
      if (variance < 0) decrease -= variance;
    });

    tx.update(sessionPath, {
      'completionLock.lastProgressMs': store.nowMs(),
      'result.appliedLines': store.increment(applied),
      'result.changedLines': store.increment(changed),
      'result.increaseQty': store.increment(increase),
      'result.decreaseQty': store.increment(decrease),
      updatedAt: store.serverTime(),
    });
  });
}

/** Reverts every applied line of the session and returns it to 'Counting'. Each chunk is atomic and idempotent. */
async function rollbackSession(
  store: AdjustmentStore, sessionId: string, lockId: string, reason: string,
  retries: number, chunkSize: number, sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const sessionPath = paths.session(sessionId);
  const withRetry = async (fn: () => Promise<void>) => {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (err) {
        if (attempt >= retries || (err instanceof StockAdjustmentError && err.code === 'lock-lost')) throw err;
        await sleep(attempt * 500);
      }
    }
  };

  let applied: StockAdjustmentLine[] = [];
  await withRetry(async () => { applied = (await store.listLines(sessionId)).filter((l) => l.applied); });

  for (const part of chunk(applied, chunkSize)) {
    await withRetry(() => store.runTransaction(async (tx) => {
      const session = await tx.get(sessionPath);
      assertLock(session, lockId);
      const liveLines = await Promise.all(part.map((l) => tx.get(paths.line(sessionId, l.id))));
      const invDocs = await Promise.all(part.map((l) => tx.get(paths.inventory(l.id))));

      let reverted = 0, changed = 0, increase = 0, decrease = 0;
      part.forEach((line, i) => {
        const live = liveLines[i];
        if (!live?.['applied']) return;
        const variance = Number(live['variance']) || 0;
        // increment(-variance) restores the pre-adjustment stock while keeping any
        // movement (packing, GRN…) that happened after this line was applied.
        if (variance !== 0 && invDocs[i]) {
          tx.update(paths.inventory(line.id), { currentStock: store.increment(-variance), updatedAt: store.serverTime() });
        }
        tx.update(paths.line(sessionId, line.id), {
          applied: false,
          previousStock: store.deleteField(), countedQty: store.deleteField(),
          variance: store.deleteField(), appliedAt: store.deleteField(),
          updatedAt: store.serverTime(),
        });
        reverted++;
        if (variance !== 0) changed++;
        if (variance > 0) increase += variance;
        if (variance < 0) decrease -= variance;
      });
      tx.update(sessionPath, {
        'completionLock.lastProgressMs': store.nowMs(),
        'result.appliedLines': store.increment(-reverted),
        'result.changedLines': store.increment(-changed),
        'result.increaseQty': store.increment(-increase),
        'result.decreaseQty': store.increment(-decrease),
        updatedAt: store.serverTime(),
      });
    }));
  }

  await withRetry(() => store.runTransaction(async (tx) => {
    const session = await tx.get(sessionPath);
    assertLock(session, lockId);
    tx.update(sessionPath, {
      status: 'Counting',
      completionLock: store.deleteField(),
      lastError: reason,
      updatedAt: store.serverTime(),
    });
  }));
}

async function markLockFailed(store: AdjustmentStore, sessionId: string, lockId: string, reason: string): Promise<void> {
  await store.runTransaction(async (tx) => {
    const session = await tx.get(paths.session(sessionId));
    assertLock(session, lockId);
    tx.update(paths.session(sessionId), { 'completionLock.failed': true, lastError: reason, updatedAt: store.serverTime() });
  });
}
