// ── Runtime line item (pick session only) ────────────────────────────────────
export interface PickListLineItem {
  salesOrderId:     string;
  salesNo:          string;
  clientId:         string;
  clientName:       string;
  designId:         string;
  styleNo:          string;
  color:            string;
  group:            string;
  size:             string;
  sleeveType?:      string;
  orderedQty:       number;
  alreadyPickedQty: number;
  balanceQty:       number;
  stockAvailable:   number;
  pickQty:          number;
  selected:         boolean;
  status:           'available' | 'partial' | 'out_of_stock' | 'fulfilled';
}

// ── Persisted line ────────────────────────────────────────────────────────────
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
}

// ── Pick List document ────────────────────────────────────────────────────────
export type PickListType = 'direct' | 'combined' | 'itemwise';

export interface PickList {
  id?:           string;
  pickListNo:    string;
  type:          PickListType;
  salesOrderIds: string[];
  salesNos:      string[];
  clientId:      string;
  clientName:    string;
  status:        'Draft' | 'Partial' | 'Completed';
  items:         PickListLine[];
  remarks?:      string;
  createdAt?:    any;
  updatedAt?:    any;
}