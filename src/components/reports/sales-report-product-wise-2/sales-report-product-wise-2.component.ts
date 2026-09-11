import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { switchMap, catchError, finalize, of, from } from 'rxjs';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { ReportFilterBarComponent } from '../report-filter-bar/report-filter-bar.component';
import { InvoiceService } from '../../../services/invoice.service';
import { DeliveryChallanService } from '../../../services/delivery-challan.service';
import type { Invoice } from '../../../models/invoice.model';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows, type ExportMeta } from '../report-export.util';
import { ReportStatusComponent } from '../report-status/report-status.component';
import { ReportPaginationComponent } from '../report-pagination/report-pagination.component';
import { buildInvoiceProductLines, type InvoiceProductLine } from '../invoice-product-lines.util';

const REPORT_TITLE = 'Sales Report - Product-wise Format 2';

// Matches the SIZE_ORDER convention used in style-wise-report/pick-list/
// packing-list/goods-inward components — numeric sizes (e.g. 36/38/40) fall
// back to a natural string compare.
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL', '6XL', 'Free Size'];

interface ProductWise2Row {
  key: string;
  invoiceNo: string;
  invoiceDate: Date | null;
  clientName: string;
  group: string;
  fabricDescription: string;
  styleNo: string;
  color: string;
  sleeveType: string;
  qtyBySize: Record<string, number>;
  total: number;
}

interface ProductWise2Report {
  sizes: string[];
  rows: ProductWise2Row[];
  grandTotalBySize: Record<string, number>;
  grandTotal: number;
}

