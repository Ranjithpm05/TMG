// Unit tests for src/services/bulk-flow.engine.ts — Bulk Picking/Packing
// validation and the DC Flat Rate / Discount → Invoice pricing rules.
// Run: npm run test:bulk-flow   (Node ≥ 22.18 runs the .ts engine directly via type stripping)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BulkFlowError, assertBulkPickAllowed, assertBulkUnpickAllowed, bulkPickListStatus, bulkPickStage,
  dcDiscountSummary, dcHasPricingOverride, dcPricingFields, dcUnitPrice, invoiceUnitPrice,
  isBulkPackingComplete, parseBulkQty, parseDcPricingInput, resolveInvoiceDiscountPct, validateBulkPackEntries,
} from '../../src/services/bulk-flow.engine.ts';

const code = (fn) => {
  try { fn(); } catch (err) { assert.ok(err instanceof BulkFlowError, `expected BulkFlowError, got ${err}`); return err.code; }
  assert.fail('expected a BulkFlowError');
};

const openBulk = { type: 'bulk', finalizedAt: undefined };

// ─── Bulk Picking ────────────────────────────────────────────────────────────

test('parseBulkQty: accepts positive whole numbers only', () => {
  assert.equal(parseBulkQty('5'), 5);
  assert.equal(parseBulkQty(1), 1);
  for (const bad of ['', '0', '-2', '1.5', 'abc', '10000', null, undefined]) {
    assert.equal(code(() => parseBulkQty(bad)), 'qty_invalid', `input ${bad}`);
  }
});

test('Scan All Items: allowed even when stock is zero or negative', () => {
  assert.doesNotThrow(() => assertBulkPickAllowed({ pickList: openBulk, qty: 1, currentStock: 1 }));
  assert.doesNotThrow(() => assertBulkPickAllowed({ pickList: openBulk, qty: 1, currentStock: 0 }));
  assert.doesNotThrow(() => assertBulkPickAllowed({ pickList: openBulk, qty: 1, currentStock: -3 }));
});

test('Scan + Quantity: entered qty may exceed live stock', () => {
  assert.doesNotThrow(() => assertBulkPickAllowed({ pickList: openBulk, qty: 12, currentStock: 12 }));
  assert.doesNotThrow(() => assertBulkPickAllowed({ pickList: openBulk, qty: 150, currentStock: 149 }));
});

test('Bulk picking rejects: no inventory record, completed list, non-bulk list', () => {
  assert.equal(code(() => assertBulkPickAllowed({ pickList: openBulk, qty: 1, currentStock: null })), 'no_stock_record');
  assert.equal(code(() => assertBulkPickAllowed({ pickList: { type: 'bulk', finalizedAt: 123 }, qty: 1, currentStock: 50 })), 'bulk_completed');
  assert.equal(code(() => assertBulkPickAllowed({ pickList: { type: 'party' }, qty: 1, currentStock: 50 })), 'not_bulk');
});

test('Removing picked units: never below what is already packed, never after completion', () => {
  assert.doesNotThrow(() => assertBulkUnpickAllowed({ pickList: openBulk, pickedQty: 5, packedIntoPackingListsQty: 0, qty: 5 }));
  assert.equal(code(() => assertBulkUnpickAllowed({ pickList: openBulk, pickedQty: 5, packedIntoPackingListsQty: 0, qty: 6 })), 'qty_invalid');
  assert.equal(code(() => assertBulkUnpickAllowed({ pickList: openBulk, pickedQty: 5, packedIntoPackingListsQty: 3, qty: 3 })), 'already_packed');
  assert.equal(code(() => assertBulkUnpickAllowed({ pickList: { finalizedAt: 1 }, pickedQty: 5, packedIntoPackingListsQty: 0, qty: 1 })), 'bulk_completed');
});

