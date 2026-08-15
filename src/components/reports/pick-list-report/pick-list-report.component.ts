import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { from, of, switchMap, map, tap } from 'rxjs';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { LoadingService } from '../../../services/loading.service';
import { PickListService } from '../../../services/pick-list.service';
import { PackingListService } from '../../../services/packing-list.service';
import { DeliveryChallanService } from '../../../services/delivery-challan.service';
import { InvoiceService } from '../../../services/invoice.service';
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
  packedQty: number;
  dcQty: number;
  invoiceQty: number;
}

interface PickListDownstream {
  packedQtyByLineId: Map<string, number>;
  dcQtyByLineId: Map<string, number>;
  invoiceQtyByLineId: Map<string, number>;
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
  private readonly packingListService = inject(PackingListService);
  private readonly dcService = inject(DeliveryChallanService);
  private readonly invoiceService = inject(InvoiceService);
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

  // getPickListLinesOnce() is fetched once per matching pick list (not the
  // header's possibly-stale `items` snapshot) so this report is correct even
  // while a Party-wise list is still 'Partial' — see
  // PickListService.processPartyScan. Lines and downstream (packed/DC/
  // invoice) data are fetched together in one pipeline — previously each ran
  // as its own independent toSignal/switchMap chain, both calling
  // getPickListLinesOnce() for the exact same pick lists, doubling that read
  // for every party pick list in range.
  private readonly reportData = toSignal(
    toObservable(this.partyPickListsInRange).pipe(
      switchMap((pickLists) => {
        if (!pickLists.length) {
          return of({
            linesByPickList: new Map<string, PickListLine[]>(),
            downstreamByPickList: new Map<string, PickListDownstream>(),
          });
        }
        return from(
          Promise.all(
            pickLists.map(async (pickList) => {
              const lines = await this.pickListService.getPickListLinesOnce(pickList.id!);
              const downstream = await this.loadDownstream(pickList, lines);
              return { id: pickList.id!, lines, downstream };
            })
          )
        ).pipe(
          map((entries) => ({
            linesByPickList: new Map(entries.map((entry) => [entry.id, entry.lines] as const)),
            downstreamByPickList: new Map(entries.map((entry) => [entry.id, entry.downstream] as const)),
          }))
        );
      }),
      tap({ subscribe: () => this.loadingService.start(), finalize: () => this.loadingService.stop() })
    ),
    {
      initialValue: {
        linesByPickList: new Map<string, PickListLine[]>(),
        downstreamByPickList: new Map<string, PickListDownstream>(),
      },
    }
  );

