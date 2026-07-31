import { Component, ChangeDetectionStrategy, signal, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';
import Swal from 'sweetalert2';

import { SalesOrderService } from '../../services/sales-order.service';
import { ClientService } from '../../services/client.service';
import { DesignService } from '../../services/design.service';
import { InventoryService } from '../../services/inventory.service';
import type { SalesOrder, OrderItem } from '../../models/sales-order.model';
import type { Client } from '../../models/client.model';
import type { Design } from '../../models/design.model';
import type { InventoryItem } from '../../models/inventory.model';

export type ReportTab = 'customer' | 'agent' | 'product' | 'exceed';

interface MatrixRow {
  key: string;
  label: string;
  qtyByGroup: Record<string, number>;
  totalQty: number;
  totalValue: number;
}

interface MatrixReport {
  groups: string[];
  rows: MatrixRow[];
  grandTotal: { qtyByGroup: Record<string, number>; totalQty: number; totalValue: number };
}

interface ProductRow {
  group: string;
  totalQty: number;
  totalValue: number;
}

interface ExceedRow {
  designId: string;
  styleNo: string;
  color: string;
  orderedQty: number;
  availableQty: number;
  exceeds: boolean;
}

const STATUS_OPTIONS = ['Pending', 'Confirmed', 'Shipped'] as const;

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './reports.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportsComponent {
  private readonly salesOrderService = inject(SalesOrderService);
  private readonly clientService = inject(ClientService);
  private readonly designService = inject(DesignService);
  private readonly inventoryService = inject(InventoryService);

  // ── Filter state ──────────────────────────────────────────────────────
  readonly startDate = signal(this.currentMonthStart());
  readonly endDate = signal(this.formatDateInput(new Date()));
  readonly selectedCustomerId = signal('');
  readonly selectedAgent = signal('');
  readonly selectedGroup = signal('');
  readonly designSearch = signal('');
  readonly selectedStatus = signal('');
  readonly activeReport = signal<ReportTab>('customer');

  readonly statusOptions = STATUS_OPTIONS;

  readonly dateRange = computed(() => {
    const rawStart = this.parseInputDate(this.startDate()) ?? this.parseInputDate(this.currentMonthStart())!;
    const rawEnd = this.parseInputDate(this.endDate()) ?? new Date();
    const start = rawStart <= rawEnd ? rawStart : rawEnd;
    const end = rawEnd >= rawStart ? rawEnd : rawStart;
    return { start: this.startOfDay(start), end: this.endOfDay(end) };
  });

  // ── Data sources ──────────────────────────────────────────────────────
  private readonly ordersInRange = toSignal(
    toObservable(this.dateRange).pipe(
      switchMap(({ start, end }) => this.salesOrderService.getSalesOrdersInRange(start, end))
    ),
    { initialValue: [] as SalesOrder[] }
  );

  readonly clients = toSignal(this.clientService.getClients(), { initialValue: [] as Client[] });
  readonly designs = toSignal(this.designService.getDesigns(), { initialValue: [] as Design[] });
  readonly inventory = toSignal(this.inventoryService.getInventory(), { initialValue: [] as InventoryItem[] });

  readonly clientById = computed(() => {
    const map = new Map<string, Client>();
    for (const c of this.clients()) {
      if (c.id) map.set(c.id, c);
    }
    return map;
  });

  readonly sortedClients = computed(() =>
    [...this.clients()].sort((a, b) => this.toText(a.clientName).localeCompare(this.toText(b.clientName)))
  );

  readonly agentOptions = computed(() => {
    const set = new Set<string>();
    for (const c of this.clients()) {
      set.add(this.resolveAgentName(c));
    }
    return [...set].sort();
  });

  readonly groupOptions = computed(() => {
    const set = new Set<string>();
    for (const d of this.designs()) {
      const group = this.toText(d.group);
      if (group) set.add(group);
    }
    return [...set].sort();
  });

  // ── Filtering pipeline ────────────────────────────────────────────────
  readonly filteredOrders = computed(() => {
    const customerId = this.selectedCustomerId();
    const agent = this.selectedAgent();
    const status = this.selectedStatus();
    const clientById = this.clientById();

    return this.ordersInRange().filter((order) => {
      if (customerId && order.clientId !== customerId) return false;
      if (status && order.status !== status) return false;
      if (agent) {
        const client = clientById.get(order.clientId);
        if (!client || this.resolveAgentName(client) !== agent) return false;
      }
      return true;
    });
  });

  // ── Report aggregations ───────────────────────────────────────────────
  readonly report1 = computed<MatrixReport>(() => {
    const clientById = this.clientById();
    return this.buildMatrix(
      (order) => order.clientId,
      (key) => this.toText(clientById.get(key)?.clientName) || 'Unknown Client'
    );
  });

  readonly report2 = computed<MatrixReport>(() => {
    const clientById = this.clientById();
    return this.buildMatrix(
      (order) => {
        const client = clientById.get(order.clientId);
        return client ? this.resolveAgentName(client) : '';
      },
      (key) => key
    );
  });

  readonly report3 = computed(() => this.buildProductSummary());
  readonly report4 = computed(() => this.buildExceedReport());

  // ── Filter actions ────────────────────────────────────────────────────
  setTab(tab: ReportTab): void {
    this.activeReport.set(tab);
  }

  updateStartDate(value: string): void {
    this.startDate.set(value);
  }

  updateEndDate(value: string): void {
    this.endDate.set(value);
  }

  resetToCurrentMonth(): void {
    this.startDate.set(this.currentMonthStart());
    this.endDate.set(this.formatDateInput(new Date()));
  }

  setPreset(days: number): void {
    const end = new Date();
    const start = this.shiftDays(end, -(days - 1));
    this.startDate.set(this.formatDateInput(start));
    this.endDate.set(this.formatDateInput(end));
  }

  resetFilters(): void {
    this.selectedCustomerId.set('');
    this.selectedAgent.set('');
    this.selectedGroup.set('');
    this.designSearch.set('');
    this.selectedStatus.set('');
  }

  getReportTitle(tab: ReportTab = this.activeReport()): string {
    switch (tab) {
      case 'customer': return 'Customer Wise Sales Report';
      case 'agent': return 'Agent Wise Sales Report';
      case 'product': return 'Product Wise Summary Report';
      case 'exceed': return 'Exceed Order Report';
    }
  }

  filterSummary(): string {
    const { start, end } = this.dateRange();
    const parts = [`${this.formatLongDate(start)} - ${this.formatLongDate(end)}`];
    const customer = this.clients().find((c) => c.id === this.selectedCustomerId())?.clientName;
    parts.push(`Customer: ${customer ?? 'All'}`);
    parts.push(`Agent: ${this.selectedAgent() || 'All'}`);
    parts.push(`Product: ${this.selectedGroup() || 'All'}`);
    if (this.designSearch().trim()) parts.push(`Design: ${this.designSearch().trim()}`);
    parts.push(`Status: ${this.selectedStatus() || 'All'}`);
    return parts.join('  ·  ');
  }

  // ── Export / Print ────────────────────────────────────────────────────
  async exportExcel(): Promise<void> {
    const tab = this.activeReport();
    const rows = this.buildExportRows(tab);
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to export for the current filters.' });
      return;
    }

    try {
      const XLSX = await import('xlsx');
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, this.getReportTitle(tab).slice(0, 31));
      XLSX.writeFile(wb, `${this.getReportTitle(tab).replace(/\s+/g, '_')}_${this.formatTimestamp()}.xlsx`);
    } catch {
      Swal.fire({ icon: 'error', title: 'Export Failed', text: 'Could not generate the Excel file.' });
    }
  }

  printReport(): void {
    const tab = this.activeReport();
    const rows = this.buildExportRows(tab);
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to print for the current filters.' });
      return;
    }

    const [header, ...body] = rows;
    const isGrandTotalRow = (row: any[]) => String(row[1]).toLowerCase().includes('grand total');

    const th = (t: any) =>
      `<th style="padding:6px 10px;border:1px solid #ccc;background:#1e293b;color:#fff;text-align:center">${t}</th>`;
    const td = (t: any, bold = false) =>
      `<td style="padding:5px 10px;border:1px solid #ddd;text-align:center;${bold ? 'font-weight:700;background:#f1f5f9' : ''}">${t}</td>`;

    const theadHtml = `<tr>${header.map((h) => th(h)).join('')}</tr>`;
    const bodyHtml = body
      .map((row) => {
        const bold = isGrandTotalRow(row);
        const highlight = tab === 'exceed' && row[row.length - 1] === 'Exceeds';
        return `<tr style="${highlight ? 'background:#fee2e2;color:#991b1b;font-weight:600' : ''}">${row.map((c) => td(c, bold)).join('')}</tr>`;
      })
      .join('');

    const html = `<!DOCTYPE html><html><head><title>${this.getReportTitle(tab)}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#1e293b}
      h2{margin:0 0 4px 0} p{margin:0 0 14px 0;color:#64748b;font-size:11px}
      table{border-collapse:collapse;width:100%}
      @media print{body{margin:10px}}
    </style></head><body>
    <h2>${this.getReportTitle(tab)}</h2>
    <p>${this.filterSummary()}</p>
    <table><thead>${theadHtml}</thead><tbody>${bodyHtml}</tbody></table>
    </body></html>`;

    const win = window.open('', '_blank', 'width=1100,height=750');
    if (win) {
      win.document.write(html);
      win.document.close();
      setTimeout(() => win.print(), 700);
    }
  }

  async exportPdf(): Promise<void> {
    const tab = this.activeReport();
    const rows = this.buildExportRows(tab);
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to export for the current filters.' });
      return;
    }

    const [header, ...body] = rows;
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
    doc.text(this.getReportTitle(tab), margin, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(this.filterSummary(), margin, y);
    y += 6;

    const drawRow = (
      values: any[],
      opts: { bold?: boolean; fillColor?: [number, number, number]; textColor?: [number, number, number] } = {}
    ) => {
      if (y > pageH - margin - rowH) {
        doc.addPage();
        y = margin;
      }
      if (opts.fillColor) {
        doc.setFillColor(opts.fillColor[0], opts.fillColor[1], opts.fillColor[2]);
        doc.rect(margin, y, usableW, rowH, 'F');
      }
      doc.setDrawColor(200, 200, 200);
      doc.rect(margin, y, usableW, rowH, 'S');
      doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
      doc.setFontSize(7.5);
      const textColor = opts.textColor ?? [0, 0, 0];
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
      const isGrandTotal = String(row[1]).toLowerCase().includes('grand total');
      const isExceed = tab === 'exceed' && row[row.length - 1] === 'Exceeds';
      drawRow(row, {
        bold: isGrandTotal,
        fillColor: isGrandTotal ? [241, 245, 249] : isExceed ? [254, 226, 226] : undefined,
        textColor: isExceed ? [153, 27, 27] : [0, 0, 0],
      });
    });

    doc.save(`${this.getReportTitle(tab).replace(/\s+/g, '_')}_${this.formatTimestamp()}.pdf`);
  }

  private buildExportRows(tab: ReportTab): any[][] {
    switch (tab) {
      case 'customer':
        return this.matrixToRows(this.report1(), 'Customer Name');
      case 'agent':
        return this.matrixToRows(this.report2(), 'Agent Name');
      case 'product': {
        const { rows, grandTotal } = this.report3();
        const header = ['#', 'Product / Group', 'Order Qty', 'Order Value'];
        const body = rows.map((r, i) => [i + 1, r.group, r.totalQty, this.round2(r.totalValue)]);
        body.push(['', 'Grand Total', grandTotal.totalQty, this.round2(grandTotal.totalValue)]);
        return [header, ...body];
      }
      case 'exceed': {
        const { rows } = this.report4();
        const header = ['#', 'Design No', 'Color', 'Ordered Qty', 'Available Qty', 'Status'];
        return [
          header,
          ...rows.map((r, i) => [i + 1, r.styleNo, r.color, r.orderedQty, r.availableQty, r.exceeds ? 'Exceeds' : 'OK']),
        ];
      }
    }
  }

  private matrixToRows(matrix: MatrixReport, labelHeader: string): any[][] {
    const header = ['#', labelHeader, ...matrix.groups, 'Total Qty', 'Total Order Value'];
    const body = matrix.rows.map((r, i) => [
      i + 1,
      r.label,
      ...matrix.groups.map((g) => r.qtyByGroup[g] ?? 0),
      r.totalQty,
      this.round2(r.totalValue),
    ]);
    body.push([
      '',
      'Grand Total',
      ...matrix.groups.map((g) => matrix.grandTotal.qtyByGroup[g] ?? 0),
      matrix.grandTotal.totalQty,
      this.round2(matrix.grandTotal.totalValue),
    ]);
    return [header, ...body];
  }

  // ── Aggregation helpers ───────────────────────────────────────────────
  private buildMatrix(keyFn: (order: SalesOrder) => string, labelFn: (key: string) => string): MatrixReport {
    const rows = new Map<string, MatrixRow>();
    const groupSet = new Set<string>();

    for (const order of this.filteredOrders()) {
      const key = keyFn(order);
      if (!key) continue;

      for (const item of order.items ?? []) {
        if (!this.matchesItemFilters(item)) continue;
        const group = this.toText(item.design?.group) || 'Other';
        groupSet.add(group);

        let row = rows.get(key);
        if (!row) {
          row = { key, label: labelFn(key), qtyByGroup: {}, totalQty: 0, totalValue: 0 };
          rows.set(key, row);
        }

        for (const size of item.itemSizes ?? []) {
          const qty = Number(size.quantity) || 0;
          const value = qty * (Number(size.WSP) || 0);
          row.qtyByGroup[group] = (row.qtyByGroup[group] ?? 0) + qty;
          row.totalQty += qty;
          row.totalValue += value;
        }
      }
    }

    const groups = [...groupSet].sort();
    const rowList = [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
    const grandTotal = {
      qtyByGroup: Object.fromEntries(groups.map((g) => [g, rowList.reduce((s, r) => s + (r.qtyByGroup[g] ?? 0), 0)])),
      totalQty: rowList.reduce((s, r) => s + r.totalQty, 0),
      totalValue: rowList.reduce((s, r) => s + r.totalValue, 0),
    };

    return { groups, rows: rowList, grandTotal };
  }

  private buildProductSummary(): { rows: ProductRow[]; grandTotal: { totalQty: number; totalValue: number } } {
    const rows = new Map<string, ProductRow>();

    for (const order of this.filteredOrders()) {
      for (const item of order.items ?? []) {
        if (!this.matchesItemFilters(item)) continue;
        const group = this.toText(item.design?.group) || 'Other';

        let row = rows.get(group);
        if (!row) {
          row = { group, totalQty: 0, totalValue: 0 };
          rows.set(group, row);
        }

        for (const size of item.itemSizes ?? []) {
          const qty = Number(size.quantity) || 0;
          row.totalQty += qty;
          row.totalValue += qty * (Number(size.WSP) || 0);
        }
      }
    }

    const rowList = [...rows.values()].sort((a, b) => a.group.localeCompare(b.group));
    const grandTotal = {
      totalQty: rowList.reduce((s, r) => s + r.totalQty, 0),
      totalValue: rowList.reduce((s, r) => s + r.totalValue, 0),
    };

    return { rows: rowList, grandTotal };
  }

  private buildExceedReport(): { rows: ExceedRow[] } {
    const orderedByDesign = new Map<string, number>();

    for (const order of this.filteredOrders()) {
      for (const item of order.items ?? []) {
        if (!this.matchesItemFilters(item)) continue;
        const designId = item.design?.id;
        if (!designId) continue;
        const qty = (item.itemSizes ?? []).reduce((s, sz) => s + (Number(sz.quantity) || 0), 0);
        orderedByDesign.set(designId, (orderedByDesign.get(designId) ?? 0) + qty);
      }
    }

    const availableByDesign = new Map<string, number>();
    for (const inv of this.inventory()) {
      if (!inv.designId) continue;
      availableByDesign.set(inv.designId, (availableByDesign.get(inv.designId) ?? 0) + (Number(inv.currentStock) || 0));
    }

    const designById = new Map<string, Design>();
    for (const d of this.designs()) {
      if (d.id) designById.set(d.id, d);
    }

    const rows: ExceedRow[] = [...orderedByDesign.entries()]
      .map(([designId, orderedQty]) => {
        const design = designById.get(designId);
        const availableQty = availableByDesign.get(designId) ?? 0;
        return {
          designId,
          styleNo: this.toText(design?.styleNo) || 'Unknown',
          color: this.toText(design?.color),
          orderedQty,
          availableQty,
          exceeds: orderedQty > availableQty,
        };
      })
      .sort((a, b) => a.styleNo.localeCompare(b.styleNo));

    return { rows };
  }

  private matchesItemFilters(item: OrderItem): boolean {
    const group = this.selectedGroup();
    const search = this.toText(this.designSearch()).toLowerCase();
    if (group && this.toText(item.design?.group) !== group) return false;
    if (search && !this.toText(item.design?.styleNo).toLowerCase().includes(search)) return false;
    return true;
  }

  private resolveAgentName(client: Client): string {
    const agent = this.toText(client.agentName);
    if (agent) return agent;
    if (client.clientType === 'Agent') return this.toText(client.clientName) || 'Unassigned';
    return 'Unassigned';
  }

  /** Firestore documents aren't type-checked — coerce possibly-non-string values before string ops. */
  private toText(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (value == null) return '';
    return String(value).trim();
  }

  // ── Date / formatting helpers ─────────────────────────────────────────
  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private parseInputDate(value: string): Date | null {
    if (!value) return null;
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  }

  private endOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  }

  private shiftDays(date: Date, days: number): Date {
    const shifted = new Date(date);
    shifted.setDate(shifted.getDate() + days);
    return shifted;
  }

  private currentMonthStart(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  private formatDateInput(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private formatLongDate(date: Date): string {
    return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  }

  private formatTimestamp(): string {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  }
}
