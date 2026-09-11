import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { ReportCalcService, type SkuFulfillment } from '../report-calc.service';
import { ReportFilterBarComponent } from '../report-filter-bar/report-filter-bar.component';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows, type ExportMeta } from '../report-export.util';
import { ReportSummaryCardsComponent } from '../report-summary-cards/report-summary-cards.component';
import { ReportStatusComponent } from '../report-status/report-status.component';
import { ReportPaginationComponent } from '../report-pagination/report-pagination.component';

const REPORT_TITLE = 'Exceed Order Report';

/**
 * Redefined per spec: this tab used to compare Order Qty against current
 * Inventory stock. It now shows only SKUs where Dispatched Qty > Order Qty
 * (an over-dispatch), sourced from the same shared skuFulfillments() every
 * other report uses — no separate Inventory read here anymore.
 */
@Component({
  selector: 'app-exceed-order-report',
  standalone: true,
  imports: [CommonModule, ReportFilterBarComponent, ReportSummaryCardsComponent, ReportStatusComponent, ReportPaginationComponent],
  providers: [ReportsDataService, ReportCalcService],
  templateUrl: './exceed-order-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExceedOrderReportComponent {
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

  protected readonly rows = computed<SkuFulfillment[]>(() =>
    this.calc.skuFulfillments()
      .filter((f) => f.extraQty > 0)
      .sort((a, b) => a.styleNo.localeCompare(b.styleNo) || a.clientName.localeCompare(b.clientName))
  );

  private readonly resetPageOnRowsChange = effect(() => {
    this.rows();
    this.currentPage.set(1);
  });

  protected readonly totalPages = computed(() => Math.max(1, Math.ceil(this.rows().length / this.pageSize())));

  protected readonly pagedRows = computed(() => {
    const size = this.pageSize();
    const page = Math.min(this.currentPage(), this.totalPages());
    const start = (page - 1) * size;
    return this.rows().slice(start, start + size);
  });

  protected setPage(page: number): void {
    this.currentPage.set(page);
  }

  protected setPageSize(size: number): void {
    this.pageSize.set(size);
    this.currentPage.set(1);
  }

  protected readonly grandTotal = computed(() => {
    const rows = this.rows();
    return {
      orderQty: rows.reduce((s, r) => s + r.orderQty, 0),
      dispatchedQty: rows.reduce((s, r) => s + r.dispatchedQty, 0),
      extraQty: rows.reduce((s, r) => s + r.extraQty, 0),
      pendingQty: rows.reduce((s, r) => s + r.pendingQty, 0),
    };
  });

  protected filterSummary(): string {
    return this.data.filterSummary();
  }

  protected formatDate(date: Date | null): string {
    return date ? this.data.formatLongDate(date) : '-';
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
      await exportRowsToPdf(rows, REPORT_TITLE, this.data.filterSummary(), { highlightRow: () => true }, this.exportMeta());
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
      printReportRows(rows, REPORT_TITLE, this.data.filterSummary(), { highlightRow: () => true }, this.exportMeta());
    });
  }

  private exportMeta(): ExportMeta {
    const grandTotal = this.grandTotal();
    return {
      generatedAt: new Date(),
      summary: {
        'Order Qty': grandTotal.orderQty,
        'Dispatched Qty': grandTotal.dispatchedQty,
        'Extra Qty': grandTotal.extraQty,
        'Pending Qty': grandTotal.pendingQty,
      },
    };
  }

  private buildExportRows(): any[][] {
    const rows = this.rows();
    const grandTotal = this.grandTotal();
    const header = ['#', 'Style No', 'Product', 'Color', 'Size', 'Sleeve', 'Customer', 'Agent', 'Order Qty', 'Dispatched Qty', 'Extra Qty', 'DC No.', 'Dispatch Date'];
    const body = rows.map((r, i) => [
      i + 1, r.styleNo, r.group, r.color || '-', r.size, r.sleeveType || '-', r.clientName || 'Unknown Client', r.agentName,
      r.orderQty, r.dispatchedQty, r.extraQty, r.lastDcNo || '-', this.formatDate(r.lastDcDate),
    ]);
    body.push(['', 'Grand Total', '', '', '', '', '', '', grandTotal.orderQty, grandTotal.dispatchedQty, grandTotal.extraQty, '', '']);
    return [header, ...body];
  }
}
