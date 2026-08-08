import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { from, of, switchMap, map, tap } from 'rxjs';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { LoadingService } from '../../../services/loading.service';
import { PickListService } from '../../../services/pick-list.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows } from '../report-export.util';
import type { PickList, PickListLine } from '../../../models/pick-list.model';

const REPORT_TITLE = 'Party-wise Pick List Report';

interface PickListReportRow {
  pickListNo: string;
  pickListStatus: PickList['status'];
  createdAt: Date | null;
  clientName: string;
  salesNo: string;
  styleNo: string;
  color: string;
  size: string;
  sleeveType: string;
  itemType: 'Requested' | 'Additional';
  requiredQty: number;
  pickedQty: number;
  pendingQty: number;
}

@Component({
  selector: 'app-pick-list-report',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './pick-list-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PickListReportComponent {
  private readonly data = inject(ReportsDataService);
  private readonly pickListService = inject(PickListService);
  protected readonly loadingService = inject(LoadingService);

  private readonly pickLists = toSignal(this.pickListService.getPickLists(), { initialValue: [] as PickList[] });

  private readonly partyPickListsInRange = computed(() => {
    const { start, end } = this.data.dateRange();
    const customerId = this.data.selectedCustomerId();
    return this.pickLists().filter((pickList) => {
      if (pickList.type !== 'party') return false;
      if (customerId && pickList.clientId !== customerId) return false;
      const created = this.toDate(pickList.createdAt);
      return !!created && created >= start && created <= end;
    });
  });

  // getPickListLinesOnce() is fetched per matching pick list (not the header's
  // possibly-stale `items` snapshot) so this report is correct even while a
  // Party-wise list is still 'Partial' — see PickListService.processPartyScan.
  private readonly linesByPickList = toSignal(
    toObservable(this.partyPickListsInRange).pipe(
      switchMap((pickLists) => {
        if (!pickLists.length) return of(new Map<string, PickListLine[]>());
        return from(
          Promise.all(
            pickLists.map((pickList) =>
              this.pickListService.getPickListLinesOnce(pickList.id!).then((lines) => [pickList.id!, lines] as const)
            )
          )
        ).pipe(map((entries) => new Map(entries)));
      }),
      tap({ subscribe: () => this.loadingService.start(), finalize: () => this.loadingService.stop() })
    ),
    { initialValue: new Map<string, PickListLine[]>() }
  );

  protected readonly report = computed<PickListReportRow[]>(() => {
    const linesByPickList = this.linesByPickList();
    const rows: PickListReportRow[] = [];

    for (const pickList of this.partyPickListsInRange()) {
      const lines = [...(linesByPickList.get(pickList.id!) ?? [])].sort((a, b) => {
        if (!!a.isAdditional !== !!b.isAdditional) return a.isAdditional ? 1 : -1;
        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      });

      for (const line of lines) {
        rows.push({
          pickListNo: pickList.pickListNo,
          pickListStatus: pickList.status,
          createdAt: this.toDate(pickList.createdAt),
          clientName: pickList.clientName,
          salesNo: line.salesNo,
          styleNo: line.styleNo,
          color: line.color,
          size: line.size,
          sleeveType: line.sleeveType ?? '',
          itemType: line.isAdditional ? 'Additional' : 'Requested',
          requiredQty: line.isAdditional ? 0 : line.requiredQty,
          pickedQty: line.pickedQty,
          pendingQty: line.isAdditional ? 0 : Math.max(0, line.requiredQty - line.pickedQty),
        });
      }
    }

    return rows;
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
    const header = ['Pick List No', 'Status', 'Date', 'Client', 'Sales No', 'Style No', 'Color', 'Size', 'Sleeve', 'Item Type', 'Required Qty', 'Picked Qty', 'Pending Qty'];
    const body = this.report().map((row) => [
      row.pickListNo,
      row.pickListStatus,
      this.formatDate(row.createdAt),
      row.clientName,
      row.salesNo,
      row.styleNo,
      row.color,
      row.size,
      row.sleeveType || '-',
      row.itemType,
      row.itemType === 'Additional' ? '-' : row.requiredQty,
      row.pickedQty,
      row.itemType === 'Additional' ? '-' : row.pendingQty,
    ]);
    return [header, ...body];
  }

  private toDate(raw: any): Date | null {
    if (!raw) return null;
    try {
      const date = raw?.toDate ? raw.toDate() : new Date(raw);
      return Number.isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }
}
