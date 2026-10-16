// Unit tests for src/services/stock-adjustment.engine.ts.
// Run: npm run test:stock-adjustment   (Node ≥ 22.18 runs the .ts engine directly via type stripping)
//
// FakeStore mimics the Firestore transaction semantics the engine relies on:
//  - writes are buffered and committed atomically (all or nothing)
//  - optimistic concurrency: if a doc read by a transaction changed before commit,
//    the transaction function is re-run (Firestore retries up to 5 times)
//  - update() on a missing doc fails; dotted field paths, increment() and deleteField()
// plus hooks to inject commit failures and concurrent writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScanLedger, StockAdjustmentError, cancelSession, classifyScan, completeSession, indexByBarcode,
  paths, rowFor, startSession, summarize,
} from '../../src/services/stock-adjustment.engine.ts';

const INC = Symbol('inc');
const DEL = Symbol('del');

class FakeStore {
  constructor() {
    this.docs = new Map(); // path -> { data, v }
    this.seq = 0;
    this.clock = 1_000_000;
    this.txCount = 0;
    this.beforeCommit = null;   // (txNo, writes) => void | throws
    this.failListLines = false;
  }
  put(path, data) { this.docs.set(path, { data: structuredClone(data), v: (this.docs.get(path)?.v ?? 0) + 1 }); }
  read(path) { return this.docs.get(path)?.data ?? null; }
  newSessionId() { return `S${++this.seq}`; }
  serverTime() { return { ts: this.clock }; }
  increment(n) { return { [INC]: n }; }
  deleteField() { return { [DEL]: true }; }
  nowMs() { return this.clock; }

  async listLines(sessionId) {
    if (this.failListLines) throw new Error('network down');
    const prefix = `${paths.linesCollection(sessionId)}/`;
    return [...this.docs.entries()]
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, d]) => ({ id: p.slice(prefix.length), ...structuredClone(d.data) }));
  }

  async runTransaction(fn) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const txNo = ++this.txCount;
      const readVersions = new Map();
      const writes = [];
      const tx = {
        get: async (p) => {
          await Promise.resolve(); // yield, so concurrent transactions really interleave
          const d = this.docs.get(p);
          readVersions.set(p, d?.v ?? 0);
          return d ? structuredClone(d.data) : null;
        },
        set: (p, data) => writes.push(['set', p, data]),
        update: (p, data) => writes.push(['update', p, data]),
        delete: (p) => writes.push(['delete', p]),
      };
      const result = await fn(tx);
      this.beforeCommit?.(txNo, writes);
      const conflict = [...readVersions].some(([p, v]) => (this.docs.get(p)?.v ?? 0) !== v);
      if (conflict) continue; // contention → retry like Firestore
      this.commit(writes);
      return result;
    }
    throw new Error('Transaction failed: too much contention');
  }

  commit(writes) {
    const next = new Map(this.docs);
    for (const [op, p, data] of writes) {
      if (op === 'delete') { next.delete(p); continue; }
      const prev = next.get(p);
      if (op === 'update' && !prev) throw new Error(`NOT_FOUND: no document to update: ${p}`);
      const base = op === 'set' ? {} : structuredClone(prev.data);
      for (const [key, value] of Object.entries(data)) applyField(base, op === 'update' ? key.split('.') : [key], value);
      next.set(p, { data: base, v: (prev?.v ?? 0) + 1 });
    }
    this.docs = next;
  }
}

