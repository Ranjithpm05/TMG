import * as QRCode from 'qrcode';
import { PackingListLine } from '../models/packing-list.model';

/**
 * Which way each tag's content is turned on the 2-up sheet. 270 = text reads
 * bottom→top as fed, pre-printed branding bar on each tag's RIGHT (the
 * orientation `^A0B` was confirmed to produce on this printer, and the one the
 * reference sample shows); 90 = text reads top→bottom, bar on the LEFT — for a
 * roll loaded the other way round.
 */
export type MrpTagRotation = 90 | 270;

/** Printer-level settings for the MRP Label ZPL print flow — persisted per workstation (localStorage), not per user. */
export interface MrpLabelPrinterSettings {
  printerName: string;
  /** Whole 2-up sheet across the print head: both tags plus the liner gap between them. */
  labelWidthMm: number;
  /** Sheet length along the feed — which is also each tag's long (reading-width) side. */
  labelHeightMm: number;
  gapMm: number;
  /** Liner gap between the two tags across the sheet. */
  columnGapMm: number;
  /** UI density level, 1 (lightest) – 15 (darkest) — mapped to ZPL `~SD` darkness (0–30) as densityLevel * 2. */
  densityLevel: number;
  /** Print speed in inches/second, passed straight through to ZPL `^PR` — the printer clamps to its nearest supported step. */
  speedLevel: number;
  dpi: 203 | 300;
  rotation: MrpTagRotation;
  /** Calibration nudge in printer coordinates: + moves the print right, across the head. */
  offsetXMm: number;
  /** Calibration nudge in printer coordinates: + moves the print further down the feed. */
  offsetYMm: number;
}

export const DEFAULT_MRP_LABEL_SETTINGS: MrpLabelPrinterSettings = {
  printerName: '',
  labelWidthMm: 80,
  labelHeightMm: 70,
  gapMm: 2,
  columnGapMm: 2,
  densityLevel: 8,
  speedLevel: 4,
  dpi: 203,
  rotation: 270,
  offsetXMm: 0,
  offsetYMm: 0,
};

const STORAGE_KEY = 'mrpLabelPrinterSettings';

export function loadMrpLabelSettings(): MrpLabelPrinterSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MRP_LABEL_SETTINGS };
    return { ...DEFAULT_MRP_LABEL_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_MRP_LABEL_SETTINGS };
  }
}

export function saveMrpLabelSettings(settings: MrpLabelPrinterSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Best effort — a workstation with storage disabled just re-prompts for a printer next time.
  }
}

/** One physical garment tag's worth of field data — one instance printed per piece (Qty is always "1 No" on the label itself). */
export interface MrpLabelData {
  design: string;
  style: string;
  shade: string;
  size: string;
  mrp: number;
  /** QR payload and the human-readable code printed under it — the entry's own barcode, which already encodes Design/Style/Size. */
  code: string;
}

/**
 * Design Master MRP per size: by barcode (each size has its own), falling back
 * to styleNo|color|size for a Packing List line that has no barcode or whose
 * barcode isn't in Design Master — the same join DesignService
 * .getSizeEntryByStyleColorSizeMap() uses for the PT File export.
 */
export interface MrpLabelLookup {
  byBarcode: Map<string, number>;
  byStyleColorSize: Map<string, number>;
}

export function mrpForLine(line: PackingListLine, lookup: MrpLabelLookup): number {
  const barcode = String(line.barcode ?? '').trim();
  const byBarcode = barcode ? lookup.byBarcode.get(barcode) : undefined;
  if (byBarcode && byBarcode > 0) return byBarcode;
  return lookup.byStyleColorSize.get(`${line.styleNo ?? ''}|${line.color ?? ''}|${line.size ?? ''}`) ?? byBarcode ?? 0;
}

/**
 * Sourced from the Packing List's own lines (`PackingListLine`, its
 * `requiredQty`) rather than from cartons — MRP tags are per-garment and
 * don't depend on which box a piece ends up in, so printing works as soon
 * as a Packing List is generated, whether or not packing (carton creation)
 * has started yet.
 */
