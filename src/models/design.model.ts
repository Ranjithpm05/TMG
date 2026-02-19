export interface SizePrice {
  size: string;
  price: number;
  WSP: number;
  BARCODE:any
  sleeveType: string | undefined
  fabricType?: string;
}

export interface Design {
  id?: string;
  styleNo: string;
  color?: string;
  group?: string;
  sizes: SizePrice[];

  createdAt?: any;
  updatedAt?: any;
  
}
