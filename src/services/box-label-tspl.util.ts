import { PackingList } from '../models/packing-list.model';
import { DeliveryChallan } from '../models/delivery-challan.model';

/** Printer-level settings for the Box Label TSPL print flow — persisted per workstation (localStorage), not per user. */
export interface BoxLabelPrinterSettings {
  printerName: string;
  labelWidthMm: number;
  labelHeightMm: number;
  gapMm: number;
  /** TSC DENSITY, 1 (lightest) – 15 (darkest). */
  densityLevel: number;
  /** TSC SPEED, in inches/second — typical range 1–6 depending on model. */
  speedLevel: number;
  dpi: 203 | 300;
}

export const DEFAULT_BOX_LABEL_SETTINGS: BoxLabelPrinterSettings = {
  printerName: '',
  labelWidthMm: 235,
  labelHeightMm: 105,
  gapMm: 3,
  densityLevel: 8,
  speedLevel: 4,
  dpi: 203,
};

const STORAGE_KEY = 'boxLabelPrinterSettings';

export function loadBoxLabelSettings(): BoxLabelPrinterSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BOX_LABEL_SETTINGS };
    return { ...DEFAULT_BOX_LABEL_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_BOX_LABEL_SETTINGS };
  }
}

export function saveBoxLabelSettings(settings: BoxLabelPrinterSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Best effort — a workstation with storage disabled just re-prompts for a printer next time.
  }
}

/**
 * Builds one TSPL (TSC Printer Language) command stream for a single Box
 * Label carton, ending in its own `PRINT 1` — join several of these with
 * "\r\n" to send a multi-label batch to QZ Tray in one call.
 *
 * IMPORTANT — best-effort coordinates: font codes ("1"–"5" are TSC's
 * built-in bitmap fonts of increasing size), text positions, and the QR
 * module size below were composed by mirroring the existing HTML label
 * (see PackingListComponent.buildEnhancedBoxLabelHtml) proportionally onto a
 * 235×105mm grid — they have NOT been verified against physical hardware.
 * Print one test label on the real printer and adjust the `Y`/`X` constants
 * or font sizes below before relying on this for production runs.
 */
