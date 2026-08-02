import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import Swal from 'sweetalert2';

import { ReportsDataService, type MatrixReport } from '../reports-data.service';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows } from '../report-export.util';

const REPORT_TITLE = 'Agent Wise Sales Report';

@Component({
  selector: 'app-agent-wise-report',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './agent-wise-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentWiseReportComponent {
  private readonly data = inject(ReportsDataService);
  protected readonly loadingService = inject(LoadingService);

  protected readonly report = computed<MatrixReport>(() => {
    const clientById = this.data.clientById();
    return this.data.buildMatrix(
      (order) => {
        const client = clientById.get(order.clientId);
        return client ? this.data.resolveAgentName(client) : '';
      },
      (key) => key
    );
  });

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
    const matrix = this.report();
    const header = ['#', 'Agent Name', ...matrix.groups, 'Total Qty', 'Total Order Value'];
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

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
