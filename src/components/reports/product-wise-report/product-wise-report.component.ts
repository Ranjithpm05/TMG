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

const REPORT_TITLE = 'Product Wise Report';

@Component({
  selector: 'app-product-wise-report',
  standalone: true,
  imports: [CommonModule, ReportTableComponent, ReportSummaryCardsComponent, ReportStatusComponent],
  templateUrl: './product-wise-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProductWiseReportComponent {
  protected readonly data = inject(ReportsDataService);
  private readonly calc = inject(ReportCalcService);
  protected readonly loadingService = inject(LoadingService);

  protected readonly isLoading = computed(() => this.data.isLoadingOrders() || this.calc.isLoadingDispatch());
  protected readonly error = computed(() => this.data.ordersError() || this.calc.dispatchError());

  protected retry(): void {
    this.data.retryOrders();
    this.calc.retryDispatch();
  }

  protected readonly report = computed(() => this.calc.aggregate((f) => f.group, (key) => key));

  // Order Value isn't part of SkuFulfillment (calc layer intentionally
  // carries no price) — computed separately from filteredOrders(), same as
  // this report always did.
  protected readonly valueByGroup = computed(() => {
    const map = new Map<string, number>();
    for (const order of this.data.filteredOrders()) {
      for (const item of order.items ?? []) {
        if (!this.data.matchesItemFilters(item)) continue;
        const group = this.data.toText(item.design?.group) || 'Other';
        let value = map.get(group) ?? 0;
        for (const size of item.itemSizes ?? []) {
          value += (Number(size.quantity) || 0) * (Number(size.WSP) || 0);
        }
        map.set(group, value);
      }
    }
    return map;
  });

  protected readonly totalValue = computed(() => [...this.valueByGroup().values()].reduce((sum, v) => sum + v, 0));

  protected readonly valueFor = (row: AggregatedRow): number => this.valueByGroup().get(row.key) ?? 0;

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

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private buildExportRows(): any[][] {
    const { rows, grandTotal } = this.report();
    const header = ['#', 'Product / Group', 'Order Qty', 'Dispatched Qty', 'Extra Qty', 'Pending Qty', 'Order Value'];
    const body = rows.map((row, i) => [
      i + 1, row.label, row.orderQty, row.dispatchedQty, row.extraQty, row.pendingQty, this.round2(this.valueFor(row)),
    ]);
    body.push(['', 'Grand Total', grandTotal.orderQty, grandTotal.dispatchedQty, grandTotal.extraQty, grandTotal.pendingQty, this.round2(this.totalValue())]);
    return [header, ...body];
  }
}