export function mrpLabelDataForLine(line: PackingListLine, lookup: MrpLabelLookup): MrpLabelData {
  const barcode = String(line.barcode ?? '').trim();
  return {
    design: line.styleNo,
    style: line.sleeveType || '-',
    shade: line.color || '-',
    size: line.size,
    mrp: mrpForLine(line, lookup),
    code: barcode || [line.styleNo, line.size].filter(Boolean).join(''),
  };
}

/**
 * Expands a Packing List's lines into one `MrpLabelData` per physical piece
 * (a line with requiredQty 3 yields 3 identical label instances) — the
 * sample labels always show "Qty: 1 No", i.e. one tag per garment, not one
 * aggregate tag per size-line.
 */
export function buildMrpLabelDataForLines(lines: PackingListLine[], lookup: MrpLabelLookup): MrpLabelData[] {
  const out: MrpLabelData[] = [];
  for (const line of lines) {
    const data = mrpLabelDataForLine(line, lookup);
    for (let i = 0; i < Math.max(1, line.requiredQty); i++) out.push(data);
  }
  return out;
}

// ─── Tag layout ──────────────────────────────────────────────────────────────
//
// Every position below is in millimetres in the tag's READING orientation —
// 70mm wide × 39mm tall, pre-printed TMG CLOTHINGS bar along the bottom —
// measured off the physical reference sample (printed + blank stock). The
// tag is drawn upright in that frame and then turned 90° onto the printer's
// sheet (see `composeSheet`), exactly how the stock is fed: each tag runs
// 39mm across the head and 70mm along the feed, two tags side by side.

const REF_TAG_W = 70;
const REF_TAG_H = 39;

/** Top edge of the pre-printed branding bar (TMG CLOTHINGS / Enquiry / Made in India). It is already on the stock, so nothing is ever printed at or below it. */
const BAR_TOP = 28.6;

const LAYOUT = {
  labelU: 4.8,
  colonU: 17.0,
  valueU: 19.8,
  /** Values stop short of the QR's left edge — longer text is condensed to fit, never clipped or overlapped. */
  valueMaxW: 28.4,
  labelCap: 1.75,
  rows: {
    design: { baseline: 8.6, cap: 2.2 },
    style: { baseline: 11.3, cap: 1.8 },
    shade: { baseline: 14.0, cap: 1.8 },
    size: { baseline: 16.7, cap: 2.2 },
    qty: { baseline: 19.4, cap: 1.35 },
  },
  mrp: {
    baseline: 25.3,
    labelCap: 3.3,
    labelCondense: 0.85,
    colonU: 15.2,
    rupeeU: 17.8,
    amountU: 21.4,
    amountCap: 4.4,
    amountCondense: 0.72,
    amountMaxW: 26,
  },
  tax: { u: 18.4, baseline: 27.7, cap: 1.25 },
  qr: { u: 49.2, v: 8.6, size: 14 },
  code: { centerU: 56.2, baseline: 26.0, cap: 1.4, maxW: 15 },
};

/** Arial's cap height as a fraction of its em — converts a measured cap height into a font size. */
const ARIAL_CAP = 0.716;
const FONT_STACK = 'Arial, "Liberation Sans", Helvetica, sans-serif';
/** Grey level (0–255) below which an anti-aliased pixel becomes a printed dot — biased dark so 1-dot strokes of the small captions survive on a 203dpi head. */
const DOT_THRESHOLD = 160;

interface Bitmap {
  w: number;
  h: number;
  /** Row-major, 1 = printed dot. */
  bits: Uint8Array;
}

interface TextOpts {
  bold?: boolean;
  /** Horizontal squeeze (1 = natural Arial width) — the sample's type is a condensed face. */
  condense?: number;
  maxW?: number;
  align?: 'left' | 'center';
}

