import Swal from 'sweetalert2';
import { Invoice } from '../../models/invoice.model';
import { PackingList } from '../../models/packing-list.model';
import { SizePrice } from '../../models/design.model';

// Column order matches the "PT FILE FORMAT.xls" reference template exactly.
const HEADERS = [
  'BILL NO', 'BILL DATE', 'BARCODE', 'Group', 'FabricDescription', 'STYLE NO', 'Color',
  'SLEEVETYPE', 'Size', 'BILL QTY', 'MRP', 'WSP', 'GROSS', 'DISC', 'GROSS2', 'TAX', 'NET AMOUNT',
];

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** "DD-MM-YYYY", zero-padded — matches every date cell in the PT File Format reference. */
function formatPtDate(raw: any): string {
  if (!raw) return '';
  let d: Date;
  if (raw?.toDate) d = raw.toDate();
  else if (raw?.seconds) d = new Date(raw.seconds * 1000);
  else if (raw instanceof Date) d = raw;
  else d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function formatTimestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface PtFileSizeMaps {
  byBarcode: Map<string, SizePrice>;
  byStyleColorSize: Map<string, SizePrice>;
}

/**
 * One PT row per Packing List line — Invoice.items is aggregated by
 * style+MRP across sizes (see packing-list.component's generateInvoice) and
 * carries no barcode/WSP/fabric columns, so this reads back the source
 * Packing List's lines (already one row per barcode/size, with the actual
 * billed quantity in packedQty) and joins Design Master for MRP/WSP/Fabric.
 */
function buildInvoiceRows(invoice: Invoice, packingList: PackingList | undefined, sizeMaps: PtFileSizeMaps): (string | number)[][] {
  const lines = (packingList?.items ?? []).filter((line) => line.packedQty > 0);
  const billNo = invoice.invoiceNo;
  const billDate = formatPtDate(invoice.invoiceDate);
  // The invoice tracks one discount % and one CGST/SGST-or-IGST rate for the
  // whole invoice (see generateInvoice) — cgstRate+sgstRate and igstRate are
  // mutually exclusive, so summing all three always yields the single total
  // GST % that was applied.
  const totalTaxRate = (invoice.cgstRate || 0) + (invoice.sgstRate || 0) + (invoice.igstRate || 0);
  const discountPct = invoice.discountPct || 0;

  return lines.map((line) => {
    const sizeEntry = (line.barcode && sizeMaps.byBarcode.get(line.barcode))
      || sizeMaps.byStyleColorSize.get(`${line.styleNo}|${line.color}|${line.size}`);
    const mrp = sizeEntry?.price ?? 0;
    const wsp = sizeEntry?.WSP ?? 0;
    const qty = line.packedQty;
    const gross = r2(wsp * qty);
    const disc = r2(gross * discountPct / 100);
    const gross2 = r2(gross - disc);
    const tax = r2(gross2 * totalTaxRate / 100);
    const netAmount = r2(gross2 + tax);

    return [
      billNo, billDate,
      line.barcode || sizeEntry?.BARCODE || '',
      line.partName || '',
      sizeEntry?.fabricType || '',
      line.styleNo || '',
      line.color || '-',
      line.sleeveType || sizeEntry?.sleeveType || '',
      line.size || '',
      qty, mrp, wsp, gross, disc, gross2, tax, netAmount,
    ];
  });
}

export function buildPtFileRows(invoices: Invoice[], packingListsById: Map<string, PackingList>, sizeMaps: PtFileSizeMaps): (string | number)[][] {
  const rows: (string | number)[][] = [HEADERS];
  for (const invoice of invoices) {
    rows.push(...buildInvoiceRows(invoice, packingListsById.get(invoice.packingListId), sizeMaps));
  }
  return rows;
}

/** Builds and downloads a PT-File-Format .xlsx for one or more invoices (single/all export share this). */
export async function exportInvoicesToPtFile(
  invoices: Invoice[],
  packingListsById: Map<string, PackingList>,
  sizeMaps: PtFileSizeMaps,
  fileNamePrefix: string
): Promise<void> {
  try {
    const rows = buildPtFileRows(invoices, packingListsById, sizeMaps);
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PT FILE');
    XLSX.writeFile(wb, `${fileNamePrefix.replace(/\s+/g, '_')}_${formatTimestamp()}.xlsx`);
  } catch {
    Swal.fire({ icon: 'error', title: 'Export Failed', text: 'Could not generate the PT File.' });
  }
}
