// One valuation of a Sales Return as a GST credit note, shared by the Sales
// Return PDF and the Credit Note e-Invoice (Doc type CRN) so both always show
// the same figures as the return itself: every line keeps the taxable value
// and GST the return stored for it (sales-return.engine.ts lineAmounts, at its
// own invoice's discount and rate) — only the CGST/SGST vs IGST split and the
// HSN code are added here, both taken from the original invoice.

import type { Invoice } from '../models/invoice.model';
import type { SalesReturn, SalesReturnLine } from '../models/sales-return.model';
import { resolveHsnCode } from '../models/hsn-code.model';
import { round2 } from './sales-return.engine';

export interface CreditNoteItem {
  line: SalesReturnLine;
  hsnSac: string;
  uom: string;
  gstRate: number;
  /** qty × price, before the invoice discount. */
  grossAmount: number;
  discount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
}

export interface CreditNote {
  items: CreditNoteItem[];
  isInterState: boolean;
  grossAmount: number;
  discount: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  taxAmount: number;
  roundOff: number;
  netAmount: number;
}

/**
 * Whether the original sale was inter-state. Trusts what the IRP accepted for
 * that invoice when it was e-invoiced, else the invoice's own rates (set from
 * the same Place-of-Supply resolution at invoice generation).
 */
export function invoiceIsInterState(invoice: Pick<Invoice, 'igstRate' | 'eInvoicePayload'>): boolean {
  const val = invoice.eInvoicePayload?.ValDtls;
  if (val) return (Number(val.IgstVal) || 0) > 0;
  return (Number(invoice.igstRate) || 0) > 0;
}

function invoiceItemFor(invoice: Invoice | undefined, line: SalesReturnLine) {
  const items = invoice?.items ?? [];
  return items.find((i) => (i.styleNo ?? '') === line.styleNo && (i.sleeveType ?? '') === (line.sleeveType ?? '') && Number(i.mrp) === line.mrp)
    ?? items.find((i) => (i.styleNo ?? '') === line.styleNo && Number(i.mrp) === line.mrp)
    ?? items.find((i) => (i.description ?? '').toUpperCase() === (line.description ?? '').toUpperCase());
}

export function buildCreditNote(ret: Pick<SalesReturn, 'lines'>, invoicesById: Map<string, Invoice>, isInterState: boolean): CreditNote {
  const items = (ret.lines ?? []).map((line): CreditNoteItem => {
    const invoice = invoicesById.get(line.invoiceId);
    const invItem = invoiceItemFor(invoice, line);
    const gstRate = invItem?.taxRate
      ?? ((Number(invoice?.cgstRate) || 0) + (Number(invoice?.sgstRate) || 0) + (Number(invoice?.igstRate) || 0));
    const grossAmount = round2(line.qty * line.price);
    const taxAmount = round2(line.taxAmount);
    const cgstAmount = isInterState ? 0 : round2(taxAmount / 2);
    return {
      line,
      hsnSac: resolveHsnCode(line.description, invItem?.hsnSac ?? invoice?.items?.[0]?.hsnSac ?? ''),
      uom: invItem?.uom || 'NOS',
      gstRate: Number(gstRate) || 0,
      grossAmount,
      discount: round2(grossAmount - line.taxableValue),
      cgstAmount,
      sgstAmount: isInterState ? 0 : round2(taxAmount - cgstAmount),
      igstAmount: isInterState ? taxAmount : 0,
    };
  });

  const sum = (pick: (i: CreditNoteItem) => number) => round2(items.reduce((s, i) => s + pick(i), 0));
  const taxableValue = sum((i) => i.line.taxableValue);
  const cgstAmount = sum((i) => i.cgstAmount);
  const sgstAmount = sum((i) => i.sgstAmount);
  const igstAmount = sum((i) => i.igstAmount);
  const taxAmount = round2(cgstAmount + sgstAmount + igstAmount);
  const total = round2(taxableValue + taxAmount);
  const netAmount = Math.round(total);
  return {
    items, isInterState,
    grossAmount: sum((i) => i.grossAmount),
    discount: sum((i) => i.discount),
    taxableValue, cgstAmount, sgstAmount, igstAmount, taxAmount,
    roundOff: round2(netAmount - total),
    netAmount,
  };
}
