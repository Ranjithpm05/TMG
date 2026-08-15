export interface DCItem {
  partName: string;
  styleNo: string;
  color: string;
  sleeveType?: string;
  sizeQty: Record<string, number>;
  total: number;
  mrp: number;
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
  transport: string;
  items: DCItem[];
  sizes: string[];
  // Set atomically inside InvoiceService.createInvoice()'s transaction to
  // prevent generating more than one Invoice per DC. A Packing List
  // produces exactly one DC, so this also caps invoices at one per Packing List.
  invoiceId?: string;
  invoiceNo?: string;
  createdAt: any;
  updatedAt: any;
}
