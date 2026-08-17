export interface InvoiceItem {
  description: string;
  hsnSac: string;
  discountPct: number;
  taxRate: number;
  mrp: number;
  uom: string;
  quantity: number;
  price: number;
  amount: number;
}

export interface InvoiceTaxSummary {
  hsnSac: string;
  taxableValue: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  igstRate: number;
  igstAmount: number;
}

export interface Invoice {
  id?: string;
  invoiceNo: string;
  invoiceSeq: number;
  invoiceDate: any;
  dcNo: string;
  dcId?: string;
  packingListId: string;
  packingListNo: string;
  salesOrderIds: string[];
  salesNos: string[];
  orderNo: string;
  clientId: string;
  clientName: string;
  clientAddress: string;
  clientPlace: string;
  clientState: string;
  clientZipCode: string;
  clientPhone: string;
  clientGstin: string;
  destination: string;
  // Transport Master fields — see PackingList.transport/transportId for how
  // these are sourced.
  transport: string;
  transportId?: string;
  transportAddress?: string;
  transportGstNo?: string;
  vehicleNo: string;
  docNo: string;
  shipmentDate: any;
  totalPkgs: number;
  agentName: string;
  items: InvoiceItem[];
  grossAmount: number;
  discountPct: number;
  discountAmount: number;
  taxableValue: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  igstRate: number;
  igstAmount: number;
  totalTaxAmount: number;
  roundOff: number;
  totalAmount: number;
  amountInWords: string;
  taxSummary: InvoiceTaxSummary[];
  // E-Invoice fields
  eInvoiceStatus?: 'pending' | 'generated' | 'cancelled';
  irn?: string;
  irnGeneratedAt?: any;
  ackNo?: string;
  ackDt?: string;
  signedQrCode?: string;
  eInvoicePayload?: any;
  cancelReason?: string;
  cancelledAt?: any;
  createdAt?: any;
  updatedAt?: any;
}
