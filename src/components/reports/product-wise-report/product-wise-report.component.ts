import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows } from '../report-export.util';

const REPORT_TITLE = 'Product Wise Summary Report';

interface ProductRow {
  group: string;
  totalQty: number;
  totalValue: number;
}

@Component({
  selector: 'app-product-wise-report',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './product-wise-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProductWiseReportComponent {
  private readonly data = inject(ReportsDataService);
  protected readonly loadingService = inject(LoadingService);

  protected readonly report = computed(() => this.buildProductSummary());

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
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await exportRowsToExcel(rows, REPORT_TITLE);
    });
  }

  async exportPdf(): Promise<void> {
    const rows = this.buildExportRows();
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to export for the current filters.' });
      return;
    }

    await this.loadingService.run(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await exportRowsToPdf(rows, REPORT_TITLE, this.data.filterSummary());
    });
  }

  async printReport(): Promise<void> {
    const rows = this.buildExportRows();
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to print for the current filters.' });
      return;
    }

    await this.loadingService.run(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      printReportRows(rows, REPORT_TITLE, this.data.filterSummary());
    });
  }

  private buildExportRows(): any[][] {
    const { rows, grandTotal } = this.report();
    const header = ['#', 'Product / Group', 'Order Qty', 'Order Value'];
    const body = rows.map((r, i) => [i + 1, r.group, r.totalQty, this.round2(r.totalValue)]);
    body.push(['', 'Grand Total', grandTotal.totalQty, this.round2(grandTotal.totalValue)]);
    return [header, ...body];
  }

  private buildProductSummary(): { rows: ProductRow[]; grandTotal: { totalQty: number; totalValue: number } } {
    const rows = new Map<string, ProductRow>();

    for (const order of this.data.filteredOrders()) {
      for (const item of order.items ?? []) {
        if (!this.data.matchesItemFilters(item)) continue;
        const group = this.data.toText(item.design?.group) || 'Other';

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

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
