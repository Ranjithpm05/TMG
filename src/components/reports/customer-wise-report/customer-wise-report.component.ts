import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { ReportCalcService, type AggregatedRow } from '../report-calc.service';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows, type ExportMeta } from '../report-export.util';
import { ReportTableComponent } from '../report-table/report-table.component';
import { ReportSummaryCardsComponent } from '../report-summary-cards/report-summary-cards.component';
import { ReportStatusComponent } from '../report-status/report-status.component';

const REPORT_TITLE = 'Customer Wise Report';

@Component({
  selector: 'app-customer-wise-report',
  standalone: true,
  imports: [CommonModule, ReportTableComponent, ReportSummaryCardsComponent, ReportStatusComponent],
  templateUrl: './customer-wise-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CustomerWiseReportComponent {
  protected readonly data = inject(ReportsDataService);
  private readonly calc = inject(ReportCalcService);
  protected readonly loadingService = inject(LoadingService);

  protected readonly isLoading = computed(() => this.data.isLoadingOrders() || this.calc.isLoadingDispatch());
  protected readonly error = computed(() => this.data.ordersError() || this.calc.dispatchError());

  protected retry(): void {
    this.data.retryOrders();
    this.calc.retryDispatch();
  }

  protected readonly report = computed(() =>
    this.calc.aggregate(
      (f) => f.clientId,
      (_key, sample) => sample.clientName || 'Unknown Client',
      { keyFn: (f) => f.styleNo, labelFn: (key) => key }
    )
  );

  /** Rows are keyed by clientId, so the agent name (resolved via Client) is already carried on the row's sample fulfillment. */
  protected readonly agentNameFor = (row: AggregatedRow): string => row.sample.agentName || 'Unassigned';

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
        'Order Qty': grandTotal.orderQty,
        'Dispatched Qty': grandTotal.dispatchedQty,
        'Extra Qty': grandTotal.extraQty,
        'Pending Qty': grandTotal.pendingQty,
      },
    };
  }

  private buildExportRows(): any[][] {
    const { rows, grandTotal } = this.report();
    const header = ['#', 'Customer Name', 'Agent Name', 'Order Qty', 'Dispatched Qty', 'Extra Qty', 'Pending Qty'];
    const body: any[][] = [];
    rows.forEach((row, i) => {
      body.push([i + 1, row.label, this.agentNameFor(row), row.orderQty, row.dispatchedQty, row.extraQty, row.pendingQty]);
      for (const child of row.children ?? []) {
        body.push(['', `  ${child.label}`, '', child.orderQty, child.dispatchedQty, child.extraQty, child.pendingQty]);
      }
    });
    body.push(['', 'Grand Total', '', grandTotal.orderQty, grandTotal.dispatchedQty, grandTotal.extraQty, grandTotal.pendingQty]);
    return [header, ...body];
  }
}
