import Swal from 'sweetalert2';
import { Invoice, InvoiceItem } from '../../models/invoice.model';

// Exact two-row header of TallyInvoice.XLSX (sheet "REPORT"), column-for-column (A..AR).
const HEADER_ROW_1 = [
  'Supplier', 'Supplier', 'VchDate', 'Invoice No.', 'State Name', 'GSTIN', 'pin', 'Customer Name', 'Code',
  'ADDRESS1', 'Address2', 'Voucher Type', 'Product Name', 'Product Name/Alais', 'stock', 'category', 'MRP',
  'HSNCODE', 'Units', 'godown', 'batch', 'mfg date', 'expdate', 'serialno\\ItemDescription', 'Actual', 'Billed ',
  'Rate', 'Amount', 'CGST %', 'CGST', 'SGST %', 'SGST', 'IGST %', 'IGST', 'cess', 'TCS', 'Accounting', 'Ledger1',
  'Ledger2', 'ExpLed1', 'ExpLed2', 'Vch', 'GST', 'Cess',
];
// Built by explicit column index (0=A .. 43=AR) rather than a hand-counted blank
// run, since a single miscounted blank silently shifts every column after it.
const HEADER_ROW_2: string[] = new Array(44).fill('');
Object.assign(HEADER_ROW_2, {
  0: 'Inv.No', 1: 'Inv.Date', 2: 'Date', 4: 'Name', 5: 'No', 6: 'code', 7: 'p', 8: 'Alais',
  14: 'group(NEWLYADDED)', 15: 'category', 16: '(NEWLADDED',
  21: 'mfg date', 22: 'expdate',
  24: 'Qty', 25: 'Qty',
  36: 'LEDGER', 37: 'INCOME', 38: 'INCOME', 39: 'EXPENSES', 40: 'EXPENSES',
  41: 'Narration', 43: 'Per',
});

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** "D-M-YYYY", no zero-padding — matches every date cell in the reference Tally sheet. */
function formatTallyDate(raw: any): string {
  if (!raw) return '';
  let d: Date;
  if (raw?.toDate) d = raw.toDate();
  else if (raw?.seconds) d = new Date(raw.seconds * 1000);
  else if (raw instanceof Date) d = raw;
  else d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  return `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
}

/** Tally stores pin codes / HSN codes as plain numbers when they round-trip losslessly; keeps leading zeros as text otherwise. */
function toNumericIfSafe(value: string | number | undefined | null): string | number {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s) && String(Number(s)) === s) return Number(s);
  return s;
}

function formatTimestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * One Tally row per invoice item. The invoice only tracks a single discount %
 * and CGST/SGST/IGST rate for the whole invoice (see packing-list.component's
 * generateInvoice), so each item's Rate/Amount is netted down by that discount
 * — the Tally template has no separate discount column, and its own reference
 * rows show Amount tying directly to Rate*Qty with tax computed straight off it.
 */
function buildItemRow(invoice: Invoice, item: InvoiceItem, clientCode: string): (string | number)[] {
  const dateStr = formatTallyDate(invoice.invoiceDate);
  const discountFactor = 1 - (invoice.discountPct || 0) / 100;
  const netAmount = r2(item.amount * discountFactor);
  const netRate = item.quantity ? r2(netAmount / item.quantity) : r2(item.price * discountFactor);

  const isInterstate = (invoice.igstRate || 0) > 0;
  const cgstRate = isInterstate ? 0 : invoice.cgstRate || 0;
  const sgstRate = isInterstate ? 0 : invoice.sgstRate || 0;
  const igstRate = isInterstate ? invoice.igstRate || 0 : 0;
  const cgstAmt = r2(netAmount * cgstRate / 100);
  const sgstAmt = r2(netAmount * sgstRate / 100);
  const igstAmt = r2(netAmount * igstRate / 100);
  const ledgerName = isInterstate ? 'Local IGST Sales' : 'Local GST Sales';
  const totalGstRate = item.taxRate || cgstRate + sgstRate + igstRate;

  return [
    invoice.invoiceNo, dateStr, dateStr, invoice.invoiceNo,
    invoice.clientState, invoice.clientGstin, toNumericIfSafe(invoice.clientZipCode),
    invoice.clientName, clientCode || '',
    invoice.clientAddress, '',
    'SALES',
    item.description, '', '', '',
    item.mrp || '',
    toNumericIfSafe(item.hsnSac),
    item.uom || 'NOS',
    '', '', '', '', '',
    '', item.quantity,
    netRate, netAmount,
    cgstRate, cgstAmt, sgstRate, sgstAmt, igstRate, igstAmt,
    0, 0,
    ledgerName,
    0, 0, 0, 0,
    invoice.invoiceNo,
    totalGstRate,
    '',
  ];
}

export function buildTallyRows(invoices: Invoice[], clientCodeByClientId: Map<string, string>): (string | number)[][] {
  const rows: (string | number)[][] = [HEADER_ROW_1, HEADER_ROW_2];
  for (const invoice of invoices) {
    const clientCode = clientCodeByClientId.get(invoice.clientId) || '';
    for (const item of invoice.items) {
      rows.push(buildItemRow(invoice, item, clientCode));
    }
  }
  return rows;
}

/** Builds and downloads a Tally-import-compatible .xlsx for one or more invoices (single/all export share this). */
export async function exportInvoicesToTally(
  invoices: Invoice[],
  clientCodeByClientId: Map<string, string>,
  fileNamePrefix: string
): Promise<void> {
  try {
    const rows = buildTallyRows(invoices, clientCodeByClientId);
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'REPORT');
    XLSX.writeFile(wb, `${fileNamePrefix.replace(/\s+/g, '_')}_${formatTimestamp()}.xlsx`);
  } catch {
    Swal.fire({ icon: 'error', title: 'Export Failed', text: 'Could not generate the Tally Excel file.' });
  }
}
