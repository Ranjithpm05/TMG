export type PickListDraftLineStatus = 'ready' | 'pending_stock' | 'blocked';
export type PickListLineStatus = 'pending_stock' | 'ready' | 'in_progress' | 'completed' | 'blocked';

export interface PickListLineItem {
  lineId: string;
  salesOrderId: string;
  salesNo: string;
  clientId: string;
  clientName: string;
  designId: string;
  styleNo: string;
  color: string;
  group: string;
  size: string;
  sleeveType?: string;
  orderedQty: number;
  alreadyPickedQty: number;
  balanceQty: number;
  stockAvailable: number;
  requiredQty: number;
  pendingQty: number;
  barcode?: string;
  inventoryId?: string;
  selected: boolean;
  status: PickListDraftLineStatus;
}

export interface PickListOrderSummary {
  salesOrderId: string;
  salesNo: string;
  clientId: string;
  clientName: string;
  requiredQty: number;
  pickedQty: number;
  pendingQty: number;
}

export interface PickListLine {
  lineId: string;
  salesOrderId: string;
  salesNo: string;
  clientId?: string;
  clientName?: string;
  designId: string;
  styleNo: string;
  color: string;
  group: string;
  size: string;
  sleeveType?: string;
  barcode?: string;
  inventoryId?: string;
  orderedQty: number;
  requiredQty: number;
  pickedQty: number;
  remainingQty: number;
  balanceQty: number;
  pendingQty?: number;
  status: PickListLineStatus;
  claimedByUserId?: string;
  claimedByUsername?: string;
  claimExpiresAt?: number;
  completedAt?: number;
  completedByUserId?: string;
  completedByUsername?: string;
  sortOrder?: number;
  createdAt?: any;
  updatedAt?: any;
}

export type PickListType = 'direct' | 'combined' | 'itemwise';

export interface PickList {
  id?: string;
  pickListNo: string;
  type: PickListType;
  salesOrderIds: string[];
  salesNos: string[];
  clientId: string;
  clientName: string;
  status: 'Draft' | 'Pending' | 'Partial' | 'Completed';
  totalRequiredQty?: number;
  totalPickedQty?: number;
  totalPendingQty?: number;
  pickableLineCount?: number;
  completedLineCount?: number;
  orderSummaries?: PickListOrderSummary[];
  items: PickListLine[];
  remarks?: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface PickListClaimUser {
  id: string;
  username: string;
}

export interface PickListScanResult {
  line: PickListLine;
  lineCompleted: boolean;
  pickListCompleted: boolean;
  orderCompleted: boolean;
  salesOrderId: string;
}
