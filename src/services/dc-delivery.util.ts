import { Timestamp } from '@angular/fire/firestore';
import type {
  DCDelivery,
  DCDeliveryItem,
  DCDeliveryStatus,
  DCItem,
  DeliveryChallan,
} from '../models/delivery-challan.model';

/**
 * Partial delivery against a Delivery Challan — every place that needs a
 * DC's Original / Delivered / Closed / Balance qty (services, DC History,
 * DC print, reports) goes through here so they can't drift apart.
 *
 * Quantities are tracked per DC item (by index into DeliveryChallan.items)
 * per size. Source of truth is DeliveryChallan.deliveries[] + balanceClosure;
 * the DC's deliveredQty/balanceQty/deliveryStatus fields are only
 * denormalized copies written by deliveryPatch().
 */

/** itemIndex -> size -> qty */
export type ItemSizeQty = Record<number, Record<string, number>>;

export interface DCDeliveryRow {
  itemIndex: number;
  item: DCItem;
  original: Record<string, number>;
  delivered: Record<string, number>;
  closed: Record<string, number>;
  balance: Record<string, number>;
  originalQty: number;
  deliveredQty: number;
  closedQty: number;
  balanceQty: number;
}

export interface DCDeliverySummary {
  rows: DCDeliveryRow[];
  deliveries: DCDelivery[];
  originalQty: number;
  deliveredQty: number;
  closedQty: number;
  balanceQty: number;
  status: DCDeliveryStatus;
}

const sum = (rec: Record<string, number>) => Object.values(rec).reduce((s, q) => s + (Number(q) || 0), 0);

/**
 * deliveries[] as stored, or — for a DC created before partial delivery
 * existed — one synthesized full delivery when it was already invoiced
 * (user-confirmed rule: invoiced legacy DC = fully delivered). A legacy DC
 * with no Invoice has no deliveries yet, i.e. its whole qty is pending.
 */
export function effectiveDeliveries(dc: DeliveryChallan): DCDelivery[] {
  if (dc.deliveries?.length) return dc.deliveries;
  if (!dc.invoiceId) return [];
  return [{
    deliveryId: 'legacy',
    deliveryNo: 1,
    deliveryDate: dc.createdAt,
    items: dc.items.map((item, itemIndex) => ({ ...item, itemIndex })),
    totalQty: dc.totalQty,
    totalAmount: dc.totalAmount ?? 0,
    boxCount: dc.boxCount,
    invoiceId: dc.invoiceId,
    invoiceNo: dc.invoiceNo,
    createdAt: dc.createdAt,
  }];
}

export function summarizeDCDelivery(dc: DeliveryChallan): DCDeliverySummary {
  const deliveries = effectiveDeliveries(dc);
  const deliveredBy: ItemSizeQty = {};
  const closedBy: ItemSizeQty = {};
  const addTo = (target: ItemSizeQty, items: DCDeliveryItem[]) => {
    for (const item of items) {
      const bucket = (target[item.itemIndex] ??= {});
      for (const [size, qty] of Object.entries(item.sizeQty ?? {})) {
        bucket[size] = (bucket[size] ?? 0) + (Number(qty) || 0);
      }
    }
  };
  for (const delivery of deliveries) addTo(deliveredBy, delivery.items ?? []);
  if (dc.balanceClosure) addTo(closedBy, dc.balanceClosure.items ?? []);

  const rows: DCDeliveryRow[] = dc.items.map((item, itemIndex) => {
    const original: Record<string, number> = {};
    const balance: Record<string, number> = {};
    const delivered = deliveredBy[itemIndex] ?? {};
    const closed = closedBy[itemIndex] ?? {};
    for (const [size, rawQty] of Object.entries(item.sizeQty ?? {})) {
      const qty = Number(rawQty) || 0;
      if (qty <= 0) continue;
      original[size] = qty;
      balance[size] = Math.max(0, qty - (delivered[size] ?? 0) - (closed[size] ?? 0));
    }
    return {
      itemIndex, item, original, delivered, closed, balance,
      originalQty: sum(original), deliveredQty: sum(delivered), closedQty: sum(closed), balanceQty: sum(balance),
    };
  });

  const originalQty = rows.reduce((s, r) => s + r.originalQty, 0);
  const deliveredQty = rows.reduce((s, r) => s + r.deliveredQty, 0);
  const closedQty = rows.reduce((s, r) => s + r.closedQty, 0);
  const balanceQty = rows.reduce((s, r) => s + r.balanceQty, 0);
  const status: DCDeliveryStatus = balanceQty > 0
    ? (deliveredQty > 0 ? 'partial' : 'open')
    : (closedQty > 0 ? 'closed' : 'delivered');

  return { rows, deliveries, originalQty, deliveredQty, closedQty, balanceQty, status };
}