export function buildBoxLabelTspl(
  packingList: PackingList,
  cartonIndex: number,
  totalBoxes: number,
  dc: DeliveryChallan | null,
  invoiceNo: string,
  settings: BoxLabelPrinterSettings,
): string {
  const carton = packingList.cartons[cartonIndex];
  if (!carton) return '';

  const dotsPerMm = settings.dpi / 25.4;
  const d = (mmVal: number) => Math.round(mmVal * dotsPerMm);
  const esc = (s: unknown) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const partyProgress = packingList.partyProgress ?? [];
  const soIds = [...new Set(carton.entries.flatMap((e) => e.salesOrderIds))];
  const party = partyProgress.find((p) => soIds.includes(p.salesOrderId));
  const customerName = party?.clientName || packingList.clientName;

  const addrParts: string[] = [];
  if (dc?.billingAddress) addrParts.push(dc.billingAddress);
  if (dc?.place || dc?.state) addrParts.push([dc.place, dc.state].filter(Boolean).join(', ') + (dc?.zipCode ? ' - ' + dc.zipCode : ''));
  if (dc?.clientPhone) addrParts.push('Ph: ' + dc.clientPhone);

  const qrData = 'INV:' + (invoiceNo || 'N/A') + '|BOX:' + (cartonIndex + 1) + 'of' + totalBoxes
    + '|CODE:' + (dc?.clientId || packingList.clientId).substring(0, 8).toUpperCase();

  const W = settings.labelWidthMm;
  const H = settings.labelHeightMm;
  const col2X = W / 3;
  const col3X = (W / 3) * 2;

  const lines: string[] = [
    `SIZE ${W} mm, ${H} mm`,
    `GAP ${settings.gapMm} mm, 0 mm`,
    `DENSITY ${settings.densityLevel}`,
    `SPEED ${settings.speedLevel}`,
    'DIRECTION 1',
    'CLS',
  ];

  // ── Header (y 0–14mm): logo box, company name/address, box no., carton no.
  lines.push(`BOX ${d(2)},${d(2)},${d(12)},${d(12)},2`);
  lines.push(`TEXT ${d(3)},${d(4)},"2",0,1,1,"TMG"`);
  lines.push(`TEXT ${d(3)},${d(8)},"2",0,1,1,"CLG"`);
  lines.push(`TEXT ${d(15)},${d(3)},"4",0,1,1,"TMG Clothings"`);
  lines.push(`TEXT ${d(15)},${d(9)},"1",0,1,1,"${esc('Door No.334/2, Serayampalaym, Coimbatore - 641048 | GSTIN: 33AAYFT2559B1ZY')}"`);
  lines.push(`TEXT ${d(W - 45)},${d(3)},"2",0,1,1,"Box ${cartonIndex + 1} of ${totalBoxes}"`);
  lines.push(`TEXT ${d(W - 45)},${d(7)},"3",0,1,1,"${esc(carton.cartonNo)}"`);
  lines.push(`BAR ${d(0)},${d(14)},${d(W)},${d(0.3)}`);

  // ── Ship To + QR (y 14–64mm)
  lines.push(`TEXT ${d(4)},${d(16)},"1",0,1,1,"SHIP TO"`);
  lines.push(`TEXT ${d(4)},${d(20)},"3",0,1,1,"${esc(customerName)}"`);
  let addrY = 26;
  for (const part of addrParts) {
    lines.push(`TEXT ${d(4)},${d(addrY)},"2",0,1,1,"${esc(part)}"`);
    addrY += 5;
  }
  lines.push(`BAR ${d(W - 70)},${d(14)},${d(0.3)},${d(50)}`);
  lines.push(`QRCODE ${d(W - 60)},${d(18)},"L",6,"A",0,"${esc(qrData)}"`);
  lines.push(`TEXT ${d(W - 66)},${d(58)},"1",0,1,1,"Scan for details"`);
  lines.push(`BAR ${d(0)},${d(64)},${d(W)},${d(0.3)}`);

  // ── Pick List / Order No / Invoice No (y 64–78mm)
  lines.push(`TEXT ${d(2)},${d(66)},"1",0,1,1,"PICK LIST"`);
  lines.push(`TEXT ${d(2)},${d(70)},"2",0,1,1,"${esc(packingList.pickListNo)}"`);
  lines.push(`TEXT ${d(col2X + 2)},${d(66)},"1",0,1,1,"ORDER NO."`);
  lines.push(`TEXT ${d(col2X + 2)},${d(70)},"2",0,1,1,"${esc((packingList.salesNos ?? []).join(', '))}"`);
  lines.push(`TEXT ${d(col3X + 2)},${d(66)},"1",0,1,1,"INVOICE NO."`);
  lines.push(`TEXT ${d(col3X + 2)},${d(70)},"2",0,1,1,"${esc(invoiceNo || '-')}"`);
  lines.push(`BAR ${d(col2X)},${d(64)},${d(0.3)},${d(14)}`);
  lines.push(`BAR ${d(col3X)},${d(64)},${d(0.3)},${d(14)}`);
  lines.push(`BAR ${d(0)},${d(78)},${d(W)},${d(0.3)}`);

  // ── Destination / Transport / Total Qty (y 78–H mm)
  lines.push(`TEXT ${d(2)},${d(80)},"1",0,1,1,"DESTINATION"`);
  lines.push(`TEXT ${d(2)},${d(84)},"2",0,1,1,"${esc(dc?.place || '-')}"`);
  lines.push(`TEXT ${d(col2X + 2)},${d(80)},"1",0,1,1,"TRANSPORT"`);
  lines.push(`TEXT ${d(col2X + 2)},${d(84)},"2",0,1,1,"${esc(dc?.transport || packingList.transport || '-')}"`);
  lines.push(`TEXT ${d(col3X + 2)},${d(80)},"1",0,1,1,"TOTAL QTY"`);
  lines.push(`TEXT ${d(col3X + 2)},${d(86)},"4",0,1,1,"${carton.totalQty} PCS"`);
  lines.push(`BAR ${d(col2X)},${d(78)},${d(0.3)},${d(H - 78)}`);
  lines.push(`BAR ${d(col3X)},${d(78)},${d(0.3)},${d(H - 78)}`);

  lines.push('PRINT 1');
  return lines.join('\r\n');
}

/** Joins several single-label TSPL streams into one multi-label batch job. */
export function buildBoxLabelTsplBatch(
  packingList: PackingList,
  cartonIndexes: number[],
  totalBoxes: number,
  dc: DeliveryChallan | null,
  invoiceNo: string,
  settings: BoxLabelPrinterSettings,
): string[] {
  return cartonIndexes
    .map((idx) => buildBoxLabelTspl(packingList, idx, totalBoxes, dc, invoiceNo, settings))
    .filter(Boolean);
}
