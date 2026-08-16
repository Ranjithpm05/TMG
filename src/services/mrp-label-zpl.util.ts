import { PackingListLine } from '../models/packing-list.model';

/** Printer-level settings for the MRP Label ZPL print flow — persisted per workstation (localStorage), not per user. */
export interface MrpLabelPrinterSettings {
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

export const DEFAULT_MRP_LABEL_SETTINGS: MrpLabelPrinterSettings = {
  printerName: '',
  labelWidthMm: 80,
  labelHeightMm: 70,
  gapMm: 2,
  densityLevel: 8,
  speedLevel: 4,
  dpi: 203,
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
 * Sourced from the Packing List's own lines (`PackingListLine`, its
 * `requiredQty`) rather than from cartons — MRP tags are per-garment and
 * don't depend on which box a piece ends up in, so printing works as soon
 * as a Packing List is generated, whether or not packing (carton creation)
 * has started yet.
 */
export function mrpLabelDataForLine(line: PackingListLine, mrpByBarcode: Map<string, number>): MrpLabelData {
  return {
    design: line.styleNo,
    style: line.sleeveType || '-',
    shade: line.color || '-',
    size: line.size,
    mrp: line.barcode ? (mrpByBarcode.get(line.barcode) ?? 0) : 0,
    code: line.barcode || [line.styleNo, line.size].filter(Boolean).join(''),
  };
}

/**
 * Expands a Packing List's lines into one `MrpLabelData` per physical piece
 * (a line with requiredQty 3 yields 3 identical label instances) — the
 * sample labels always show "Qty: 1 No", i.e. one tag per garment, not one
 * aggregate tag per size-line.
 */
export function buildMrpLabelDataForLines(lines: PackingListLine[], mrpByBarcode: Map<string, number>): MrpLabelData[] {
  const out: MrpLabelData[] = [];
  for (const line of lines) {
    const data = mrpLabelDataForLine(line, mrpByBarcode);
    for (let i = 0; i < Math.max(1, line.requiredQty); i++) out.push(data);
  }
  return out;
}

/** The half-width one portrait tag's layout below was tuned for:
 * (80mm sheet − 2mm divider gap) / 2 ≈ 39mm. `scaleW` (computed in
 * `mrpLabelTagFields`) adjusts if the configured label width deviates from
 * 80mm. */
const REF_HALF_W = 39;

/** Height reserved at each tag's BOTTOM edge for the PRE-PRINTED branding
 * (TMG CLOTHINGS / Enquiry email / Made in India, a horizontal bar) —
 * already physically printed on the label stock, so the software must
 * never draw anything in this zone, only leave it blank. ≈11mm, matching
 * the "~11mm design/branding section" from the original spec. */
const PRE_PRINTED_ZONE_H = 11;

/**
 * The MRP tag's PRINTABLE (variable) content only — Design, Style, Size,
 * Qty, Shade, MRP, and "(Incl. of all Taxes)" as SEPARATE ROTATED text
 * columns (not combined — confirmed against a physical reference sample
 * that each field is its own aligned line, not several fields crammed
 * onto one), plus a QR code (also rotated, matching the fields) with its
 * code text. The TMG CLOTHINGS branding, email, and "Made in India" are
 * already physically printed as a horizontal bar at the BOTTOM of the
 * label stock and are DELIBERATELY NOT drawn here — printing them again
 * would double-ink the pre-printed strip. `PRE_PRINTED_ZONE_H` reserves
 * that bar's height so nothing below overlaps it.
 *
 * ROTATION — confirmed via `buildRotationDiagnosticZpl`'s physical test
 * print: `^A0B` (scalable font, orientation "B" — 270° clockwise / 90°
 * counter-clockwise) is the technique this printer's firmware actually
 * honors. Both `^A0R` and the bitmap-font `^ADR` were tried first and
 * confirmed NOT to rotate on this hardware; `^A0B` is CONFIRMED correct,
 * unlike those two. IMPORTANT: `^A0B` text grows DOWNWARD from its `^FO`
 * origin (confirmed the hard way — anchoring near the tag's bottom edge
 * left almost no room for that downward growth and printed nothing at
 * all). Anchor field text near the TOP of its available space, never the
 * bottom.
 *
 * LAYOUT — the QR is a horizontal band spanning the tag's FULL WIDTH at
 * the TOP, taking the top 25% of the tag's height (`hMm`) and sized to
 * nearly fill that band; field columns run left to right, anchored just
 * below the QR band and growing downward through the remaining 75%.
 * `offsetXMm` places this tag in the left or right half of the physical
 * 80×70mm sheet; `halfWMm` is that half's actual available width (used to
 * derive `scaleW` against `REF_HALF_W`).
 */
function mrpLabelTagFields(
  data: MrpLabelData,
  offsetXMm: number,
  halfWMm: number,
  hMm: number,
  d: (mm: number) => number,
  esc: (s: unknown) => string,
): string[] {
  const scaleW = halfWMm / REF_HALF_W;
  const font = (heightMm: number, rotate: boolean) => {
    const h = d(heightMm * scaleW);
    const w = Math.max(1, Math.round(h * 0.58));
    return `^A0${rotate ? 'B' : 'N'},${h},${w}`;
  };

  const lines: string[] = [];

  // ── QR code + code text, a horizontal band across the FULL WIDTH at the
  // TOP, taking the top 25% of the tag's height — sized to nearly fill
  // that band (1mm margin). ROTATED to match the confirmed-correct `^A0B`
  // text orientation (`^BQB` instead of `^BQN`) so the whole label reads
  // consistently in one orientation, per explicit request — a QR scans
  // fine at any rotation, so this is purely a visual-consistency choice,
  // not a functional requirement. ──
  const qrBandHMm = hMm * 0.25;
  const qrZoneMm = Math.min(qrBandHMm - 1, halfWMm - 2);
  const qrX = (halfWMm - qrZoneMm) / 2;
  const qrY = (qrBandHMm - qrZoneMm) / 2;
  const qrMagnification = Math.max(1, Math.min(8, Math.round((qrZoneMm / 25) * 5)));
  lines.push(`^FO${d(offsetXMm + qrX)},${d(qrY)}^BQB,2,${qrMagnification}^FDQA,${esc(data.code)}^FS`);
  lines.push(`^FO${d(offsetXMm + qrX)},${d(qrY + qrZoneMm + 1)}${font(1.2, false)}^FD${esc(data.code)}^FS`);

  // ── Design / Style / Size / Qty / Shade / MRP / tax caption — each its
  // OWN rotated 90° column (not combined), anchored just BELOW the QR
  // band (not the tag's bottom edge). IMPORTANT — anchoring at the very
  // bottom edge (an earlier revision's attempt) broke printing entirely:
  // `^A0B` extends text DOWNWARD from its origin, so an origin placed only
  // ~2mm above the bottom edge left almost no room before running off the
  // physical label, rendering nothing. Anchoring near the top (right after
  // the QR band) gives the full remaining height for the downward-growing
  // text to actually appear. ──
  const topYMm = qrBandHMm + 4;
  const col = (xMm: number, heightMm: number, value: string) =>
    `^FO${d(offsetXMm + xMm * scaleW)},${d(topYMm)}${font(heightMm, true)}^FD${esc(value)}^FS`;

  let x = 1.5;
  const push = (heightMm: number, value: string) => {
    lines.push(col(x, heightMm, value));
    x += (heightMm * scaleW + 0.5) / scaleW;
  };
  push(2.8, `Design : ${data.design || '-'}`);
  push(2.4, `Style : ${data.style}`);
  push(2.4, `Size : ${data.size || '-'}`);
  push(2.4, 'Qty : 1 No');
  push(2.4, `Shade : ${data.shade}`);
  push(4.2, `MRP : Rs. ${data.mrp.toFixed(2)}`);
  push(1.8, '(Incl. of all Taxes)');

  return lines;
}

/**
 * Builds one ZPL II command stream for a physical 80×70mm MRP label sheet
 * — which, per the real label stock (confirmed directly against a physical
 * printed sample), is a 2-up layout: two independent PORTRAIT garment tags
 * (each ≈39mm wide × the sheet's full 70mm height) placed side by side,
 * separated by a thin vertical divider line. `right` is `null` for a
 * trailing odd piece, leaving that half blank.
 *
 * The TMG CLOTHINGS / email / Made in India branding is pre-printed on the
 * physical label stock as a horizontal bar along each tag's bottom edge —
 * this function prints ONLY the variable content (see `mrpLabelTagFields`)
 * and deliberately draws no background/box for that bar.
 *
 * This label's media is loaded in the SAME orientation the design is
 * authored in (width 80mm > height 70mm) so there is no whole-canvas
 * rotation model here (unlike the Box Label) — each field is individually
 * rotated instead via `^A0B`, confirmed correct for this printer against
 * an actual physical diagnostic test print. See `mrpLabelTagFields`'s doc
 * comment for this field's rotation history.
 */
export function buildMrpLabelZpl(left: MrpLabelData, right: MrpLabelData | null, settings: MrpLabelPrinterSettings): string {
  const dotsPerMm = settings.dpi / 25.4;
  const d = (mmVal: number) => Math.round(mmVal * dotsPerMm);
  // ^ and ~ are ZPL's command prefixes — strip them out of field data so label text can't be mistaken for a new command.
  const esc = (s: unknown) => String(s ?? '').replace(/[\^~]/g, '');

  const W = settings.labelWidthMm; // 80mm — the whole 2-up sheet
  const H = settings.labelHeightMm; // 70mm

  const DIVIDER_GAP_MM = 2; // clear space either side of the centre divider line
  const halfW = (W - DIVIDER_GAP_MM) / 2;

  const lines: string[] = [
    '^XA',
    `^PW${d(W)}`,
    `^LL${d(H)}`,
    '^LH0,0',
    '^MNY', // non-continuous (gap) media sensing — gapMm itself has no direct ZPL param, the printer auto-calibrates gap length
    `~SD${Math.min(30, Math.max(0, Math.round(settings.densityLevel * 2)))}`,
    `^PR${settings.speedLevel}`,
    '^CI28', // UTF-8 field data
  ];

  lines.push(...mrpLabelTagFields(left, 0, halfW, H, d, esc));

  const rightOffsetXMm = halfW + DIVIDER_GAP_MM;
  if (right) {
    lines.push(...mrpLabelTagFields(right, rightOffsetXMm, halfW, H, d, esc));
  }

  // Thin centre divider between the two tags.
  lines.push(`^FO${d(halfW + DIVIDER_GAP_MM / 2)},0^GB${d(0.3)},${d(H)},${d(0.3)},B,0^FS`);

  lines.push('^XZ');
  return lines.join('\n');
}

/** Pairs up consecutive pieces (2 per physical 80×70mm sheet) and builds one ZPL stream per sheet. */
export function buildMrpLabelZplBatch(dataList: MrpLabelData[], settings: MrpLabelPrinterSettings): string[] {
  const out: string[] = [];
  for (let i = 0; i < dataList.length; i += 2) {
    out.push(buildMrpLabelZpl(dataList[i], dataList[i + 1] ?? null, settings));
  }
  return out.filter(Boolean);
}

/**
 * DIAGNOSTIC ONLY — not used by the normal MRP label print flow. Two
 * earlier ZPL rotation techniques (scalable font `^A0R`, then bitmap font
 * `^ADR`) BOTH failed on physical test prints — every field kept printing
 * fully upright/horizontal regardless. The user has since confirmed field
 * text should in fact be rotated (reversing an intermediate conclusion
 * that it shouldn't), so a THIRD technique is needed — but guessing again
 * without testing would risk a third wasted physical print. This prints 6
 * small unrotated captions side by side, each followed by a rotated "TEST"
 * sample using a different technique, so one physical print settles which
 * (if any) this printer's firmware actually honors:
 *   - A0R / A0B: scalable font ("0"), clockwise / counter-clockwise
 *   - ADR / ADB: bitmap font ("D"), clockwise / counter-clockwise
 *   - AER: a DIFFERENT bitmap font ("E") — in case "D" specifically has an
 *     issue rather than bitmap rotation in general
 *   - A0R-big: scalable font at a much larger size, in case rotation only
 *     engages above some minimum size this firmware requires
 * Whichever column's "TEST" prints sideways (not the caption above it,
 * which is always plain/unrotated as a fixed reference point) tells us
 * which technique to switch the real label build to. If NONE rotate, that
 * itself is important information — it would point to a printer-side
 * driver/OS setting overriding ZPL's own rotation requests, something
 * outside this codebase's control.
 */
export function buildRotationDiagnosticZpl(settings: MrpLabelPrinterSettings): string {
  const dotsPerMm = settings.dpi / 25.4;
  const d = (mmVal: number) => Math.round(mmVal * dotsPerMm);

  const W = settings.labelWidthMm;
  const H = settings.labelHeightMm;

  const lines: string[] = [
    '^XA',
    `^PW${d(W)}`,
    `^LL${d(H)}`,
    '^LH0,0',
    '^MNY',
    `~SD${Math.min(30, Math.max(0, Math.round(settings.densityLevel * 2)))}`,
    `^PR${settings.speedLevel}`,
    '^CI28',
  ];

  const colW = W / 6;
  const techniques: { label: string; cmd: string; fontHeightMm: number }[] = [
    { label: 'A0R', cmd: '^A0R', fontHeightMm: 8 },
    { label: 'A0B', cmd: '^A0B', fontHeightMm: 8 },
    { label: 'ADR', cmd: '^ADR', fontHeightMm: 8 },
    { label: 'ADB', cmd: '^ADB', fontHeightMm: 8 },
    { label: 'AER', cmd: '^AER', fontHeightMm: 8 },
    { label: 'A0R-big', cmd: '^A0R', fontHeightMm: 14 },
  ];

  techniques.forEach((t, i) => {
    const x = i * colW + 1;
    // Fixed, always-unrotated caption identifying the technique — compare every column's "TEST" against this same baseline.
    lines.push(`^FO${d(x)},${d(2)}^A0N,${d(2.6)},${d(1.6)}^FD${t.label}^FS`);
    const h = d(t.fontHeightMm);
    const w = Math.max(1, Math.round(h * 0.58));
    lines.push(`^FO${d(x)},${d(10)}${t.cmd},${h},${w}^FDTEST^FS`);
  });

  lines.push('^XZ');
  return lines.join('\n');
}

