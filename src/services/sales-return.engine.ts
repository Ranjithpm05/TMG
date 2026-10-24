// Business rules for Sales Return, kept free of Angular and Firebase imports so
// they run unchanged under `node --test` against an in-memory store
// (scripts/tests/sales-return.engine.test.mjs). SalesReturnService is the
// Firestore implementation of ReturnStore; everything that decides WHAT is
// written lives here.
//
// Guarantees:
//  - Sold qty is never trusted from the screen. Posting re-reads every Invoice
//    (and, for an invoice billed in full, its DCs) inside the transaction and
//    rebuilds the billed per-size lines the same way the sales reports do
//    (invoice.deliveryItems, else DC items — see invoice-product-lines.util.ts).
//  - salesReturnLedger/{invoiceId} holds what Posted returns already took back
//    per billed line. It is read, checked (sold − returned ≥ this return) and
//    rewritten in the same transaction as the stock writes, so two returns
//    posted at once against the same bill can never exceed what was sold.
//  - Stock moves exactly once: only Draft → Posted applies it and only
//    Posted → Cancelled reverses it, both status-gated inside the transaction,
//    so a double click, retry or second device is a no-op.
//  - Cancelling a Posted return is refused while any of its Fresh pieces have
//    already left stock again (re-picked/re-sold) — reversing then would push
//    currentStock below what is physically on hand.

import type { Invoice } from '../models/invoice.model';
import type { DCItem, DeliveryChallan } from '../models/delivery-challan.model';
import type {
  ReturnCondition, SalesReturn, SalesReturnLine, SalesReturnMode, SalesReturnTotals,
} from '../models/sales-return.model';

export type DocData = Record<string, any>;

/** The subset of a Firestore transaction the engine needs. */
export interface TxLike {
  get(path: string): Promise<DocData | null>;
  set(path: string, data: DocData): void;
  update(path: string, patch: DocData): void;
}

export interface ReturnStore {
  runTransaction<T>(fn: (tx: TxLike) => Promise<T>): Promise<T>;
  serverTime(): unknown;
  increment(n: number): unknown;
}

// Per post: 1 return + ≤1 ledger per invoice + ≤1 inventory and ≤1 damage write
// per line — far under Firestore's 500-writes-per-transaction limit.
export const MAX_RETURN_LINES = 150;
export const CONDITIONS: ReturnCondition[] = ['Fresh', 'Damage'];

export const paths = {
  salesReturn: (id: string) => `salesReturns/${id}`,
  ledger: (invoiceId: string) => `salesReturnLedger/${invoiceId}`,
  invoice: (invoiceId: string) => `invoices/${invoiceId}`,
  dc: (dcId: string) => `deliveryChallans/${dcId}`,
  inventory: (inventoryId: string) => `inventory/${inventoryId}`,
  damage: (inventoryId: string) => `damageStock/${inventoryId}`,
  counter: 'counters/salesReturnCounter',
};

export class SalesReturnError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SalesReturnError';
  }
}

export function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function billLineKey(dcId: string, itemIndex: number, size: string): string {
  return `${dcId}#${itemIndex}#${encodeURIComponent(String(size ?? ''))}`;
}

/** Same styleNo|color|sleeve|size match DeliveryChallanService.closeBalance() uses to find a billed piece's inventory record. */
export function inventoryKey(styleNo: unknown, color: unknown, sleeveType: unknown, size: unknown): string {
  return `${styleNo ?? ''}|${color ?? ''}|${sleeveType ?? ''}|${size ?? ''}`.toUpperCase();
}

export function lineLabel(l: Pick<SalesReturnLine, 'styleNo' | 'color' | 'size' | 'sleeveType'>): string {
  return [l.styleNo, l.color, l.sleeveType, `size ${l.size}`].filter(Boolean).join(' ');
}

// ═════════════════════════════════════════════════════════════════════════════
// Billed lines of an invoice
// ═════════════════════════════════════════════════════════════════════════════

export interface BilledLine {
  lineKey: string;
  dcId: string;
  itemIndex: number;
  size: string;
  qty: number;
  item: DCItem;
}

