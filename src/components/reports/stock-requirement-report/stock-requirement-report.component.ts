import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { ReportCalcService } from '../report-calc.service';
import { ReportFilterBarComponent } from '../report-filter-bar/report-filter-bar.component';
import { ReportStatusComponent } from '../report-status/report-status.component';
import { ReportPaginationComponent } from '../report-pagination/report-pagination.component';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows, type ExportMeta } from '../report-export.util';
import {
  StockRequirementService, type ItemLevel, type PendingOrderAllocation, type StockItemRow, type StockStatus,
} from './stock-requirement.service';

const REPORT_TITLE = 'Stock vs Pending Sales Orders';

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL', '6XL', 'Free Size'];

type ViewMode = 'items' | 'orders';
type StatusFilter = '' | 'needsStock' | StockStatus | 'excess';
type SortKey = 'shortage' | 'pending' | 'stock' | 'excess' | 'style';
type OrderCoverage = 'Covered by Stock' | 'Partially Covered' | 'Waiting for Stock' | 'Picked, Awaiting DC';

export const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: '', label: 'All Items' },
  { value: 'needsStock', label: 'Needs Stock (Insufficient + Zero)' },
  { value: 'Insufficient', label: 'Insufficient' },
  { value: 'Zero Stock', label: 'Zero Stock' },
  { value: 'Sufficient', label: 'Sufficient' },
  { value: 'excess', label: 'Excess Stock' },
];

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'shortage', label: 'Additional Required (high → low)' },
  { value: 'pending', label: 'Pending SO Qty (high → low)' },
  { value: 'stock', label: 'Current Stock (high → low)' },
  { value: 'excess', label: 'Excess Stock (high → low)' },
  { value: 'style', label: 'Style No.' },
];

function sizeRank(size: string): number {
  const index = SIZE_ORDER.indexOf(size.trim().toUpperCase() === 'FREE SIZE' ? 'Free Size' : size.trim().toUpperCase());
  return index === -1 ? SIZE_ORDER.length : index;
}

function compareItems(a: StockItemRow, b: StockItemRow): number {
  return a.styleNo.localeCompare(b.styleNo, undefined, { numeric: true })
    || a.color.localeCompare(b.color)
    || a.sleeveType.localeCompare(b.sleeveType)
    || sizeRank(a.size) - sizeRank(b.size)
    || a.size.localeCompare(b.size, undefined, { numeric: true });
}

