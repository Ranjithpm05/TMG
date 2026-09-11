import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { ReportCalcService } from '../report-calc.service';
import { ReportFilterBarComponent } from '../report-filter-bar/report-filter-bar.component';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows, type ExportMeta } from '../report-export.util';
import { ReportStatusComponent } from '../report-status/report-status.component';
import { ReportPaginationComponent } from '../report-pagination/report-pagination.component';
import type { Design } from '../../../models/design.model';
import type { SalesOrder } from '../../../models/sales-order.model';

const REPORT_TITLE = 'Pending Order Report - Customer-wise';

// Matches the SIZE_ORDER convention used in style-wise-report/pick-list/
// packing-list/goods-inward components — numeric sizes (e.g. 30/32/34) fall
// back to a natural string compare.
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL', '6XL', 'Free Size'];

interface PendingOrderRow {
  key: string;
  salesNo: string;
  soDate: Date | null;
  clientName: string;
  group: string;
  fabricDescription: string;
  styleNo: string;
  color: string;
  sleeveType: string;
  qtyBySize: Record<string, number>;
  total: number;
}

interface PendingOrderReport {
  sizes: string[];
  rows: PendingOrderRow[];
  grandTotalBySize: Record<string, number>;
  grandTotal: number;
}

@Component({
  selector: 'app-pending-order-customer-wise-report',
  standalone: true,
  imports: [CommonModule, ReportFilterBarComponent, ReportStatusComponent, ReportPaginationComponent],
  providers: [ReportsDataService, ReportCalcService],
  templateUrl: './pending-order-customer-wise-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PendingOrderCustomerWiseReportComponent {
  protected readonly reportTitle = REPORT_TITLE;
  protected readonly data = inject(ReportsDataService);
  private readonly calc = inject(ReportCalcService);
  protected readonly loadingService = inject(LoadingService);

  protected readonly isLoading = computed(() => this.data.isLoadingOrders() || this.calc.isLoadingDispatch());
  protected readonly error = computed(() => this.data.ordersError() || this.calc.dispatchError());

  protected retry(): void {
    this.data.retryOrders();
    this.calc.retryDispatch();
  }

  protected readonly pageSize = signal(25);
  protected readonly currentPage = signal(1);

  protected readonly report = computed<PendingOrderReport>(() => this.buildReport());

  private readonly resetPageOnReportChange = effect(() => {
    this.report();
    this.currentPage.set(1);
  });

  protected readonly totalPages = computed(() => Math.max(1, Math.ceil(this.report().rows.length / this.pageSize())));

  protected readonly pagedRows = computed(() => {
    const size = this.pageSize();
    const page = Math.min(this.currentPage(), this.totalPages());
    const start = (page - 1) * size;
    return this.report().rows.slice(start, start + size);
  });

  protected setPage(page: number): void {
    this.currentPage.set(page);
  }

  protected setPageSize(size: number): void {
    this.pageSize.set(size);
    this.currentPage.set(1);
  }

  protected filterSummary(): string {
    return this.data.filterSummary();
  }

  protected formatDate(date: Date | null): string {
    if (!date) return '-';
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
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
    return { generatedAt: new Date(), summary: { 'Total Pending Qty': grandTotal } };
  }

  private buildExportRows(): any[][] {
    const report = this.report();
    const header = ['Sales Order No', 'SO Date', 'Customer', 'Group', 'Fabric Description', 'Styleno', 'Color', 'SleeveType', ...report.sizes, 'Total'];
    const body: any[][] = report.rows.map((row) => [
      row.salesNo, this.formatDate(row.soDate), row.clientName, row.group, row.fabricDescription,
      row.styleNo, row.color, row.sleeveType, ...report.sizes.map((s) => row.qtyBySize[s] ?? 0), row.total,
    ]);
    body.push([
      '', '', '', '', 'Grand Total', '', '', '',
      ...report.sizes.map((s) => report.grandTotalBySize[s] ?? 0), report.grandTotal,
    ]);
    return [header, ...body];
  }

  private buildReport(): PendingOrderReport {
    const salesOrderById = new Map<string, SalesOrder>();
    for (const order of this.data.filteredOrders()) {
      if (order.id) salesOrderById.set(order.id, order);
    }
    const fabricByStyleColorSize = this.buildFabricLookup(this.data.designs());

    const rowMap = new Map<string, PendingOrderRow>();
    const sizeSet = new Set<string>();

    for (const f of this.calc.skuFulfillments()) {
      if (f.pendingQty <= 0) continue;
      const key = `${f.salesOrderId}||${f.styleNo}||${f.color}||${f.sleeveType}`;
      let row = rowMap.get(key);
      if (!row) {
        const order = salesOrderById.get(f.salesOrderId);
        const fabricDescription = fabricByStyleColorSize.get(`${f.styleNo}|${f.color}|${f.size}`) ?? '';
        row = {
          key, salesNo: f.salesNo, soDate: this.toDate(order?.createdAt), clientName: f.clientName,
          group: f.group, fabricDescription, styleNo: f.styleNo, color: f.color, sleeveType: f.sleeveType,
          qtyBySize: {}, total: 0,
        };
        rowMap.set(key, row);
      }
      sizeSet.add(f.size);
      row.qtyBySize[f.size] = (row.qtyBySize[f.size] ?? 0) + f.pendingQty;
      row.total += f.pendingQty;
    }

    const sizes = this.sortSizes([...sizeSet]);
    const rows = [...rowMap.values()].sort(
      (a, b) => a.salesNo.localeCompare(b.salesNo) || a.styleNo.localeCompare(b.styleNo) || a.color.localeCompare(b.color)
    );

    const grandTotalBySize: Record<string, number> = {};
    let grandTotal = 0;
    for (const row of rows) {
      for (const size of sizes) grandTotalBySize[size] = (grandTotalBySize[size] ?? 0) + (row.qtyBySize[size] ?? 0);
      grandTotal += row.total;
    }

    return { sizes, rows, grandTotalBySize, grandTotal };
  }

  /** styleNo|color|size -> Fabric Description, built from the already-loaded Design Master signal (SkuFulfillment itself carries no fabric text). */
  private buildFabricLookup(designs: Design[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const design of designs) {
      for (const sizeEntry of design.sizes ?? []) {
        const key = `${design.styleNo ?? ''}|${design.color ?? ''}|${sizeEntry.size ?? ''}`;
        map.set(key, sizeEntry.fabricType ?? '');
      }
    }
    return map;
  }

  private sortSizes(sizes: string[]): string[] {
    return [...sizes].sort((a, b) => {
      const aIndex = SIZE_ORDER.indexOf(a);
      const bIndex = SIZE_ORDER.indexOf(b);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  }

  private toDate(raw: any): Date | null {
    if (!raw) return null;
    try {
      const date = raw?.toDate ? raw.toDate() : new Date(raw?.seconds ? raw.seconds * 1000 : raw);
      return Number.isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }
}
