export interface GoodsInwardItem {
  designId: string;
  styleNo: string;
  color: string;
  group: string;
  size: string;
  sleeveType?: string;
  barcode: string;
  fabricType: string;
  receivedQty: number;
  WSP: number;
  price: number;
}

export interface GoodsInward {
  id?: string;
  grnNo: string;
  supplierId?: string;
  supplierName: string;
  invoiceNo: string;
  invoiceDate: string;
  receivedDate: string;
  items: GoodsInwardItem[];
  status: 'Pending' | 'Approving' | 'Approved';
  // Set while an approval is applying inventory in chunks; lets a concurrent/retried
  // approval attempt detect the in-flight lock instead of double-applying inventory.
  approvalLock?: {
    lockId: string;
    chunksDone: number;
    totalChunks: number;
    lastProgressAt: any;
  };
  approvedBy?: string;
  approvedAt?: any;
  remarks?: string;
  createdAt?: any;
  updatedAt?: any;
}