export type PackingListLineStatus = 'ready' | 'in_progress' | 'completed';
export type PackingMode = 'customer' | 'order';

export interface PackingListLineSource {
  pickListId: string;
  pickListLineId: string;
  qty: number;
}

export interface PackingListLine {
  lineId: string;
  pickListLineId: string;
  salesOrderIds: string[];
  salesNos: string[];
  clientId?: string;
  clientName?: string;
  designId: string;
  styleNo: string;
  color: string;
  partName: string;
  size: string;
  sleeveType?: string;
  barcode?: string;
  inventoryId?: string;
  pickedQty: number;
  requiredQty: number;
  packedQty: number;
  remainingQty: number;
  status: PackingListLineStatus;
  lastCartonNo?: string;
  sortOrder?: number;
  createdAt?: any;
  updatedAt?: any;
  // Exactly which Pick List line(s) — possibly from more than one Pick List
  // (the "combine" flow) and across multiple packing batches over time —
  // contributed how much quantity to this line. Lets reports trace Packed
  // Qty back to a specific Sales Order/additional Pick List line without
  // re-deriving a guess from style/color/size alone.
  sources?: PackingListLineSource[];
}

export interface PackingCartonEntry {
  lineId: string;
  pickListLineId: string;
  salesOrderIds: string[];
  salesNos: string[];
  styleNo: string;
  color: string;
  partName: string;
  size: string;
  sleeveType?: string;
  barcode?: string;
  qty: number;
}

export interface PackingCarton {
  cartonNo: string;
  totalQty: number;
  cartonStatus: 'open' | 'sealed';
  entries: PackingCartonEntry[];
  createdAt?: any;
  updatedAt?: any;
}

export interface PackingPartyProgress {
  salesOrderId: string;
  salesNo: string;
  clientId?: string;
  clientName: string;
  requiredQty: number;
  packedQty: number;
  pendingQty: number;
}

export interface PackingPartSummary {
  partName: string;
  requiredQty: number;
  packedQty: number;
}

export interface PackingList {
  id?: string;
  packingListNo: string;
  // Singular fields kept for backward compatibility — always derived as
  // pickListIds[0]/pickListNos[0]. Prefer the arrays below for new code since
  // a packing list can now be combined from multiple source pick lists.
  pickListId: string;
  pickListNo: string;
  pickListIds: string[];
  pickListNos: string[];
  salesOrderIds: string[];
  salesNos: string[];
  clientId: string;
  clientName: string;
  packingMode: PackingMode;
  status: 'Draft' | 'Partial' | 'Completed';
  totalRequiredQty: number;
  totalPackedQty: number;
  lineCount: number;
  completedLineCount: number;
  cartonCount: number;
  partSummaries: PackingPartSummary[];
  partyProgress?: PackingPartyProgress[];
  cartons: PackingCarton[];
  items: PackingListLine[];
  agentName?: string;
  // Transport Master fields — transport is the transporter name, kept for
  // backward compatibility with documents created before Transport Master
  // existed; transportId/transportAddress/transportGstNo are looked up from
  // Transport Master and carried through to the DC/Invoice created from this
  // Packing List.
  transport?: string;
  transportId?: string;
  transportAddress?: string;
  transportGstNo?: string;
  qcVerifiedAt?: any;
  stockDeducted?: boolean;
  remarks?: string;
  // Keys ("salesOrderId" or "__all__" for the no-party single-DC case) that
  // already have a DC generated — checked-and-appended atomically inside
  // DeliveryChallanService.createDC()'s transaction to prevent duplicate DCs
  // for the same (Packing List, Sales Order) combination.
  dcGeneratedKeys?: string[];
  // Set atomically inside InvoiceService.createInvoice()'s transaction to
  // prevent generating more than one Invoice per Packing List.
  invoiceId?: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface PackingScanResult {
  line: PackingListLine;
  carton: PackingCarton;
  lineCompleted: boolean;
  packingListCompleted: boolean;
  stockDeducted: boolean;
  totalPackedQty: number;
  completedLineCount: number;
  cartonCount: number;
  status: PackingList['status'];
  partSummaries: PackingPartSummary[];
  partyProgress: PackingPartyProgress[];
}