@Component({
  selector: 'app-sales-report-product-wise-2',
  standalone: true,
  imports: [CommonModule, ReportFilterBarComponent, ReportStatusComponent, ReportPaginationComponent],
  providers: [ReportsDataService],
  templateUrl: './sales-report-product-wise-2.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SalesReportProductWise2Component {
  protected readonly reportTitle = REPORT_TITLE;
  protected readonly data = inject(ReportsDataService);
  private readonly invoiceService = inject(InvoiceService);
  private readonly dcService = inject(DeliveryChallanService);
  protected readonly loadingService = inject(LoadingService);

  protected readonly isLoadingInvoices = signal(false);
  protected readonly invoicesError = signal<string | null>(null);
  private readonly retryTrigger = signal(0);

  private readonly invoices = toSignal(
    toObservable(this.retryTrigger).pipe(
      switchMap(() => {
        this.invoicesError.set(null);
        this.isLoadingInvoices.set(true);
        return this.invoiceService.getInvoices().pipe(
          catchError((err) => {
            console.error('Sales Report Product-wise Format 2: failed to load invoices', err);
            this.invoicesError.set('Unable to load report data. Please try again.');
            return of([] as Invoice[]);
          }),
          finalize(() => this.isLoadingInvoices.set(false))
        );
      })
    ),
    { initialValue: [] as Invoice[] }
  );

  private readonly filteredInvoices = computed<Invoice[]>(() => {
    const { start, end } = this.data.dateRange();
    const customerId = this.data.selectedCustomerId();
    const fromMs = start.getTime();
    const toMs = end.getTime();
    return this.invoices().filter((invoice) => {
      if (customerId && invoice.clientId !== customerId) return false;
      const invoiceDate = this.toDate(invoice.invoiceDate);
      const ms = invoiceDate?.getTime();
      return ms !== undefined && Number.isFinite(ms) && ms >= fromMs && ms <= toMs;
    });
  });

  protected readonly isBuildingLines = signal(false);
  protected readonly linesError = signal<string | null>(null);

  private readonly rawLines = toSignal(
    toObservable(this.filteredInvoices).pipe(
      switchMap((invoices) => {
        this.linesError.set(null);
        this.isBuildingLines.set(true);
        return from(buildInvoiceProductLines(invoices, this.data.designs(), this.dcService)).pipe(
          catchError((err) => {
            console.error('Sales Report Product-wise Format 2: failed to build report rows', err);
            this.linesError.set('Unable to load report data. Please try again.');
            return of([] as InvoiceProductLine[]);
          }),
          finalize(() => this.isBuildingLines.set(false))
        );
      })
    ),
    { initialValue: [] as InvoiceProductLine[] }
  );

  protected readonly isLoading = computed(() => this.isLoadingInvoices() || this.isBuildingLines());
  protected readonly error = computed(() => this.invoicesError() || this.linesError());

  private readonly filteredLines = computed<InvoiceProductLine[]>(() => {
    const group = this.data.selectedGroup();
    const search = this.data.toText(this.data.designSearch()).toLowerCase();
    return this.rawLines().filter((row) => {
      if (group && row.group !== group) return false;
      if (search && !row.styleNo.toLowerCase().includes(search)) return false;
      return true;
    });
  });

  protected readonly report = computed<ProductWise2Report>(() => this.buildReport(this.filteredLines()));

  protected retry(): void {
    this.retryTrigger.update((n) => n + 1);
  }

  protected readonly pageSize = signal(50);
  protected readonly currentPage = signal(1);

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

  protected formatDate(date: Date | null): string {
    if (!date) return '-';
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
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
    return { generatedAt: new Date(), summary: { 'Total Qty': grandTotal } };
  }

  private buildExportRows(): any[][] {
    const report = this.report();
    const header = ['#', 'Invoice#', 'Invoice Date', 'Customer', 'Group', 'Fabric Description', 'Styleno', 'Color', 'SleeveType', ...report.sizes, 'Total'];
    const body: any[][] = report.rows.map((row, i) => [
      i + 1, row.invoiceNo, this.formatDate(row.invoiceDate), row.clientName, row.group, row.fabricDescription,
      row.styleNo, row.color, row.sleeveType, ...report.sizes.map((s) => row.qtyBySize[s] ?? 0), row.total,
    ]);
    body.push([
      '', '', '', '', '', 'Grand Total', '', '', '',
      ...report.sizes.map((s) => report.grandTotalBySize[s] ?? 0), report.grandTotal,
    ]);
    return [header, ...body];
  }

  private buildReport(lines: InvoiceProductLine[]): ProductWise2Report {
    const rowMap = new Map<string, ProductWise2Row>();
    const sizeSet = new Set<string>();

    for (const line of lines) {
      sizeSet.add(line.size);
      const key = [line.invoiceNo, line.group, line.fabricDescription, line.styleNo, line.color, line.sleeveType].join('||');
      let row = rowMap.get(key);
      if (!row) {
        row = {
          key, invoiceNo: line.invoiceNo, invoiceDate: line.invoiceDate, clientName: line.clientName,
          group: line.group, fabricDescription: line.fabricDescription, styleNo: line.styleNo,
          color: line.color, sleeveType: line.sleeveType, qtyBySize: {}, total: 0,
        };
        rowMap.set(key, row);
      }
      row.qtyBySize[line.size] = (row.qtyBySize[line.size] ?? 0) + line.qty;
      row.total += line.qty;
    }

    const sizes = this.sortSizes([...sizeSet]);
    const rows = [...rowMap.values()].sort(
      (a, b) => (a.invoiceDate?.getTime() ?? 0) - (b.invoiceDate?.getTime() ?? 0) || a.invoiceNo.localeCompare(b.invoiceNo) || a.styleNo.localeCompare(b.styleNo)
    );

    const grandTotalBySize: Record<string, number> = {};
    let grandTotal = 0;
    for (const row of rows) {
      for (const size of sizes) grandTotalBySize[size] = (grandTotalBySize[size] ?? 0) + (row.qtyBySize[size] ?? 0);
      grandTotal += row.total;
    }

    return { sizes, rows, grandTotalBySize, grandTotal };
  }

  private sortSizes(sizes: string[]): string[] {
    return [...sizes].sort((a, b) => {
      const aIndex = SIZE_ORDER.indexOf(a);
      const bIndex = SIZE_ORDER.indexOf(b);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  }

  private toDate(raw: any): Date | null {
    if (!raw) return null;
    try {
      const date = raw?.toDate ? raw.toDate() : new Date(raw?.seconds ? raw.seconds * 1000 : raw);
      return Number.isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }
}
