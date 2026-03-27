export interface InventoryItem {
  id?: string;
  barcode: string;
  designId: string;
  styleNo: string;
  color: string;
  group: string;
  size: string;
  sleeveType?: string;
  fabricType: string;
  currentStock: number;
  totalReceived: number;
  WSP: number;
  price: number;
  lastGrnNo?: string;
  createdAt?: any;
  updatedAt?: any;
}