export type AppScreen = 'sales' | 'clients' | 'designs' | 'transportMaster' | 'goodsInward' | 'inventory' | 'pickList' | 'packingList' | 'users' | 'einvoice' | 'reports';

export const ALL_SCREENS: { id: AppScreen, name: string }[] = [
  { id: 'sales',       name: 'Sales Order' },
  { id: 'clients',     name: 'Client Master' },
  { id: 'designs',     name: 'Design Master' },
  { id: 'transportMaster', name: 'Transport Master' },
  { id: 'goodsInward', name: 'Goods Inward' },
  { id: 'inventory',   name: 'Inventory' },
  { id: 'pickList',    name: 'Pick List' },
  { id: 'packingList', name: 'Packing List' },
  { id: 'users',       name: 'User Management' },
  { id: 'einvoice',    name: 'E-Invoice' },
  { id: 'reports',     name: 'Reports' },
];

export interface UserGroup {
  id: string;
  name: string;
  permissions: Partial<Record<AppScreen, boolean>>;
  // Protected system role: unrestricted access to every screen. Only Super Admins
  // may create/edit/delete this group or manage users assigned to it.
  isSuperAdmin?: boolean;
}
