// Sales Return document (A4 portrait, downloaded via jsPDF like the Ready to
// Pack print) — same layout as the business's existing Sales Return form:
// company header, M/S + No./Date/Doc No./Reference box, then per product
// group a size-wise grid (one row per item / shade / price), and a totals
// block with GST, round off and signatures. Values come from buildCreditNote(),
// so the PDF always matches the return and its Credit Note e-Invoice.

import type { CompanySettings } from '../models/einvoice.model';
import type { Invoice } from '../models/invoice.model';
import type { SalesReturn } from '../models/sales-return.model';
import { INDIA_STATE_CODES } from '../models/einvoice.model';
import type { CreditNote, CreditNoteItem } from './sales-return-credit-note.util';

interface GridRow {
  styleNo: string;
  description: string;
  uom: string;
  shade: string;
  price: number;
  qtyBySize: Map<string, number>;
  qty: number;
  amount: number;
}

interface Group {
  name: string;
  sizes: string[];
  rows: GridRow[];
}

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL'];

export function sortSizes(sizes: string[]): string[] {
  const rank = (s: string) => {
    const n = Number(s);
    if (Number.isFinite(n)) return [0, n] as const;
    const i = SIZE_ORDER.indexOf(s.toUpperCase());
    return [i >= 0 ? 1 : 2, i >= 0 ? i : 0] as const;
  };
  return [...sizes].sort((a, b) => {
    const [ga, va] = rank(a);
    const [gb, vb] = rank(b);
    return ga - gb || va - vb || a.localeCompare(b);
  });
}

function buildGroups(items: CreditNoteItem[]): Group[] {
  const groups = new Map<string, { rows: Map<string, GridRow>; sizes: Set<string> }>();
  for (const item of items) {
    const l = item.line;
    const groupName = (l.description || 'ITEMS').toUpperCase();
    const g = groups.get(groupName) ?? { rows: new Map(), sizes: new Set<string>() };
    groups.set(groupName, g);
    g.sizes.add(l.size);
    const shade = l.condition === 'Damage' ? `${l.color} (Damage)` : l.color;
    const key = [l.styleNo, l.sleeveType ?? '', shade, l.price].join('|');
    const row = g.rows.get(key) ?? {
      styleNo: l.styleNo,
      description: [l.description, l.sleeveType].filter(Boolean).join(' '),
      uom: item.uom,
      shade,
      price: l.price,
      qtyBySize: new Map(),
      qty: 0,
      amount: 0,
    };
    row.qtyBySize.set(l.size, (row.qtyBySize.get(l.size) ?? 0) + l.qty);
    row.qty += l.qty;
    row.amount += item.grossAmount;
    g.rows.set(key, row);
  }
  return [...groups.entries()].map(([name, g]) => ({
    name,
    sizes: sortSizes([...g.sizes]),
    rows: [...g.rows.values()].sort((a, b) =>
      a.styleNo.localeCompare(b.styleNo) || a.shade.localeCompare(b.shade, undefined, { numeric: true }) || a.price - b.price),
  }));
}

const money = (n: number) => (Number(n) || 0).toFixed(2);

function fmtDate(raw: any): string {
  if (!raw) return '';
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-');
    return `${d}/${m}/${y}`;
  }
  const date = raw?.toDate ? raw.toDate() : new Date(raw?.seconds ? raw.seconds * 1000 : raw);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

function stateLabel(state: string | undefined, gstin: string | undefined): string {
  const code = /^\d{2}/.test(gstin ?? '') ? gstin!.slice(0, 2) : '';
  const byCode = INDIA_STATE_CODES.find((s) => s.code === code);
  const name = state || byCode?.name || '';
  return code ? `${name}(${code})` : name;
}

