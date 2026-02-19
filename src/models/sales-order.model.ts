import { Design } from './design.model';
import type { SizePrice } from './design.model';

export type { SizePrice };

export interface OrderItemSize {
  size: string;
  quantity: number;
  price: number;
}

export interface OrderItem {
  design: Design;
  itemSizes: OrderItemSize[];
  sleeveType?: string
}

export interface SalesOrder {
  id:string;
  salesNo: string;
  clientId: string;
  deliveryDate: string;
  items: OrderItem[];
  status: 'Pending' | 'Confirmed' | 'Shipped';
  createdAt: Date
}