/** The full pending balance, in the shape buildDeliveryItems()/validateDeliveryQty() take. */
export function balanceItemSizeQty(dc: DeliveryChallan): ItemSizeQty {
  const result: ItemSizeQty = {};
  for (const row of summarizeDCDelivery(dc).rows) {
    const sizes = Object.entries(row.balance).filter(([, qty]) => qty > 0);
    if (sizes.length) result[row.itemIndex] = Object.fromEntries(sizes);
  }
  return result;
}

/**
 * Over-delivery guard: every requested qty must be a whole number between 0
 * and that item/size's pending balance, with at least one piece in total.
 * Returns an error message, or null when valid. Run again inside the write
 * transaction against the fresh DC, not just in the dialog.
 */
export function validateDeliveryQty(dc: DeliveryChallan, requested: ItemSizeQty): string | null {
  const summary = summarizeDCDelivery(dc);
  if (summary.status === 'closed') return `Delivery Challan ${dc.dcNo} balance is already closed.`;
  let total = 0;
  for (const [indexKey, sizes] of Object.entries(requested)) {
    const row = summary.rows[Number(indexKey)];
    for (const [size, rawQty] of Object.entries(sizes)) {
      const qty = Number(rawQty);
      if (!Number.isInteger(qty) || qty < 0) return 'Delivery quantities must be whole numbers, 0 or more.';
      if (qty === 0) continue;
      const pending = row?.balance[size] ?? 0;
      if (qty > pending) {
        const label = row ? `${row.item.styleNo} ${row.item.color} ${row.item.sleeveType ?? ''} size ${size}`.replace(/\s+/g, ' ') : `size ${size}`;
        return `${label}: ${qty} requested but only ${pending} pending on ${dc.dcNo}.`;
      }
      total += qty;
    }
  }
  if (total <= 0) return 'Enter a delivery quantity for at least one item.';
  return null;
}

/**
 * DCDeliveryItem[] for the requested qty — same row shape as DC.items with
 * sizeQty/total/amount cut down to just this delivery. Amount uses each
 * size's own MRP × the row's margin factor (price/mrp), the same
 * reconstruction buildCustomerDCHtml uses for multi-MRP legacy rows.
 */
export function buildDeliveryItems(dc: DeliveryChallan, requested: ItemSizeQty): DCDeliveryItem[] {
  const result: DCDeliveryItem[] = [];
  dc.items.forEach((item, itemIndex) => {
    const sizeQty: Record<string, number> = {};
    for (const [size, rawQty] of Object.entries(requested[itemIndex] ?? {})) {
      const qty = Number(rawQty) || 0;
      if (qty > 0) sizeQty[size] = qty;
    }
    const total = sum(sizeQty);
    if (total <= 0) return;
    const factor = item.mrp > 0 && item.price != null ? item.price / item.mrp : 1;
    const amount = Object.entries(sizeQty).reduce((s, [size, qty]) => {
      const mrp = item.mrpBySize?.[size] ?? item.mrp;
      return s + qty * Math.round(mrp * factor * 100) / 100;
    }, 0);
    result.push({ ...item, itemIndex, sizeQty, total, amount: Math.round(amount * 100) / 100 });
  });
  return result;
}

