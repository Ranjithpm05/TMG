// Pure rules for the Bulk Picking → Bulk Packing → DC flow and for the
// optional DC Flat Rate / Discount. No Angular/Firestore imports (type-only
// imports are erased), so Node runs this file directly in
// scripts/tests/bulk-flow.engine.test.mjs. PickListService/PackingListService
// call these inside their transactions with freshly-read values, and the
// components call the same functions up front for instant feedback.
import type { PickList } from '../models/pick-list.model';
import type { DCItem, DeliveryChallan } from '../models/delivery-challan.model';

export class BulkFlowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BulkFlowError';
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Bulk Picking ─────────────────────────────────────────────────────────────

// Upper bound for one typed quantity — guards against a scanner dumping a
// barcode into the quantity box (a 13-digit "quantity").
export const MAX_BULK_ENTRY_QTY = 9999;

/** Parses a typed/scanned quantity into a positive whole number, or throws. */
export function parseBulkQty(raw: unknown): number {
  const text = String(raw ?? '').trim();
  const qty = Number(text);
  if (!text || !Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
    throw new BulkFlowError('qty_invalid', 'Enter a whole quantity greater than 0.');
  }
  if (qty > MAX_BULK_ENTRY_QTY) {
    throw new BulkFlowError('qty_invalid', `Quantity cannot exceed ${MAX_BULK_ENTRY_QTY} in one entry.`);
  }
  return qty;
}

/**
 * Validates adding `qty` units of one barcode to a Bulk Pick List. Bulk
 * Picking never lets stock go negative (unlike the Sales-Order pickers):
 * `currentStock` null means the barcode has no inventory record at all.
 */
export function assertBulkPickAllowed(input: {
  pickList: Pick<PickList, 'type' | 'finalizedAt'>;
  qty: number;
  currentStock: number | null;
}): void {
  if (input.pickList.type !== 'bulk') throw new BulkFlowError('not_bulk', 'This is not a Bulk Pick List.');
  if (input.pickList.finalizedAt) {
    throw new BulkFlowError('bulk_completed', 'Bulk Picking is already completed for this list — no more items can be scanned.');
  }
  if (input.currentStock == null) {
    throw new BulkFlowError('no_stock_record', 'This item has no stock in Inventory (never received through Goods Inward).');
  }
  if (input.qty > input.currentStock) {
    throw new BulkFlowError(
      'insufficient_stock',
      input.currentStock <= 0
        ? 'This item is out of stock.'
        : `Only ${input.currentStock} in stock — cannot pick ${input.qty}.`,
    );
  }
}

/**
 * Validates taking `qty` units back off a bulk line. Units already carried
 * into a Packing List can't be un-picked here.
 */
export function assertBulkUnpickAllowed(input: {
  pickList: Pick<PickList, 'finalizedAt'>;
  pickedQty: number;
  packedIntoPackingListsQty: number;
  qty: number;
}): void {
  if (input.pickList.finalizedAt) {
    throw new BulkFlowError('bulk_completed', 'Bulk Picking is already completed — picked items can no longer be removed.');
  }
  if (input.qty <= 0 || input.qty > input.pickedQty) {
    throw new BulkFlowError('qty_invalid', `Can remove at most ${input.pickedQty} of this item.`);
  }
  if (input.pickedQty - input.qty < input.packedIntoPackingListsQty) {
    throw new BulkFlowError('already_packed', 'Part of this item has already been packed and cannot be removed.');
  }
}

/**
 * Bulk Pick List status: 'Draft' before anything is picked, 'Partial' while
 * picking and after completion until every picked unit has been packed,
 * 'Completed' once fully packed. Same "Partial + finalizedAt" shape the
 * Packing screen already treats as ready-to-pack for Party-wise lists.
 */
export function bulkPickListStatus(finalized: boolean, totalPickedQty: number, totalPackedQty: number): PickList['status'] {
  if (totalPickedQty <= 0) return 'Draft';
  if (finalized && totalPackedQty >= totalPickedQty) return 'Completed';
  return 'Partial';
}

/** Display stage for a Bulk Pick List (status alone can't tell picking from awaiting-packing). */
export function bulkPickStage(pickList: Pick<PickList, 'finalizedAt' | 'totalPickedQty' | 'totalPackedIntoPackingListsQty'>): 'picking' | 'ready_to_pack' | 'packing' | 'packed' {
  if (!pickList.finalizedAt) return 'picking';
  const picked = pickList.totalPickedQty ?? 0;
  const packed = pickList.totalPackedIntoPackingListsQty ?? 0;
  if (picked > 0 && packed >= picked) return 'packed';
  return packed > 0 ? 'packing' : 'ready_to_pack';
}

// ─── Bulk Packing ─────────────────────────────────────────────────────────────

export interface BulkPackLineState {
  lineId: string;
  requiredQty: number;
  packedQty: number;
}

/**
 * Validates one Bulk Packing submission (item-wise quantities into one
 * carton). Returns the entries merged per line with zero rows dropped.
 * Throws on unknown lines, fractional/negative qty, or over-packing.
 */
