export interface DCItem {
  partName: string;
  styleNo: string;
  color: string;
  sleeveType?: string;
  sizeQty: Record<string, number>;
  total: number;
  // Same design/color/sleeve can carry a different MRP per size (e.g. size
  // 36/38 at ₹795 vs 40/42 at ₹825) — mrpBySize is the source of truth for
  // display and amount calculation. `mrp` is kept only as a legacy
  // single-value fallback (first size encountered) for older DC documents
  // written before mrpBySize existed and for call sites that haven't been
  // updated to read per-size MRP.
  mrp: number;
  mrpBySize?: Record<string, number>;
  // Margin-adjusted unit price (Client Master Margin%) and its line total —
  // no Discount is ever applied here, only in the Invoice. When a row mixes
  // more than one MRP across its sizes, amount is the sum of each size's
  // qty × its own margin-adjusted price, not a single flat price × total.
  price?: number;
  amount?: number;
}

// One physical dispatch against a DC. A DC's quantity can go out in several
// deliveries (e.g. 80 now, 10 after ten days, …) — each delivery gets its own
// Invoice (and so its own e-Invoice/E-Way Bill), created in the same
// transaction that appends it here (InvoiceService.createDeliveryInvoice /
// createInvoice / createInvoiceFromDCs). Items reuse DCItem with sizeQty/
// total/amount holding just this delivery's qty; itemIndex points back at
// DeliveryChallan.items[itemIndex] (a DC can carry the same design twice at
// different MRPs, so matching by design alone would be ambiguous).
export interface DCDeliveryItem extends DCItem {
  itemIndex: number;
}

export interface DCDelivery {
  deliveryId: string;
  deliveryNo: number;
  deliveryDate: any;
  items: DCDeliveryItem[];
  totalQty: number;
  totalAmount: number;
  // Boxes that went out in this delivery (DC.boxCount is the whole DC's).
  boxCount?: number;
  invoiceId?: string;
  invoiceNo?: string;
  remarks?: string;
  createdAt: any;
}

// Undelivered balance explicitly closed (DeliveryChallanService.closeBalance).
// The closed pieces are returned to inventory — they were deducted at packing
// completion, long before the DC existed.
export interface DCBalanceClosure {
  closedDate: any;
  items: DCDeliveryItem[];
  totalQty: number;
  reason: string;
  returnedToStock: boolean;
}

// open: nothing delivered yet · partial: some delivered, balance pending ·
// delivered: full qty delivered · closed: balance cancelled/closed.
export type DCDeliveryStatus = 'open' | 'partial' | 'delivered' | 'closed';

export interface DeliveryChallan {
  id?: string;
  dcNo: string;
  dcSeq: number;
  packingListId: string;
  packingListNo: string;
  salesOrderIds: string[];
  salesNos: string[];
  // Customer PO Number(s) behind this DC's Sales Orders (SalesOrder.poNumber),
  // merged/joined the same way salesNos is when more than one Sales Order is
  // covered. Printed as "Order No." — falls back to salesNos/packingListNo
  // when blank (older DCs, or Sales Orders with no PO recorded).
  orderNo: string;
  clientId: string;
  clientName: string;
  billingAddress: string;
  place: string;
  state: string;
  zipCode: string;
  clientPhone: string;
  clientGstin: string;
  packedOn: any;
  totalQty: number;
  boxCount: number;
  agentName: string;
  // Transport Master fields — see PackingList.transport/transportId for how
  // these are sourced.
  transport: string;
  transportId?: string;
  transportAddress?: string;
  transportGstNo?: string;
  items: DCItem[];
  sizes: string[];
  totalAmount?: number;
  // Stamped atomically inside InvoiceService.createInvoice()'s transaction
  // once its consolidated Invoice is created — informational/DC-keyed lookup
  // only. The actual "at most one Invoice" gate lives on the owning Packing
  // List's own `invoiceId` (see PackingList.invoiceId), not here, since a
  // legacy Packing List can carry more than one DC doc.
  invoiceId?: string;
  invoiceNo?: string;
  // Partial delivery tracking — see DCDelivery. Absent on DCs created before
  // this existed; dc-delivery.util.ts treats such a DC as fully delivered when
  // it already has an Invoice, otherwise as open with its full qty pending.
  // deliveredQty/balanceQty/deliveryStatus are denormalized aggregates kept in
  // step with deliveries[]/balanceClosure (the source of truth) for display.
  deliveries?: DCDelivery[];
  balanceClosure?: DCBalanceClosure;
  deliveredQty?: number;
  balanceQty?: number;
  deliveryStatus?: DCDeliveryStatus;
  createdAt: any;
  updatedAt: any;
}
