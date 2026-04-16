export type PackingListLineStatus = 'ready' | 'in_progress' | 'completed';

export interface PackingListLine {
  lineId: string;
  pickListLineId: string;
  salesOrderIds: string[];
  salesNos: string[];
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
  entries: PackingCartonEntry[];
  createdAt?: any;
  updatedAt?: any;
}

export interface PackingPartSummary {
  partName: string;
  requiredQty: number;
  packedQty: number;
}

export interface PackingList {
  id?: string;
  packingListNo: string;
  pickListId: string;
  pickListNo: string;
  salesOrderIds: string[];
  salesNos: string[];
  clientId: string;
  clientName: string;
  status: 'Draft' | 'Partial' | 'Completed';
  totalRequiredQty: number;
  totalPackedQty: number;
  lineCount: number;
  completedLineCount: number;
  cartonCount: number;
  partSummaries: PackingPartSummary[];
  cartons: PackingCarton[];
  items: PackingListLine[];
  remarks?: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface PackingScanResult {
  line: PackingListLine;
  carton: PackingCarton;
  lineCompleted: boolean;
  packingListCompleted: boolean;
  totalPackedQty: number;
  completedLineCount: number;
  cartonCount: number;
  status: PackingList['status'];
  partSummaries: PackingPartSummary[];
}
