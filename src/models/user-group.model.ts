export type AppScreen = 'sales' | 'clients' | 'designs' | 'goodsInward' | 'inventory' | 'users';

export const ALL_SCREENS: { id: AppScreen, name: string }[] = [
  { id: 'sales', name: 'Sales Order' },
  { id: 'clients', name: 'Client Master' },
  { id: 'designs', name: 'Design Master' },
  { id: 'goodsInward', name: 'Goods Inward' },
  { id: 'users', name: 'User Management' },
  { id: 'inventory', name: 'Inventory' },
];

export interface UserGroup {
  id: string;
  name: string;
  permissions: Partial<Record<AppScreen, boolean>>;
}