/** DC docs needed to rebuild an invoice's billed lines — none when it carries its own deliveryItems. */
export function dcIdsNeeded(invoice: Pick<Invoice, 'deliveryItems' | 'dcIds' | 'dcId'>): string[] {
  if (invoice.deliveryItems?.length) return [];
  return [...new Set((invoice.dcIds?.length ? invoice.dcIds : [invoice.dcId]).filter((id): id is string => !!id))];
}

/**
 * One entry per DC item + size the invoice billed. An invoice for one (possibly
 * partial) delivery carries the exact qty it billed in deliveryItems — never
 * fall back to the DC's full items for it, or a partial invoice would allow
 * returning the whole DC.
 */
export function billedLines(
  invoice: Pick<Invoice, 'deliveryItems' | 'dcIds' | 'dcId'>,
  dcsById: Map<string, Pick<DeliveryChallan, 'items'>>,
): { lines: BilledLine[]; missingDcIds: string[] } {
  const byKey = new Map<string, BilledLine>();
  const missingDcIds: string[] = [];
  const add = (dcId: string, itemIndex: number, item: DCItem) => {
    for (const [size, raw] of Object.entries(item.sizeQty ?? {})) {
      const qty = Number(raw) || 0;
      if (qty <= 0) continue;
      const lineKey = billLineKey(dcId, itemIndex, size);
      const existing = byKey.get(lineKey);
      if (existing) existing.qty += qty;
      else byKey.set(lineKey, { lineKey, dcId, itemIndex, size, qty, item });
    }
  };

  if (invoice.deliveryItems?.length) {
    const dcId = invoice.dcId || invoice.dcIds?.[0] || '';
    invoice.deliveryItems.forEach((item, i) => add(dcId, Number.isInteger(item.itemIndex) ? item.itemIndex : i, item));
  } else {
    for (const dcId of dcIdsNeeded(invoice)) {
      const dc = dcsById.get(dcId);
      if (!dc) { missingDcIds.push(dcId); continue; }
      (dc.items ?? []).forEach((item, i) => add(dcId, i, item));
    }
  }
  return { lines: [...byKey.values()], missingDcIds };
}

/** The price the invoice actually billed per styleNo|sleeveType|mrp — same lookup as invoice-product-lines.util.ts. */
function invoicePriceMap(invoice: Pick<Invoice, 'items'>): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of invoice.items ?? []) {
    const price = Number(item.price);
    const mrp = Number(item.mrp);
    if (!(price > 0) || !(mrp > 0)) continue;
    map.set(`${item.styleNo ?? ''}|${item.sleeveType ?? ''}|${mrp}`, price);
    if (!map.has(`${item.styleNo ?? ''}||${mrp}`)) map.set(`${item.styleNo ?? ''}||${mrp}`, price);
  }
  return map;
}

function billedPrice(priceMap: Map<string, number>, item: DCItem, size: string): { mrp: number; price: number } {
  const mrp = Number(item.mrpBySize?.[size] ?? item.mrp) || 0;
  const fromInvoice = priceMap.get(`${item.styleNo ?? ''}|${item.sleeveType ?? ''}|${mrp}`) ?? priceMap.get(`${item.styleNo ?? ''}||${mrp}`);
  const factor = item.mrp > 0 && item.price != null ? item.price / item.mrp : 1;
  return { mrp, price: fromInvoice ?? round2(mrp * factor) };
}

export type TaxRates = Pick<Invoice, 'discountPct' | 'cgstRate' | 'sgstRate' | 'igstRate'>;

/** Value of returned pieces at the invoice's own discount and GST rates (freight is never returned). */
export function lineAmounts(rates: TaxRates, qty: number, price: number): { taxableValue: number; taxAmount: number; totalAmount: number } {
  const gross = round2(qty * price);
  const taxableValue = round2(gross - (gross * (Number(rates.discountPct) || 0)) / 100);
  const taxRate = (Number(rates.cgstRate) || 0) + (Number(rates.sgstRate) || 0) + (Number(rates.igstRate) || 0);
  const taxAmount = round2((taxableValue * taxRate) / 100);
  return { taxableValue, taxAmount, totalAmount: round2(taxableValue + taxAmount) };
}