/** Apr–Mar financial year containing `date`, as yyyy-mm-dd. */
function financialYearStart(date: Date): string {
  const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${year}-04-01`;
}

@Component({
  selector: 'app-stock-requirement-report',
  standalone: true,
  imports: [CommonModule, FormsModule, ReportFilterBarComponent, ReportStatusComponent, ReportPaginationComponent],
  providers: [ReportsDataService, ReportCalcService, StockRequirementService],
  templateUrl: './stock-requirement-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StockRequirementReportComponent {
  protected readonly reportTitle = REPORT_TITLE;
  protected readonly data = inject(ReportsDataService);
  protected readonly stock = inject(StockRequirementService);
  private readonly loadingService = inject(LoadingService);

  protected readonly statusFilterOptions = STATUS_FILTER_OPTIONS;
  protected readonly sortOptions = SORT_OPTIONS;

  constructor() {
    // Pending orders are rarely all from this month — default to the whole
    // financial year so older open orders count as demand. Set before the
    // first orders query runs (it starts from an effect, after construction).
    const start = financialYearStart(new Date());
    this.data.startDate.set(start);
    this.data.draftStartDate.set(start);
  }

  protected readonly isLoading = this.stock.isLoading;
  protected readonly error = this.stock.error;

  protected retry(): void {
    this.stock.retry();
  }

  // ── Local view state ──────────────────────────────────────────────────
  protected readonly viewMode = signal<ViewMode>('items');
  protected readonly statusFilter = signal<StatusFilter>('');
  protected readonly pendingOnly = signal(false);
  protected readonly onlyShortOrders = signal(true);
  protected readonly sortKey = signal<SortKey>('shortage');
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected setItemLevel(level: ItemLevel): void {
    this.stock.itemLevel.set(level);
    this.expanded.set(new Set());
  }

  protected toggleExpanded(key: string): void {
    const next = new Set(this.expanded());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.expanded.set(next);
  }

  // ── Item view ─────────────────────────────────────────────────────────
  protected readonly itemRows = computed<StockItemRow[]>(() => {
    const status = this.statusFilter();
    const pendingOnly = this.pendingOnly();
    const rows = this.stock.rows().filter((row) => {
      if (pendingOnly && row.pendingQty <= 0) return false;
      switch (status) {
        case '': return true;
        case 'needsStock': return row.additionalRequiredQty > 0;
        case 'excess': return row.excessQty > 0;
        default: return row.status === status;
      }
    });
    const sortKey = this.sortKey();
    const metric = (row: StockItemRow): number => {
      switch (sortKey) {
        case 'shortage': return row.additionalRequiredQty;
        case 'pending': return row.pendingQty;
        case 'stock': return row.currentStock;
        case 'excess': return row.excessQty;
        default: return 0;
      }
    };
    return rows.sort((a, b) => metric(b) - metric(a) || b.pendingQty - a.pendingQty || compareItems(a, b));
  });

  protected readonly totals = computed(() => this.stock.totalsOf(this.itemRows()));

  // ── Sales Order breakdown view ────────────────────────────────────────
  protected readonly orderRows = computed<PendingOrderAllocation[]>(() => {
    const onlyShort = this.onlyShortOrders();
    const rows = this.stock.rows().flatMap((row) => row.orders).filter((o) => !onlyShort || o.shortQty > 0);
    return rows.sort((a, b) =>
      a.clientName.localeCompare(b.clientName)
      || (a.orderDate?.getTime() ?? 0) - (b.orderDate?.getTime() ?? 0)
      || a.salesNo.localeCompare(b.salesNo)
      || a.styleNo.localeCompare(b.styleNo, undefined, { numeric: true })
      || a.color.localeCompare(b.color)
      || sizeRank(a.size) - sizeRank(b.size)
    );
  });

  protected readonly orderTotals = computed(() => {
    const totals = { orders: new Set<string>(), customers: new Set<string>(), pendingQty: 0, reservedQty: 0, allocatedQty: 0, shortQty: 0 };
    for (const o of this.orderRows()) {
      totals.orders.add(o.salesOrderId);
      totals.customers.add(o.clientId || o.clientName);
      totals.pendingQty += o.pendingQty;
      totals.reservedQty += o.reservedQty;
      totals.allocatedQty += o.allocatedQty;
      totals.shortQty += o.shortQty;
    }
    return { orderCount: totals.orders.size, customerCount: totals.customers.size, ...totals };
  });

  protected coverage(o: PendingOrderAllocation): OrderCoverage {
    if (o.requiredFromStockQty <= 0) return 'Picked, Awaiting DC';
    if (o.shortQty <= 0) return 'Covered by Stock';
    return o.allocatedQty > 0 ? 'Partially Covered' : 'Waiting for Stock';
  }

  // ── Pagination ────────────────────────────────────────────────────────
  protected readonly pageSize = signal(50);
  protected readonly currentPage = signal(1);

  private readonly resetPageOnChange = effect(() => {
    this.itemRows();
    this.orderRows();
    this.viewMode();
    this.currentPage.set(1);
  });

  protected readonly pagedItemRows = computed(() => this.slicePage(this.itemRows()));
  protected readonly pagedOrderRows = computed(() => this.slicePage(this.orderRows()));

  private slicePage<T>(rows: T[]): T[] {
    const size = this.pageSize();
    const totalPages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(this.currentPage(), totalPages);
    return rows.slice((page - 1) * size, page * size);
  }

  protected setPage(page: number): void {
    this.currentPage.set(page);
  }

  protected setPageSize(size: number): void {
    this.pageSize.set(size);
    this.currentPage.set(1);
  }

  // ── Display helpers ───────────────────────────────────────────────────
  protected formatDate(date: Date | null): string {
    if (!date) return '-';
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  protected formatDeliveryDate(value: string): string {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : this.formatDate(date);
  }

  protected statusClass(status: StockStatus): string {
    switch (status) {
      case 'Sufficient': return 'bg-emerald-100 text-emerald-800';
      case 'Insufficient': return 'bg-amber-100 text-amber-800';
      default: return 'bg-rose-100 text-rose-800';
    }
  }

  protected coverageClass(coverage: OrderCoverage): string {
    switch (coverage) {
      case 'Covered by Stock': return 'bg-emerald-100 text-emerald-800';
      case 'Picked, Awaiting DC': return 'bg-sky-100 text-sky-800';
      case 'Partially Covered': return 'bg-amber-100 text-amber-800';
      default: return 'bg-rose-100 text-rose-800';
    }
  }

  protected filterSummary(): string {
    const parts = [this.data.filterSummary()];
    parts.push(`Level: ${this.stock.itemLevel() === 'style' ? 'Style & Color' : 'Item (Size)'}`);
    if (this.stock.itemSearch().trim()) parts.push(`Item: ${this.stock.itemSearch().trim()}`);
    if (this.stock.salesOrderSearch().trim()) parts.push(`SO No: ${this.stock.salesOrderSearch().trim()}`);
    if (this.viewMode() === 'items') {
      const status = STATUS_FILTER_OPTIONS.find((o) => o.value === this.statusFilter());
      if (this.statusFilter()) parts.push(`Stock Status: ${status?.label}`);
      if (this.pendingOnly()) parts.push('Only items with pending orders');
    } else if (this.onlyShortOrders()) {
      parts.push('Only orders waiting for stock');
    }
    return parts.join('  ·  ');
  }

  // ── Export / print ────────────────────────────────────────────────────
  async exportExcel(): Promise<void> {
    await this.runExport((rows, meta) => exportRowsToExcel(rows, this.exportTitle(), this.filterSummary(), meta));
  }

  async exportPdf(): Promise<void> {
    await this.runExport((rows, meta) => exportRowsToPdf(rows, this.exportTitle(), this.filterSummary(), undefined, meta));
  }

  async printReport(): Promise<void> {
    await this.runExport(async (rows, meta) => printReportRows(rows, this.exportTitle(), this.filterSummary(), undefined, meta));
  }

  private exportTitle(): string {
    return this.viewMode() === 'items' ? REPORT_TITLE : `${REPORT_TITLE} - SO Breakdown`;
  }

  private async runExport(write: (rows: any[][], meta: ExportMeta) => Promise<void>): Promise<void> {
    const rows = this.viewMode() === 'items' ? this.buildItemExportRows() : this.buildOrderExportRows();
    if (rows.length <= 2) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to export for the current filters.' });
      return;
    }
    await this.loadingService.run(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await write(rows, this.exportMeta());
    });
  }

  private exportMeta(): ExportMeta {
    if (this.viewMode() === 'items') {
      const t = this.totals();
      return {
        generatedAt: new Date(),
        summary: {
          'Items': t.itemCount, 'Current Stock': t.currentStock, 'Reserved': t.reservedQty, 'Pending SO Qty': t.pendingQty,
          'Additional Required': t.additionalRequiredQty, 'Excess': t.excessQty,
        },
      };
    }
    const t = this.orderTotals();
    return {
      generatedAt: new Date(),
      summary: { 'Sales Orders': t.orderCount, 'Customers': t.customerCount, 'Pending Qty': t.pendingQty, 'Short Qty': t.shortQty },
    };
  }

  private buildItemExportRows(): any[][] {
    const sku = this.stock.itemLevel() === 'sku';
    const header = [
      ...(sku ? ['Item Code (Barcode)'] : []), 'Style No', 'Product', 'Color', 'Sleeve', ...(sku ? ['Size'] : []),
      'Current Stock', 'Reserved (Picked, Not Dispatched)', 'Available Stock', 'Pending SO Qty', 'Required from Stock',
      'Additional Required', 'Excess Stock', 'Status', 'Pending SOs',
    ];
    const body = this.itemRows().map((row) => [
      ...(sku ? [row.barcode] : []), row.styleNo, row.group, row.color, row.sleeveType, ...(sku ? [row.size] : []),
      row.currentStock, row.reservedQty, row.availableQty, row.pendingQty, row.requiredFromStockQty,
      row.additionalRequiredQty, row.excessQty, row.status, new Set(row.orders.map((o) => o.salesOrderId)).size,
    ]);
    const t = this.totals();
    const labelCols = sku ? 6 : 4;
    const total = ['Grand Total', ...Array(labelCols - 1).fill(''),
      t.currentStock, t.reservedQty, t.availableQty, t.pendingQty, t.requiredFromStockQty, t.additionalRequiredQty, t.excessQty, '', ''];
    return [header, ...body, total];
  }

  private buildOrderExportRows(): any[][] {
    const header = [
      'Sales Order No', 'Order Date', 'Delivery Date', 'Customer', 'Agent', 'Style No', 'Color', 'Sleeve', 'Size',
      'Ordered Qty', 'Dispatched Qty', 'Pending Qty', 'Reserved (Picked)', 'Required from Stock', 'Covered by Stock', 'Short Qty', 'Status',
    ];
    const body = this.orderRows().map((o) => [
      o.salesNo, this.formatDate(o.orderDate), this.formatDeliveryDate(o.deliveryDate), o.clientName, o.agentName,
      o.styleNo, o.color, o.sleeveType, o.size,
      o.orderQty, o.dispatchedQty, o.pendingQty, o.reservedQty, o.requiredFromStockQty, o.allocatedQty, o.shortQty, this.coverage(o),
    ]);
    const sum = (pick: (o: PendingOrderAllocation) => number) => this.orderRows().reduce((s, o) => s + pick(o), 0);
    const total = ['Grand Total', '', '', '', '', '', '', '', '',
      sum((o) => o.orderQty), sum((o) => o.dispatchedQty), sum((o) => o.pendingQty), sum((o) => o.reservedQty),
      sum((o) => o.requiredFromStockQty), sum((o) => o.allocatedQty), sum((o) => o.shortQty), ''];
    return [header, ...body, total];
  }
}
