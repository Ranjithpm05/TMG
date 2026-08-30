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

export interface DeliveryChallan {
  id?: string;
  dcNo: string;
  dcSeq: number;
  packingListId: string;
  packingListNo: string;
  salesOrderIds: string[];
  salesNos: string[];
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
  createdAt: any;
  updatedAt: any;
}
