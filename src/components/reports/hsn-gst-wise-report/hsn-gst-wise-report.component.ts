import { Component, ChangeDetectionStrategy, inject, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { switchMap, catchError, finalize, of } from 'rxjs';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { InvoiceService } from '../../../services/invoice.service';
import type { Invoice, InvoiceTaxSummary } from '../../../models/invoice.model';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows, type ExportMeta } from '../report-export.util';
import { ReportStatusComponent } from '../report-status/report-status.component';
import { ReportPaginationComponent } from '../report-pagination/report-pagination.component';

const REPORT_TITLE = 'HSN / GST Wise Sales Report';

// One row per Invoice + HSN combination — an invoice with multiple HSN codes
// across its line items produces one row per code, all sharing the same
// Invoice#/Date/Customer/GST No/Total Amount.
interface HsnGstRow {
  invoiceNo: string;
  invoiceDate: Date | null;
  clientName: string;
  clientGstin: string;
  hsnSac: string;
  qty: number;
  grossAmount1: number;
  discount: number;
  grossAmount2: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
}

interface HsnGstTotals {
  invoiceCount: number;
  qty: number;
  grossAmount1: number;
  discount: number;
  grossAmount2: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
}

interface HsnGstReport {
  rows: HsnGstRow[];
  grandTotal: HsnGstTotals;
}

