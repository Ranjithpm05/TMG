export interface PickListLineItem {
  designId:       string;
  styleNo:        string;
  color:          string;
  group:          string;
  size:           string;
  sleeveType?:    string;
  orderedQty:     number;
  alreadyPickedQty: number;
  balanceQty:     number;
  stockAvailable: number;
  pickQty:        number;       // editable — what the user will pick this session
  status:         'available' | 'partial' | 'out_of_stock' | 'fulfilled';
}

export interface PickList {
  id?:          string;
  pickListNo:   string;
  salesOrderId: string;
  salesNo:      string;
  clientId:     string;
  clientName:   string;
  status:       'Draft' | 'Partial' | 'Completed';
  items:        PickListLine[];
  remarks?:     string;
  createdAt?:   any;
  updatedAt?:   any;
}

// Stored version — no runtime-only fields
export interface PickListLine {
  designId:         string;
  styleNo:          string;
  color:            string;
  group:            string;
  size:             string;
  sleeveType?:      string;
  orderedQty:       number;
  pickedQty:        number;
  balanceQty:       number;
}