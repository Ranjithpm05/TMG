// LR Entry — the transporter's Lorry Receipt/Consignment Note issued for a
// Packing List's dispatch (DC generation). Captured once at DC-generation
// time (see PackingListComponent.generateAndPrintDC), then mapped to at
// most one Invoice from the Invoice screen — the relationship is strictly
// one LR Entry <-> one Invoice (enforced by LrEntryService.mapInvoiceToLrEntry),
// so `invoiceIds`/`invoiceNos` below hold at most a single entry each.
export interface LrEntry {
  id?: string;
  lrNo: string;
  lrDate: any;
  // Free-text transporter name — matches Invoice.transport exactly (both are
  // sourced from Transport Master), which is what the Invoice screen's LR
  // mapping picker filters on to decide "eligible" LR Entries for an invoice.
  transport: string;
  transportId?: string;
  vehicleNo?: string;
  packingListId: string;
  packingListNo: string;
  dcId: string;
  dcNo: string;
  clientId: string;
  clientName: string;
  // Denormalized reverse-index of every Invoice currently mapped to this LR —
  // kept in sync with each Invoice's own lrEntryId by LrEntryService's
  // mapInvoiceToLrEntry/unmapInvoiceFromLrEntry (both run as a Firestore
  // transaction so the two sides never drift apart).
  invoiceIds: string[];
  invoiceNos: string[];
  createdAt?: any;
  updatedAt?: any;
}
