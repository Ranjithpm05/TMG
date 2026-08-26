import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { ReportCalcService } from '../report-calc.service';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows, type ExportMeta } from '../report-export.util';
import { ReportStatusComponent } from '../report-status/report-status.component';
import { ReportPaginationComponent } from '../report-pagination/report-pagination.component';
import type { OrderItem } from '../../../models/sales-order.model';

const REPORT_TITLE = 'Style No. & Customer Wise Report';

// Matches the SIZE_ORDER convention used in pick-list/packing-list/goods-inward
// components — known apparel sizes sort by garment-size order, anything else
// (e.g. numeric waist sizes) falls back to a natural string compare.
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL', '6XL', 'Free Size'];

// One row per Design No. + Color combination — the leaf of the pivot report.
interface StyleColorRow {
  key: string;
  color: string;
  sleeveType: string;
  qtyBySize: Record<string, number>;
  dispatchedBySize: Record<string, number>;
  totalQty: number;
  dispatchedQty: number;
  extraQty: number;
  pendingQty: number;
  wsp: number;
  value: number;
}

interface StyleGroup {
  styleNo: string;
  fabricDescription: string;
  rows: StyleColorRow[];
  totalQty: number;
  dispatchedQty: number;
  extraQty: number;
  pendingQty: number;
  value: number;
}

interface CustomerStyleGroup {
  clientName: string;
  agentName: string;
  styles: StyleGroup[];
  totalQty: number;
  dispatchedQty: number;
  extraQty: number;
  pendingQty: number;
  value: number;
}

interface StyleCustomerWiseReport {
  sizes: string[];
  customers: CustomerStyleGroup[];
  grandTotal: { totalQty: number; dispatchedQty: number; extraQty: number; pendingQty: number; value: number };
}

// Intermediate accumulator while scanning order items.
interface StyleAccumulatorEntry {
  fabricDescription: string;
  colors: Map<string, { color: string; sleeveType: string; qtyBySize: Map<string, number>; value: number }>;
}

