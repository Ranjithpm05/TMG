import Swal from 'sweetalert2';

/** Optional per-report row styling hooks for printReportRows/exportRowsToPdf. */
export interface ExportRowOpts {
  /** Defaults to matching "...Total..." labels in columns 1-3 (works for every report's grand/sub-total rows). */
  isGrandTotalRow?: (row: any[]) => boolean;
  /** Only the Exceed Order report passes this (highlights rows where stock is exceeded). */
  highlightRow?: (row: any[]) => boolean;
  /** exportRowsToPdf only: draws one underlined blank per label, evenly spaced, below the table (e.g. ['Prepared By', 'Checked By', 'Packed By']). */
  signatureLabels?: string[];
}

function formatTimestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

const defaultIsGrandTotalRow = (row: any[]) => [1, 2, 3].some((i) => String(row[i]).toLowerCase().includes('total'));

/** Builds and downloads an .xlsx file from a header+body row matrix via a dynamic `xlsx` import. */
export async function exportRowsToExcel(rows: any[][], title: string): Promise<void> {
  try {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, title.slice(0, 31));
    XLSX.writeFile(wb, `${title.replace(/\s+/g, '_')}_${formatTimestamp()}.xlsx`);
  } catch {
    Swal.fire({ icon: 'error', title: 'Export Failed', text: 'Could not generate the Excel file.' });
  }
}

/** Opens a new window with an HTML table built from the row matrix and triggers the browser print dialog. */
export function printReportRows(rows: any[][], title: string, filterSummaryText: string, opts?: ExportRowOpts): void {
  const [header, ...body] = rows;
  const isGrandTotalRow = opts?.isGrandTotalRow ?? defaultIsGrandTotalRow;
  const highlightRow = opts?.highlightRow;

  const th = (t: any) =>
    `<th style="padding:6px 10px;border:1px solid #ccc;background:#1e293b;color:#fff;text-align:center">${t}</th>`;
  const td = (t: any, bold = false) =>
    `<td style="padding:5px 10px;border:1px solid #ddd;text-align:center;${bold ? 'font-weight:700;background:#f1f5f9' : ''}">${t}</td>`;

  const theadHtml = `<tr>${header.map((h) => th(h)).join('')}</tr>`;
  const bodyHtml = body
    .map((row) => {
      const bold = isGrandTotalRow(row);
      const highlight = highlightRow?.(row) ?? false;
      return `<tr style="${highlight ? 'background:#fee2e2;color:#991b1b;font-weight:600' : ''}">${row.map((c) => td(c, bold)).join('')}</tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html><html><head><title>${title}</title>
  <style>
    body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#1e293b}
    h2{margin:0 0 4px 0} p{margin:0 0 14px 0;color:#64748b;font-size:11px}
    table{border-collapse:collapse;width:100%}
    @media print{body{margin:10px}}
  </style></head><body>
  <h2>${title}</h2>
  <p>${filterSummaryText}</p>
  <table><thead>${theadHtml}</thead><tbody>${bodyHtml}</tbody></table>
  </body></html>`;

  const win = window.open('', '_blank', 'width=1100,height=750');
  if (win) {
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 700);
  }
}

/** Builds and downloads a paginated PDF table from the row matrix via a dynamic `jspdf` import. */
export async function exportRowsToPdf(
  rows: any[][],
  title: string,
  filterSummaryText: string,
  opts?: ExportRowOpts
): Promise<void> {
  const [header, ...body] = rows;
  const isGrandTotalRow = opts?.isGrandTotalRow ?? defaultIsGrandTotalRow;
  const highlightRow = opts?.highlightRow;

  const { default: JsPDF } = await import('jspdf');
  const doc = new JsPDF({ orientation: header.length > 6 ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;
  const usableW = pageW - margin * 2;
  const colW = usableW / header.length;
  const rowH = 7;
  let y = margin;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(title, margin, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(filterSummaryText, margin, y);
  y += 6;

  const drawRow = (
    values: any[],
    rowOpts: { bold?: boolean; fillColor?: [number, number, number]; textColor?: [number, number, number] } = {}
  ) => {
    if (y > pageH - margin - rowH) {
      doc.addPage();
      y = margin;
    }
    if (rowOpts.fillColor) {
      doc.setFillColor(rowOpts.fillColor[0], rowOpts.fillColor[1], rowOpts.fillColor[2]);
      doc.rect(margin, y, usableW, rowH, 'F');
    }
    doc.setDrawColor(200, 200, 200);
    doc.rect(margin, y, usableW, rowH, 'S');
    doc.setFont('helvetica', rowOpts.bold ? 'bold' : 'normal');
    doc.setFontSize(7.5);
    const textColor = rowOpts.textColor ?? [0, 0, 0];
    doc.setTextColor(textColor[0], textColor[1], textColor[2]);
    values.forEach((v, i) => {
      const x = margin + i * colW;
      doc.line(x, y, x, y + rowH);
      doc.text(String(v ?? ''), x + colW / 2, y + rowH / 2 + 1.2, { align: 'center', maxWidth: colW - 2 });
    });
    doc.line(margin + usableW, y, margin + usableW, y + rowH);
    y += rowH;
  };

  drawRow(header, { bold: true, fillColor: [30, 41, 59], textColor: [255, 255, 255] });
  body.forEach((row) => {
    const isGrandTotal = isGrandTotalRow(row);
    const isHighlighted = highlightRow?.(row) ?? false;
    drawRow(row, {
      bold: isGrandTotal,
      fillColor: isGrandTotal ? [241, 245, 249] : isHighlighted ? [254, 226, 226] : undefined,
      textColor: isHighlighted ? [153, 27, 27] : [0, 0, 0],
    });
  });

  if (opts?.signatureLabels?.length) {
    const labels = opts.signatureLabels;
    if (y > pageH - margin - 20) { doc.addPage(); y = margin; }
    y += 18;
    const segW = usableW / labels.length;
    doc.setDrawColor(51, 65, 85);
    doc.setLineWidth(0.3);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    labels.forEach((label, i) => {
      const x1 = margin + i * segW + 5;
      const x2 = margin + (i + 1) * segW - 5;
      doc.line(x1, y, x2, y);
      doc.text(label, (x1 + x2) / 2, y + 4, { align: 'center' });
    });
  }

  doc.save(`${title.replace(/\s+/g, '_')}_${formatTimestamp()}.pdf`);
}