test('Bulk pick list status/stage lifecycle', () => {
  assert.equal(bulkPickListStatus(false, 0, 0), 'Draft');
  assert.equal(bulkPickListStatus(false, 10, 0), 'Partial');      // picking — not eligible for packing (no finalizedAt)
  assert.equal(bulkPickListStatus(true, 10, 0), 'Partial');       // completed picking → Ready to Pack
  assert.equal(bulkPickListStatus(true, 10, 6), 'Partial');
  assert.equal(bulkPickListStatus(true, 10, 10), 'Completed');    // fully packed
  assert.equal(bulkPickStage({ totalPickedQty: 10 }), 'picking');
  assert.equal(bulkPickStage({ finalizedAt: 1, totalPickedQty: 10, totalPackedIntoPackingListsQty: 0 }), 'ready_to_pack');
  assert.equal(bulkPickStage({ finalizedAt: 1, totalPickedQty: 10, totalPackedIntoPackingListsQty: 4 }), 'packing');
  assert.equal(bulkPickStage({ finalizedAt: 1, totalPickedQty: 10, totalPackedIntoPackingListsQty: 10 }), 'packed');
});

// ─── Bulk Packing ────────────────────────────────────────────────────────────

const packLines = [
  { lineId: 'a', requiredQty: 10, packedQty: 4 },
  { lineId: 'b', requiredQty: 3, packedQty: 0 },
];

test('Bulk packing: merges entries, drops zeros', () => {
  assert.deepEqual(
    validateBulkPackEntries(packLines, [{ lineId: 'a', qty: 2 }, { lineId: 'b', qty: 0 }, { lineId: 'a', qty: 4 }]),
    [{ lineId: 'a', qty: 6 }],
  );
});

test('Bulk packing: prevents over-packing past picked qty (incl. via duplicate rows)', () => {
  assert.equal(code(() => validateBulkPackEntries(packLines, [{ lineId: 'a', qty: 7 }])), 'qty_exceeds_remaining');
  assert.equal(code(() => validateBulkPackEntries(packLines, [{ lineId: 'b', qty: 2 }, { lineId: 'b', qty: 2 }])), 'qty_exceeds_remaining');
});

test('Bulk packing: rejects empty, fractional, negative, unknown lines', () => {
  assert.equal(code(() => validateBulkPackEntries(packLines, [])), 'nothing_to_pack');
  assert.equal(code(() => validateBulkPackEntries(packLines, [{ lineId: 'a', qty: 0 }])), 'nothing_to_pack');
  assert.equal(code(() => validateBulkPackEntries(packLines, [{ lineId: 'a', qty: 1.5 }])), 'qty_invalid');
  assert.equal(code(() => validateBulkPackEntries(packLines, [{ lineId: 'a', qty: -1 }])), 'qty_invalid');
  assert.equal(code(() => validateBulkPackEntries(packLines, [{ lineId: 'zzz', qty: 1 }])), 'line_not_found');
});

test('Bulk packing complete only when every picked piece is packed', () => {
  assert.equal(isBulkPackingComplete(packLines), false);
  assert.equal(isBulkPackingComplete([{ lineId: 'a', requiredQty: 10, packedQty: 10 }, { lineId: 'b', requiredQty: 3, packedQty: 3 }]), true);
  assert.equal(isBulkPackingComplete([]), false);
});

// ─── DC Flat Rate / Discount ─────────────────────────────────────────────────

test('DC pricing input: both empty = no override', () => {
  assert.deepEqual(parseDcPricingInput('', ''), {});
  assert.deepEqual(parseDcPricingInput('  ', '0'), {}); // Discount 0 behaves as empty
  assert.equal(dcHasPricingOverride({}), false);
});

test('DC pricing input: validation', () => {
  assert.deepEqual(parseDcPricingInput('250', ''), { flatRate: 250 });
  assert.deepEqual(parseDcPricingInput('', '7.5'), { discountPct: 7.5 });
  assert.deepEqual(parseDcPricingInput('199.999', '10'), { flatRate: 200, discountPct: 10 });
  for (const bad of ['0', '-5', 'abc', '2000000']) assert.equal(code(() => parseDcPricingInput(bad, '')), 'flat_rate_invalid', bad);
  for (const bad of ['-1', '100', '150', 'x']) assert.equal(code(() => parseDcPricingInput('', bad)), 'discount_invalid', bad);
});

