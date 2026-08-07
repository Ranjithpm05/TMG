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
  // True only for lines created ad-hoc during Party-wise scanning of a
  // barcode that wasn't part of the originally generated pick list.
  isAdditional?: boolean;
}

export type PickListType = 'direct' | 'combined' | 'itemwise' | 'party';

export interface PickList {
  id?: string;
  pickListNo: string;
  type: PickListType;
  salesOrderIds: string[];
  salesNos: string[];
  clientId: string;
  clientName: string;
  status: 'Draft' | 'Pending' | 'Partial' | 'Completed' | 'Packed';
  totalRequiredQty?: number;
  totalPickedQty?: number;
  totalPendingQty?: number;
  // Sum of pickedQty across isAdditional lines — kept separate from
  // totalPickedQty so completion % still reflects genuine SO fulfillment.
  totalAdditionalPickedQty?: number;
  pickableLineCount?: number;
  completedLineCount?: number;
  orderSummaries?: PickListOrderSummary[];
  inventoryReserved?: boolean;
  legacyPickingPending?: boolean;
  items: PickListLine[];
  remarks?: string;
  // Set once this pick list has been combined/converted into a Packing List,
  // so it can't be picked again for another packing list.
  packedIntoPackingListId?: string;
  packedIntoPackingListNo?: string;
  // Stamped by the explicit "Complete Pick List" action (Party-wise type),
  // which force-closes a list regardless of remaining pending quantity.
  finalizedAt?: number;
  finalizedByUserId?: string;
  finalizedByUsername?: string;
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
