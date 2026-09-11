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

const REPORT_TITLE = 'Sales Order vs Supply vs Pending Report';

interface GroupTotals {
  orderQty: number;
  dispatchedQty: number;
  pendingQty: number;
}

interface SupplyPendingRow {
  key: string;
  clientName: string;
  agentName: string;
  byGroup: Record<string, GroupTotals>;
  orderTotal: number;
  dispatchedTotal: number;
  pendingTotal: number;
}

interface SupplyPendingReport {
  groups: string[];
  rows: SupplyPendingRow[];
  grandByGroup: Record<string, GroupTotals>;
  grandOrderTotal: number;
  grandDispatchedTotal: number;
  grandPendingTotal: number;
}

function emptyTotals(): GroupTotals {
  return { orderQty: 0, dispatchedQty: 0, pendingQty: 0 };
}

@Component({
  selector: 'app-sales-order-supply-pending-report',
  standalone: true,
  imports: [CommonModule, ReportFilterBarComponent, ReportStatusComponent, ReportPaginationComponent],
  providers: [ReportsDataService, ReportCalcService],
  templateUrl: './sales-order-supply-pending-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SalesOrderSupplyPendingReportComponent {
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

  protected readonly report = computed<SupplyPendingReport>(() => this.buildReport());

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
    const report = this.report();
    return {
      generatedAt: new Date(),
      summary: {
        'Order Qty': report.grandOrderTotal,
        'Supply Qty': report.grandDispatchedTotal,
        'Pending Qty': report.grandPendingTotal,
      },
    };
  }

  private buildExportRows(): any[][] {
    const report = this.report();
    const header = [
      'Customer Name', 'Agent Name',
      ...report.groups.map((g) => `Order Qty - ${g}`), 'Order Qty - Total',
      ...report.groups.map((g) => `Supply Qty - ${g}`), 'Supply Qty - Total',
      ...report.groups.map((g) => `Pending Qty - ${g}`), 'Pending Qty - Total',
    ];
    const body: any[][] = report.rows.map((row) => [
      row.clientName, row.agentName,
      ...report.groups.map((g) => row.byGroup[g]?.orderQty ?? 0), row.orderTotal,
      ...report.groups.map((g) => row.byGroup[g]?.dispatchedQty ?? 0), row.dispatchedTotal,
      ...report.groups.map((g) => row.byGroup[g]?.pendingQty ?? 0), row.pendingTotal,
    ]);
    body.push([
      'Grand Total', '',
      ...report.groups.map((g) => report.grandByGroup[g]?.orderQty ?? 0), report.grandOrderTotal,
      ...report.groups.map((g) => report.grandByGroup[g]?.dispatchedQty ?? 0), report.grandDispatchedTotal,
      ...report.groups.map((g) => report.grandByGroup[g]?.pendingQty ?? 0), report.grandPendingTotal,
    ]);
    return [header, ...body];
  }

  private buildReport(): SupplyPendingReport {
    const rowMap = new Map<string, SupplyPendingRow>();
    const groupSet = new Set<string>();

    for (const f of this.calc.skuFulfillments()) {
      const key = f.clientId || '__unassigned__';
      const group = f.group || 'Other';
      groupSet.add(group);

      let row = rowMap.get(key);
      if (!row) {
        row = { key, clientName: f.clientName || 'Unassigned', agentName: f.agentName || 'Unassigned', byGroup: {}, orderTotal: 0, dispatchedTotal: 0, pendingTotal: 0 };
        rowMap.set(key, row);
      }
      const totals = row.byGroup[group] ?? (row.byGroup[group] = emptyTotals());
      totals.orderQty += f.orderQty;
      totals.dispatchedQty += f.dispatchedQty;
      totals.pendingQty += f.pendingQty;
      row.orderTotal += f.orderQty;
      row.dispatchedTotal += f.dispatchedQty;
      row.pendingTotal += f.pendingQty;
    }

    const groups = [...groupSet].sort((a, b) => a.localeCompare(b));
    const rows = [...rowMap.values()].sort((a, b) => a.clientName.localeCompare(b.clientName));

    const grandByGroup: Record<string, GroupTotals> = {};
    let grandOrderTotal = 0, grandDispatchedTotal = 0, grandPendingTotal = 0;
    for (const row of rows) {
      for (const group of groups) {
        const totals = row.byGroup[group] ?? emptyTotals();
        const grand = grandByGroup[group] ?? (grandByGroup[group] = emptyTotals());
        grand.orderQty += totals.orderQty;
        grand.dispatchedQty += totals.dispatchedQty;
        grand.pendingQty += totals.pendingQty;
      }
      grandOrderTotal += row.orderTotal;
      grandDispatchedTotal += row.dispatchedTotal;
      grandPendingTotal += row.pendingTotal;
    }

    return { groups, rows, grandByGroup, grandOrderTotal, grandDispatchedTotal, grandPendingTotal };
  }
}
