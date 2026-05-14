export interface DCItem {
  partName: string;
  styleNo: string;
  color: string;
  sizeQty: Record<string, number>;
  total: number;
}

export interface DeliveryChallan {
  id?: string;
  dcNo: string;
  dcSeq: number;
  packingListId: string;
  packingListNo: string;
  salesOrderId: string;
  salesNo: string;
  clientId: string;
  clientName: string;
  billingAddress: string;
  place: string;
  state: string;
  zipCode: string;
  clientPhone: string;
  clientGstin: string;
  packedOn: any;
  totalQty: number;
  boxCount: number;
  agentName: string;
  transport: string;
  items: DCItem[];
  sizes: string[];
  createdAt: any;
  updatedAt: any;
}
