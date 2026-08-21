import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import Swal from 'sweetalert2';
import { Invoice, EwayBillTransportDetails } from '../../models/invoice.model';
import {
  EWAY_BILL_CANCEL_REASONS,
  EWAY_BILL_TRANSPORT_MODES,
  EWAY_BILL_VEHICLE_TYPES,
} from '../../models/eway-bill.model';
import { CompanySettings, INDIA_STATE_CODES } from '../../models/einvoice.model';
import { InvoiceService } from '../../services/invoice.service';
import { EwayBillService } from '../../services/eway-bill.service';
import { CompanySettingsService } from '../../services/company-settings.service';
import { LoadingService } from '../../services/loading.service';
import { fetchLogoDataUri } from '../../services/company-logo.util';
import { buildEwbQrContent, generateQrDataUrl, generateBarcodeDataUrl } from '../../services/eway-bill-pdf.util';

type FilterTab = 'all' | 'pending' | 'generated' | 'failed' | 'cancelled';

@Component({
  selector: 'app-eway-bill',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './eway-bill.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EwayBillComponent implements OnInit, OnDestroy {
  private invoiceService = inject(InvoiceService);
  private ewayBillService = inject(EwayBillService);
  private companySettingsService = inject(CompanySettingsService);
  protected loadingService = inject(LoadingService);
  private subs: Subscription[] = [];

  mode = signal<'list' | 'view'>('list');
  filterTab = signal<FilterTab>('all');
  searchTerm = signal('');

  allInvoices = signal<Invoice[]>([]);
  selectedInvoice = signal<Invoice | null>(null);
  companySettings = signal<CompanySettings | null>(null);

  isLoading = signal(true);
  isGenerating = signal(false);
  isCancelling = signal(false);

  showGenerateModal = signal(false);
  showCancelModal = signal(false);

  readonly transportModes = EWAY_BILL_TRANSPORT_MODES;
  readonly vehicleTypes = EWAY_BILL_VEHICLE_TYPES;
  readonly cancelReasons = EWAY_BILL_CANCEL_REASONS;

  generateForm = signal<EwayBillTransportDetails>({
    distance: 0,
    transMode: '1',
    transporterId: '',
    transporterName: '',
    vehicleNo: '',
    vehicleType: 'R',
    transDocNo: '',
    transDocDt: '',
  });

  cancelReasonCode = signal('');
  cancelRemark = signal('');

  // Only invoices with a generated e-Invoice (IRN) are eligible — an E-Way
  // Bill is generated from that IRN via Webtel's GenEWaybyIRN sandbox API.
  eligibleInvoices = computed(() => this.allInvoices().filter((i) => i.eInvoiceStatus === 'generated'));

  filteredInvoices = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    const tab = this.filterTab();
    let list = this.eligibleInvoices();

    if (tab !== 'all') {
      list = list.filter((inv) => (inv.ewbStatus || 'pending') === tab);
    }
    if (term) {
      list = list.filter(
        (inv) =>
          inv.invoiceNo.toLowerCase().includes(term) ||
          inv.clientName.toLowerCase().includes(term) ||
          (inv.irn || '').toLowerCase().includes(term)
      );
    }
    return list;
  });

  stats = computed(() => {
    const all = this.eligibleInvoices();
    return {
      total: all.length,
      pending: all.filter((i) => !i.ewbStatus || i.ewbStatus === 'pending').length,
      generated: all.filter((i) => i.ewbStatus === 'generated').length,
      failed: all.filter((i) => i.ewbStatus === 'failed').length,
      cancelled: all.filter((i) => i.ewbStatus === 'cancelled').length,
    };
  });

  ngOnInit(): void {
    this.subs.push(
      this.invoiceService.getInvoices().subscribe((invoices) => {
        this.allInvoices.set(invoices);
        this.isLoading.set(false);
      })
    );
    this.subs.push(
      this.companySettingsService.getCompanySettings().subscribe((s) => {
        this.companySettings.set(s);
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  viewInvoice(invoice: Invoice): void {
    this.selectedInvoice.set(invoice);
    this.mode.set('view');
  }

  backToList(): void {
    this.mode.set('list');
    this.selectedInvoice.set(null);
  }

  setFilterTab(tab: FilterTab): void {
    this.filterTab.set(tab);
  }

  openGenerateModal(): void {
    const invoice = this.selectedInvoice();
    this.generateForm.set({
      distance: 0,
      transMode: '1',
      transporterId: '',
      transporterName: '',
      vehicleNo: '',
      vehicleType: 'R',
      // Transport document reference is the invoice's own DC No./today's
      // date, not a separate manual entry — the sandbox still wants these
      // for Rail/Air/Ship, but there's no separate "transport document" in
      // this app's workflow to ask the user for.
      transDocNo: invoice?.dcNo || '',
      transDocDt: this.todayYyyymmdd(),
    });
    this.showGenerateModal.set(true);
  }

  closeGenerateModal(): void {
    this.showGenerateModal.set(false);
  }

  updateGenerateField<K extends keyof EwayBillTransportDetails>(field: K, value: EwayBillTransportDetails[K]): void {
    this.generateForm.update((f) => ({ ...f, [field]: value }));
  }

  private todayYyyymmdd(): string {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  async submitGenerate(): Promise<void> {
    const invoice = this.selectedInvoice();
    if (!invoice?.id) return;

    const settings = this.companySettings();
    if (!settings?.gstin?.trim()) {
      Swal.fire('Company Settings Required', 'Configure company GSTIN in the E-Invoice screen first.', 'warning');
      return;
    }

    const form = this.generateForm();
    if (form.transMode === '1' && !form.vehicleNo?.trim()) {
      Swal.fire('Required', 'Vehicle number is required when the transport mode is Road.', 'warning');
      return;
    }

    this.isGenerating.set(true);
    try {
      // The success dialog (and the print preview it triggers) needs a user
      // click/popup to resolve — both must run *after* loadingService.run()
      // has closed its "Processing…" overlay, or the overlay swallows the
      // click and the dialog never advances (see printEInvoicePdf's identical
      // fix in einvoice.component.ts).
      const updated: Invoice = await this.loadingService.run(async () => {
        const stateCode = this.extractStateCodeFromGstin(invoice.clientGstin) || settings.stateCode;
        const dispatchStateCode = settings.stateCode;
        const result = await this.ewayBillService.generateEWayBill(
          invoice,
          form,
          settings.gstin,
          {
            addr1: invoice.clientAddress,
            loc: invoice.clientPlace || invoice.destination,
            pin: parseInt(invoice.clientZipCode) || undefined,
            stcd: stateCode,
          },
          {
            addr1: settings.address1,
            addr2: settings.address2,
            loc: settings.place,
            pin: parseInt(settings.pinCode) || undefined,
            stcd: dispatchStateCode,
          }
        );

        const next: Invoice = {
          ...invoice,
          ewbStatus: 'generated',
          ewbNo: result.ewbNo,
          ewbDate: result.ewbDate,
          ewbValidTill: result.ewbValidTill,
          ewbGstin: result.gstin,
          ewbTransportDetails: form,
          ewbErrorMessage: undefined,
          ewbErrorCode: undefined,
        };
        this.selectedInvoice.set(next);
        this.allInvoices.update((list) => list.map((i) => (i.id === invoice.id ? next : i)));
        this.showGenerateModal.set(false);
        return next;
      });

      await Swal.fire({
        title: 'E-Way Bill Generated!',
        html: `<b>E-Way Bill No.:</b><br><code style="font-size:14px;display:block;background:#f1f5f9;padding:8px;border-radius:6px;margin-top:4px">${updated.ewbNo}</code><p style="margin-top:8px;font-size:12px;color:#64748b">Valid till ${updated.ewbValidTill}</p>`,
        icon: 'success',
        confirmButtonColor: '#10b981',
      });
      // "E-Way Bill Generated → Show E-Way Bill Preview" — open the print
      // preview right after the success dialog closes, using the
      // just-updated invoice directly (selectedInvoice() may not have
      // re-rendered from the signal update yet).
      await this.printEwayBillPdf(updated);
    } catch (err: any) {
      const message = err?.message || 'Could not generate E-Way Bill. Please try again.';
      const updated: Invoice = { ...invoice, ewbStatus: 'failed', ewbErrorMessage: message };
      this.selectedInvoice.set(updated);
      this.allInvoices.update((list) => list.map((i) => (i.id === invoice.id ? updated : i)));
      Swal.fire('Generation Failed', message, 'error');
    } finally {
      this.isGenerating.set(false);
    }
  }

  openCancelModal(): void {
    this.cancelReasonCode.set('');
    this.cancelRemark.set('');
    this.showCancelModal.set(true);
  }

  closeCancelModal(): void {
    this.showCancelModal.set(false);
  }

  async confirmCancel(): Promise<void> {
    const invoice = this.selectedInvoice();
    if (!invoice?.id) return;
    const code = this.cancelReasonCode();
    if (!code) {
      Swal.fire('Required', 'Please select a cancellation reason.', 'warning');
      return;
    }
    const settings = this.companySettings();
    if (!settings?.gstin) {
      Swal.fire('Settings Missing', 'Company GSTIN is required to cancel via the sandbox.', 'warning');
      return;
    }

    const label = this.cancelReasons.find((r) => r.code === code)?.label || 'Others';

    this.isCancelling.set(true);
    try {
      await this.loadingService.run(async () => {
        await this.ewayBillService.cancelEWayBill(invoice, code, label, this.cancelRemark(), settings.gstin);
        const updated: Invoice = { ...invoice, ewbStatus: 'cancelled', ewbCancelReason: label };
        this.selectedInvoice.set(updated);
        this.allInvoices.update((list) => list.map((i) => (i.id === invoice.id ? updated : i)));
        this.showCancelModal.set(false);
        Swal.fire('Cancelled', 'The E-Way Bill has been cancelled successfully.', 'success');
      });
    } catch (err: any) {
      Swal.fire('Error', err?.message || 'Failed to cancel E-Way Bill.', 'error');
    } finally {
      this.isCancelling.set(false);
    }
  }

  getStatusClass(status: string): string {
    const map: Record<string, string> = {
      generated: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
      cancelled: 'bg-rose-100 text-rose-700 border border-rose-200',
      pending: 'bg-amber-100 text-amber-700 border border-amber-200',
      failed: 'bg-red-100 text-red-700 border border-red-200',
    };
    return map[status] ?? map['pending'];
  }

  getStatusLabel(status: string): string {
    return { generated: 'Generated', cancelled: 'Cancelled', pending: 'Pending', failed: 'Failed' }[status] ?? 'Pending';
  }

  formatDate(ts: any): string {
    if (!ts) return '-';
    let d: Date;
    if (ts?.toDate) d = ts.toDate();
    else if (ts?.seconds) d = new Date(ts.seconds * 1000);
    else if (ts instanceof Date) d = ts;
    else d = new Date(ts);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  formatCurrency(v: number): string {
    return '₹ ' + (v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  transportModeLabel(code: string): string {
    return this.transportModes.find((m) => m.code === code)?.label || code;
  }

  private extractStateCodeFromGstin(gstin: string): string {
    if (!gstin || gstin.length < 2) return '';
    return gstin.substring(0, 2);
  }

  private stateNameFromCode(code: string | undefined): string {
    if (!code) return '-';
    return INDIA_STATE_CODES.find((s) => s.code === code)?.name.toUpperCase() || code;
  }

  // ─── E-Way Bill PDF Print ───────────────────────────────────────────────
  // Mirrors printEInvoicePdf/buildEInvoiceDocumentHtml in einvoice.component.ts
  // (same window.open + fetchLogoDataUri + HTML-string pattern). Only
  // meaningful once an E-Way Bill actually exists: never shown for a
  // pending/failed generation, so this print can never claim success when
  // generateEwayBillByIrn didn't succeed.
  async printEwayBillPdf(invoiceOverride?: Invoice): Promise<void> {
    const invoice = invoiceOverride ?? this.selectedInvoice();
    if (!invoice?.ewbNo || invoice.ewbStatus !== 'generated') {
      Swal.fire('Not Available', 'Generate the E-Way Bill successfully first to print this document.', 'warning');
      return;
    }
    // Opened synchronously, before the async logo/QR/barcode generation
    // below, so browsers don't treat the popup as unrequested and block it.
    const win = window.open('', '_blank', 'width=1000,height=900');
    if (!win) {
      Swal.fire({ icon: 'warning', title: 'Popup Blocked', text: 'Please allow popups for this site, then try again.' });
      return;
    }
    const logoDataUri = await fetchLogoDataUri();
    const html = await this.buildEwayBillDocumentHtml(invoice, this.companySettings(), logoDataUri);
    win.document.write(html);
    win.document.close();
  }

  private fmtDateNumeric(raw: any): string {
    if (!raw) return '-';
    try {
      const d = raw?.toDate ? raw.toDate() : new Date(raw?.seconds ? raw.seconds * 1000 : raw);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch { return '-'; }
  }

  // Webtel returns ewbDate/ewbValidTill as "yyyy-MM-dd HH:mm:ss" strings —
  // reformat for display without relying on Date parsing of that exact
  // (non-ISO) shape across browsers.
  private parseEwbTimestamp(raw: string | undefined): Date | null {
    if (!raw) return null;
    const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }

  private fmtEwbDateTime(raw: string | undefined): string {
    const d = this.parseEwbTimestamp(raw);
    if (!d) return raw || '-';
    const datePart = d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timePart = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${datePart} ${timePart}`;
  }

  private fmtEwbDateOnly(raw: string | undefined): string {
    const d = this.parseEwbTimestamp(raw);
    if (!d) return raw || '-';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  private formatEwbNoSpaced(ewbNo: string | undefined): string {
    if (!ewbNo) return '-';
    return ewbNo.replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  private async buildEwayBillDocumentHtml(invoice: Invoice, company: CompanySettings | null, logoDataUri: string): Promise<string> {
    const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const B = 'border:1px solid #999;';
    const row = (label: string, value: string) =>
      `<tr><td style="padding:3px 8px;font-size:9px;color:#555;white-space:nowrap;width:38%">${label}</td><td style="padding:3px 8px;font-size:9px;font-weight:600">: ${value}</td></tr>`;
    const th = (txt: string) =>
      `<th style="padding:5px 6px;${B}background:#e8e8e8;font-size:9px;font-weight:700;text-align:center">${txt}</th>`;
    const td = (txt: string | number) =>
      `<td style="padding:5px 6px;${B}font-size:9px;text-align:center">${txt}</td>`;

    const td_ = invoice.ewbTransportDetails;
    const companyName = company?.legalName || 'TMG Clothings';
    const companyGstin = company?.gstin || '-';
    const generatorGstin = invoice.ewbGstin || companyGstin;
    const dispatchPlace = company
      ? `${esc(company.place || '-')}, ${this.stateNameFromCode(company.stateCode)}-${esc(company.pinCode || '-')}`
      : '-';
    const deliveryPlace = `${esc(invoice.clientPlace || '-')}, ${(invoice.clientState || '-').toUpperCase()}${invoice.clientZipCode ? '-' + esc(invoice.clientZipCode) : ''}`;

    const items = invoice.items || [];
    const primaryItem = items[0];
    const hsnCell = primaryItem
      ? `${esc(primaryItem.hsnSac)} - ${esc(primaryItem.description).toUpperCase()}${items.length > 1 ? ` ( +${items.length - 1} )` : ''}`
      : '-';

    const distance = td_?.distance;
    const validFrom = `${this.fmtEwbDateTime(invoice.ewbDate)}${distance ? ` [${distance}Kms]` : ''}`;
    const validUntil = this.fmtEwbDateOnly(invoice.ewbValidTill);

    const logoHtml = logoDataUri
      ? `<img src="${logoDataUri}" style="width:64px;height:64px;object-fit:contain;border-radius:6px;flex-shrink:0;margin-right:10px" alt="Logo">`
      : `<div style="width:64px;height:64px;border:1.5px solid #1e3a8a;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:900;color:#1e3a8a;text-align:center;flex-shrink:0;margin-right:10px;line-height:1.3">TMG<br>CLOTHINGS</div>`;

    const qrContent = buildEwbQrContent({
      ewbNo: invoice.ewbNo || '',
      ewbDate: invoice.ewbDate || '',
      generatorGstin,
      docNo: invoice.invoiceNo,
      docDate: this.fmtDateNumeric(invoice.invoiceDate),
      fromGstin: companyGstin,
      toGstin: invoice.clientGstin,
      totalValue: invoice.totalAmount,
      distance,
      transporterId: td_?.transporterId,
      vehicleNo: td_?.vehicleNo,
    });
    const qrDataUrl = await generateQrDataUrl(qrContent);
    const barcodeDataUrl = await generateBarcodeDataUrl(invoice.ewbNo || '');

    const qrHtml = qrDataUrl
      ? `<img src="${qrDataUrl}" style="width:110px;height:110px" alt="E-Way Bill QR">`
      : `<div style="width:110px;height:110px;border:1px dashed #ccc;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:8px;color:#999;text-align:center">QR not<br>available</div>`;

    const barcodeHtml = barcodeDataUrl
      ? `<img src="${barcodeDataUrl}" style="max-width:320px" alt="E-Way Bill Barcode">`
      : `<div style="font-size:8px;color:#999">Barcode not available</div>`;

    const transportModeCell = td_ ? this.transportModeLabel(td_.transMode).toUpperCase() : '-';
    const vehicleDocCell = td_
      ? [td_.vehicleNo, td_.transDocNo, td_.transDocDt ? this.fmtEwbDateOnly(`${td_.transDocDt.slice(0, 4)}-${td_.transDocDt.slice(4, 6)}-${td_.transDocDt.slice(6, 8)}`) : '']
          .filter(Boolean)
          .join(' &amp; ')
      : '-';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>E-Way Bill - ${esc(invoice.ewbNo)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;font-size:10px;color:#000;padding:14px}
  table{width:100%;border-collapse:collapse}
  thead{display:table-header-group}
  tr{page-break-inside:avoid}
  section{page-break-inside:avoid}
  .page-break{page-break-before:always}
  .toolbar{position:sticky;top:0;background:#fff;padding:8px 0;margin-bottom:10px;display:flex;gap:8px;justify-content:flex-end;border-bottom:1px solid #eee}
  .toolbar button{padding:7px 16px;border-radius:6px;border:none;font-size:12px;font-weight:600;cursor:pointer}
  .btn-print{background:#10b981;color:#fff}
  .btn-close{background:#e2e8f0;color:#334155}
  @media print{
    @page{size:A4;margin:12mm}
    .toolbar{display:none !important}
    body{padding:0}
  }
</style>
</head><body>

<div class="toolbar">
  <button class="btn-close" onclick="window.close()">Close</button>
  <button class="btn-print" onclick="window.print()">Print / Save as PDF</button>
</div>

<!-- ── PAGE 1 ── -->
<div style="display:flex;align-items:flex-start;border:2px solid #000;padding:8px;margin-bottom:8px">
  ${logoHtml}
  <div style="flex:1;text-align:center">
    <div style="font-size:18px;font-weight:900;letter-spacing:1px">e-Way Bill</div>
    <div style="font-size:11px;font-weight:700;margin-top:2px">${esc(companyName)}</div>
  </div>
  <div>${qrHtml}</div>
</div>

<section style="border:1px solid #999;padding:8px;margin-bottom:8px">
  <table>
    ${row('EWAYBILL No.', `<span style="font-size:13px;font-weight:900">${esc(this.formatEwbNoSpaced(invoice.ewbNo))}</span>`)}
    ${row('E-Way Bill Date', esc(this.fmtEwbDateTime(invoice.ewbDate)))}
    ${row('Generated by', esc(`${generatorGstin} - ${companyName}`))}
    ${row('Valid From', esc(validFrom))}
    ${row('Valid Until', esc(validUntil))}
  </table>
</section>

<section style="border:1px solid #999;padding:8px;margin-bottom:8px">
  <div style="font-size:11px;font-weight:700;margin-bottom:6px">IRN Details</div>
  <table>
    ${row('IRN', `<span style="font-family:monospace;font-size:8px;word-break:break-all">${esc(invoice.irn)}</span>`)}
    ${row('Ack No', esc(invoice.ackNo || '-'))}
    ${row('Ack Date', esc(invoice.ackDt || '-'))}
  </table>
</section>

<section style="border:1px solid #999;padding:8px;margin-bottom:8px">
  <div style="font-size:11px;font-weight:700;margin-bottom:6px">Part - A</div>
  <table>
    ${row('GSTIN of Supplier', esc(`${companyGstin}, ${companyName}`))}
    ${row('Place of Dispatch', dispatchPlace)}
    ${row('GSTIN of Recipient', esc(`${invoice.clientGstin || '-'}, ${invoice.clientName}`))}
    ${row('Place of Delivery', deliveryPlace)}
    ${row('Document No.', esc(invoice.invoiceNo))}
    ${row('Document Date', esc(this.fmtDateNumeric(invoice.invoiceDate)))}
    ${row('Transaction Type', 'Regular')}
    ${row('Value of Goods', esc(this.formatCurrency(invoice.totalAmount)))}
    ${row('HSN Code', hsnCell)}
    ${row('Reason for Transportation', 'Outward - Supply')}
    ${row('Transporter', esc(`${td_?.transporterId || '-'} & ${td_?.transporterName || '-'}`))}
  </table>
</section>

<section style="border:1px solid #999;padding:8px;margin-bottom:8px">
  <div style="font-size:11px;font-weight:700">Part - B</div>
</section>

<!-- ── PAGE 2 ── -->
<section class="page-break">
  <div style="font-size:11px;font-weight:700;margin:8px 0">Part - B : Vehicle / Transport Details</div>
  <table><thead><tr>
    ${th('Mode')}${th('Vehicle/Trans Doc No &amp; Dt.')}${th('From')}${th('Entered Date')}${th('Entered By')}${th('CEWB No. (If any)')}${th('Multi Veh.Info (If any)')}
  </tr></thead><tbody>
    <tr>
      ${td(transportModeCell)}${td(vehicleDocCell)}${td((company?.place || '-').toUpperCase())}${td(this.fmtEwbDateTime(invoice.ewbDate))}${td(esc(generatorGstin))}${td('-')}${td('-')}
    </tr>
  </tbody></table>

  <div style="margin-top:40px;text-align:center">
    ${barcodeHtml}
  </div>
</section>

<div style="margin-top:16px;font-size:8px;color:#888;text-align:center;border-top:1px solid #eee;padding-top:6px">
  Print Date : ${esc(new Date().toLocaleString('en-IN'))}
</div>

</body></html>`;
  }
}