@Component({
  selector: 'app-style-customer-wise-report',
  standalone: true,
  imports: [CommonModule, ReportStatusComponent, ReportPaginationComponent],
  templateUrl: './style-customer-wise-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StyleCustomerWiseReportComponent {
  protected readonly data = inject(ReportsDataService);
  private readonly calc = inject(ReportCalcService);
  protected readonly loadingService = inject(LoadingService);

  protected readonly isLoading = computed(() => this.data.isLoadingOrders() || this.calc.isLoadingDispatch());
  protected readonly error = computed(() => this.data.ordersError() || this.calc.dispatchError());

  protected retry(): void {
    this.data.retryOrders();
    this.calc.retryDispatch();
  }

  private readonly expandedKeys = signal<Set<string>>(new Set());

  // Pagination applies at the Customer level (top-level rows).
  protected readonly pageSize = signal(25);
  protected readonly currentPage = signal(1);

  protected readonly report = computed<StyleCustomerWiseReport>(() => this.buildStyleCustomerWiseReport());

  private readonly resetPageOnReportChange = effect(() => {
    this.report();
    this.currentPage.set(1);
  });

  protected readonly totalPages = computed(() => Math.max(1, Math.ceil(this.report().customers.length / this.pageSize())));

  protected readonly pagedCustomers = computed(() => {
    const size = this.pageSize();
    const page = Math.min(this.currentPage(), this.totalPages());
    const start = (page - 1) * size;
    return this.report().customers.slice(start, start + size);
  });

  protected setPage(page: number): void {
    this.currentPage.set(page);
  }

  protected setPageSize(size: number): void {
    this.pageSize.set(size);
    this.currentPage.set(1);
  }

  protected isExpanded(key: string): boolean {
    return this.expandedKeys().has(key);
  }

  protected toggle(key: string): void {
    const next = new Set(this.expandedKeys());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.expandedKeys.set(next);
  }

  protected filterSummary(): string {
    return this.data.filterSummary();
  }

  async exportExcel(): Promise<void> {
    const rows = this.buildExportRows();
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to export for the current filters.' });
      return;
    }

    await this.loadingService.run(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await exportRowsToExcel(rows, REPORT_TITLE, this.data.filterSummary(), this.exportMeta());
    });
  }

  async exportPdf(): Promise<void> {
    const rows = this.buildExportRows();
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to export for the current filters.' });
      return;
    }

    await this.loadingService.run(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await exportRowsToPdf(rows, REPORT_TITLE, this.data.filterSummary(), undefined, this.exportMeta());
    });
  }

  async printReport(): Promise<void> {
    const rows = this.buildExportRows();
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to print for the current filters.' });
      return;
    }

    await this.loadingService.run(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      printReportRows(rows, REPORT_TITLE, this.data.filterSummary(), undefined, this.exportMeta());
    });
  }

  private exportMeta(): ExportMeta {
    const { grandTotal } = this.report();
    return {
      generatedAt: new Date(),
      summary: {
        'Order Qty': grandTotal.totalQty,
        'Dispatched Qty': grandTotal.dispatchedQty,
        'Extra Qty': grandTotal.extraQty,
        'Pending Qty': grandTotal.pendingQty,
      },
    };
  }

  private buildExportRows(): any[][] {
    const report = this.report();
    const header = ['#', 'Customer Name', 'Agent Name', 'Style No', 'Product', 'Color', 'Sleeve Type', ...report.sizes, 'Order Qty', 'Dispatched Qty', 'Extra Qty', 'Pending Qty', 'WSP', 'Value'];
    const blankSizes = report.sizes.map(() => '');
    const body: any[][] = [];
    let counter = 0;

    for (const customer of report.customers) {
      for (const style of customer.styles) {
        for (const row of style.rows) {
          counter += 1;
          body.push([
            counter, customer.clientName, customer.agentName, style.styleNo, style.fabricDescription, row.color, row.sleeveType,
            ...report.sizes.map((s) => row.qtyBySize[s] ?? 0),
            row.totalQty, row.dispatchedQty, row.extraQty, row.pendingQty,
            this.round2(row.wsp), this.round2(row.value),
          ]);
        }
      }
      body.push([
        '', `Customer Total: ${customer.clientName}`, '', '', '', '', '', ...blankSizes,
        customer.totalQty, customer.dispatchedQty, customer.extraQty, customer.pendingQty, '', this.round2(customer.value),
      ]);
    }

    body.push([
      '', 'Grand Total', '', '', '', '', '', ...blankSizes,
      report.grandTotal.totalQty, report.grandTotal.dispatchedQty, report.grandTotal.extraQty, report.grandTotal.pendingQty,
      '', this.round2(report.grandTotal.value),
    ]);
    return [header, ...body];
  }

  private buildStyleCustomerWiseReport(): StyleCustomerWiseReport {
    const clientById = this.data.clientById();
    const customerMap = new Map<string, Map<string, StyleAccumulatorEntry>>();
    const agentByCustomer = new Map<string, string>();
    const sizeSet = new Set<string>();

    for (const order of this.data.filteredOrders()) {
      const client = clientById.get(order.clientId);
      const clientName = this.data.toText(client?.clientName) || 'Unknown Client';
      agentByCustomer.set(clientName, client ? this.data.resolveAgentName(client) : 'Unassigned');
      let styleMap = customerMap.get(clientName);
      if (!styleMap) { styleMap = new Map(); customerMap.set(clientName, styleMap); }

      for (const item of order.items ?? []) {
        this.accumulateOrderItem(item, styleMap, sizeSet);
      }
    }

    const sizes = this.sortSizes([...sizeSet]);
    const dispatchByCustomerStyleColor = this.buildDispatchByCustomerStyleColor();
    const customers: CustomerStyleGroup[] = [...customerMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([clientName, styleMap]) => {
        const styles = this.buildStyleGroups(clientName, styleMap, sizes, dispatchByCustomerStyleColor);
        return {
          clientName,
          agentName: agentByCustomer.get(clientName) ?? 'Unassigned',
          styles,
          totalQty: styles.reduce((s, st) => s + st.totalQty, 0),
          dispatchedQty: styles.reduce((s, st) => s + st.dispatchedQty, 0),
          extraQty: styles.reduce((s, st) => s + st.extraQty, 0),
          pendingQty: styles.reduce((s, st) => s + st.pendingQty, 0),
          value: styles.reduce((s, st) => s + st.value, 0),
        };
      });

    const grandTotal = {
      totalQty: customers.reduce((s, c) => s + c.totalQty, 0),
      dispatchedQty: customers.reduce((s, c) => s + c.dispatchedQty, 0),
      extraQty: customers.reduce((s, c) => s + c.extraQty, 0),
      pendingQty: customers.reduce((s, c) => s + c.pendingQty, 0),
      value: customers.reduce((s, c) => s + c.value, 0),
    };

    return { sizes, customers, grandTotal };
  }

  /** Dispatch side, sourced from the shared calc layer (not re-derived) and re-keyed by customer+style+color+sleeve+size to match this report's pivot shape. */
  private buildDispatchByCustomerStyleColor(): Map<string, { dispatchedBySize: Map<string, number>; dispatchedQty: number }> {
    const map = new Map<string, { dispatchedBySize: Map<string, number>; dispatchedQty: number }>();
    for (const f of this.calc.skuFulfillments()) {
      const clientName = f.clientName || 'Unknown Client';
      const styleNo = f.styleNo || 'Unknown';
      const color = f.color || 'Unspecified';
      const sleeveType = f.sleeveType || '-';
      const key = `${clientName}||${styleNo}||${color}||${sleeveType}`;
      let entry = map.get(key);
      if (!entry) { entry = { dispatchedBySize: new Map(), dispatchedQty: 0 }; map.set(key, entry); }
      entry.dispatchedBySize.set(f.size, (entry.dispatchedBySize.get(f.size) ?? 0) + f.dispatchedQty);
      entry.dispatchedQty += f.dispatchedQty;
    }
    return map;
  }

  /** Folds one order item's per-size quantities into the styleNo -> color accumulator. */
  private accumulateOrderItem(item: OrderItem, styleMap: Map<string, StyleAccumulatorEntry>, sizeSet: Set<string>): void {
    if (!this.data.matchesItemFilters(item)) return;
    const styleNo = this.data.toText(item.design?.styleNo) || 'Unknown';
    const color = this.data.toText(item.design?.color) || 'Unspecified';
    const sleeveType = this.data.toText(item.sleeveType) || '-';
    // Same convention as the Sales Order "Enter Quantities by Fabric Description" grouping.
    const fabricDescription = this.data.toText(item.design?.sizes?.[0]?.fabricType) || 'Uncategorized';

    let style = styleMap.get(styleNo);
    if (!style) { style = { fabricDescription, colors: new Map() }; styleMap.set(styleNo, style); }
    const colorKey = `${color}||${sleeveType}`;
    let colorEntry = style.colors.get(colorKey);
    if (!colorEntry) { colorEntry = { color, sleeveType, qtyBySize: new Map(), value: 0 }; style.colors.set(colorKey, colorEntry); }

    for (const size of item.itemSizes ?? []) {
      const qty = Number(size.quantity) || 0;
      if (qty <= 0) continue;
      const sizeLabel = this.data.toText(size.size);
      sizeSet.add(sizeLabel);
      colorEntry.qtyBySize.set(sizeLabel, (colorEntry.qtyBySize.get(sizeLabel) ?? 0) + qty);
      colorEntry.value += qty * (Number(size.WSP) || 0);
    }
  }

  private buildStyleGroups(
    clientName: string,
    styleMap: Map<string, StyleAccumulatorEntry>,
    sizes: string[],
    dispatchByCustomerStyleColor: Map<string, { dispatchedBySize: Map<string, number>; dispatchedQty: number }>
  ): StyleGroup[] {
    return [...styleMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([styleNo, style]) => {
        const rows: StyleColorRow[] = [...style.colors.values()]
          .sort((a, b) => a.color.localeCompare(b.color) || a.sleeveType.localeCompare(b.sleeveType))
          .map((entry) => {
            const key = `${clientName}||${styleNo}||${entry.color}||${entry.sleeveType}`;
            const qtyBySize = Object.fromEntries(entry.qtyBySize);
            const totalQty = sizes.reduce((s, size) => s + (qtyBySize[size] ?? 0), 0);
            const value = this.round2(entry.value);
            const wsp = totalQty > 0 ? this.round2(entry.value / totalQty) : 0;
            const dispatch = dispatchByCustomerStyleColor.get(key);
            const dispatchedQty = dispatch?.dispatchedQty ?? 0;
            return {
              key, color: entry.color, sleeveType: entry.sleeveType, qtyBySize,
              dispatchedBySize: Object.fromEntries(dispatch?.dispatchedBySize ?? new Map()),
              totalQty, dispatchedQty,
              extraQty: Math.max(0, dispatchedQty - totalQty),
              pendingQty: Math.max(0, totalQty - dispatchedQty),
              wsp, value,
            };
          });
        return {
          styleNo,
          fabricDescription: style.fabricDescription,
          rows,
          totalQty: rows.reduce((s, r) => s + r.totalQty, 0),
          dispatchedQty: rows.reduce((s, r) => s + r.dispatchedQty, 0),
          extraQty: rows.reduce((s, r) => s + r.extraQty, 0),
          pendingQty: rows.reduce((s, r) => s + r.pendingQty, 0),
          value: rows.reduce((s, r) => s + r.value, 0),
        };
      });
  }

  private sortSizes(sizes: string[]): string[] {
    return [...sizes].sort((a, b) => {
      const aIndex = SIZE_ORDER.indexOf(a);
      const bIndex = SIZE_ORDER.indexOf(b);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
