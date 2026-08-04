export interface SizePrice {
  size: string;
  price: number;
  WSP: number;
  BARCODE:any
  sleeveType: string | null | undefined
  fabricType?: string;
}

export interface Design {
  id?: string;
  styleNo: string;
  color?: string;
  group?: string;
  supplierName?: string;
  supplierCode?: string;
  imageUrl?: string;
  sizes: SizePrice[];

  createdAt?: any;
  updatedAt?: any;

}
