// ── Runtime line item (pick session only — not persisted) ───────────────────
export interface PickListLineItem {
  salesOrderId:     string;
  salesNo:          string;
  clientId:         string;
  clientName:       string;
  designId:         string;
  styleNo:          string;
  color:            string;
  group:            string;
  size:             string;  // always stored as String
  sleeveType?:      string;
  orderedQty:       number;
  alreadyPickedQty: number;
  balanceQty:       number;
  stockAvailable:   number;
  pickQty:          number;
  selected:         boolean;
  status:           'available' | 'partial' | 'out_of_stock' | 'pending' | 'fulfilled';
}

// ── Persisted pick list line ──────────────────────────────────────────────────
export interface PickListLine {
  salesOrderId: string;
  salesNo:      string;
  designId:     string;
  styleNo:      string;
  color:        string;
  group:        string;
  size:         string;
  sleeveType?:  string;
  orderedQty:   number;
  pickedQty:    number;
  balanceQty:   number;
  pendingQty?:  number;  // qty with no stock — awaiting future pick
}

// ── Pick List types ───────────────────────────────────────────────────────────
export type PickListType = 'direct' | 'combined' | 'itemwise';

export interface PickList {
  id?:           string;
  pickListNo:    string;
  type:          PickListType;
  salesOrderIds: string[];          // always array — use (pl.salesOrderIds ?? [(pl as any).salesOrderId]) for old docs
  salesNos:      string[];
  clientId:      string;
  clientName:    string;
  status:        'Draft' | 'Pending' | 'Partial' | 'Completed';
  // Pending  = saved but zero stock — all items awaiting stock
  // Partial  = some picked, some balance remaining
  // Completed = all items fully picked
  items:         PickListLine[];
  remarks?:      string;
  createdAt?:    any;
  updatedAt?:    any;
}