export type AppScreen = 'sales' | 'clients' | 'designs' | 'transportMaster' | 'goodsInward' | 'inventory' | 'pickList' | 'packingList' | 'users' | 'einvoice' | 'ewayBill' | 'salesReportProductWise1' | 'salesReportProductWise2' | 'salesOrderSupplyPendingReport' | 'pendingOrderCustomerWiseReport' | 'customerWiseReport' | 'agentWiseReport' | 'productWiseReport' | 'exceedOrderReport' | 'styleWiseReport' | 'styleCustomerWiseReport' | 'pickListWiseReport' | 'hsnGstWiseReport';

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
  { id: 'ewayBill',    name: 'E-Way Bill' },
  { id: 'customerWiseReport', name: 'Report - Customer Wise' },
  { id: 'agentWiseReport', name: 'Report - Agent Wise' },
  { id: 'salesReportProductWise1', name: 'Report - Product-wise Format 1' },
  { id: 'salesReportProductWise2', name: 'Report - Product-wise Format 2' },
  { id: 'productWiseReport', name: 'Report - Product Wise' },
  { id: 'salesOrderSupplyPendingReport', name: 'Report - Sales Order vs Supply vs Pending' },
  { id: 'pendingOrderCustomerWiseReport', name: 'Report - Pending Orders Customer-wise' },
  { id: 'exceedOrderReport', name: 'Report - Exceed Order' },
  { id: 'styleWiseReport', name: 'Report - Style No. Wise' },
  { id: 'styleCustomerWiseReport', name: 'Report - Style No. & Customer Wise' },
  { id: 'pickListWiseReport', name: 'Report - Pick List Wise' },
  { id: 'hsnGstWiseReport', name: 'Report - HSN / GST Wise' },
];

export interface UserGroup {
  id: string;
  name: string;
  permissions: Partial<Record<AppScreen, boolean>>;
  // Protected system role: unrestricted access to every screen. Only Super Admins
  // may create/edit/delete this group or manage users assigned to it.
  isSuperAdmin?: boolean;
}
