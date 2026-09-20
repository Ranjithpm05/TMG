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

const REPORT_TITLE = 'Sales Report - Product-wise Format 1';

interface ProductWiseTotals {
  qty: number;
  grossAmount1: number;
  discount: number;
  grossAmount2: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
}

@Component({
  selector: 'app-sales-report-product-wise-1',
  standalone: true,
  imports: [CommonModule, ReportFilterBarComponent, ReportStatusComponent, ReportPaginationComponent],
  providers: [ReportsDataService],
  templateUrl: './sales-report-product-wise-1.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SalesReportProductWise1Component {
  protected readonly reportTitle = REPORT_TITLE;
  protected readonly data = inject(ReportsDataService);
  private readonly invoiceService = inject(InvoiceService);
  private readonly dcService = inject(DeliveryChallanService);
  protected readonly loadingService = inject(LoadingService);

  protected readonly isLoadingInvoices = signal(false);
  protected readonly invoicesError = signal<string | null>(null);
  private readonly retryTrigger = signal(0);

  // Scoped to the report's selected date range instead of pulling the entire
  // (ever-growing) invoice history on every load — invoiceDate/createdAt are
  // stamped from the same instant at invoice creation, so range-querying the
  // indexed createdAt field returns exactly the invoices this report would
  // have filtered down to anyway. Refetches whenever the range or retry
  // trigger changes.
  private readonly invoicesTrigger = computed(() => ({ ...this.data.dateRange(), retry: this.retryTrigger() }));

  private readonly invoices = toSignal(
    toObservable(this.invoicesTrigger).pipe(
      switchMap(({ start, end }) => {
        this.invoicesError.set(null);
        this.isLoadingInvoices.set(true);
        return this.invoiceService.getInvoicesInRange(start, end).pipe(
          catchError((err) => {
            console.error('Sales Report Product-wise Format 1: failed to load invoices', err);
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
            console.error('Sales Report Product-wise Format 1: failed to build report rows', err);
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

  protected readonly rows = computed<InvoiceProductLine[]>(() => {
    const group = this.data.selectedGroup();
    const search = this.data.toText(this.data.designSearch()).toLowerCase();
    return this.rawLines().filter((row) => {
      if (group && row.group !== group) return false;
      if (search && !row.styleNo.toLowerCase().includes(search)) return false;
      return true;
    });
  });

  protected readonly grandTotal = computed<ProductWiseTotals>(() => this.buildGrandTotal(this.rows()));

  protected retry(): void {
    this.retryTrigger.update((n) => n + 1);
  }

  protected readonly pageSize = signal(50);
  protected readonly currentPage = signal(1);

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
    const grandTotal = this.grandTotal();
    return {
      generatedAt: new Date(),
      summary: {
        'Qty Invoiced': grandTotal.qty,
        'Total Amount': grandTotal.totalAmount,
      },
    };
  }

  private buildExportRows(): any[][] {
    const rows = this.rows();
    const grandTotal = this.grandTotal();
    const header = [
      '#', 'Invoice#', 'Invoice Date', 'Customer', 'Barcode', 'Group', 'Fabric Description', 'Styleno', 'Color',
      'Sleevetype', 'Size', 'Cost Price', 'MRP', 'WSP', 'Qty Invoiced', 'Gross Amount1', 'Discount', 'Gross Amount2',
      'CGST %', 'CGST Amount', 'SGST %', 'SGST Amount', 'IGST %', 'IGST Amount', 'Total Amount',
    ];
    const body: any[][] = rows.map((row, i) => [
      i + 1, row.invoiceNo, this.formatDate(row.invoiceDate), row.clientName, row.barcode, row.group,
      row.fabricDescription, row.styleNo, row.color, row.sleeveType, row.size, row.costPrice, row.mrp, row.wsp,
      row.qty, row.grossAmount1, row.discount, row.grossAmount2, row.cgstRate, row.cgstAmount, row.sgstRate,
      row.sgstAmount, row.igstRate, row.igstAmount, row.totalAmount,
    ]);
    body.push([
      '', 'Grand Total', '', '', '', '', '', '', '', '', '', '', '', '',
      grandTotal.qty, grandTotal.grossAmount1, grandTotal.discount, grandTotal.grossAmount2,
      '', grandTotal.cgstAmount, '', grandTotal.sgstAmount, '', grandTotal.igstAmount, grandTotal.totalAmount,
    ]);
    return [header, ...body];
  }

  private buildGrandTotal(rows: InvoiceProductLine[]): ProductWiseTotals {
    const total: ProductWiseTotals = { qty: 0, grossAmount1: 0, discount: 0, grossAmount2: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, totalAmount: 0 };
    for (const row of rows) {
      total.qty += row.qty;
      total.grossAmount1 += row.grossAmount1;
      total.discount += row.discount;
      total.grossAmount2 += row.grossAmount2;
      total.cgstAmount += row.cgstAmount;
      total.sgstAmount += row.sgstAmount;
      total.igstAmount += row.igstAmount;
      total.totalAmount += row.totalAmount;
    }
    total.grossAmount1 = this.round2(total.grossAmount1);
    total.discount = this.round2(total.discount);
    total.grossAmount2 = this.round2(total.grossAmount2);
    total.cgstAmount = this.round2(total.cgstAmount);
    total.sgstAmount = this.round2(total.sgstAmount);
    total.igstAmount = this.round2(total.igstAmount);
    total.totalAmount = this.round2(total.totalAmount);
    return total;
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

  private round2(value: number): number {
    return Math.round((Number(value) || 0) * 100) / 100;
  }
}
