import { PackingList } from '../models/packing-list.model';
import { DeliveryChallan } from '../models/delivery-challan.model';

/** Printer-level settings for the Box Label ZPL print flow — persisted per workstation (localStorage), not per user. */
export interface BoxLabelPrinterSettings {
  printerName: string;
  labelWidthMm: number;
  labelHeightMm: number;
  gapMm: number;
  /** UI density level, 1 (lightest) – 15 (darkest) — mapped to ZPL `~SD` darkness (0–30) as densityLevel * 2. */
  densityLevel: number;
  /** Print speed in inches/second, passed straight through to ZPL `^PR` — the printer clamps to its nearest supported step. */
  speedLevel: number;
  dpi: 203 | 300;
}

export const DEFAULT_BOX_LABEL_SETTINGS: BoxLabelPrinterSettings = {
  printerName: '',
  labelWidthMm: 105,
  labelHeightMm: 235,
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

/** Cap-height (mm) per font tier. '1' is every caption; '2' is the Ship To
 *  address block; '3' is the "value" style used in the two lower rows
 *  (sales order no., DC no., box no., destination, transport, total qty);
 *  '4' is Ship To's own, deliberately larger customer-name style — Ship To
 *  gets both a bigger font and a bigger share of the section-height budget
 *  below, at the two lower rows' expense (they had a lot of spare room). */
const FONT_HEIGHT_MM: Record<string, number> = { '1': 3.2, '2': 6.5, '3': 7.2, '4': 11.0 };

/** Minimum clear gap (mm) enforced between two stacked lines that share the
 *  same left margin — see the rotation comment: this margin becomes the
 *  actual physical separation between them once printed, not just line
 *  spacing, so it must be a real, non-zero number. */
const STACK_GAP_MM = 2;

/**
 * Builds one ZPL II command stream for a single Box Label carton, ending in
 * its own `^XZ` — join several of these with "\n" to send a multi-label
 * batch to QZ Tray in one call.
 *
 * The Citizen CL-S621 does not understand TSPL (that is TSC's own printer
 * language, unrelated to Citizen despite the similar-sounding acronym) — it
 * ships with on-board ZPL II and Datamax emulation plus Cross-Emulation
 * auto-detection between the two, so ZPL II is what this printer actually
 * speaks out of the box.
 *
 * Fields, top to bottom: Ship To (name + address), a 3-column row (Sales
 * Order No. / DC No. / Box No.), a 3-column row (Destination / Transport /
 * Total Qty), and an unrotated QR reserved at the tail of the label. There is
 * no company/header block and no Invoice No. — both were dropped from the
 * design; the QR encodes the DC number instead of the invoice number.
 *
 * ROTATION MODEL — read this before touching any coordinate below.
 *
 * The label media is loaded portrait (105mm wide × 235mm long), but the
 * design is a landscape layout, so the whole canvas is authored on a
 * 235×105 logical grid and then rotated 90° clockwise onto the physical
 * portrait canvas via `rot(xMm, yMm) = { x: physW - yMm, y: xMm }`. That
 * means, after rotation:
 *   - the logical **X** of a field (its left-margin position, 0–235) becomes
 *     its physical **Y** — i.e. position *down the 235mm length*. This axis
 *     has lots of room.
 *   - the logical **Y** of a field (which "row"/section it's in, 0–105)
 *     becomes its physical **X** (inverted) — i.e. position *across the
 *     105mm width*. This axis is the scarce one: the whole label only has
 *     105mm of it, shared by every section (ship-to/order-row/dest-row) and
 *     every stacked line inside each section.
 *
 * A field's ZPL origin is its top-left, so rotating the bare `(xMm, yMm)`
 * (as a first cut of this code did) is wrong — it needs the logical
 * bottom-left, `(xMm, yMm + fontHeightMm)`, rotated instead. Using the bare
 * top-left collapsed every line sharing a left margin (e.g. a caption
 * directly above its value) onto the *same* physical Y, so they printed on
 * top of each other on a physical test print. `text()` below folds the font
 * height into the origin to fix that, the same way `box()` already does for
 * `^GB` boxes (which have no ZPL orientation parameter at all, so their
 * geometry is pre-rotated by hand — origin shifted, width/height swapped —
 * instead of relying on field rotation).
 *
 * Because that scarce 105mm-wide axis is shared by *every* stacked line in a
 * section, `STACK_GAP_MM` below is a real, deliberate safety margin (not
 * cosmetic line-height) between any two lines sharing a left margin, and
 * each section's own boundary (the constants inside the function) leaves a
 * few mm of headroom past the last line it holds.
 *
 * QR CODE — deliberately NOT run through the rotation above. Some ZPL
 * firmwares don't honor the orientation parameter on `^BQ` the way they do
 * for `^A0` text (the QR is rotation-agnostic for scanning, so several
 * implementations just ignore it and always render at 0°), which would
 * silently misplace a rotated-origin QR. Since a standard QR scanner reads a
 * symbol at any rotation anyway, the QR here is placed with plain `^BQN`
 * (no rotation) at literal physical dot coordinates in a small reserved zone
 * at the tail end of the label that nothing else in this layout reaches —
 * this makes it correct-by-construction regardless of how a given firmware
 * treats `^BQ` rotation.
 *
 * IMPORTANT — still best-effort: this has been checked by hand against the
 * numbers above (row budgets vs. font heights vs. stack gaps), but has not
 * been run through an actual ZPL rendering engine. Print one test label and
 * compare against this comment's rotation model before a production run. If
 * the printed *text* comes out upside down or mirrored (the QR shouldn't be
 * affected either way, per above), swap `'R'` for `'B'` in `font()` and flip
 * `rot()` to `{ x: yMm, y: physH - xMm }`.
 */
export function buildBoxLabelZpl(
  packingList: PackingList,
  cartonIndex: number,
  totalBoxes: number,
  dc: DeliveryChallan | null,
  settings: BoxLabelPrinterSettings,
): string {
  const carton = packingList.cartons[cartonIndex];
  if (!carton) return '';

  const dotsPerMm = settings.dpi / 25.4;
  const d = (mmVal: number) => Math.round(mmVal * dotsPerMm);
  // ^ and ~ are ZPL's command prefixes — strip them out of field data so label text can't be mistaken for a new command.
  const esc = (s: unknown) => String(s ?? '').replace(/[\^~]/g, '');

  // Physical media, as loaded in the printer.
  const physW = settings.labelWidthMm; // e.g. 105mm — printhead width axis
  const physH = settings.labelHeightMm; // e.g. 235mm — feed/length axis

  // Logical design canvas — always the landscape shape (wide × short) the
  // layout below was authored for, regardless of which physical dimension
  // is larger.
  const W = Math.max(physW, physH);
  const H = Math.min(physW, physH);

  // Reference canvas this layout's constants were hand-tuned against — with
  // today's 105×235 media this is exactly W/H (scale === 1), but a
  // differently sized label configured later scales every constant below
  // proportionally instead of staying pinned to these fixed mm values.
  const REF_W = 235;
  const REF_H = 105;
  const scale = Math.min(W / REF_W, H / REF_H);
  const sc = (mm: number) => mm * scale;

  // Rotates a logical (landscape-canvas) point 90° clockwise onto the
  // physical (portrait-media) coordinate system — see the rotation model
  // in the doc comment above.
  const rot = (xMm: number, yMm: number) => ({ x: physW - yMm, y: xMm });

  const font = (code: string) => {
    const h = d(sc(FONT_HEIGHT_MM[code] ?? 3.0));
    const w = Math.max(1, Math.round(h * 0.62));
    return `^A0R,${h},${w}`;
  };
  // Origin is the logical bottom-left (xMm, yMm + fontHeight) rotated onto
  // the physical canvas — using the bare top-left (xMm, yMm) here was the
  // bug that made every stacked line collapse onto the same physical Y.
  const text = (xMm: number, yMm: number, code: string, data: unknown) => {
    const h = sc(FONT_HEIGHT_MM[code] ?? 3.0);
    const p = rot(xMm, yMm + h);
    return `^FO${d(p.x)},${d(p.y)}${font(code)}^FD${esc(data)}^FS`;
  };
  // ^GB has no field-orientation parameter, so the box itself is pre-rotated
  // (origin shifted to the rotated top-left corner, width/height swapped).
  const box = (xMm: number, yMm: number, wMm: number, hMm: number, thicknessMm: number) => {
    const p = rot(xMm, yMm + hMm);
    const boxW = d(hMm), boxH = d(wMm), boxT = d(thicknessMm);
    return `^FO${d(p.x)},${d(p.y)}^GB${boxW},${boxH},${boxT},B,0^FS`;
  };
  const bar = (xMm: number, yMm: number, wMm: number, hMm: number) => box(xMm, yMm, wMm, hMm, Math.min(wMm, hMm));

  const partyProgress = packingList.partyProgress ?? [];
  const soIds = [...new Set(carton.entries.flatMap((e) => e.salesOrderIds))];
  const party = partyProgress.find((p) => soIds.includes(p.salesOrderId));
  const customerName = party?.clientName || packingList.clientName;

  const addrParts: string[] = [];
  if (dc?.billingAddress) addrParts.push(dc.billingAddress);
  if (dc?.place || dc?.state) addrParts.push([dc.place, dc.state].filter(Boolean).join(', ') + (dc?.zipCode ? ' - ' + dc.zipCode : ''));
  if (dc?.clientPhone) addrParts.push('Ph: ' + dc.clientPhone);

  const qrData = 'DC:' + (dc?.dcNo || 'N/A') + '|BOX:' + (cartonIndex + 1) + 'of' + totalBoxes
    + '|CODE:' + (dc?.clientId || packingList.clientId).substring(0, 8).toUpperCase();

  const col2X = W / 3;
  const col3X = (W / 3) * 2;
  const gap = sc(STACK_GAP_MM);
  const capH = FONT_HEIGHT_MM['1'] * scale;
  const addrH = FONT_HEIGHT_MM['2'] * scale;
  const valH = FONT_HEIGHT_MM['3'] * scale;
  const nameH = FONT_HEIGHT_MM['4'] * scale;

  const lines: string[] = [
    '^XA',
    `^PW${d(physW)}`,
    `^LL${d(physH)}`,
    '^LH0,0',
    '^MNY', // non-continuous (gap) media sensing — gapMm itself has no direct ZPL param, the printer auto-calibrates gap length
    `~SD${Math.min(30, Math.max(0, Math.round(settings.densityLevel * 2)))}`,
    `^PR${settings.speedLevel}`,
    '^CI28', // UTF-8 field data
  ];

  // ── Ship To (logical y 0–60mm) — the biggest section, and the only one
  // using the larger '4' name style, per the user's ask to make Ship To
  // more prominent at the other two rows' expense (see FONT_HEIGHT_MM).
  lines.push(text(sc(2), sc(2), '1', 'SHIP TO'));
  const nameY = sc(2) + capH + gap;
  lines.push(text(sc(2), nameY, '4', customerName));
  let addrY = nameY + nameH + gap;
  for (const part of addrParts) {
    lines.push(text(sc(2), addrY, '4', part));
    addrY += addrH + (gap + 1);
  }
  lines.push(bar(0, sc(60), W, sc(0.3)));

  // ── Sales Order No. / DC No. / Box No. (logical y 60–80mm)
  const row1CapY = sc(62);
  const row1ValY = row1CapY + capH + gap;
  lines.push(text(sc(2), row1CapY, '1', 'SALES ORDER NO.'));
  lines.push(text(sc(2), row1ValY, '3', (packingList.salesNos ?? []).join(', ') || '-'));
  lines.push(text(col2X + sc(2), row1CapY, '1', 'DC NO.'));
  lines.push(text(col2X + sc(2), row1ValY, '3', dc?.dcNo || '-'));
  lines.push(text(col3X + sc(2), row1CapY, '1', 'BOX NO.'));
  lines.push(text(col3X + sc(2), row1ValY, '3', carton.cartonNo));
  lines.push(text(col3X + sc(2), row1ValY + valH + gap, '1', `Box ${cartonIndex + 1} of ${totalBoxes}`));
  lines.push(bar(col2X, sc(60), sc(0.3), sc(22)));
  lines.push(bar(col3X, sc(60), sc(0.3), sc(22)));
  lines.push(bar(0, sc(82), W, sc(0.3)));

  // ── Destination / Transport / Total Qty (logical y 82–105mm)
  const row2CapY = sc(84);
  const row2ValY = row2CapY + capH + gap;
  lines.push(text(sc(2), row2CapY, '1', 'DESTINATION'));
  lines.push(text(sc(2), row2ValY, '3', dc?.place || '-'));
  lines.push(text(col2X + sc(2), row2CapY, '1', 'TRANSPORT'));
  lines.push(text(col2X + sc(2), row2ValY, '3', dc?.transport || packingList.transport || '-'));
  lines.push(text(col3X + sc(2), row2CapY, '1', 'TOTAL QTY'));
  lines.push(text(col3X + sc(2), row2ValY, '3', `${carton.totalQty} PCS`));
  lines.push(bar(col2X, sc(82), sc(0.3), H - sc(82)));
  lines.push(bar(col3X, sc(82), sc(0.3), H - sc(82)));

  // ── QR code — plain, unrotated, in a reserved zone at the tail end of the
  // physical label (see the QR CODE section of the doc comment above for
  // why this deliberately skips the rotation model used everywhere else).
  const qrZoneMm = Math.min(35, physW - 10);
  const qrX = d(5);
  const qrY = d(Math.max(0, physH - qrZoneMm - 5));
  const qrMagnification = Math.max(2, Math.min(10, Math.round((qrZoneMm / 30) * 8)));
  lines.push(`^FO${qrX},${qrY}^BQN,2,${qrMagnification}^FDQA,${esc(qrData)}^FS`);
  lines.push(`^FO${qrX},${d(Math.max(0, physH - 5))}^A0N,${d(2.6)},${Math.round(d(2.6) * 0.62)}^FDScan for details^FS`);

  lines.push('^XZ');
  return lines.join('\n');
}

/** Joins several single-label ZPL streams into one multi-label batch job. */
export function buildBoxLabelZplBatch(
  packingList: PackingList,
  cartonIndexes: number[],
  totalBoxes: number,
  dc: DeliveryChallan | null,
  settings: BoxLabelPrinterSettings,
): string[] {
  return cartonIndexes
    .map((idx) => buildBoxLabelZpl(packingList, idx, totalBoxes, dc, settings))
    .filter(Boolean);
}