  protected readonly report = computed<PickListReportRow[]>(() => {
    const { linesByPickList, downstreamByPickList } = this.reportData();
    const rows: PickListReportRow[] = [];

    for (const pickList of this.partyPickListsInRange()) {
      const lines = [...(linesByPickList.get(pickList.id!) ?? [])].sort((a, b) => {
        if (!!a.isAdditional !== !!b.isAdditional) return a.isAdditional ? 1 : -1;
        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      });
      const downstream = downstreamByPickList.get(pickList.id!);

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
          packedQty: downstream?.packedQtyByLineId.get(line.lineId) ?? 0,
          dcQty: Math.round(downstream?.dcQtyByLineId.get(line.lineId) ?? 0),
          invoiceQty: Math.round(downstream?.invoiceQtyByLineId.get(line.lineId) ?? 0),
        });
      }
    }

    return rows;
  });

  // For every Packing List generated from this Pick List (possibly several,
  // over several packing batches — see PackingListService.buildPackableLines),
  // walk its DCs and their Invoices to compute, per Pick List line, how much
  // has actually reached each downstream stage.
  private async loadDownstream(pickList: PickList, lines: PickListLine[]): Promise<PickListDownstream> {
    const packedQtyByLineId = new Map<string, number>();
    const dcQtyByLineId = new Map<string, number>();
    const invoiceQtyByLineId = new Map<string, number>();

    const packingLists = await this.packingListService.getPackingListsReferencingPickListOnce(pickList.id!);
    if (!packingLists.length) return { packedQtyByLineId, dcQtyByLineId, invoiceQtyByLineId };

    const packingListsData = await Promise.all(
      packingLists.map(async (packingList) => {
        const [packingLines, dcs] = await Promise.all([
          this.packingListService.getPackingListLinesOnce(packingList.id!),
          this.dcService.getDCsByPackingListIdOnce(packingList.id!),
        ]);
        const invoices = dcs.length ? await this.invoiceService.getInvoicesByDCIdsOnce(dcs.map((dc) => dc.id!)) : [];
        const invoicedDcIds = new Set(invoices.filter((invoice) => invoice.dcId).map((invoice) => invoice.dcId!));
        return { packingLines, dcs, invoicedDcIds };
      })
    );

    // Packed Qty: exact, via PackingListLine.sources — the recorded link
    // back to exactly which Pick List line(s) contributed how much.
    for (const line of lines) {
      let packed = 0;
      for (const { packingLines } of packingListsData) {
        for (const packingLine of packingLines) {
          for (const source of packingLine.sources ?? []) {
            if (source.pickListId === pickList.id && source.pickListLineId === line.lineId) packed += source.qty;
          }
        }
      }
      if (packed > 0) packedQtyByLineId.set(line.lineId, packed);
    }

    // DC/Invoice Qty: a DC groups items by (partName, styleNo, color,
    // sleeveType, size) — not by Pick List line — so a bucket's quantity is
    // split across the Pick List lines that map into it, proportional to
    // each line's own Packed Qty. This is exact whenever only one Pick List
    // line maps to a bucket (the normal case), and a fair split in the rare
    // case where a completed requested line and a later additional scan
    // share the exact same SKU (the DC document itself has no finer
    // resolution than that to report).
    const bucketKey = (partName: string, styleNo: string, color: string, sleeveType: string, size: string) =>
      `${partName}||${styleNo}||${color}||${sleeveType}||${size}`;

    const linesByBucket = new Map<string, PickListLine[]>();
    for (const line of lines) {
      const partName = String(line.group ?? '').trim() || 'General';
      const key = bucketKey(partName, line.styleNo, line.color, line.sleeveType ?? '', line.size);
      linesByBucket.set(key, [...(linesByBucket.get(key) ?? []), line]);
    }

    for (const { dcs, invoicedDcIds } of packingListsData) {
      for (const dc of dcs) {
        for (const item of dc.items) {
          for (const [size, rawQty] of Object.entries(item.sizeQty ?? {})) {
            const qty = Number(rawQty) || 0;
            if (qty <= 0) continue;
            const key = bucketKey(item.partName, item.styleNo, item.color, item.sleeveType ?? '', size);
            const bucketLines = (linesByBucket.get(key) ?? []).filter((line) => !dc.salesOrderIds.length || dc.salesOrderIds.includes(line.salesOrderId));
            if (!bucketLines.length) continue;
            const bucketPackedTotal = bucketLines.reduce((sum, line) => sum + (packedQtyByLineId.get(line.lineId) ?? 0), 0);
            for (const line of bucketLines) {
              const share = bucketPackedTotal > 0
                ? qty * (packedQtyByLineId.get(line.lineId) ?? 0) / bucketPackedTotal
                : qty / bucketLines.length;
              dcQtyByLineId.set(line.lineId, (dcQtyByLineId.get(line.lineId) ?? 0) + share);
              if (dc.id && invoicedDcIds.has(dc.id)) {
                invoiceQtyByLineId.set(line.lineId, (invoiceQtyByLineId.get(line.lineId) ?? 0) + share);
              }
            }
          }
        }
      }
    }

    return { packedQtyByLineId, dcQtyByLineId, invoiceQtyByLineId };
  }

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
    const header = ['Pick List No', 'Status', 'Date', 'Client', 'Sales No', 'Style No', 'Color', 'Size', 'Sleeve', 'Item Type', 'Required Qty', 'Picked Qty', 'Pending Qty', 'Packed Qty', 'DC Qty', 'Invoice Qty'];
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
      row.packedQty,
      row.dcQty,
      row.invoiceQty,
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