test('DC with Flat Rate: every item uses the flat rate', () => {
  const pricing = parseDcPricingInput('300', '');
  assert.equal(dcUnitPrice(636, pricing), 300);
  assert.equal(dcUnitPrice(700.5, pricing), 300);
});

test('DC without Flat Rate: existing item rate unchanged', () => {
  assert.equal(dcUnitPrice(636, {}), 636);
  assert.equal(dcUnitPrice(636, { discountPct: 10 }), 636);
});

test('DC without Flat Rate/Discount stores no new fields (byte-identical to before)', () => {
  assert.deepEqual(dcPricingFields(12345.67, {}), {});
});

test('DC with Discount: discount and net amount', () => {
  // 10 pcs × 300 flat + 5 pcs × 300 = 4500 gross; 12.5% → 562.50 off → 3937.50 net
  assert.deepEqual(dcPricingFields(4500, { flatRate: 300, discountPct: 12.5 }), {
    flatRate: 300, discountPct: 12.5, discountAmount: 562.5, netAmount: 3937.5,
  });
  // Flat rate only → discount 0, net = gross
  assert.deepEqual(dcPricingFields(4500, { flatRate: 300 }), {
    flatRate: 300, discountPct: undefined, discountAmount: 0, netAmount: 4500,
  });
  // Rounding to paise
  assert.deepEqual(dcDiscountSummary({ discountPct: 3.33 }, 1234.56), { discountPct: 3.33, discountAmount: 41.11, netAmount: 1193.45 });
  assert.deepEqual(dcDiscountSummary({}, 1000), { discountPct: 0, discountAmount: 0, netAmount: 1000 });
});

// ─── Invoice compatibility ───────────────────────────────────────────────────

test('Invoice from a normal DC: MRP − Margin price and Client Master discount (unchanged)', () => {
  const normalDc = { dcNo: 'DC1' };
  assert.equal(invoiceUnitPrice(normalDc, { price: 636 }, 636), 636);
  assert.equal(invoiceUnitPrice(normalDc, { price: 999 }, 636), 636); // stored price never overrides a normal DC
  assert.equal(resolveInvoiceDiscountPct([normalDc], 8), 8);
});

test('Invoice from a Flat Rate/Discount DC: bills DC price and DC discount', () => {
  const flatDc = { dcNo: 'DC2', flatRate: 300, discountPct: 5 };
  assert.equal(invoiceUnitPrice(flatDc, { price: 300 }, 636), 300);
  assert.equal(resolveInvoiceDiscountPct([flatDc], 8), 5);
  // Flat rate only → 0% (empty DC discount = 0), not the client's 8%
  assert.equal(resolveInvoiceDiscountPct([{ dcNo: 'DC3', flatRate: 300 }], 8), 0);
  // Missing stored price falls back to margin price rather than billing ₹0
  assert.equal(invoiceUnitPrice(flatDc, { price: 0 }, 636), 636);
});

test('Multi-DC invoice: mixed discounts are rejected, matching ones allowed', () => {
  assert.equal(resolveInvoiceDiscountPct([{ dcNo: 'A' }, { dcNo: 'B' }], 8), 8);
  assert.equal(resolveInvoiceDiscountPct([{ dcNo: 'A', discountPct: 8 }, { dcNo: 'B' }], 8), 8);
  const err = (() => { try { resolveInvoiceDiscountPct([{ dcNo: 'A', flatRate: 300 }, { dcNo: 'B' }], 8); } catch (e) { return e; } })();
  assert.equal(err.code, 'mixed_discount');
  assert.match(err.message, /A: 0%, B: 8%/);
});