/**
 * Draws text in device units with ref-mm coordinates: `sx`/`sy` are device
 * units per reference millimetre (they also absorb any deviation of the
 * configured stock from the 70×39mm reference). Font size is derived from
 * the cap height so on-paper letter heights match the sample.
 */
function drawText(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  s: string,
  u: number,
  baseline: number,
  cap: number,
  o: TextOpts = {},
): void {
  if (!s) return;
  ctx.font = `${o.bold ? 'bold ' : ''}${(cap * sy) / ARIAL_CAP}px ${FONT_STACK}`;
  ctx.textBaseline = 'alphabetic';
  const natural = ctx.measureText(s).width;
  if (!natural) return;
  let c = o.condense ?? 1;
  if (o.maxW) c = Math.min(c, (o.maxW * sx) / natural);
  let x = u * sx;
  if (o.align === 'center') x -= (natural * c) / 2;
  ctx.save();
  ctx.translate(x, baseline * sy);
  ctx.scale(c, 1);
  ctx.fillText(s, 0, 0);
  ctx.restore();
}

/** The tag's variable content only, in its reading orientation — the branding bar is pre-printed and deliberately not drawn. */
function drawTagContent(ctx: CanvasRenderingContext2D, data: MrpLabelData, sx: number, sy: number): void {
  const L = LAYOUT;
  ctx.fillStyle = '#000';
  const t = (s: string, u: number, baseline: number, cap: number, o?: TextOpts) => drawText(ctx, sx, sy, s, u, baseline, cap, o);
  const upper = (s: string) => String(s ?? '').trim().toUpperCase() || '-';

  const row = (label: string, value: string, r: { baseline: number; cap: number }) => {
    t(label, L.labelU, r.baseline, L.labelCap);
    t(':', L.colonU, r.baseline, L.labelCap);
    t(value, L.valueU, r.baseline, r.cap, { maxW: L.valueMaxW });
  };
  row('Design', upper(data.design), L.rows.design);
  row('Style', upper(data.style), L.rows.style);
  row('Shade', upper(data.shade), L.rows.shade);
  row('Size', String(data.size ?? '').trim() || '-', L.rows.size);
  row('Qty', '1 No', L.rows.qty);

  const m = L.mrp;
  t('MRP', L.labelU, m.baseline, m.labelCap, { bold: true, condense: m.labelCondense });
  t(':', m.colonU, m.baseline, m.labelCap, { bold: true });
  t('₹', m.rupeeU, m.baseline, m.labelCap, { bold: true });
  t((Number(data.mrp) || 0).toFixed(2), m.amountU, m.baseline, m.amountCap, { bold: true, condense: m.amountCondense, maxW: m.amountMaxW });
  t('(Incl of all Taxes)', L.tax.u, L.tax.baseline, L.tax.cap);

  // QR — whole device-unit modules (never resampled), centred in its box, so every module prints as a crisp square.
  const qr = QRCode.create(data.code || '-', { errorCorrectionLevel: 'Q' });
  const n = qr.modules.size;
  const boxX = L.qr.u * sx;
  const boxY = L.qr.v * sy;
  const boxW = L.qr.size * sx;
  const boxH = L.qr.size * sy;
  const mod = Math.max(1, Math.floor(Math.min(boxW, boxH) / n));
  const ox = Math.round(boxX + (boxW - mod * n) / 2);
  const oy = Math.round(boxY + (boxH - mod * n) / 2);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) ctx.fillRect(ox + c * mod, oy + r * mod, mod, mod);
    }
  }
  t(data.code, L.code.centerU, L.code.baseline, L.code.cap, { align: 'center', maxW: L.code.maxW });
}