export async function downloadSalesReturnPdf(
  ret: SalesReturn,
  creditNote: CreditNote,
  invoices: Invoice[],
  company: CompanySettings | null,
  mode: 'download' | 'print' = 'download',
): Promise<void> {
  const { default: JsPDF } = await import('jspdf');
  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;
  const usableW = pageW - margin * 2;
  const inv0 = invoices[0];
  doc.setLineWidth(0.2);
  doc.setDrawColor(0, 0, 0);
  doc.setTextColor(0, 0, 0);

  // ── Company header + title (repeated on every page) ──
  let titleY = 0;
  const drawPageHeader = (): number => {
    let y = margin + 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(14);
    doc.text(company?.tradeName || company?.legalName || 'TMG Clothings', margin, y);
    y += 1.5;
    doc.line(margin, y, pageW - margin, y);
    y += 4.5;
    doc.setFontSize(9.5);
    const addr = [company?.address1, company?.address2].filter(Boolean).join(', ');
    for (const ln of doc.splitTextToSize(addr, usableW * 0.6)) { doc.text(ln, margin, y); y += 4; }
    doc.text([company?.place, company?.pinCode].filter(Boolean).join(' - ') + (company?.phone ? `, Phone: ${company.phone}` : ''), margin, y);
    y += 4;
    if (company?.gstin) { doc.text(`GSTIN: ${company.gstin}`, margin, y); y += 4; }
    y += 4;
    titleY = y;
    doc.setFontSize(13);
    doc.text(ret.eInvoiceStatus === 'generated' ? 'Sales Return (Credit Note)' : 'Sales Return', pageW / 2, y, { align: 'center' });
    return y + 4;
  };

  let y = drawPageHeader();

  // ── Party / document box ──
  const boxTop = y;
  const leftW = usableW * 0.64;
  const rightX = margin + leftW;
  doc.setFontSize(9);
  let ly = boxTop + 5;
  const labelL = (label: string, value: string, x: number, yy: number, valueX: number, maxW: number) => {
    doc.text(label, x, yy);
    const lines = doc.splitTextToSize(value ? `: ${value}` : ':', maxW);
    lines.forEach((ln: string, i: number) => doc.text(i === 0 ? ln : `  ${ln}`, valueX, yy + i * 4));
    return lines.length;
  };
  labelL('M/S', ret.clientName, margin + 2, ly, margin + 22, leftW - 26);
  ly += 4.5;
  const addrLines = [inv0?.clientAddress, [inv0?.clientPlace, inv0?.clientZipCode].filter(Boolean).join(' - ')]
    .filter(Boolean).flatMap((a) => doc.splitTextToSize(a!, leftW - 28));
  for (const ln of addrLines) { doc.text(ln, margin + 24, ly); ly += 4; }
  labelL('State', stateLabel(inv0?.clientState, ret.clientGstin || inv0?.clientGstin), margin + 2, ly, margin + 22, leftW - 26);
  ly += 4.5;
  doc.text(`GSTIN: ${ret.clientGstin || inv0?.clientGstin || 'URP'}`, margin + 2, ly);
  ly += 3;

  let ry = boxTop + 5;
  const docNo = invoices.length
    ? invoices.map((inv) => `${inv.invoiceNo} DT ${fmtDate(inv.invoiceDate)}`).join(', ')
    : (ret.invoiceNos ?? []).join(', ');
  const rightRows: [string, string][] = [
    ['No.', ret.returnNo],
    ['Date', fmtDate(ret.returnDate)],
    ['Doc No.', docNo],
    ['Reference', ret.referenceNo ?? ''],
  ];
  for (const [label, value] of rightRows) {
    const n = labelL(label, value, rightX + 2, ry, rightX + 22, usableW - leftW - 24);
    ry += 4 * n + 2;
  }
  const boxBottom = Math.max(ly, ry - 2) + 2;
  doc.rect(margin, boxTop, usableW, boxBottom - boxTop);
  doc.line(rightX, boxTop, rightX, boxBottom);
  y = boxBottom;

  // ── E-Invoice block (credit note registered with the IRP) ──
  if (ret.eInvoiceStatus === 'generated' && ret.irn) {
    const h = 26;
    doc.rect(margin, y, usableW, h);
    doc.setFontSize(8.5);
    doc.text(`IRN : ${ret.irn}`, margin + 2, y + 6, { maxWidth: usableW - 32 });
    doc.text(`Ack No. : ${ret.ackNo ?? ''}`, margin + 2, y + 12);
    doc.text(`Ack Date : ${ret.ackDt ?? ''}`, margin + 2, y + 17);
    doc.text('Document Type : CRN (Credit Note)', margin + 2, y + 22);
    if (ret.signedQrCode) {
      const src = ret.signedQrCode.startsWith('data:') ? ret.signedQrCode : `data:image/png;base64,${ret.signedQrCode}`;
      try { doc.addImage(src, 'PNG', pageW - margin - 25, y + 1, 24, 24); } catch { /* QR is cosmetic on the PDF */ }
    }
    y += h;
  }
  y += 2;

  // ── Item grid per product group ──
  const groups = buildGroups(creditNote.items);
  const maxSizes = Math.max(4, ...groups.map((g) => g.sizes.length));
  const fixed = { item: 22, desc: 30, uom: 11, shade: 22, total: 12, price: 16, amount: 21 };
  const fixedW = Object.values(fixed).reduce((s, w) => s + w, 0);
  const sizeW = Math.min(12, (usableW - fixedW) / maxSizes);
  const lineH = 3.6;
  const footerReserve = 14;

  const newPage = () => {
    doc.addPage();
    y = drawPageHeader() + 2;
  };

  const drawGroupHeader = (g: Group) => {
    const bandH = 5;
    const headH = 9;
    if (y + bandH + headH + 6 > pageH - margin - footerReserve) newPage();
    doc.setFillColor(102, 153, 255);
    doc.rect(margin, y, usableW, bandH, 'F');
    doc.setFontSize(9);
    doc.text(g.name, margin + 1.5, y + 3.7);
    y += bandH;

    const tableW = fixedW + sizeW * g.sizes.length;
    doc.setFontSize(8.5);
    let x = margin;
    const cell = (label: string, w: number) => {
      doc.rect(x, y, w, headH);
      doc.text(label, x + 1.2, y + headH / 2 + 1.2);
      x += w;
    };
    cell('Item', fixed.item);
    cell('Description', fixed.desc);
    cell('UOM', fixed.uom);
    cell('Shade', fixed.shade);
    // "Size" spans the size columns; each size label sits below it.
    doc.rect(x, y, sizeW * g.sizes.length, headH / 2);
    doc.text('Size', x + (sizeW * g.sizes.length) / 2, y + 3.4, { align: 'center' });
    g.sizes.forEach((s, i) => {
      doc.rect(x + i * sizeW, y + headH / 2, sizeW, headH / 2);
      doc.text(s, x + i * sizeW + sizeW / 2, y + headH - 1.2, { align: 'center' });
    });
    x += sizeW * g.sizes.length;
    cell('Total', fixed.total);
    cell('Price', fixed.price);
    cell('Amount', fixed.amount);
    y += headH;
    return tableW;
  };

  for (const g of groups) {
    let tableW = drawGroupHeader(g);
    let lastStyle = '';
    for (const row of g.rows) {
      doc.setFontSize(8.5);
      const firstOfItem = row.styleNo !== lastStyle;
      const itemLines = firstOfItem ? doc.splitTextToSize(row.styleNo, fixed.item - 2) : [];
      const descLines = firstOfItem ? doc.splitTextToSize(row.description, fixed.desc - 2) : [];
      const shadeLines = doc.splitTextToSize(row.shade || '-', fixed.shade - 2);
      const rowH = Math.max(itemLines.length, descLines.length, shadeLines.length, 1) * lineH + 1.6;
      if (y + rowH > pageH - margin - footerReserve) {
        newPage();
        tableW = drawGroupHeader(g);
        lastStyle = '';
      }
      let x = margin;
      const textCell = (lines: string[], w: number) => {
        doc.rect(x, y, w, rowH);
        lines.forEach((ln, i) => doc.text(ln, x + 1.2, y + lineH * (i + 1)));
        x += w;
      };
      const numCell = (text: string, w: number, fill?: boolean) => {
        if (fill) { doc.setFillColor(204, 229, 255); doc.rect(x, y, w, rowH, 'F'); }
        doc.rect(x, y, w, rowH);
        if (text) doc.text(text, x + w - 1.2, y + lineH, { align: 'right' });
        x += w;
      };
      textCell(itemLines, fixed.item);
      textCell(descLines, fixed.desc);
      textCell(firstOfItem ? [row.uom] : [], fixed.uom);
      textCell(shadeLines, fixed.shade);
      for (const s of g.sizes) {
        const q = row.qtyBySize.get(s) ?? 0;
        doc.rect(x, y, sizeW, rowH);
        if (q) doc.text(String(q), x + sizeW / 2, y + lineH, { align: 'center' });
        x += sizeW;
      }
      numCell(String(row.qty), fixed.total, true);
      numCell(money(row.price), fixed.price, true);
      numCell(money(row.amount), fixed.amount, true);
      y += rowH;
      lastStyle = row.styleNo;
    }

    // Group total row
    const totH = 5.5;
    if (y + totH > pageH - margin - footerReserve) { newPage(); tableW = drawGroupHeader(g); }
    doc.setFillColor(204, 229, 255);
    doc.rect(margin, y, tableW, totH, 'F');
    let x = margin;
    const labelW = fixed.item + fixed.desc + fixed.uom + fixed.shade;
    doc.rect(x, y, labelW, totH);
    doc.text('Total', x + labelW - 1.2, y + 3.9, { align: 'right' });
    x += labelW;
    for (const s of g.sizes) {
      const q = g.rows.reduce((sum, r) => sum + (r.qtyBySize.get(s) ?? 0), 0);
      doc.rect(x, y, sizeW, totH);
      if (q) doc.text(String(q), x + sizeW / 2, y + 3.9, { align: 'center' });
      x += sizeW;
    }
    doc.rect(x, y, fixed.total, totH);
    doc.text(String(g.rows.reduce((s, r) => s + r.qty, 0)), x + fixed.total - 1.2, y + 3.9, { align: 'right' });
    x += fixed.total;
    doc.rect(x, y, fixed.price, totH);
    x += fixed.price;
    doc.rect(x, y, fixed.amount, totH);
    doc.text(money(g.rows.reduce((s, r) => s + r.amount, 0)), x + fixed.amount - 1.2, y + 3.9, { align: 'right' });
    y += totH + 3;
  }

  // ── Totals / remarks / signatures (bottom of the last page) ──
  const rate = (n: number) => `${Number(n.toFixed(2))}%`;
  const gstRate = creditNote.items[0]?.gstRate ?? 0;
  const summary: [string, string][] = [
    ['Gross :', money(creditNote.grossAmount)],
    ...(creditNote.discount > 0 ? [['Discount :', money(creditNote.discount)] as [string, string]] : []),
    ['Taxable Value :', money(creditNote.taxableValue)],
    ...(creditNote.isInterState
      ? [[`IGST @ ${rate(gstRate)} :`, money(creditNote.igstAmount)] as [string, string]]
      : [[`CGST @ ${rate(gstRate / 2)} :`, money(creditNote.cgstAmount)], [`SGST @ ${rate(gstRate / 2)} :`, money(creditNote.sgstAmount)]] as [string, string][]),
    ['Round Off :', money(creditNote.roundOff)],
  ];
  const footH = 12 + summary.length * 5 + 8;
  if (y + footH > pageH - margin) newPage();
  const fy = pageH - margin - footH;
  const leftBoxW = usableW * 0.36;
  doc.rect(margin, fy, usableW, footH);
  doc.line(margin + leftBoxW, fy, margin + leftBoxW, fy + footH);
  doc.line(margin, fy + 6, margin + leftBoxW, fy + 6);
  doc.setFontSize(9);
  doc.text(`Total Qty : ${creditNote.items.reduce((s, i) => s + i.line.qty, 0)}`, margin + leftBoxW / 2, fy + 4.3, { align: 'center' });
  let sy = fy + 11;
  const labelX = margin + leftBoxW * 0.62;
  const valueX = margin + leftBoxW - 3;
  for (const [label, value] of summary) {
    doc.text(label, labelX, sy, { align: 'right' });
    doc.text(value, valueX, sy, { align: 'right' });
    sy += 5;
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Total :', labelX, sy + 1, { align: 'right' });
  doc.text(money(creditNote.netAmount), valueX, sy + 1, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);

  const rx = margin + leftBoxW + 3;
  const remarksW = usableW - leftBoxW - 6;
  doc.text('Remarks :', rx, fy + 5);
  const remarks = [ret.remarks, ret.status === 'Cancelled' ? `CANCELLED${ret.cancelReason ? ` — ${ret.cancelReason}` : ''}` : '']
    .filter(Boolean).join('  ');
  if (remarks) doc.text(doc.splitTextToSize(remarks, remarksW - 18).slice(0, 4), rx + 17, fy + 5);
  const sigY = fy + footH - 6;
  const half = remarksW / 2;
  doc.line(rx, sigY, rx + half - 6, sigY);
  doc.line(rx + half + 3, sigY, rx + remarksW, sigY);
  doc.text('Checked By', rx + (half - 6) / 2, sigY + 4.2, { align: 'center' });
  doc.text('Authorised By', rx + half + 3 + (half - 3) / 2, sigY + 4.2, { align: 'center' });

  // ── Page x / n ──
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8.5);
    doc.text(`Page :  ${p} / ${pages}`, pageW - margin, titleY, { align: 'right' });
  }

  if (mode === 'print') {
    // Same document, opened in a new tab with the browser's print dialog
    // raised on load (jsPDF autoPrint) — the Credit Note print with IRN/QR.
    doc.autoPrint();
    const url = URL.createObjectURL(doc.output('blob'));
    const win = window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (!win) throw new Error('The print window was blocked — allow pop-ups for this site and try again.');
    return;
  }
  doc.save(`Sales_Return_${ret.returnNo}.pdf`);
}