function applyField(target, pathParts, value) {
  let obj = target;
  for (const part of pathParts.slice(0, -1)) obj = obj[part] ??= {};
  const last = pathParts.at(-1);
  if (value && typeof value === 'object' && DEL in value) delete obj[last];
  else if (value && typeof value === 'object' && INC in value) obj[last] = (Number(obj[last]) || 0) + value[INC];
  else obj[last] = structuredClone(value);
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const inv = (id, barcode, group, currentStock) => ({
  id, barcode, group, currentStock, styleNo: `ST-${id}`, color: 'Blue', size: 'M', designId: 'd',
  fabricType: '', totalReceived: 0, WSP: 100, price: 200,
});

function seed(store, items) {
  for (const i of items) store.put(paths.inventory(i.id), i);
}
function groupItems(store, group) {
  return [...store.docs.entries()]
    .filter(([p, d]) => p.startsWith('inventory/') && d.data.group === group)
    .map(([p, d]) => ({ ...d.data, id: p.split('/')[1] }));
}
function scan(store, sessionId, item, qty, extra = {}) {
  const p = paths.line(sessionId, item.id);
  const prev = store.read(p);
  store.put(p, {
    barcode: item.barcode, styleNo: item.styleNo, color: item.color, size: item.size,
    startStock: item.currentStock, scannedQty: (prev?.scannedQty ?? 0) + qty, ...extra,
  });
}
const stock = (store, id) => store.read(paths.inventory(id)).currentStock;
const start = (store, group = 'SHIRTS') => startSession(store, { group, startedBy: 'ravi', totalProducts: 0, startStockTotal: 0 });

// ═════════════════════════════════════════════════════════════════════════════
test('classifyScan: valid, case-insensitive, other group, invalid, empty, duplicate barcode', () => {
  const all = [inv('a', 'ABC1', 'SHIRTS', 5), inv('b', '222', 'TROUSERS', 1), inv('c', 'DUP', 'SHIRTS', 1), inv('d', 'DUP', 'SHIRTS', 1)];
  const groupIdx = indexByBarcode(all.filter((i) => i.group === 'SHIRTS'));
  const allIdx = indexByBarcode(all);

  const ok = classifyScan('  abc1 ', 'SHIRTS', groupIdx, allIdx);
  assert.equal(ok.ok, true);
  assert.equal(ok.item.id, 'a');
  assert.equal(classifyScan('222', 'SHIRTS', groupIdx, allIdx).reason, 'other-group');
  assert.match(classifyScan('222', 'SHIRTS', groupIdx, allIdx).message, /belongs to "TROUSERS"/);
  assert.equal(classifyScan('999', 'SHIRTS', groupIdx, allIdx).reason, 'unknown');
  assert.equal(classifyScan('   ', 'SHIRTS', groupIdx, allIdx).reason, 'empty');
  assert.equal(classifyScan('dup', 'SHIRTS', groupIdx, allIdx).reason, 'ambiguous');
});

test('ScanLedger: repeated scans accumulate, cannot go below zero, failed flush is restored not lost', () => {
  const l = new ScanLedger();
  l.load([{ id: 'a', scannedQty: 2 }]);
  assert.equal(l.add('a', 1), 3);
  assert.equal(l.add('a', 1), 4);
  assert.equal(l.add('b', 1), 1);
  assert.equal(l.add('b', -2), null, 'cannot go below zero');
  assert.equal(l.add('b', 0), null);
  assert.equal(l.add('b', 1.5), null);

  const batch = l.takePending();
  assert.deepEqual([...batch], [['a', 2], ['b', 1]]);
  assert.equal(l.add('a', 1), 5, 'scans during an in-flight flush still count');
  l.restore(batch); // flush failed
  assert.equal(l.count('a'), 5);
  assert.equal(l.count('b'), 1);

  const retry = l.takePending();
  assert.deepEqual([...retry], [['a', 3], ['b', 1]]);
  assert.equal(l.count('a'), 5, 'in-flight deltas still count');
  l.commit(retry);
  assert.equal(l.unsavedCount, 0);
  assert.equal(l.count('a'), 5, 'no double counting after commit');
});

test('rowFor/summarize: pending vs no-stock, negative book stock is pending, zero-confirmed, variances', () => {
  const rows = [
    rowFor(inv('a', '1', 'G', 10), { scannedQty: 12 }),                 // +2
    rowFor(inv('b', '2', 'G', 5), { scannedQty: 3 }),                   // -2
    rowFor(inv('c', '3', 'G', 4), undefined),                           // pending
    rowFor(inv('d', '4', 'G', 0), undefined),                           // no stock
    rowFor(inv('e', '5', 'G', -1), undefined),                          // pending (negative)
    rowFor(inv('f', '6', 'G', 7), { scannedQty: 0, zeroConfirmed: true }), // -7
    rowFor(inv('g', '7', 'G', 0), { scannedQty: 2 }),                   // +2 found
  ];
  assert.deepEqual(rows.map((r) => r.status), ['scanned', 'scanned', 'pending', 'no-stock', 'pending', 'zero-confirmed', 'scanned']);
  const s = summarize(rows);
  assert.equal(s.pending, 2);
  assert.equal(s.scanned, 3);
  assert.equal(s.zeroConfirmed, 1);
  assert.equal(s.noStock, 1);
  assert.equal(s.increaseQty, 4);
  assert.equal(s.decreaseQty, 9);
  assert.equal(s.netVariance, -5);
  assert.equal(s.varianceProducts, 4);
});

test('startSession: numbering, one active session per group, other groups independent, cancel releases', async () => {
  const store = new FakeStore();
  const s1 = await start(store, 'SHIRTS');
  assert.equal(s1.adjustmentNo, 'SA-0001');
  assert.equal(store.read(paths.session(s1.id)).status, 'Counting');

  await assert.rejects(start(store, ' shirts '), (e) => e.code === 'session-active');
  const t1 = await start(store, 'TROUSERS');
  assert.equal(t1.adjustmentNo, 'SA-0002');

  await cancelSession(store, s1.id, 'ravi');
  assert.equal(store.read(paths.session(s1.id)).status, 'Cancelled');
  assert.equal(store.read(paths.lock('SHIRTS')), null);
  const s2 = await start(store, 'SHIRTS');
  assert.equal(s2.adjustmentNo, 'SA-0003');
  await assert.rejects(cancelSession(store, s1.id, 'ravi'), (e) => e.code === 'not-counting');
});

test('concurrent Start for the same group: exactly one wins', async () => {
  const store = new FakeStore();
  const results = await Promise.allSettled([start(store), start(store), start(store)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'session-active'));
});

test('complete: stock increases and decreases set inventory to the counted qty, with audit trail', async () => {
  const store = new FakeStore();
  seed(store, [inv('a', '1', 'SHIRTS', 10), inv('b', '2', 'SHIRTS', 5), inv('c', '3', 'SHIRTS', 0), inv('x', '9', 'TROUSERS', 4)]);
  const { id } = await start(store);
  scan(store, id, inv('a', '1', 'SHIRTS', 10), 12);
  scan(store, id, inv('b', '2', 'SHIRTS', 5), 3);

  const r = await completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS'), chunkSize: 1 });
  assert.equal(r.outcome, 'completed');
  assert.deepEqual(r.result, { appliedLines: 2, changedLines: 2, increaseQty: 2, decreaseQty: 2 });
  assert.equal(stock(store, 'a'), 12);
  assert.equal(stock(store, 'b'), 3);
  assert.equal(stock(store, 'c'), 0, 'no-stock product untouched');
  assert.equal(stock(store, 'x'), 4, 'other group untouched');

  const lineA = store.read(paths.line(id, 'a'));
  assert.equal(lineA.applied, true);
  assert.equal(lineA.previousStock, 10);
  assert.equal(lineA.countedQty, 12);
  assert.equal(lineA.variance, 2);
  const session = store.read(paths.session(id));
  assert.equal(session.status, 'Completed');
  assert.equal(session.completedBy, 'mgr');
  assert.equal(session.completionLock, undefined);
  assert.equal(store.read(paths.lock('SHIRTS')), null, 'group lock released');
});

test('complete: blocked while products with stock are unscanned; zero-confirm resolves it', async () => {
  const store = new FakeStore();
  seed(store, [inv('a', '1', 'SHIRTS', 10), inv('b', '2', 'SHIRTS', 5)]);
  const { id } = await start(store);
  scan(store, id, inv('a', '1', 'SHIRTS', 10), 10);

  await assert.rejects(
    completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS') }),
    (e) => e.code === 'pending-items' && /1 product/.test(e.message));
  assert.equal(stock(store, 'b'), 5, 'unscanned product NOT silently zeroed');
  assert.equal(store.read(paths.session(id)).status, 'Counting');

  store.put(paths.line(id, 'b'), { barcode: '2', styleNo: 'ST-b', color: 'Blue', size: 'M', startStock: 5, scannedQty: 0, zeroConfirmed: true });
  const r = await completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS') });
  assert.equal(r.outcome, 'completed');
  assert.equal(stock(store, 'b'), 0);
  assert.equal(stock(store, 'a'), 10);
  assert.deepEqual(r.result, { appliedLines: 2, changedLines: 1, increaseQty: 0, decreaseQty: 5 });
});

test('duplicate completion: sequential and concurrent attempts apply the adjustment exactly once', async () => {
  const store = new FakeStore();
  seed(store, [inv('a', '1', 'SHIRTS', 10), inv('b', '2', 'SHIRTS', 5)]);
  const { id } = await start(store);
  scan(store, id, inv('a', '1', 'SHIRTS', 10), 4);
  scan(store, id, inv('b', '2', 'SHIRTS', 5), 9);
  const opts = { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS'), chunkSize: 1 };

  const outcomes = await Promise.all([completeSession(store, opts), completeSession(store, opts), completeSession(store, opts)]);
  assert.equal(outcomes.filter((o) => o.outcome === 'completed').length, 1);
  assert.ok(outcomes.every((o) => ['completed', 'in-progress', 'already-completed'].includes(o.outcome)));

  // a pack happens afterwards, then someone clicks Complete again
  store.put(paths.inventory('a'), { ...store.read(paths.inventory('a')), currentStock: 3 });
  const again = await completeSession(store, opts);
  assert.equal(again.outcome, 'already-completed');
  assert.equal(stock(store, 'a'), 3, 'second click did not re-apply the count');
  assert.equal(stock(store, 'b'), 9);
  assert.deepEqual(store.read(paths.session(id)).result, { appliedLines: 2, changedLines: 2, increaseQty: 4, decreaseQty: 6 });
});

test('transaction failure mid-way: everything rolled back (keeping concurrent movement), retry succeeds', async () => {
  const store = new FakeStore();
  const items = ['a', 'b', 'c', 'd', 'e'].map((k, i) => inv(k, String(i), 'SHIRTS', 10));
  seed(store, items);
  const { id } = await start(store);
  items.forEach((it, i) => scan(store, id, it, 20 + i)); // all increases

  let applyChunks = 0;
  store.beforeCommit = (_txNo, writes) => {
    const isApply = writes.some(([op, p, d]) => op === 'update' && p.includes('/lines/') && d.applied === true);
    if (!isApply) return;
    applyChunks++;
    if (applyChunks === 2) {
      // packing deducts 1 unit of 'a' (already adjusted) while completion is running
      store.put(paths.inventory('a'), { ...store.read(paths.inventory('a')), currentStock: store.read(paths.inventory('a')).currentStock - 1 });
    }
    if (applyChunks === 3) throw new Error('DEADLINE_EXCEEDED');
  };

  await assert.rejects(
    completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS'), chunkSize: 2, sleep: async () => {} }),
    (e) => e.code === 'completion-failed' && /DEADLINE_EXCEEDED/.test(e.message) && /rolled back/.test(e.message));

  assert.equal(stock(store, 'a'), 9, 'a: back to 10 minus the 1 unit packed meanwhile');
  for (const k of ['b', 'c', 'd', 'e']) assert.equal(stock(store, k), 10, `${k} restored`);
  const session = store.read(paths.session(id));
  assert.equal(session.status, 'Counting');
  assert.match(session.lastError, /DEADLINE_EXCEEDED/);
  assert.deepEqual(session.result, { appliedLines: 0, changedLines: 0, increaseQty: 0, decreaseQty: 0 });
  assert.ok((await store.listLines(id)).every((l) => !l.applied && l.variance === undefined));

  store.beforeCommit = null;
  const r = await completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS'), chunkSize: 2 });
  assert.equal(r.outcome, 'completed');
  assert.deepEqual(items.map((it) => stock(store, it.id)), [20, 21, 22, 23, 24]);
  assert.equal(store.read(paths.line(id, 'a')).previousStock, 9);
});

test('rollback cannot reach server: session flagged, completing again resumes without double-applying', async () => {
  const store = new FakeStore();
  const items = ['a', 'b', 'c', 'd'].map((k, i) => inv(k, String(i), 'SHIRTS', 10));
  seed(store, items);
  const { id } = await start(store);
  items.forEach((it) => scan(store, id, it, 3)); // all decreases

  let offline = false;
  store.beforeCommit = (_txNo, writes) => {
    if (offline) throw new Error('UNAVAILABLE');
    if (writes.some(([, p, d]) => p === paths.line(id, 'c') && d.applied === true)) { offline = true; throw new Error('UNAVAILABLE'); }
  };
  await assert.rejects(
    completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS'), chunkSize: 2, sleep: async () => {} }),
    (e) => e.code === 'rollback-failed');
  assert.equal(stock(store, 'a'), 3, 'first chunk stayed applied (could not be reverted)');
  assert.equal(stock(store, 'c'), 10);
  const stuck = store.read(paths.session(id));
  assert.equal(stuck.status, 'Completing');

  // markLockFailed also could not reach the server → lock is only stale after 2 minutes
  offline = false;
  store.beforeCommit = null;
  const early = await completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS') });
  assert.equal(early.outcome, 'in-progress', 'a fresh lock is not taken over');

  store.clock += 3 * 60 * 1000;
  const r = await completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS') });
  assert.equal(r.outcome, 'completed');
  assert.deepEqual(items.map((it) => stock(store, it.id)), [3, 3, 3, 3]);
  assert.deepEqual(r.result, { appliedLines: 4, changedLines: 4, increaseQty: 0, decreaseQty: 28 });
  assert.equal(store.read(paths.line(id, 'a')).previousStock, 10, 'a was not re-applied against its new stock');
});

test('missing inventory item: meaningful error and no partial update', async () => {
  const store = new FakeStore();
  seed(store, [inv('a', '1', 'SHIRTS', 10), inv('b', '2', 'SHIRTS', 5)]);
  const { id } = await start(store);
  scan(store, id, inv('a', '1', 'SHIRTS', 10), 11);
  scan(store, id, inv('b', '2', 'SHIRTS', 5), 6);
  const items = groupItems(store, 'SHIRTS');
  store.docs.delete(paths.inventory('b'));

  await assert.rejects(
    completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: items, chunkSize: 1, sleep: async () => {} }),
    (e) => e.code === 'completion-failed' && /2 \(ST-b · Blue · M\) no longer exists/.test(e.message));
  assert.equal(stock(store, 'a'), 10);
  assert.equal(store.read(paths.session(id)).status, 'Counting');
});