/** Renders one tag at the printer's own resolution (1 canvas pixel = 1 dot) and thresholds it to 1-bit. */
function renderTagBitmap(data: MrpLabelData, wDots: number, hDots: number): Bitmap {
  const canvas = document.createElement('canvas');
  canvas.width = wDots;
  canvas.height = hDots;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, wDots, hDots);
  drawTagContent(ctx, data, wDots / REF_TAG_W, hDots / REF_TAG_H);

  // Hard stop above the pre-printed bar — whatever the font metrics do, nothing may overprint it.
  const barTopRow = Math.floor((BAR_TOP * hDots) / REF_TAG_H);
  const px = ctx.getImageData(0, 0, wDots, hDots).data;
  const bits = new Uint8Array(wDots * hDots);
  for (let i = 0; i < wDots * barTopRow; i++) {
    if (px[i * 4 + 1] < DOT_THRESHOLD) bits[i] = 1;
  }
  return { w: wDots, h: hDots, bits };
}

interface SheetGeometry {
  dotsPerMm: number;
  sheetW: number;
  sheetH: number;
  /** Each tag's extent across the head (its reading HEIGHT, ~39mm). */
  tagAcross: number;
  /** Each tag's extent along the feed (its reading WIDTH, ~70mm). */
  tagAlong: number;
  slotX: [number, number];
  /** Column where the left half's graphic ends and the right half's begins — the middle of the liner gap. */
  splitX: number;
}

function sheetGeometry(settings: MrpLabelPrinterSettings): SheetGeometry {
  const dotsPerMm = settings.dpi / 25.4;
  const d = (mm: number) => Math.round(mm * dotsPerMm);
  const gap = Math.max(0, settings.columnGapMm || 0);
  const tagAcrossMm = (settings.labelWidthMm - gap) / 2;
  return {
    dotsPerMm,
    sheetW: d(settings.labelWidthMm),
    sheetH: d(settings.labelHeightMm),
    tagAcross: d(tagAcrossMm),
    tagAlong: d(settings.labelHeightMm),
    slotX: [0, d(tagAcrossMm + gap)],
    splitX: d(tagAcrossMm + gap / 2),
  };
}

/**
 * Lays both tags onto the printer's sheet, each turned 90° (direction per
 * `settings.rotation`) so its reading width runs along the feed and its
 * branding-bar edge lines up with the bar pre-printed on the stock. Rotation
 * is done here on the bit grid — exact, no resampling — rather than with ZPL
 * field rotation, which this printer's firmware has proven unreliable at.
 */
function composeSheet(left: MrpLabelData, right: MrpLabelData | null, settings: MrpLabelPrinterSettings, g: SheetGeometry): Bitmap {
  const bits = new Uint8Array(g.sheetW * g.sheetH);
  const offX = Math.round((settings.offsetXMm || 0) * g.dotsPerMm);
  const offY = Math.round((settings.offsetYMm || 0) * g.dotsPerMm);
  const place = (data: MrpLabelData, slotX: number) => {
    const tag = renderTagBitmap(data, g.tagAlong, g.tagAcross);
    for (let y = 0; y < tag.h; y++) {
      for (let x = 0; x < tag.w; x++) {
        if (!tag.bits[y * tag.w + x]) continue;
        const px = (settings.rotation === 90 ? slotX + (tag.h - 1 - y) : slotX + y) + offX;
        const py = (settings.rotation === 90 ? x : tag.w - 1 - x) + offY;
        if (px >= 0 && px < g.sheetW && py >= 0 && py < g.sheetH) bits[py * g.sheetW + px] = 1;
      }
    }
  };
  place(left, g.slotX[0]);
  if (right) place(right, g.slotX[1]);
  return { w: g.sheetW, h: g.sheetH, bits };
}

