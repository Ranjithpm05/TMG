// Unit tests for src/services/sales-return.engine.ts.
// Run: npm run test:sales-return   (Node ≥ 22.18 runs the .ts engine directly via type stripping)
//
// FakeStore mimics the Firestore transaction semantics the engine relies on —
// buffered all-or-nothing commits, optimistic-concurrency retries, update() on a
// missing doc fails, increment() — same as stock-adjustment.engine.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SalesReturnError, billLineKey, billedLines, buildBillRows, cancelReturn, makeLine, paths, postReturn,
  rowRef, saveDraft, summarizeLines, validateDraft,
} from '../../src/services/sales-return.engine.ts';

const INC = Symbol('inc');

class FakeStore {
  constructor() {
    this.docs = new Map(); // path -> { data, v }
    this.clock = 1_000_000;
    this.beforeCommit = null;
  }
  put(path, data) { this.docs.set(path, { data: structuredClone(data), v: (this.docs.get(path)?.v ?? 0) + 1 }); }
  read(path) { return this.docs.get(path)?.data ?? null; }
  serverTime() { return { ts: this.clock }; }
  increment(n) { return { [INC]: n }; }

  async runTransaction(fn) {
    for (let attempt = 1; attempt <= 5; attempt++) {
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
      };
      const result = await fn(tx);
      this.beforeCommit?.(writes);
      const conflict = [...readVersions].some(([p, v]) => (this.docs.get(p)?.v ?? 0) !== v);
      if (conflict) continue;
      this.commit(writes);
      return result;
    }
    throw new Error('Transaction failed: too much contention');
  }

  commit(writes) {
    const next = new Map(this.docs);
    for (const [op, p, data] of writes) {
      const prev = next.get(p);
      if (op === 'update' && !prev) throw new Error(`NOT_FOUND: no document to update: ${p}`);
      const base = op === 'set' ? {} : structuredClone(prev.data);
      for (const [key, value] of Object.entries(data)) {
        base[key] = value && typeof value === 'object' && INC in value ? (Number(base[key]) || 0) + value[INC] : structuredClone(value);
      }
      next.set(p, { data: base, v: (prev?.v ?? 0) + 1 });
    }
    this.docs = next;
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────
// DC-1: shirt (2 sizes, MRP 800 / 850), trouser. Invoice INV-A bills DC-1 in full.
// DC-2 delivered in parts: INV-B bills a partial delivery of it.
const dc1 = {
  items: [
    { partName: 'Shirt', styleNo: 'S1', color: 'Blue', sizeQty: { M: 10, L: 5 }, total: 15, mrp: 800, mrpBySize: { M: 800, L: 850 }, price: 640 },
    { partName: 'Trouser', styleNo: 'T1', color: 'Black', sleeveType: '', sizeQty: { '32': 4 }, total: 4, mrp: 1000, price: 800 },
  ],
};
const dc2 = { items: [{ partName: 'Shirt', styleNo: 'S1', color: 'Blue', sizeQty: { M: 20 }, total: 20, mrp: 800, price: 640 }] };
const invA = {
  id: 'A', invoiceNo: 'INV-A', clientId: 'C1', clientName: 'Acme', dcId: 'DC1', dcIds: ['DC1'],
  discountPct: 10, cgstRate: 2.5, sgstRate: 2.5, igstRate: 0,
  items: [{ styleNo: 'S1', mrp: 800, price: 600 }, { styleNo: 'S1', mrp: 850, price: 640 }, { styleNo: 'T1', mrp: 1000, price: 800 }],
};
const invB = {
  id: 'B', invoiceNo: 'INV-B', clientId: 'C1', clientName: 'Acme', dcId: 'DC2', dcIds: ['DC2'],
  discountPct: 0, cgstRate: 0, sgstRate: 0, igstRate: 5,
  deliveryItems: [{ ...dc2.items[0], itemIndex: 0, sizeQty: { M: 6 }, total: 6 }],
  items: [{ styleNo: 'S1', mrp: 800, price: 640 }],
};
const invOther = { ...invB, id: 'X', invoiceNo: 'INV-X', clientId: 'C2', clientName: 'Other' };

const INVENTORY = { 'S1|BLUE||M': 'invS1M', 'S1|BLUE||L': 'invS1L', 'T1|BLACK||32': 'invT1' };
const resolve = (styleNo, color, sleeve, size) => {
  const id = INVENTORY[`${styleNo}|${color}|${sleeve ?? ''}|${size}`.toUpperCase()];
  return id ? { id, barcode: `BC-${id}` } : null;
};

function seed() {
  const s = new FakeStore();
  s.put(paths.invoice('A'), invA);
  s.put(paths.invoice('B'), invB);
  s.put(paths.invoice('X'), invOther);
  s.put(paths.dc('DC1'), dc1);
  s.put(paths.dc('DC2'), dc2);
  for (const id of Object.values(INVENTORY)) s.put(paths.inventory(id), { currentStock: 2 });
  return s;
}

const dcs = new Map([['DC1', dc1], ['DC2', dc2]]);
const rowsOf = (invoice, returned) => buildBillRows(invoice, dcs, returned, resolve).rows;
const row = (rows, styleNo, size) => rows.find((r) => r.styleNo === styleNo && r.size === size);

function input(lines, mode = 'multiple') {
  return { mode, returnDate: '2026-10-24', clientId: 'C1', clientName: 'Acme', lines };
}
const stock = (s, id) => s.read(paths.inventory(id)).currentStock;
const damage = (s, id) => s.read(paths.damage(id))?.qty ?? 0;
const returned = (s, invId) => s.read(paths.ledger(invId))?.returned ?? {};

async function draft(s, id, lines, mode) {
  return saveDraft(s, { id, input: input(lines, mode), user: 'ravi', fyCode: '2627' });
}

// ═════════════════════════════════════════════════════════════════════════════
test('billedLines: full invoice reads its DC per size; partial invoice uses only deliveryItems', () => {
  const full = billedLines(invA, dcs);
  assert.deepEqual(full.lines.map((l) => [l.lineKey, l.qty]), [
    [billLineKey('DC1', 0, 'M'), 10], [billLineKey('DC1', 0, 'L'), 5], [billLineKey('DC1', 1, '32'), 4],
  ]);
  const partial = billedLines(invB, new Map()); // needs no DC doc at all
  assert.deepEqual(partial.lines.map((l) => [l.lineKey, l.qty]), [[billLineKey('DC2', 0, 'M'), 6]]);
  assert.deepEqual(billedLines(invA, new Map()).missingDcIds, ['DC1']);
});

test('buildBillRows: billed price per MRP, previously returned and eligible qty, inventory match', () => {
  const rows = rowsOf(invA, { [billLineKey('DC1', 0, 'M')]: 3 });
  const m = row(rows, 'S1', 'M');
  assert.equal(m.price, 600);
  assert.equal(row(rows, 'S1', 'L').price, 640);
  assert.equal(row(rows, 'S1', 'L').mrp, 850);
  assert.deepEqual([m.soldQty, m.returnedQty, m.eligibleQty], [10, 3, 7]);
  assert.equal(m.inventoryId, 'invS1M');
  assert.equal(m.barcode, 'BC-invS1M');
});

test('makeLine values the return at the invoice discount and GST rates', () => {
  const line = makeLine(row(rowsOf(invA), 'S1', 'M'), invA, 'Fresh', 2, ' Rack A ');
  assert.equal(line.taxableValue, 1080);  // 2 × 600 − 10%
  assert.equal(line.taxAmount, 54);       // 5% GST
  assert.equal(line.totalAmount, 1134);
  assert.equal(line.location, 'Rack A');
  const t = summarizeLines([line, makeLine(row(rowsOf(invA), 'T1', '32'), invA, 'Damage', 1, '')]);
  assert.deepEqual([t.qty, t.freshQty, t.damageQty], [3, 2, 1]);
});

test('validateDraft: excess qty (fresh+damage combined), bad qty, duplicates, single-bill mode, unmatched inventory', () => {
  const rows = rowsOf(invA, { [billLineKey('DC1', 0, 'M')]: 8 });
  const byRef = new Map(rows.map((r) => [rowRef(r.invoiceId, r.lineKey), r]));
  const m = row(rows, 'S1', 'M');
  const ok = validateDraft(input([makeLine(m, invA, 'Fresh', 1, ''), makeLine(m, invA, 'Damage', 1, '')]), byRef);
  assert.deepEqual(ok, []);
  const over = validateDraft(input([makeLine(m, invA, 'Fresh', 2, ''), makeLine(m, invA, 'Damage', 1, '')]), byRef);
  assert.match(over.join(), /returning 3, but only 2 of 10 sold can still be returned \(8 already returned\)/);
  assert.match(validateDraft(input([{ ...makeLine(m, invA, 'Fresh', 1, ''), qty: 1.5 }])).join(), /whole number/);
  assert.match(validateDraft(input([makeLine(m, invA, 'Fresh', 1, ''), makeLine(m, invA, 'Fresh', 1, '')])).join(), /entered twice/);
  const b = rowsOf(invB)[0];
  assert.match(validateDraft(input([makeLine(m, invA, 'Fresh', 1, ''), makeLine(b, invB, 'Fresh', 1, '')], 'single')).join(), /Single Bill Return/);
  assert.match(validateDraft(input([{ ...makeLine(m, invA, 'Fresh', 1, ''), inventoryId: '' }])).join(), /no inventory record/);
  assert.match(validateDraft(input([])).join(), /at least one item/);
});

test('saveDraft numbers once, is idempotent per id, updates only while Draft, never moves stock', async () => {
  const s = seed();
  const m = row(rowsOf(invA), 'S1', 'M');
  const first = await draft(s, 'R1', [makeLine(m, invA, 'Fresh', 1, '')]);
  assert.deepEqual(first, { id: 'R1', returnNo: 'SR2627-0001', created: true });
  const again = await draft(s, 'R1', [makeLine(m, invA, 'Fresh', 2, '')]); // double click / edit
  assert.deepEqual(again, { id: 'R1', returnNo: 'SR2627-0001', created: false });
  assert.equal(s.read(paths.salesReturn('R1')).totals.qty, 2);
  assert.equal((await draft(s, 'R2', [makeLine(m, invA, 'Fresh', 1, '')])).returnNo, 'SR2627-0002');
  assert.equal(stock(s, 'invS1M'), 2);
  assert.equal(s.read(paths.ledger('A')), null);

  await postReturn(s, 'R1', 'ravi');
  await assert.rejects(draft(s, 'R1', [makeLine(m, invA, 'Fresh', 1, '')]), (e) => e.code === 'not-draft');
});

test('post (multiple bills): Fresh to inventory, Damage to damage stock, ledger per invoice — exactly once', async () => {
  const s = seed();
  const a = rowsOf(invA);
  const b = rowsOf(invB)[0];
  await draft(s, 'R1', [
    makeLine(row(a, 'S1', 'M'), invA, 'Fresh', 3, 'Rack A'),
    makeLine(row(a, 'S1', 'M'), invA, 'Damage', 2, 'Rack A'),
    makeLine(row(a, 'T1', '32'), invA, 'Damage', 1, ''),
    makeLine(b, invB, 'Fresh', 4, 'Rack B'),
  ]);
  assert.equal(await postReturn(s, 'R1', 'ravi'), 'posted');
  assert.equal(stock(s, 'invS1M'), 2 + 3 + 4);
  assert.equal(stock(s, 'invT1'), 2);                  // damage never enters sellable stock
  assert.equal(damage(s, 'invS1M'), 2);
  assert.equal(damage(s, 'invT1'), 1);
  assert.deepEqual(s.read(paths.damage('invT1')).byLocation, { UNSPECIFIED: 1 });
  assert.deepEqual(returned(s, 'A'), { [billLineKey('DC1', 0, 'M')]: 5, [billLineKey('DC1', 1, '32')]: 1 });
  assert.deepEqual(returned(s, 'B'), { [billLineKey('DC2', 0, 'M')]: 4 });
  assert.deepEqual(s.read(paths.ledger('A')).returnIds, ['R1']);
  const ret = s.read(paths.salesReturn('R1'));
  assert.equal(ret.status, 'Posted');
  assert.equal(ret.stockApplied, true);

  assert.equal(await postReturn(s, 'R1', 'ravi'), 'already-posted'); // retry / double click
  assert.equal(stock(s, 'invS1M'), 9);
  assert.equal(damage(s, 'invS1M'), 2);
});

test('partial and repeated returns against one bill stop at the billed qty (server-side check)', async () => {
  const s = seed();
  const b = rowsOf(invB)[0]; // 6 sold
  await draft(s, 'R1', [makeLine(b, invB, 'Fresh', 4, '')]);
  await draft(s, 'R2', [makeLine(b, invB, 'Fresh', 2, '')]);
  await draft(s, 'R3', [makeLine(b, invB, 'Damage', 1, '')]);
  await postReturn(s, 'R1', 'u');
  await postReturn(s, 'R2', 'u');
  await assert.rejects(postReturn(s, 'R3', 'u'), (e) => e instanceof SalesReturnError && e.code === 'validation-failed' &&
    /only 0 of 6 sold can still be returned \(6 already returned\)/.test(e.message));
  assert.equal(stock(s, 'invS1M'), 8);
  assert.equal(damage(s, 'invS1M'), 0);
  assert.equal(s.read(paths.salesReturn('R3')).status, 'Draft');
});

test('two returns posted concurrently against the same bill cannot exceed it', async () => {
  const s = seed();
  const b = rowsOf(invB)[0]; // 6 sold
  await draft(s, 'R1', [makeLine(b, invB, 'Fresh', 4, '')]);
  await draft(s, 'R2', [makeLine(b, invB, 'Fresh', 4, '')]);
  const results = await Promise.allSettled([postReturn(s, 'R1', 'u'), postReturn(s, 'R2', 'u')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(returned(s, 'B')[billLineKey('DC2', 0, 'M')], 4);
  assert.equal(stock(s, 'invS1M'), 6);
});

test('post is refused for a cancelled invoice, another customer\'s invoice, or a missing inventory record — nothing written', async () => {
  const s = seed();
  const b = rowsOf(invB)[0];
  s.put(paths.invoice('B'), { ...invB, eInvoiceStatus: 'cancelled' });
  await draft(s, 'R1', [makeLine(b, invB, 'Fresh', 1, '')]);
  await assert.rejects(postReturn(s, 'R1', 'u'), /is cancelled/);

  const x = rowsOf(invOther)[0];
  await draft(s, 'R2', [makeLine(x, invOther, 'Fresh', 1, '')]);
  await assert.rejects(postReturn(s, 'R2', 'u'), /belongs to Other, not Acme/);

  const a = row(rowsOf(invA), 'S1', 'L');
  s.docs.delete(paths.inventory('invS1L'));
  await draft(s, 'R3', [makeLine(a, invA, 'Fresh', 1, '')]);
  await assert.rejects(postReturn(s, 'R3', 'u'), /no longer exists/);
  assert.equal(s.read(paths.ledger('A')), null);
  assert.equal(stock(s, 'invS1M'), 2);
});

test('a failed commit leaves no partial stock or ledger update', async () => {
  const s = seed();
  const a = rowsOf(invA);
  await draft(s, 'R1', [makeLine(row(a, 'S1', 'M'), invA, 'Fresh', 1, ''), makeLine(row(a, 'S1', 'L'), invA, 'Damage', 1, '')]);
  s.beforeCommit = () => { throw new Error('network down'); };
  await assert.rejects(postReturn(s, 'R1', 'u'), /network down/);
  s.beforeCommit = null;
  assert.equal(stock(s, 'invS1M'), 2);
  assert.equal(damage(s, 'invS1L'), 0);
  assert.equal(s.read(paths.ledger('A')), null);
  assert.equal(s.read(paths.salesReturn('R1')).status, 'Draft');
  assert.equal(await postReturn(s, 'R1', 'u'), 'posted'); // and can simply be posted again
  assert.equal(stock(s, 'invS1M'), 3);
});

test('cancel: Draft closes without stock; Posted reverses stock + ledger exactly once and frees the qty', async () => {
  const s = seed();
  const a = rowsOf(invA);
  const m = row(a, 'S1', 'M');
  await draft(s, 'D', [makeLine(m, invA, 'Fresh', 1, '')]);
  assert.equal(await cancelReturn(s, 'D', 'u', ''), 'cancelled');
  assert.equal(stock(s, 'invS1M'), 2);

  await draft(s, 'R1', [makeLine(m, invA, 'Fresh', 3, 'A'), makeLine(m, invA, 'Damage', 2, 'A')]);
  await postReturn(s, 'R1', 'u');
  await assert.rejects(cancelReturn(s, 'R1', 'u', ' '), (e) => e.code === 'reason-required');
  assert.equal(await cancelReturn(s, 'R1', 'u', 'Entered wrongly'), 'cancelled');
  assert.equal(stock(s, 'invS1M'), 2);
  assert.equal(damage(s, 'invS1M'), 0);
  assert.deepEqual(s.read(paths.damage('invS1M')).byLocation, {});
  assert.deepEqual(returned(s, 'A'), {});
  assert.deepEqual(s.read(paths.ledger('A')).returnIds, []);
  const ret = s.read(paths.salesReturn('R1'));
  assert.equal(ret.status, 'Cancelled');
  assert.equal(ret.stockApplied, false);
  assert.equal(ret.cancelReason, 'Entered wrongly');

  assert.equal(await cancelReturn(s, 'R1', 'u', 'again'), 'already-cancelled');
  assert.equal(stock(s, 'invS1M'), 2);
  await assert.rejects(postReturn(s, 'R1', 'u'), (e) => e.code === 'not-draft');

  // The full 10 can be returned again after the cancel.
  await draft(s, 'R2', [makeLine(m, invA, 'Fresh', 10, '')]);
  assert.equal(await postReturn(s, 'R2', 'u'), 'posted');
});

test('cancel of a Posted return is refused once its Fresh pieces left stock again', async () => {
  const s = seed();
  const m = row(rowsOf(invA), 'S1', 'M');
  await draft(s, 'R1', [makeLine(m, invA, 'Fresh', 3, '')]);
  await postReturn(s, 'R1', 'u');
  s.put(paths.inventory('invS1M'), { currentStock: 1 }); // re-picked and packed meanwhile
  await assert.rejects(cancelReturn(s, 'R1', 'u', 'oops'), (e) => e.code === 'stock-consumed' && /only 1 left in stock/.test(e.message));
  assert.equal(s.read(paths.salesReturn('R1')).status, 'Posted');
  assert.equal(returned(s, 'A')[billLineKey('DC1', 0, 'M')], 3);
});
