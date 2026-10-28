// Sales Return — goods coming back against one or more Invoices of a customer.
//
// Firestore layout:
//   salesReturns/{returnId}            — one return entry (header + lines), SR2627-0001 numbering
//   salesReturnLedger/{invoiceId}      — qty already returned per billed line of that invoice (Posted returns only)
//   damageStock/{inventoryId}          — damaged pieces held aside; never part of inventory.currentStock
//   counters/salesReturnCounter        — same pattern as counters/invoiceCounter
//
// Stock: billed pieces left inventory.currentStock at Packing List completion
// (PackingListService.deductInventoryOnCompletion). A Fresh return puts them
// back there, exactly like DeliveryChallanService.closeBalance; a Damage return
// goes to damageStock instead so it can never be picked/sold again. Both are
// applied only when the return is Posted, and reversed only by cancelling it —
// see sales-return.engine.ts.

export type SalesReturnStatus = 'Draft' | 'Posted' | 'Cancelled';
export type SalesReturnMode = 'single' | 'multiple';
export type ReturnCondition = 'Fresh' | 'Damage';

export interface SalesReturnLine {
  invoiceId: string;
  invoiceNo: string;
  invoiceDate?: any;
  /** Billed line within its invoice — `${dcId}#${itemIndex}#${size}`, see billLineKey(). */
  lineKey: string;
  dcId: string;
  itemIndex: number;
  size: string;
  condition: ReturnCondition;
  qty: number;
  inventoryId: string;
  barcode: string;
  styleNo: string;
  color: string;
  sleeveType?: string;
  description: string;
  mrp: number;
  /** Billed unit price before invoice discount. */
  price: number;
  /** Billed qty of this line on its invoice (snapshot for display; re-checked server-side on post). */
  soldQty: number;
  location: string;
  remarks?: string;
  taxableValue: number;
  taxAmount: number;
  totalAmount: number;
}

export interface SalesReturnTotals {
  qty: number;
  freshQty: number;
  damageQty: number;
  taxableValue: number;
  taxAmount: number;
  /** taxableValue + taxAmount, before rounding to the rupee. */
  totalAmount: number;
  /** netAmount − totalAmount. Absent on returns saved before round-off existed — see returnNetAmount(). */
  roundOff?: number;
  /** totalAmount rounded to the rupee — the credit value of the return. */
  netAmount?: number;
}

export type SalesReturnEInvoiceStatus = 'generated' | 'failed' | 'cancelled';

export interface SalesReturn {
  id?: string;
  returnNo: string;
  returnSeq: number;
  /** yyyy-MM-dd, entered by the user (goods-received date). */
  returnDate: string;
  mode: SalesReturnMode;
  clientId: string;
  clientName: string;
  clientGstin?: string;
  invoiceIds: string[];
  invoiceNos: string[];
  lines: SalesReturnLine[];
  totals: SalesReturnTotals;
  status: SalesReturnStatus;
  remarks?: string;
  /** Customer's own reference for the return (e.g. their debit note no.) — printed as "Reference". */
  referenceNo?: string;
  createdBy: string;
  updatedBy?: string;
  postedBy?: string;
  postedAt?: any;
  cancelledBy?: string;
  cancelledAt?: any;
  cancelReason?: string;
  /** True once Post applied stock; set back to false when a cancel reversed it. */
  stockApplied?: boolean;
  // Credit Note e-Invoice (Doc type CRN) for a Posted return — written only by
  // SalesReturnEInvoiceService, never by the stock engine. Same fields as the
  // Invoice's own e-Invoice block.
  eInvoiceStatus?: SalesReturnEInvoiceStatus;
  irn?: string;
  ackNo?: string;
  ackDt?: string;
  signedQrCode?: string;
  signedInvoice?: string;
  eInvoicePayload?: any;
  irnGeneratedAt?: any;
  eInvoiceErrorMessage?: string;
  eInvoiceCancelReason?: string;
  eInvoiceCancelledAt?: any;
  createdAt?: any;
  updatedAt?: any;
}

export interface SalesReturnLedger {
  invoiceId: string;
  invoiceNo: string;
  /** lineKey → qty returned by Posted (not cancelled) returns, Fresh + Damage combined. */
  returned: Record<string, number>;
  returnIds: string[];
  updatedAt?: any;
}

export interface DamageStockItem {
  id?: string;
  inventoryId: string;
  barcode: string;
  styleNo: string;
  color: string;
  size: string;
  sleeveType?: string;
  qty: number;
  byLocation: Record<string, number>;
  updatedAt?: any;
}
