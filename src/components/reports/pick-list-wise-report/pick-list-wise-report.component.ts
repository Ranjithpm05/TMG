import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { ReportCalcService } from '../report-calc.service';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows, type ExportMeta } from '../report-export.util';
import { ReportSummaryCardsComponent } from '../report-summary-cards/report-summary-cards.component';
import { ReportStatusComponent } from '../report-status/report-status.component';
import { ReportPaginationComponent } from '../report-pagination/report-pagination.component';

const REPORT_TITLE = 'Pick List Wise Report';

@Component({
  selector: 'app-pick-list-wise-report',
  standalone: true,
  imports: [CommonModule, ReportSummaryCardsComponent, ReportStatusComponent, ReportPaginationComponent],
  templateUrl: './pick-list-wise-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PickListWiseReportComponent {
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

  protected readonly rows = this.calc.pickListWiseRows;

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
      pickedQty: rows.reduce((s, r) => s + r.pickedQty, 0),
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

  protected statusBadgeClass(status: string): string {
    switch (status) {
      case 'Completed': return 'bg-emerald-100 text-emerald-800';
      case 'Dispatched': return 'bg-blue-100 text-blue-800';
      case 'Partially Dispatched': return 'bg-indigo-100 text-indigo-800';
      case 'Picked': return 'bg-teal-100 text-teal-800';
      case 'Partially Picked': return 'bg-amber-100 text-amber-800';
      default: return 'bg-gray-100 text-gray-700';
    }
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
    const grandTotal = this.grandTotal();
    return {
      generatedAt: new Date(),
      summary: {
        'Order Qty': grandTotal.orderQty,
        'Picked Qty': grandTotal.pickedQty,
        'Dispatched Qty': grandTotal.dispatchedQty,
        'Extra Qty': grandTotal.extraQty,
        'Pending Qty': grandTotal.pendingQty,
      },
    };
  }

  private buildExportRows(): any[][] {
    const rows = this.rows();
    const grandTotal = this.grandTotal();
    const header = ['#', 'Pick List No', 'Date', 'Customer', 'Agent', 'Style', 'Product', 'Color', 'Size', 'Sleeve', 'Order Qty', 'Picked Qty', 'Dispatched Qty', 'Extra Qty', 'Pending Qty', 'Status'];
    const body = rows.map((r, i) => [
      i + 1, r.pickListNo, this.formatDate(r.createdAt), r.clientName, r.agentName, r.styleNo, r.group,
      r.color || '-', r.size, r.sleeveType || '-',
      r.itemType === 'Additional' ? '-' : r.orderQty, r.pickedQty, r.dispatchedQty, r.extraQty,
      r.itemType === 'Additional' ? '-' : r.pendingQty, r.displayStatus,
    ]);
    body.push(['', 'Grand Total', '', '', '', '', '', '', '', '', grandTotal.orderQty, grandTotal.pickedQty, grandTotal.dispatchedQty, grandTotal.extraQty, grandTotal.pendingQty, '']);
    return [header, ...body];
  }
}