/** One `^GFA` field covering just the printed dots between columns x0..x1 (trimmed to their bounding box to keep the payload small). */
function gfaField(sheet: Bitmap, x0: number, x1: number): string {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < sheet.h; y++) {
    for (let x = x0; x < x1; x++) {
      if (!sheet.bits[y * sheet.w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return '';
  const bytesPerRow = Math.ceil((maxX - minX + 1) / 8);
  const rows: string[] = [];
  for (let y = minY; y <= maxY; y++) {
    let hex = '';
    for (let b = 0; b < bytesPerRow; b++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = minX + b * 8 + bit;
        if (x <= maxX && sheet.bits[y * sheet.w + x]) byte |= 0x80 >> bit;
      }
      hex += byte.toString(16).padStart(2, '0');
    }
    rows.push(hex);
  }
  const total = bytesPerRow * (maxY - minY + 1);
  return `^FO${minX},${minY}^GFA,${total},${total},${bytesPerRow},${rows.join('').toUpperCase()}^FS`;
}

/**
 * Builds one ZPL II command stream for a physical 80×70mm 2-up MRP label
 * sheet — two garment tags side by side, each ≈39mm across the head × 70mm
 * along the feed. `right` is `null` for a trailing odd piece, leaving that
 * tag blank. `copies` (`^PQ`) repeats identical sheets without resending
 * the graphic.
 *
 * Content goes out as a dot-for-dot `^GFA` bitmap, not ZPL text: the
 * printer's built-in font 0 has no ₹ glyph, its field rotation (`^A0R`,
 * `^ADR`) misbehaved on this hardware, and a bitmap makes the on-screen
 * preview the literal print. The bitmap is built at `settings.dpi`, sized to
 * `^PW`/`^LL` exactly, with `^PON`/`^PMN`/`^LH0,0` resetting any orientation,
 * mirror or home offset left stored in the printer — so nothing is scaled,
 * stretched or turned after it leaves the app. The TMG CLOTHINGS branding is
 * pre-printed on the stock and is never printed here.
 */
export function buildMrpLabelZpl(left: MrpLabelData, right: MrpLabelData | null, settings: MrpLabelPrinterSettings, copies = 1): string {
  const g = sheetGeometry(settings);
  const sheet = composeSheet(left, right, settings, g);
  return [
    '^XA',
    `^PW${g.sheetW}`,
    `^LL${g.sheetH}`,
    '^LH0,0',
    '^PON',
    '^PMN',
    '^MNY', // non-continuous (gap) media sensing — gapMm itself has no direct ZPL param, the printer auto-calibrates gap length
    `~SD${Math.min(30, Math.max(0, Math.round(settings.densityLevel * 2)))}`,
    `^PR${settings.speedLevel}`,
    gfaField(sheet, 0, g.splitX),
    gfaField(sheet, g.splitX, g.sheetW),
    `^PQ${Math.max(1, Math.floor(copies))}`,
    '^XZ',
  ].filter(Boolean).join('\n');
}

/**
 * Pairs up consecutive pieces (2 per physical 80×70mm sheet) and builds one
 * ZPL stream per run of identical sheets — a size line's pieces are
 * consecutive, so e.g. 12 pieces of one size become a single sheet image
 * sent once with `^PQ6`, instead of 6 copies of the same bitmap.
 */
export function buildMrpLabelZplBatch(dataList: MrpLabelData[], settings: MrpLabelPrinterSettings): string[] {
  const runs: { left: MrpLabelData; right: MrpLabelData | null; copies: number; key: string }[] = [];
  for (let i = 0; i < dataList.length; i += 2) {
    const left = dataList[i];
    const right = dataList[i + 1] ?? null;
    const key = JSON.stringify([left, right]);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.copies++;
    else runs.push({ left, right, copies: 1, key });
  }
  return runs.map((r) => buildMrpLabelZpl(r.left, r.right, settings, r.copies));
}

// ─── Preview ─────────────────────────────────────────────────────────────────

/** The tag's die-cut outline on the liner (preview only — never printed), drawn in the tag's reading orientation. The TMG CLOTHINGS band is already on the stock, so the preview shows only the content this process prints. */
function drawTagOutline(ctx: CanvasRenderingContext2D, sx: number, sy: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(0, 0, REF_TAG_W * sx, REF_TAG_H * sy, 2 * sy);
  ctx.fill();
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 0.25 * sy;
  ctx.stroke();
}

export interface MrpLabelPreviewImages {
  /** Both tags upright and stacked — how the printed content reads. */
  readable: string;
  /** The whole sheet exactly as the printer receives it (same dots, rotation and offsets as the ZPL). */
  printer: string;
  /** Preview canvas pixels per printer dot — lets the template size the images to true millimetres. */
  pxPerDot: number;
}

/**
 * Renders the preview from the very bitmap the ZPL sends — `composeSheet` —
 * so preview and physical print can't drift apart. The tag outlines sit in
 * fixed sheet positions (they're the die-cut stock),
 * while the dots move with the calibration offsets, exactly as on paper.
 */
export function renderMrpLabelPreview(left: MrpLabelData, right: MrpLabelData | null, settings: MrpLabelPrinterSettings): MrpLabelPreviewImages {
  const k = 3; // preview pixels per printer dot
  const g = sheetGeometry(settings);
  const sheet = composeSheet(left, right, settings, g);
  const tagSx = g.tagAlong / REF_TAG_W;
  const tagSy = g.tagAcross / REF_TAG_H;

  // Reading frame → sheet frame for the tag in `slotX` (in dots).
  const toSheet = (ctx: CanvasRenderingContext2D, slotX: number) => {
    if (settings.rotation === 90) {
      ctx.translate(slotX + g.tagAcross, 0);
      ctx.rotate(Math.PI / 2);
    } else {
      ctx.translate(slotX, g.tagAlong);
      ctx.rotate(-Math.PI / 2);
    }
  };
  const toReading = (ctx: CanvasRenderingContext2D, slotX: number) => {
    if (settings.rotation === 90) {
      ctx.rotate(-Math.PI / 2);
      ctx.translate(-slotX - g.tagAcross, 0);
    } else {
      ctx.rotate(Math.PI / 2);
      ctx.translate(-slotX, -g.tagAlong);
    }
  };

  const printer = document.createElement('canvas');
  printer.width = g.sheetW * k;
  printer.height = g.sheetH * k;
  const pctx = printer.getContext('2d')!;
  pctx.fillStyle = '#e7e5e4'; // liner
  pctx.fillRect(0, 0, printer.width, printer.height);
  for (const slotX of g.slotX) {
    pctx.save();
    pctx.scale(k, k);
    toSheet(pctx, slotX);
    drawTagOutline(pctx, tagSx, tagSy);
    pctx.restore();
  }
  const dots = document.createElement('canvas');
  dots.width = g.sheetW;
  dots.height = g.sheetH;
  const dctx = dots.getContext('2d')!;
  const img = dctx.createImageData(g.sheetW, g.sheetH);
  for (let i = 0; i < sheet.bits.length; i++) {
    if (!sheet.bits[i]) continue;
    img.data[i * 4] = 17;
    img.data[i * 4 + 1] = 24;
    img.data[i * 4 + 2] = 39;
    img.data[i * 4 + 3] = 255;
  }
  dctx.putImageData(img, 0, 0);
  pctx.imageSmoothingEnabled = false;
  pctx.drawImage(dots, 0, 0, printer.width, printer.height);

  const spacing = Math.round(3 * g.dotsPerMm);
  const tags = right ? g.slotX : [g.slotX[0]];
  const readable = document.createElement('canvas');
  readable.width = g.tagAlong * k;
  readable.height = (g.tagAcross * tags.length + spacing * (tags.length - 1)) * k;
  const rctx = readable.getContext('2d')!;
  rctx.fillStyle = '#ffffff';
  rctx.fillRect(0, 0, readable.width, readable.height);
  rctx.imageSmoothingEnabled = false;
  tags.forEach((slotX, i) => {
    rctx.save();
    rctx.scale(k, k);
    rctx.translate(0, i * (g.tagAcross + spacing));
    rctx.beginPath();
    rctx.rect(0, 0, g.tagAlong, g.tagAcross);
    rctx.clip();
    toReading(rctx, slotX);
    rctx.drawImage(printer, 0, 0, g.sheetW, g.sheetH);
    rctx.restore();
  });

  return { readable: readable.toDataURL('image/png'), printer: printer.toDataURL('image/png'), pxPerDot: k };
}
