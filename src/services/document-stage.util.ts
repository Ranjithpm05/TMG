import { DeliveryChallan } from '../models/delivery-challan.model';
import { Invoice } from '../models/invoice.model';

export type StageStatus = 'pending' | 'generated' | 'failed' | 'cancelled' | 'not-started';

export interface DocumentStage {
  key: 'dc' | 'invoice' | 'eInvoice' | 'ewayBill';
  label: string;
  status: StageStatus;
}

// Single source of truth for how the DC -> Invoice -> E-Invoice -> E-Way Bill
// chain is summarized across the Packing List, E-Invoice and E-Way Bill
// screens, so all three read the same stage from the same fields instead of
// re-deriving slightly different logic in each component.
export function getDocumentStages(dc: DeliveryChallan | null | undefined, invoice: Invoice | null | undefined): DocumentStage[] {
  return [
    {
      key: 'dc',
      label: 'DC',
      status: dc ? 'generated' : 'not-started',
    },
    {
      key: 'invoice',
      label: 'Invoice',
      status: invoice ? 'generated' : 'not-started',
    },
    {
      key: 'eInvoice',
      label: 'E-Invoice',
      status: !invoice ? 'not-started' : (invoice.eInvoiceStatus || 'pending'),
    },
    {
      key: 'ewayBill',
      label: 'E-Way Bill',
      status: !invoice?.eInvoiceStatus || invoice.eInvoiceStatus !== 'generated'
        ? 'not-started'
        : (invoice.ewbStatus || 'pending'),
    },
  ];
}

export function getStageBadgeClass(status: StageStatus): string {
  const map: Record<StageStatus, string> = {
    generated: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
    pending: 'bg-amber-100 text-amber-700 border border-amber-200',
    failed: 'bg-rose-100 text-rose-700 border border-rose-200',
    cancelled: 'bg-slate-200 text-slate-600 border border-slate-300',
    'not-started': 'bg-slate-50 text-slate-400 border border-slate-200',
  };
  return map[status] ?? map['not-started'];
}

export function getStageStatusLabel(status: StageStatus): string {
  const map: Record<StageStatus, string> = {
    generated: 'Generated',
    pending: 'Pending',
    failed: 'Failed',
    cancelled: 'Cancelled',
    'not-started': '—',
  };
  return map[status] ?? '—';
}
