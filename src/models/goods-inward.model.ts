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
  status: 'Draft' | 'Received';
  remarks?: string;
  createdAt?: any;
  updatedAt?: any;
}