test('variance is computed against live stock at completion, and concurrent writes cause a retry not a stale overwrite', async () => {
  const store = new FakeStore();
  seed(store, [inv('a', '1', 'SHIRTS', 10)]);
  const { id } = await start(store);
  scan(store, id, inv('a', '1', 'SHIRTS', 10), 8);
  store.put(paths.inventory('a'), { ...store.read(paths.inventory('a')), currentStock: 7 }); // packed after counting began

  let injected = false;
  store.beforeCommit = (_n, writes) => {
    if (!injected && writes.some(([, p, d]) => p === paths.line(id, 'a') && d.applied)) {
      injected = true;
      store.put(paths.inventory('a'), { ...store.read(paths.inventory('a')), currentStock: 6 }); // races the transaction
    }
  };
  await completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS') });
  assert.equal(stock(store, 'a'), 8, 'inventory matches the physical count');
  assert.equal(store.read(paths.line(id, 'a')).previousStock, 6, 'retried transaction recorded the true previous stock');
  assert.equal(store.read(paths.line(id, 'a')).variance, 2);
});

test('cancelled session cannot be completed', async () => {
  const store = new FakeStore();
  seed(store, [inv('a', '1', 'SHIRTS', 1)]);
  const { id } = await start(store);
  scan(store, id, inv('a', '1', 'SHIRTS', 1), 1);
  await cancelSession(store, id, 'ravi');
  await assert.rejects(
    completeSession(store, { sessionId: id, completedBy: 'mgr', groupItems: groupItems(store, 'SHIRTS') }),
    (e) => e instanceof StockAdjustmentError && e.code === 'cancelled');
});