export function validateBulkPackEntries(
  lines: BulkPackLineState[],
  entries: Array<{ lineId: string; qty: number }>,
): Array<{ lineId: string; qty: number }> {
  const byId = new Map(lines.map((line) => [line.lineId, line]));
  const merged = new Map<string, number>();
  for (const entry of entries) {
    const qty = Number(entry.qty);
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 0) {
      throw new BulkFlowError('qty_invalid', 'Packing quantities must be whole numbers, 0 or more.');
    }
    if (qty === 0) continue;
    if (!byId.has(entry.lineId)) throw new BulkFlowError('line_not_found', 'An item in this submission is no longer on the Packing List.');
    merged.set(entry.lineId, (merged.get(entry.lineId) ?? 0) + qty);
  }
  if (!merged.size) throw new BulkFlowError('nothing_to_pack', 'Enter a packing quantity for at least one item.');

  for (const [lineId, qty] of merged) {
    const line = byId.get(lineId)!;
    const remaining = Math.max(0, line.requiredQty - line.packedQty);
    if (qty > remaining) {
      throw new BulkFlowError('qty_exceeds_remaining', `Packing ${qty} would exceed the picked quantity — only ${remaining} left to pack for this item.`);
    }
  }
  return [...merged.entries()].map(([lineId, qty]) => ({ lineId, qty }));
}

/** True once every line's packed quantity has reached its picked quantity. */
export function isBulkPackingComplete(lines: BulkPackLineState[]): boolean {
  const live = lines.filter((line) => line.requiredQty > 0);
  return live.length > 0 && live.every((line) => line.packedQty >= line.requiredQty);
}

// ─── DC Flat Rate / Discount ──────────────────────────────────────────────────

export interface DcPricingInput {
  flatRate?: number;
  discountPct?: number;
}

export const MAX_FLAT_RATE = 1_000_000;

/**
 * Parses the optional Flat Rate / Discount % fields of the DC generation
 * dialog. Blank means "not used"; a Discount of 0 is the same as blank.
 */
export function parseDcPricingInput(flatRateRaw: unknown, discountRaw: unknown): DcPricingInput {
  const result: DcPricingInput = {};

  const flatText = String(flatRateRaw ?? '').trim();
  if (flatText) {
    const flatRate = Number(flatText);
    if (!Number.isFinite(flatRate) || flatRate <= 0) {
      throw new BulkFlowError('flat_rate_invalid', 'Flat Rate must be a number greater than 0, or left empty.');
    }
    if (flatRate > MAX_FLAT_RATE) throw new BulkFlowError('flat_rate_invalid', 'Flat Rate is too large.');
    result.flatRate = round2(flatRate);
  }

  const discountText = String(discountRaw ?? '').trim();
  if (discountText) {
    const discountPct = Number(discountText);
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct >= 100) {
      throw new BulkFlowError('discount_invalid', 'Discount % must be between 0 and 99.99, or left empty.');
    }
    if (discountPct > 0) result.discountPct = round2(discountPct);
  }

  return result;
}

/** Unit price for a DC row: the Flat Rate when given, else the existing (MRP − Margin%) price. */
export function dcUnitPrice(marginPrice: number, pricing: DcPricingInput): number {
  return pricing.flatRate != null && pricing.flatRate > 0 ? pricing.flatRate : marginPrice;
}

/**
 * The DC-level fields to store for the given pricing. Empty when neither
 * Flat Rate nor Discount was used, so a DC generated without them is
 * byte-for-byte what it was before this feature existed.
 */
export function dcPricingFields(grossAmount: number, pricing: DcPricingInput): Pick<DeliveryChallan, 'flatRate' | 'discountPct' | 'discountAmount' | 'netAmount'> {
  if (!dcHasPricingOverride(pricing)) return {};
  const discountPct = pricing.discountPct ?? 0;
  const discountAmount = round2(grossAmount * discountPct / 100);
  return {
    flatRate: pricing.flatRate,
    discountPct: discountPct > 0 ? discountPct : undefined,
    discountAmount,
    netAmount: round2(grossAmount - discountAmount),
  };
}

/** True when a DC was generated with a Flat Rate and/or Discount. */
export function dcHasPricingOverride(dc: DcPricingInput): boolean {
  return (dc.flatRate ?? 0) > 0 || (dc.discountPct ?? 0) > 0;
}

/** Discount amount and net for a (possibly partial-delivery) view of a DC. */
export function dcDiscountSummary(dc: DcPricingInput, grossAmount: number): { discountPct: number; discountAmount: number; netAmount: number } {
  const discountPct = dc.discountPct ?? 0;
  const discountAmount = round2(grossAmount * discountPct / 100);
  return { discountPct, discountAmount, netAmount: round2(grossAmount - discountAmount) };
}

/**
 * Invoice unit price for a DC item. DCs generated with a Flat Rate/Discount
 * are billed at their own stored price. Every other DC keeps the existing
 * MRP − Margin% price (marginPrice), exactly as before.
 */
export function invoiceUnitPrice(dc: DcPricingInput, item: Pick<DCItem, 'price'>, marginPrice: number): number {
  return dcHasPricingOverride(dc) && (item.price ?? 0) > 0 ? item.price! : marginPrice;
}

/**
 * Invoice Discount % for a set of DCs billed together. Flat Rate/Discount
 * DCs carry their own discount (0 when only a Flat Rate was given); every
 * other DC uses the Client Master Discount % as before. An Invoice has a
 * single Discount %, so DCs that disagree must be invoiced separately.
 */
export function resolveInvoiceDiscountPct(dcs: Array<DcPricingInput & { dcNo?: string }>, clientDiscountPct: number): number {
  const pctFor = (dc: DcPricingInput) => (dcHasPricingOverride(dc) ? dc.discountPct ?? 0 : clientDiscountPct);
  const distinct = [...new Set(dcs.map(pctFor))];
  if (distinct.length > 1) {
    const detail = dcs.map((dc) => `${dc.dcNo ?? 'DC'}: ${pctFor(dc)}%`).join(', ');
    throw new BulkFlowError('mixed_discount', `The selected Delivery Challans carry different discounts (${detail}). Invoice them separately.`);
  }
  return distinct[0] ?? clientDiscountPct;
}
