import type { Invoice } from '../../models/invoice.model';
import type { Design, SizePrice } from '../../models/design.model';
import type { DeliveryChallanService } from '../../services/delivery-challan.service';

/**
 * One row per Invoice + DC-item + Size — the finest granularity Sales Report
 * Product-wise Format 1/2 need (Barcode/Color/Size/per-size MRP). Invoice.items
 * itself can't provide this: invoice-creation (packing-list.component.ts,
 * "qtyByMrp" grouping) already collapses every size sharing one MRP into a
 * single Invoice line, dropping color/size/barcode. Rebuilding it here reads
 * back through Invoice.dcIds -> DeliveryChallan.items (DCItem.sizeQty +
 * mrpBySize are still per-size) instead, so nothing about Invoice/DC/GST
 * document generation is touched.
 */
export interface InvoiceProductLine {
  invoiceNo: string;
  invoiceDate: Date | null;
  clientName: string;
  barcode: string;
  group: string;
  fabricDescription: string;
  styleNo: string;
  color: string;
  sleeveType: string;
  size: string;
  costPrice: number;
  mrp: number;
  wsp: number;
  qty: number;
  grossAmount1: number;
  discount: number;
  grossAmount2: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  igstRate: number;
  igstAmount: number;
  totalAmount: number;
}

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toDate(raw: any): Date | null {
  if (!raw) return null;
  try {
    const date = raw?.toDate ? raw.toDate() : new Date(raw?.seconds ? raw.seconds * 1000 : raw);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/** Builds the styleNo|color -> Design.group lookup used to enrich each reconstructed line (DCItem/SizePrice carry no group of their own). */
function buildGroupByStyleColor(designs: Design[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const design of designs) {
    const key = `${design.styleNo ?? ''}|${design.color ?? ''}`;
    map.set(key, design.group ?? '');
  }
  return map;
}

/** Same styleNo|color|size join key DesignService.getSizeEntryByStyleColorSizeMap() uses — built here from the already-loaded ReportsDataService.designs() signal instead of re-subscribing to the Design collection. */
function buildSizeEntryByStyleColorSize(designs: Design[]): Map<string, SizePrice> {
  const map = new Map<string, SizePrice>();
  for (const design of designs) {
    for (const sizeEntry of design.sizes ?? []) {
      const key = `${design.styleNo ?? ''}|${design.color ?? ''}|${sizeEntry.size ?? ''}`;
      map.set(key, sizeEntry);
    }
  }
  return map;
}

export async function buildInvoiceProductLines(
  invoices: Invoice[],
  designs: Design[],
  dcService: DeliveryChallanService
): Promise<InvoiceProductLine[]> {
  const dcIds = [...new Set(invoices.flatMap((inv) => inv.dcIds ?? []).filter(Boolean))];
  const dcs = dcIds.length ? await dcService.getDCsByIdsOnce(dcIds) : [];
  const dcById = new Map(dcs.filter((dc) => dc.id).map((dc) => [dc.id!, dc] as const));
  const groupByStyleColor = buildGroupByStyleColor(designs);
  const sizeEntryByStyleColorSize = buildSizeEntryByStyleColorSize(designs);

  const rows: InvoiceProductLine[] = [];

  for (const invoice of invoices) {
    const invoiceDate = toDate(invoice.invoiceDate);
    const discountPct = Number(invoice.discountPct) || 0;
    const cgstRate = Number(invoice.cgstRate) || 0;
    const sgstRate = Number(invoice.sgstRate) || 0;
    const igstRate = Number(invoice.igstRate) || 0;

    for (const dcId of invoice.dcIds ?? []) {
      const dc = dcById.get(dcId);
      if (!dc) continue;

      for (const dcItem of dc.items ?? []) {
        for (const [size, rawQty] of Object.entries(dcItem.sizeQty ?? {})) {
          const qty = Number(rawQty) || 0;
          if (qty <= 0) continue;

          const mrp = dcItem.mrpBySize?.[size] ?? dcItem.mrp;
          // Same MRP-split precedent used to redisplay an older multi-MRP DC
          // item (packing-list.component.ts ~line 3057-3067): recover the
          // per-size margin-adjusted price from the item's own mrp/price
          // ratio rather than re-deriving Client Margin% again here.
          const factor = dcItem.mrp > 0 && dcItem.price != null ? dcItem.price / dcItem.mrp : 1;
          const wsp = round2(mrp * factor);

          const sizeEntry: SizePrice | undefined = sizeEntryByStyleColorSize.get(`${dcItem.styleNo}|${dcItem.color}|${size}`);
          const group = groupByStyleColor.get(`${dcItem.styleNo}|${dcItem.color}`) ?? '';

          const grossAmount1 = round2(qty * wsp);
          const discount = round2((grossAmount1 * discountPct) / 100);
          const grossAmount2 = round2(grossAmount1 - discount);
          const cgstAmount = round2((grossAmount2 * cgstRate) / 100);
          const sgstAmount = round2((grossAmount2 * sgstRate) / 100);
          const igstAmount = round2((grossAmount2 * igstRate) / 100);

          rows.push({
            invoiceNo: invoice.invoiceNo,
            invoiceDate,
            clientName: invoice.clientName || 'Unknown Client',
            barcode: String(sizeEntry?.BARCODE ?? ''),
            group,
            fabricDescription: sizeEntry?.fabricType ?? '',
            styleNo: dcItem.styleNo ?? '',
            color: dcItem.color ?? '',
            sleeveType: dcItem.sleeveType ?? '',
            size,
            costPrice: Number(sizeEntry?.costPrice) || 0,
            mrp,
            wsp,
            qty,
            grossAmount1,
            discount,
            grossAmount2,
            cgstRate,
            cgstAmount,
            sgstRate,
            sgstAmount,
            igstRate,
            igstAmount,
            totalAmount: round2(grossAmount2 + cgstAmount + sgstAmount + igstAmount),
          });
        }
      }
    }
  }

  rows.sort(
    (a, b) => (a.invoiceDate?.getTime() ?? 0) - (b.invoiceDate?.getTime() ?? 0) || a.invoiceNo.localeCompare(b.invoiceNo)
  );

  return rows;
}
