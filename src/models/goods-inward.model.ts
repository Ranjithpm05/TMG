export interface GoodsInwardItem {
  designId: string;
  styleNo: string;
  color: string;
  group: string;
  size: string;
  barcode: string;
  fabricType: string;
  expectedQty: number;
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
  status: 'Draft' | 'Received' | 'Partially Received';
  remarks?: string;
  createdAt?: any;
  updatedAt?: any;
}