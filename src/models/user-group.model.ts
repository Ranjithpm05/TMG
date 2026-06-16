export type AppScreen = 'sales' | 'clients' | 'designs' | 'goodsInward' | 'inventory' | 'pickList' | 'packingList' | 'users' | 'einvoice';

export const ALL_SCREENS: { id: AppScreen, name: string }[] = [
  { id: 'sales',       name: 'Sales Order' },
  { id: 'clients',     name: 'Client Master' },
  { id: 'designs',     name: 'Design Master' },
  { id: 'goodsInward', name: 'Goods Inward' },
  { id: 'inventory',   name: 'Inventory' },
  { id: 'pickList',    name: 'Pick List' },
  { id: 'packingList', name: 'Packing List' },
  { id: 'users',       name: 'User Management' },
  { id: 'einvoice',    name: 'E-Invoice' },
];

export interface UserGroup {
  id: string;
  name: string;
  permissions: Partial<Record<AppScreen, boolean>>;
}
