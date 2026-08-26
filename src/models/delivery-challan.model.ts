export interface DCItem {
  partName: string;
  styleNo: string;
  color: string;
  sleeveType?: string;
  sizeQty: Record<string, number>;
  total: number;
  mrp: number;
  // Margin-adjusted unit price (Client Master Margin%) and its line total —
  // no Discount is ever applied here, only in the Invoice.
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
