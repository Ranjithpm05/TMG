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
  // Cumulative quantity from this line already carried into some Packing
  // List (a Pick List — Party-wise in particular — can be packed in several
  // batches over time, so this can be less than pickedQty). Used to compute
  // how much is still "picked but not yet packed" when generating the next
  // Packing List, so the same physical units are never packed twice.
  packedIntoPackingListsQty?: number;
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
  // A Pick List may be packed in several batches, generating many Packing
  // Lists over time (see PackingListService.createGeneratedPackingList) — so
  // 'Completed' here means every required unit has actually flowed through
  // to a Packing List, not merely that one Packing List was made. There is
  // no "already packed, can't pack again" terminal state for a Pick List.
  status: 'Draft' | 'Pending' | 'Partial' | 'Completed';
  totalRequiredQty?: number;
  totalPickedQty?: number;
  totalPendingQty?: number;
  // Sum of pickedQty across isAdditional lines — kept separate from
  // totalPickedQty so completion % still reflects genuine SO fulfillment.
  totalAdditionalPickedQty?: number;
  // Sum of packedIntoPackingListsQty across lines — how much of this Pick
  // List's picked quantity has actually been carried into some Packing List
  // so far. Drives Party-wise status: Completed only once this reaches
  // totalRequiredQty, not merely once picking itself is done.
  totalPackedIntoPackingListsQty?: number;
  pickableLineCount?: number;
  completedLineCount?: number;
  orderSummaries?: PickListOrderSummary[];
  inventoryReserved?: boolean;
  legacyPickingPending?: boolean;
  // Legacy field: a full duplicate of every line's data, once written on
  // every recalculate/finalize. This is what pushed real pick-list documents
  // past Firestore's 1 MiB limit (see project memory on the 1 MiB fix) — no
  // longer written for new docs (replaced by totalRemainingQty/
  // pickedByLineKey/partGroups below, which cover every real consumer at a
  // fraction of the size). Only present on documents that predate that fix;
  // normalizePickList() derives the same info from the `lines` subcollection
  // fallback when this is absent, so it never needs to be read directly.
  items?: PickListLine[];
  // Sum of remainingQty across all lines — replaces summing over `items` for
  // the Dashboard's "Reserved" inventory tile.
  totalRemainingQty?: number;
  // pickedQty summed per `${salesOrderId}||${styleNo}||${color}||${size}||${sleeveType}`
  // key — replaces scanning `items` to find how much of a given order/style/
  // size combo has already been picked (used when generating a new Pick List
  // so already-picked balance isn't re-offered).
  pickedByLineKey?: Record<string, number>;
  // Distinct, trimmed `group` values across all lines — replaces scanning
  // `items` to count how many distinct parts/groups a Pick List spans.
  partGroups?: string[];
  remarks?: string;
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