@Component({
  selector: 'app-hsn-gst-wise-report',
  standalone: true,
  imports: [CommonModule, ReportStatusComponent, ReportPaginationComponent],
  templateUrl: './hsn-gst-wise-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HsnGstWiseReportComponent {
  protected readonly data = inject(ReportsDataService);
  private readonly invoiceService = inject(InvoiceService);
  protected readonly loadingService = inject(LoadingService);

  // Local retry/loading state — Invoice data is a separate source from the
  // Sales-Order data ReportsDataService pulls for every other report tab, so
  // it isn't shared there (see architectural note: this report reads
  // InvoiceService directly and date/customer-filters client-side, matching
  // the pattern already used by the e-Invoice screen).
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
            console.error('HSN/GST Report: failed to load invoices', err);
            this.invoicesError.set('Unable to load report data. Please try again.');
            return of([] as Invoice[]);
          }),
          finalize(() => this.isLoadingInvoices.set(false))
        );
      })
    ),
    { initialValue: [] as Invoice[] }
  );

  protected retry(): void {
    this.retryTrigger.update((n) => n + 1);
  }

  protected readonly pageSize = signal(50);
  protected readonly currentPage = signal(1);

  protected readonly report = computed<HsnGstReport>(() => this.buildReport());

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
    return {
      generatedAt: new Date(),
      summary: {
        Invoices: grandTotal.invoiceCount,
        'Qty Invoiced': grandTotal.qty,
        'Taxable Value': grandTotal.grossAmount2,
        'Total Amount': grandTotal.totalAmount,
      },
    };
  }

  private buildExportRows(): any[][] {
    const { rows, grandTotal } = this.report();
    const header = [
      '#', 'Invoice#', 'Invoice Date', 'Customer', 'GST No', 'HSN', 'Qty Invoiced',
      'Gross Amount1', 'Discount', 'Gross Amount2', 'CGST Amount', 'SGST Amount', 'IGST Amount', 'Total Amount',
    ];
    const body: any[][] = rows.map((row, i) => [
      i + 1, row.invoiceNo, this.formatDate(row.invoiceDate), row.clientName, row.clientGstin, row.hsnSac,
      row.qty, row.grossAmount1, row.discount, row.grossAmount2, row.cgstAmount, row.sgstAmount, row.igstAmount, row.totalAmount,
    ]);
    body.push([
      '', 'Grand Total', '', '', '', '',
      grandTotal.qty, grandTotal.grossAmount1, grandTotal.discount, grandTotal.grossAmount2,
      grandTotal.cgstAmount, grandTotal.sgstAmount, grandTotal.igstAmount, grandTotal.totalAmount,
    ]);
    return [header, ...body];
  }

  private buildReport(): HsnGstReport {
    const rows: HsnGstRow[] = [];

    for (const invoice of this.filteredInvoices()) {
      const grossByHsn = new Map<string, number>();
      const qtyByHsn = new Map<string, number>();
      for (const item of invoice.items ?? []) {
        const hsn = this.data.toText(item.hsnSac) || 'N/A';
        grossByHsn.set(hsn, (grossByHsn.get(hsn) ?? 0) + (Number(item.amount) || 0));
        qtyByHsn.set(hsn, (qtyByHsn.get(hsn) ?? 0) + (Number(item.quantity) || 0));
      }
      if (grossByHsn.size === 0) continue;

      const taxSummary = invoice.taxSummary?.length ? invoice.taxSummary : this.fallbackTaxSummary(invoice, grossByHsn);
      const invoiceDate = this.toDate(invoice.invoiceDate);
      const totalAmount = this.round2(invoice.totalAmount);

      for (const tax of taxSummary) {
        const hsn = this.data.toText(tax.hsnSac) || 'N/A';
        const grossAmount1 = this.round2(grossByHsn.get(hsn) ?? 0);
        const grossAmount2 = this.round2(tax.taxableValue);
        rows.push({
          invoiceNo: invoice.invoiceNo,
          invoiceDate,
          clientName: invoice.clientName || 'Unknown Client',
          clientGstin: invoice.clientGstin || '-',
          hsnSac: hsn,
          qty: qtyByHsn.get(hsn) ?? 0,
          grossAmount1,
          discount: this.round2(grossAmount1 - grossAmount2),
          grossAmount2,
          cgstAmount: this.round2(tax.cgstAmount),
          sgstAmount: this.round2(tax.sgstAmount),
          igstAmount: this.round2(tax.igstAmount),
          totalAmount,
        });
      }
    }

    rows.sort(
      (a, b) => (b.invoiceDate?.getTime() ?? 0) - (a.invoiceDate?.getTime() ?? 0) || a.invoiceNo.localeCompare(b.invoiceNo)
    );

    return { rows, grandTotal: this.buildGrandTotal(rows) };
  }

  private buildGrandTotal(rows: HsnGstRow[]): HsnGstTotals {
    const seenInvoices = new Set<string>();
    const total: HsnGstTotals = {
      invoiceCount: 0, qty: 0, grossAmount1: 0, discount: 0, grossAmount2: 0,
      cgstAmount: 0, sgstAmount: 0, igstAmount: 0, totalAmount: 0,
    };
    for (const row of rows) {
      total.qty += row.qty;
      total.grossAmount1 += row.grossAmount1;
      total.discount += row.discount;
      total.grossAmount2 += row.grossAmount2;
      total.cgstAmount += row.cgstAmount;
      total.sgstAmount += row.sgstAmount;
      total.igstAmount += row.igstAmount;
      // Total Amount is an invoice-level figure repeated on every HSN row of
      // that invoice — sum it once per invoice, not once per row.
      if (!seenInvoices.has(row.invoiceNo)) {
        seenInvoices.add(row.invoiceNo);
        total.totalAmount += row.totalAmount;
      }
    }
    total.invoiceCount = seenInvoices.size;
    total.grossAmount1 = this.round2(total.grossAmount1);
    total.discount = this.round2(total.discount);
    total.grossAmount2 = this.round2(total.grossAmount2);
    total.cgstAmount = this.round2(total.cgstAmount);
    total.sgstAmount = this.round2(total.sgstAmount);
    total.igstAmount = this.round2(total.igstAmount);
    total.totalAmount = this.round2(total.totalAmount);
    return total;
  }

  /** Only invoices predating the per-HSN taxSummary field (added 2026-08-30) hit this — mirrors the grouping logic in packing-list.component.ts's invoice-creation code so older invoices still report correctly. */
  private fallbackTaxSummary(invoice: Invoice, grossByHsn: Map<string, number>): InvoiceTaxSummary[] {
    const discountPct = Number(invoice.discountPct) || 0;
    const isInterState = (Number(invoice.igstAmount) || 0) > 0;
    const halfTax = Number(invoice.cgstRate) || 0;
    const taxRate = Number(invoice.igstRate) || halfTax * 2;
    return [...grossByHsn.entries()].map(([hsn, groupGross]) => {
      const groupTaxable = this.round2(groupGross - (groupGross * discountPct) / 100);
      const groupCgst = isInterState ? 0 : this.round2((groupTaxable * halfTax) / 100);
      const groupIgst = isInterState ? this.round2((groupTaxable * taxRate) / 100) : 0;
      return {
        hsnSac: hsn,
        taxableValue: groupTaxable,
        cgstRate: isInterState ? 0 : halfTax,
        cgstAmount: groupCgst,
        sgstRate: isInterState ? 0 : halfTax,
        sgstAmount: groupCgst,
        igstRate: isInterState ? taxRate : 0,
        igstAmount: groupIgst,
      };
    });
  }

  private filteredInvoices(): Invoice[] {
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