/** A DC as a DeliveryChallan-shaped view holding only the given delivery items (for printing / invoice building). */
export function dcWithItems(dc: DeliveryChallan, items: DCDeliveryItem[]): DeliveryChallan {
  const plainItems: DCItem[] = items.map(({ itemIndex: _ignored, ...item }) => item);
  const sizesInUse = new Set(plainItems.flatMap((item) => Object.keys(item.sizeQty)));
  return {
    ...dc,
    items: plainItems,
    sizes: dc.sizes.filter((s) => sizesInUse.has(s)),
    totalQty: plainItems.reduce((s, i) => s + i.total, 0),
    totalAmount: Math.round(plainItems.reduce((s, i) => s + (i.amount ?? 0), 0) * 100) / 100,
  };
}

export function newDelivery(
  dc: DeliveryChallan,
  items: DCDeliveryItem[],
  fields: { deliveryId: string; deliveryDate?: Date | null; boxCount?: number; invoiceId?: string; invoiceNo?: string; remarks?: string },
): DCDelivery {
  // serverTimestamp() is not allowed inside an array element, hence
  // Timestamp values here.
  const now = Timestamp.now();
  return {
    deliveryId: fields.deliveryId,
    deliveryNo: (dc.deliveries?.length ?? 0) + 1,
    deliveryDate: fields.deliveryDate ? Timestamp.fromDate(fields.deliveryDate) : now,
    items,
    totalQty: items.reduce((s, i) => s + i.total, 0),
    totalAmount: Math.round(items.reduce((s, i) => s + (i.amount ?? 0), 0) * 100) / 100,
    boxCount: fields.boxCount,
    invoiceId: fields.invoiceId,
    invoiceNo: fields.invoiceNo,
    remarks: fields.remarks || undefined,
    createdAt: now,
  };
}

/** Firestore patch for a DC after appending `delivery` (and/or a closure already set on `dc`). */
export function deliveryPatch(dc: DeliveryChallan, delivery?: DCDelivery): Pick<DeliveryChallan, 'deliveries' | 'deliveredQty' | 'balanceQty' | 'deliveryStatus'> {
  const deliveries = delivery ? [...(dc.deliveries ?? []), delivery] : (dc.deliveries ?? []);
  const summary = summarizeDCDelivery({ ...dc, deliveries });
  return { deliveries, deliveredQty: summary.deliveredQty, balanceQty: summary.balanceQty, deliveryStatus: summary.status };
}

/**
 * True when this DC can still be billed in one go by the original
 * full-quantity flows (createInvoice / createInvoiceFromDCs): nothing
 * delivered and nothing closed yet.
 */
export function isUndeliveredDC(dc: DeliveryChallan): boolean {
  return !dc.invoiceId && !(dc.deliveries?.length) && !dc.balanceClosure;
}

/** True when a DC's deliveries already went out in parts (or a balance was closed) — a full re-invoice of the DC would double-bill. */
export function hasPartialDeliveries(dc: DeliveryChallan): boolean {
  if (dc.balanceClosure) return true;
  const deliveries = dc.deliveries ?? [];
  return deliveries.length > 1 || (deliveries.length === 1 && deliveries[0].totalQty < dc.totalQty);
}

/**
 * Billed qty per item/size: deliveries carrying an invoiceId. Reports use
 * this in place of "invoice exists ⇒ the whole DC was billed".
 */
export function invoicedItemSizeQty(dc: DeliveryChallan): ItemSizeQty {
  const result: ItemSizeQty = {};
  for (const delivery of effectiveDeliveries(dc)) {
    if (!delivery.invoiceId) continue;
    for (const item of delivery.items ?? []) {
      const bucket = (result[item.itemIndex] ??= {});
      for (const [size, qty] of Object.entries(item.sizeQty ?? {})) bucket[size] = (bucket[size] ?? 0) + (Number(qty) || 0);
    }
  }
  return result;
}

export const DC_DELIVERY_STATUS_LABEL: Record<DCDeliveryStatus, string> = {
  open: 'Pending Delivery',
  partial: 'Partially Delivered',
  delivered: 'Delivered',
  closed: 'Balance Closed',
};
