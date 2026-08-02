import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows } from '../report-export.util';
import type { Design } from '../../../models/design.model';

const REPORT_TITLE = 'Exceed Order Report';

interface ExceedRow {
  designId: string;
  styleNo: string;
  color: string;
  orderedQty: number;
  availableQty: number;
  exceeds: boolean;
}

@Component({
  selector: 'app-exceed-order-report',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './exceed-order-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExceedOrderReportComponent {
  private readonly data = inject(ReportsDataService);
  protected readonly loadingService = inject(LoadingService);

  protected readonly report = computed(() => this.buildExceedReport());

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
      await exportRowsToPdf(rows, REPORT_TITLE, this.data.filterSummary(), {
        highlightRow: (row) => row[row.length - 1] === 'Exceeds',
      });
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
      printReportRows(rows, REPORT_TITLE, this.data.filterSummary(), {
        highlightRow: (row) => row[row.length - 1] === 'Exceeds',
      });
    });
  }

  private buildExportRows(): any[][] {
    const { rows } = this.report();
    const header = ['#', 'Design No', 'Color', 'Ordered Qty', 'Available Qty', 'Status'];
    return [
      header,
      ...rows.map((r, i) => [i + 1, r.styleNo, r.color, r.orderedQty, r.availableQty, r.exceeds ? 'Exceeds' : 'OK']),
    ];
  }

  private buildExceedReport(): { rows: ExceedRow[] } {
    const orderedByDesign = new Map<string, number>();

    for (const order of this.data.filteredOrders()) {
      for (const item of order.items ?? []) {
        if (!this.data.matchesItemFilters(item)) continue;
        const designId = item.design?.id;
        if (!designId) continue;
        const qty = (item.itemSizes ?? []).reduce((s, sz) => s + (Number(sz.quantity) || 0), 0);
        orderedByDesign.set(designId, (orderedByDesign.get(designId) ?? 0) + qty);
      }
    }

    const availableByDesign = new Map<string, number>();
    for (const inv of this.data.inventory()) {
      if (!inv.designId) continue;
      availableByDesign.set(inv.designId, (availableByDesign.get(inv.designId) ?? 0) + (Number(inv.currentStock) || 0));
    }

    const designById = new Map<string, Design>();
    for (const d of this.data.designs()) {
      if (d.id) designById.set(d.id, d);
    }

    const rows: ExceedRow[] = [...orderedByDesign.entries()]
      .map(([designId, orderedQty]) => {
        const design = designById.get(designId);
        const availableQty = availableByDesign.get(designId) ?? 0;
        return {
          designId,
          styleNo: this.data.toText(design?.styleNo) || 'Unknown',
          color: this.data.toText(design?.color),
          orderedQty,
          availableQty,
          exceeds: orderedQty > availableQty,
        };
      })
      .sort((a, b) => a.styleNo.localeCompare(b.styleNo));

    return { rows };
  }
}