/** null when goods can be returned against this invoice, else why not. */
export function invoiceNotReturnableReason(invoice: Pick<Invoice, 'invoiceNo' | 'eInvoiceStatus'>): string | null {
  if (invoice.eInvoiceStatus === 'cancelled') return `Invoice ${invoice.invoiceNo} is cancelled — goods cannot be returned against it.`;
  return null;
}

export interface BillRow {
  invoiceId: string;
  invoiceNo: string;
  invoiceDate?: any;
  lineKey: string;
  dcId: string;
  itemIndex: number;
  size: string;
  styleNo: string;
  color: string;
  sleeveType?: string;
  description: string;
  mrp: number;
  price: number;
  soldQty: number;
  returnedQty: number;
  eligibleQty: number;
  inventoryId?: string;
  barcode?: string;
}

export type InventoryResolver = (styleNo: string, color: string, sleeveType: string | undefined, size: string) => { id: string; barcode: string } | null;

export function buildBillRows(
  invoice: Invoice,
  dcsById: Map<string, Pick<DeliveryChallan, 'items'>>,
  returned: Record<string, number> | undefined,
  resolve: InventoryResolver,
): { rows: BillRow[]; missingDcIds: string[] } {
  const { lines, missingDcIds } = billedLines(invoice, dcsById);
  const priceMap = invoicePriceMap(invoice);
  const rows = lines.map((l): BillRow => {
    const { mrp, price } = billedPrice(priceMap, l.item, l.size);
    const returnedQty = Math.max(0, Number(returned?.[l.lineKey]) || 0);
    const inv = resolve(l.item.styleNo, l.item.color, l.item.sleeveType, l.size);
    return {
      invoiceId: invoice.id!, invoiceNo: invoice.invoiceNo, invoiceDate: invoice.invoiceDate,
      lineKey: l.lineKey, dcId: l.dcId, itemIndex: l.itemIndex, size: l.size,
      styleNo: l.item.styleNo ?? '', color: l.item.color ?? '',
      ...(l.item.sleeveType ? { sleeveType: l.item.sleeveType } : {}),
      description: l.item.partName ?? '',
      mrp, price,
      soldQty: l.qty, returnedQty, eligibleQty: Math.max(0, l.qty - returnedQty),
      ...(inv ? { inventoryId: inv.id, barcode: inv.barcode } : {}),
    };
  });
  return { rows, missingDcIds };
}

export const rowRef = (invoiceId: string, lineKey: string) => `${invoiceId}|${lineKey}`;

/** A return line for `qty` pieces of a bill row, valued at the invoice's own rates. */
export function makeLine(
  row: BillRow, rates: TaxRates, condition: ReturnCondition, qty: number, location: string, remarks?: string,
): SalesReturnLine {
  return {
    invoiceId: row.invoiceId, invoiceNo: row.invoiceNo,
    ...(row.invoiceDate ? { invoiceDate: row.invoiceDate } : {}),
    lineKey: row.lineKey, dcId: row.dcId, itemIndex: row.itemIndex, size: row.size,
    condition, qty,
    inventoryId: row.inventoryId ?? '', barcode: row.barcode ?? '',
    styleNo: row.styleNo, color: row.color, ...(row.sleeveType ? { sleeveType: row.sleeveType } : {}),
    description: row.description, mrp: row.mrp, price: row.price, soldQty: row.soldQty,
    location: location.trim(), ...(remarks?.trim() ? { remarks: remarks.trim() } : {}),
    ...lineAmounts(rates, qty, row.price),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Entry validation & totals
// ═════════════════════════════════════════════════════════════════════════════

export interface ReturnDraftInput {
  mode: SalesReturnMode;
  returnDate: string;
  clientId: string;
  clientName: string;
  clientGstin?: string;
  remarks?: string;
  lines: SalesReturnLine[];
}

export function summarizeLines(lines: Pick<SalesReturnLine, 'qty' | 'condition' | 'taxableValue' | 'taxAmount' | 'totalAmount'>[]): SalesReturnTotals {
  const t: SalesReturnTotals = { qty: 0, freshQty: 0, damageQty: 0, taxableValue: 0, taxAmount: 0, totalAmount: 0 };
  for (const l of lines) {
    const qty = Number(l.qty) || 0;
    t.qty += qty;
    if (l.condition === 'Damage') t.damageQty += qty;
    else t.freshQty += qty;
    t.taxableValue += Number(l.taxableValue) || 0;
    t.taxAmount += Number(l.taxAmount) || 0;
    t.totalAmount += Number(l.totalAmount) || 0;
  }
  t.taxableValue = round2(t.taxableValue);
  t.taxAmount = round2(t.taxAmount);
  t.totalAmount = round2(t.totalAmount);
  return t;
}

export function uniqueInvoices(lines: Pick<SalesReturnLine, 'invoiceId' | 'invoiceNo'>[]): { invoiceIds: string[]; invoiceNos: string[] } {
  const byId = new Map<string, string>();
  for (const l of lines) if (!byId.has(l.invoiceId)) byId.set(l.invoiceId, l.invoiceNo);
  return { invoiceIds: [...byId.keys()], invoiceNos: [...byId.values()] };
}

function sumBy<T>(items: T[], key: (t: T) => string, qty: (t: T) => number): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + qty(item));
  return map;
}

