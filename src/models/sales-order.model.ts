import { Design } from './design.model';
import type { SizePrice } from './design.model';

export type { SizePrice };

export interface OrderItemSize {
  size: string;
  quantity: number;
  price: number;
  WSP: number;
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
  // Customer-supplied Purchase Order number — flows through to DC/Invoice/
  // E-Invoice/E-Way Bill as their "Order No." (see DeliveryChallan.orderNo,
  // Invoice.orderNo). Optional: not every client issues a PO.
  poNumber?: string;
  deliveryDate: string;
  items: OrderItem[];
  status: 'Pending' | 'Confirmed' | 'Shipped';
  createdAt: Date
}