/**
 * Everything the screen can check before saving. `rowsByRef` (current bill
 * rows) adds the eligible-qty check; posting repeats that check against the
 * server's invoice and ledger regardless.
 */
export function validateDraft(input: ReturnDraftInput, rowsByRef?: Map<string, BillRow>): string[] {
  const errors: string[] = [];
  if (!input.clientId) errors.push('Select a customer.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.returnDate ?? '')) errors.push('Enter a valid return date.');
  const lines = input.lines ?? [];
  if (!lines.length) errors.push('Enter a return quantity for at least one item.');
  if (lines.length > MAX_RETURN_LINES) errors.push(`A return can hold at most ${MAX_RETURN_LINES} lines — split it into more than one return.`);

  const { invoiceIds } = uniqueInvoices(lines);
  if (input.mode === 'single' && invoiceIds.length > 1) errors.push('Single Bill Return can only return items of one invoice — switch to Multiple Bills Return.');

  const seen = new Set<string>();
  for (const l of lines) {
    const label = `${l.invoiceNo} · ${lineLabel(l)}`;
    if (!Number.isInteger(l.qty) || l.qty <= 0) errors.push(`${label}: quantity must be a whole number above 0.`);
    if (!CONDITIONS.includes(l.condition)) errors.push(`${label}: choose Fresh or Damage.`);
    if (!l.inventoryId) errors.push(`${label}: no inventory record matches this item, so it cannot be taken back into stock.`);
    const dup = `${rowRef(l.invoiceId, l.lineKey)}|${l.condition}`;
    if (seen.has(dup)) errors.push(`${label}: entered twice as ${l.condition}.`);
    seen.add(dup);
  }

  if (rowsByRef) {
    for (const [ref, qty] of sumBy(lines, (l) => rowRef(l.invoiceId, l.lineKey), (l) => Number(l.qty) || 0)) {
      const row = rowsByRef.get(ref);
      if (!row) { errors.push(`An entered item is no longer on its invoice (${ref}).`); continue; }
      if (qty > row.eligibleQty) {
        errors.push(`${row.invoiceNo} · ${lineLabel(row)}: returning ${qty}, but only ${row.eligibleQty} of ${row.soldQty} sold can still be returned` +
          (row.returnedQty ? ` (${row.returnedQty} already returned).` : '.'));
      }
    }
  }
  return errors;
}

// ═════════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═════════════════════════════════════════════════════════════════════════════

const fail = (code: string, errors: string[] | string): never => {
  throw new SalesReturnError(code, Array.isArray(errors) ? errors.join('\n') : errors);
};

export function returnNoFor(fyCode: string, seq: number): string {
  return `SR${fyCode}-${String(seq).padStart(4, '0')}`;
}

/**
 * Creates the return as a Draft, or updates it while still a Draft. `id` is
 * chosen by the screen once per entry, so a retried or double-clicked save of
 * the same entry updates that one draft instead of creating a second one.
 * Drafts never touch stock or the ledger.
 */
export async function saveDraft(
  store: ReturnStore,
  opts: { id: string; input: ReturnDraftInput; user: string; fyCode: string },
): Promise<{ id: string; returnNo: string; created: boolean }> {
  const { id, input, user } = opts;
  const errors = validateDraft(input);
  if (errors.length) fail('invalid', errors);
  const lines = input.lines.map((l) => ({ ...l, qty: Number(l.qty) }));
  const body = {
    mode: input.mode,
    returnDate: input.returnDate,
    clientId: input.clientId,
    clientName: input.clientName,
    ...(input.clientGstin ? { clientGstin: input.clientGstin } : {}),
    remarks: (input.remarks ?? '').trim(),
    ...uniqueInvoices(lines),
    lines,
    totals: summarizeLines(lines),
  };

  return store.runTransaction(async (tx) => {
    const existing = await tx.get(paths.salesReturn(id));
    if (existing) {
      if (existing['status'] !== 'Draft') fail('not-draft', `${existing['returnNo']} is ${existing['status']} — only a Draft can be edited.`);
      tx.update(paths.salesReturn(id), { ...body, updatedBy: user, updatedAt: store.serverTime() });
      return { id, returnNo: existing['returnNo'] as string, created: false };
    }
    const counter = await tx.get(paths.counter);
    const seq = (Number(counter?.['seq']) || 0) + 1;
    const returnNo = returnNoFor(opts.fyCode, seq);
    const doc: Omit<SalesReturn, 'id'> = {
      ...body, returnNo, returnSeq: seq, status: 'Draft', stockApplied: false,
      createdBy: user, updatedBy: user, createdAt: store.serverTime(), updatedAt: store.serverTime(),
    };
    tx.set(paths.salesReturn(id), doc);
    tx.set(paths.counter, { seq, fy: opts.fyCode, updatedAt: store.serverTime() });
    return { id, returnNo, created: true };
  });
}

interface StockMove { line: SalesReturnLine; qty: number; byLocation: Map<string, number> }

function stockMoves(lines: SalesReturnLine[], condition: ReturnCondition): Map<string, StockMove> {
  const moves = new Map<string, StockMove>();
  for (const line of lines) {
    if (line.condition !== condition) continue;
    const qty = Number(line.qty) || 0;
    const move = moves.get(line.inventoryId) ?? { line, qty: 0, byLocation: new Map() };
    move.qty += qty;
    const loc = locationKey(line.location);
    move.byLocation.set(loc, (move.byLocation.get(loc) ?? 0) + qty);
    moves.set(line.inventoryId, move);
  }
  return moves;
}

export function locationKey(location: unknown): string {
  return String(location ?? '').trim().toUpperCase() || 'UNSPECIFIED';
}

function damageDoc(prev: DocData | null, move: StockMove, sign: 1 | -1, now: unknown): DocData {
  const byLocation: Record<string, number> = { ...(prev?.['byLocation'] ?? {}) };
  for (const [loc, qty] of move.byLocation) {
    const next = (Number(byLocation[loc]) || 0) + sign * qty;
    if (next > 0) byLocation[loc] = next;
    else delete byLocation[loc];
  }
  const l = move.line;
  return {
    inventoryId: l.inventoryId, barcode: l.barcode, styleNo: l.styleNo, color: l.color, size: l.size,
    ...(l.sleeveType ? { sleeveType: l.sleeveType } : {}),
    qty: Math.max(0, (Number(prev?.['qty']) || 0) + sign * move.qty),
    byLocation,
    updatedAt: now,
  };
}

/**
 * Applies a Draft's stock: Fresh pieces back into inventory.currentStock,
 * Damage pieces into damageStock, and the ledger — one transaction, after
 * re-validating every line against the original invoice and what earlier
 * returns already took back.
 */
export async function postReturn(store: ReturnStore, id: string, user: string): Promise<'posted' | 'already-posted'> {
  return store.runTransaction(async (tx) => {
    // ── reads (all before any write) ──
    const ret = await tx.get(paths.salesReturn(id)) as SalesReturn | null;
    if (!ret) fail('not-found', 'Sales return not found.');
    if (ret!.status === 'Posted') return 'already-posted' as const;
    if (ret!.status !== 'Draft') fail('not-draft', `${ret!.returnNo} is ${ret!.status} — it cannot be posted.`);
    const lines = ret!.lines ?? [];
    const errors = validateDraft({ ...ret!, lines });
    if (errors.length) fail('invalid', errors);

    const { invoiceIds } = uniqueInvoices(lines);
    const invoices = await Promise.all(invoiceIds.map((invId) => tx.get(paths.invoice(invId)))) as (Invoice | null)[];
    const dcIds = [...new Set(invoices.flatMap((inv) => (inv ? dcIdsNeeded(inv) : [])))];
    const dcDocs = await Promise.all(dcIds.map((dcId) => tx.get(paths.dc(dcId))));
    const dcsById = new Map(dcIds.flatMap((dcId, i) => (dcDocs[i] ? [[dcId, dcDocs[i] as DeliveryChallan] as const] : [])));
    const ledgers = await Promise.all(invoiceIds.map((invId) => tx.get(paths.ledger(invId))));

    const fresh = stockMoves(lines, 'Fresh');
    const damage = stockMoves(lines, 'Damage');
    const freshIds = [...fresh.keys()];
    const damageIds = [...damage.keys()];
    const invDocs = await Promise.all(freshIds.map((invId) => tx.get(paths.inventory(invId))));
    const damageDocs = await Promise.all(damageIds.map((invId) => tx.get(paths.damage(invId))));

    // ── validation against the original sale ──
    const problems: string[] = [];
    const requested = sumBy(lines, (l) => rowRef(l.invoiceId, l.lineKey), (l) => Number(l.qty) || 0);
    const newReturned: Record<string, number>[] = [];
    invoiceIds.forEach((invId, i) => {
      const invoice = invoices[i];
      const invNo = lines.find((l) => l.invoiceId === invId)!.invoiceNo;
      newReturned.push({ ...(ledgers[i]?.['returned'] ?? {}) });
      if (!invoice) { problems.push(`Invoice ${invNo} no longer exists.`); return; }
      const reason = invoiceNotReturnableReason(invoice);
      if (reason) problems.push(reason);
      if (invoice.clientId && invoice.clientId !== ret!.clientId) problems.push(`Invoice ${invNo} belongs to ${invoice.clientName}, not ${ret!.clientName}.`);
      const { lines: billed, missingDcIds } = billedLines(invoice, dcsById);
      if (missingDcIds.length) problems.push(`Invoice ${invNo}: its delivery challan could not be found, so the billed quantity cannot be verified.`);
      const soldByKey = new Map(billed.map((b) => [b.lineKey, b.qty]));
      for (const line of lines.filter((l) => l.invoiceId === invId)) {
        const ref = rowRef(invId, line.lineKey);
        if (!requested.has(ref)) continue;
        const want = requested.get(ref)!;
        requested.delete(ref); // one check per billed line, Fresh + Damage together
        const sold = soldByKey.get(line.lineKey);
        if (sold === undefined) { problems.push(`${invNo} · ${lineLabel(line)} was not billed on this invoice.`); continue; }
        const already = Math.max(0, Number(newReturned[i][line.lineKey]) || 0);
        if (want > sold - already) {
          problems.push(`${invNo} · ${lineLabel(line)}: returning ${want}, but only ${Math.max(0, sold - already)} of ${sold} sold can still be returned` +
            (already ? ` (${already} already returned).` : '.'));
          continue;
        }
        newReturned[i][line.lineKey] = already + want;
      }
    });
    freshIds.forEach((invId, i) => {
      if (!invDocs[i]) problems.push(`Inventory record for ${lineLabel(fresh.get(invId)!.line)} no longer exists — it cannot be taken back as Fresh.`);
    });
    if (problems.length) fail('validation-failed', problems);

    // ── writes ──
    const now = store.serverTime();
    invoiceIds.forEach((invId, i) => {
      const prevIds: string[] = ledgers[i]?.['returnIds'] ?? [];
      tx.set(paths.ledger(invId), {
        invoiceId: invId,
        invoiceNo: lines.find((l) => l.invoiceId === invId)!.invoiceNo,
        returned: newReturned[i],
        returnIds: prevIds.includes(id) ? prevIds : [...prevIds, id],
        updatedAt: now,
      });
    });
    for (const [invId, move] of fresh) {
      tx.update(paths.inventory(invId), { currentStock: store.increment(move.qty), updatedAt: now });
    }
    damageIds.forEach((invId, i) => tx.set(paths.damage(invId), damageDoc(damageDocs[i], damage.get(invId)!, 1, now)));
    tx.update(paths.salesReturn(id), {
      status: 'Posted', stockApplied: true, postedBy: user, postedAt: now, updatedBy: user, updatedAt: now,
    });
    return 'posted' as const;
  });
}

/**
 * Cancels a return. A Draft is simply closed. A Posted return has its stock
 * and ledger reversed in the same transaction — refused if its Fresh pieces
 * already left stock again, or its Damage pieces are no longer held.
 */
export async function cancelReturn(store: ReturnStore, id: string, user: string, reason: string): Promise<'cancelled' | 'already-cancelled'> {
  return store.runTransaction(async (tx) => {
    const ret = await tx.get(paths.salesReturn(id)) as SalesReturn | null;
    if (!ret) fail('not-found', 'Sales return not found.');
    if (ret!.status === 'Cancelled') return 'already-cancelled' as const;
    const now = store.serverTime();
    const patch = { status: 'Cancelled', cancelledBy: user, cancelledAt: now, cancelReason: reason.trim(), updatedBy: user, updatedAt: now };

    if (ret!.status === 'Draft' || !ret!.stockApplied) {
      tx.update(paths.salesReturn(id), patch);
      return 'cancelled' as const;
    }
    if (!reason.trim()) fail('reason-required', 'Enter a reason for cancelling a posted return.');

    const lines = ret!.lines ?? [];
    const { invoiceIds } = uniqueInvoices(lines);
    const fresh = stockMoves(lines, 'Fresh');
    const damage = stockMoves(lines, 'Damage');
    const freshIds = [...fresh.keys()];
    const damageIds = [...damage.keys()];
    const ledgers = await Promise.all(invoiceIds.map((invId) => tx.get(paths.ledger(invId))));
    const invDocs = await Promise.all(freshIds.map((invId) => tx.get(paths.inventory(invId))));
    const damageDocs = await Promise.all(damageIds.map((invId) => tx.get(paths.damage(invId))));

    const problems: string[] = [];
    freshIds.forEach((invId, i) => {
      const move = fresh.get(invId)!;
      const onHand = Number(invDocs[i]?.['currentStock']);
      if (!invDocs[i]) problems.push(`${lineLabel(move.line)}: inventory record no longer exists.`);
      else if (!(onHand >= move.qty)) problems.push(`${lineLabel(move.line)}: ${move.qty} returned as Fresh, but only ${onHand || 0} left in stock.`);
    });
    damageIds.forEach((invId, i) => {
      const move = damage.get(invId)!;
      const held = Number(damageDocs[i]?.['qty']) || 0;
      if (held < move.qty) problems.push(`${lineLabel(move.line)}: ${move.qty} returned as Damage, but only ${held} held in damage stock.`);
    });
    if (problems.length) {
      fail('stock-consumed', [`${ret!.returnNo} cannot be cancelled — reversing it would make stock negative:`, ...problems]);
    }

    invoiceIds.forEach((invId, i) => {
      const returned: Record<string, number> = { ...(ledgers[i]?.['returned'] ?? {}) };
      for (const l of lines.filter((x) => x.invoiceId === invId)) {
        const next = (Number(returned[l.lineKey]) || 0) - (Number(l.qty) || 0);
        if (next > 0) returned[l.lineKey] = next;
        else delete returned[l.lineKey];
      }
      tx.set(paths.ledger(invId), {
        invoiceId: invId,
        invoiceNo: ledgers[i]?.['invoiceNo'] ?? lines.find((l) => l.invoiceId === invId)!.invoiceNo,
        returned,
        returnIds: ((ledgers[i]?.['returnIds'] ?? []) as string[]).filter((x) => x !== id),
        updatedAt: now,
      });
    });
    for (const [invId, move] of fresh) {
      tx.update(paths.inventory(invId), { currentStock: store.increment(-move.qty), updatedAt: now });
    }
    damageIds.forEach((invId, i) => tx.set(paths.damage(invId), damageDoc(damageDocs[i], damage.get(invId)!, -1, now)));
    tx.update(paths.salesReturn(id), { ...patch, stockApplied: false });
    return 'cancelled' as const;
  });
}
