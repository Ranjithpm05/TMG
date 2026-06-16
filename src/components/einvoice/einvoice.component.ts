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
import { Invoice } from '../../models/invoice.model';
import { CANCEL_REASONS, CompanySettings, INDIA_STATE_CODES } from '../../models/einvoice.model';
import { InvoiceService } from '../../services/invoice.service';
import { EInvoiceService } from '../../services/einvoice.service';
import { CompanySettingsService } from '../../services/company-settings.service';
import { LoadingService } from '../../services/loading.service';

type FilterTab = 'all' | 'pending' | 'generated' | 'cancelled';

@Component({
  selector: 'app-einvoice',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './einvoice.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EInvoiceComponent implements OnInit, OnDestroy {
  private invoiceService = inject(InvoiceService);
  private einvoiceService = inject(EInvoiceService);
  private companySettingsService = inject(CompanySettingsService);
  protected loadingService = inject(LoadingService);
  private subs: Subscription[] = [];

  mode = signal<'list' | 'view'>('list');
  filterTab = signal<FilterTab>('all');
  searchTerm = signal('');

  invoices = signal<Invoice[]>([]);
  selectedInvoice = signal<Invoice | null>(null);
  companySettings = signal<CompanySettings | null>(null);

  isLoading = signal(true);
  isGenerating = signal(false);
  isCancelling = signal(false);
  isSavingSettings = signal(false);

  showSettingsModal = signal(false);
  showPayloadModal = signal(false);
  showCancelModal = signal(false);

  cancelReason = signal('');
  cancelReasonOther = signal('');
  payloadJson = signal('');

  settingsForm = signal<Partial<CompanySettings>>({
    legalName: '',
    tradeName: '',
    gstin: '',
    address1: '',
    address2: '',
    place: '',
    pinCode: '',
    stateCode: '33',
    phone: '',
    email: '',
    bankAccountName: '',
    bankAccountNo: '',
    bankIfscCode: '',
    bankName: '',
  });

  readonly stateCodes = INDIA_STATE_CODES;
  readonly cancelReasons = CANCEL_REASONS;

  filteredInvoices = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    const tab = this.filterTab();
    let list = this.invoices();

    if (tab !== 'all') {
      list = list.filter((inv) => (inv.eInvoiceStatus || 'pending') === tab);
    }

    if (term) {
      list = list.filter(
        (inv) =>
          inv.invoiceNo.toLowerCase().includes(term) ||
          inv.clientName.toLowerCase().includes(term) ||
          inv.dcNo.toLowerCase().includes(term)
      );
    }
    return list;
  });

  stats = computed(() => {
    const all = this.invoices();
    return {
      total: all.length,
      pending: all.filter((i) => !i.eInvoiceStatus || i.eInvoiceStatus === 'pending').length,
      generated: all.filter((i) => i.eInvoiceStatus === 'generated').length,
      cancelled: all.filter((i) => i.eInvoiceStatus === 'cancelled').length,
    };
  });

  ngOnInit(): void {
    this.subs.push(
      this.invoiceService.getInvoices().subscribe((invoices) => {
        this.invoices.set(invoices);
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

  async generateEInvoice(): Promise<void> {
    const invoice = this.selectedInvoice();
    if (!invoice?.id) return;

    const settings = this.companySettings();
    if (!settings?.gstin?.trim()) {
      const result = await Swal.fire({
        title: 'Company Settings Required',
        text: 'Please configure your company GSTIN and details before generating an e-Invoice.',
        icon: 'warning',
        confirmButtonText: 'Configure Now',
        showCancelButton: true,
        confirmButtonColor: '#f59e0b',
      });
      if (result.isConfirmed) this.openSettingsModal();
      return;
    }

    const confirm = await Swal.fire({
      title: 'Generate E-Invoice?',
      html: `Generate e-Invoice for <strong>${invoice.invoiceNo}</strong>?<br><small>This will compute an IRN and embed a QR code.</small>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Generate',
      confirmButtonColor: '#10b981',
    });
    if (!confirm.isConfirmed) return;

    this.isGenerating.set(true);
    try {
      await this.loadingService.run(async () => {
        const { irn, qrDataUrl, payload } = await this.einvoiceService.processEInvoice(invoice);
        const ackNo = this.buildAckNo();
        const ackDt = this.buildAckDt();
        await this.einvoiceService.saveEInvoice(invoice.id!, irn, qrDataUrl, ackNo, ackDt, payload);

        const updated: Invoice = {
          ...invoice,
          eInvoiceStatus: 'generated',
          irn,
          ackNo,
          ackDt,
          signedQrCode: qrDataUrl,
          eInvoicePayload: payload,
        };
        this.selectedInvoice.set(updated);
        this.invoices.update((list) =>
          list.map((i) => (i.id === invoice.id ? updated : i))
        );

        await Swal.fire({
          title: 'E-Invoice Generated!',
          html: `<b>IRN:</b><br><code style="word-break:break-all;font-size:10px;display:block;background:#f1f5f9;padding:8px;border-radius:6px;margin-top:4px">${irn}</code>`,
          icon: 'success',
          confirmButtonColor: '#10b981',
        });
      });
    } catch (err: any) {
      Swal.fire('Generation Failed', err?.message || 'Could not generate e-Invoice. Please try again.', 'error');
    } finally {
      this.isGenerating.set(false);
    }
  }

  openCancelModal(): void {
    this.cancelReason.set('');
    this.cancelReasonOther.set('');
    this.showCancelModal.set(true);
  }

  closeCancelModal(): void {
    this.showCancelModal.set(false);
  }

  async confirmCancel(): Promise<void> {
    const invoice = this.selectedInvoice();
    if (!invoice?.id) return;
    const reason = this.cancelReason() === 'Others' ? this.cancelReasonOther().trim() : this.cancelReason();
    if (!reason) {
      Swal.fire('Required', 'Please select or enter a cancellation reason.', 'warning');
      return;
    }

    this.isCancelling.set(true);
    try {
      await this.loadingService.run(async () => {
        await this.einvoiceService.cancelEInvoice(invoice.id!, reason);
        const updated: Invoice = { ...invoice, eInvoiceStatus: 'cancelled', cancelReason: reason };
        this.selectedInvoice.set(updated);
        this.invoices.update((list) =>
          list.map((i) => (i.id === invoice.id ? updated : i))
        );
        this.showCancelModal.set(false);
        Swal.fire('Cancelled', 'The e-Invoice has been cancelled successfully.', 'success');
      });
    } catch (err: any) {
      Swal.fire('Error', err?.message || 'Failed to cancel e-Invoice.', 'error');
    } finally {
      this.isCancelling.set(false);
    }
  }

  viewPayload(): void {
    const invoice = this.selectedInvoice();
    const settings = this.companySettings();

    if (invoice?.eInvoicePayload) {
      this.payloadJson.set(JSON.stringify(invoice.eInvoicePayload, null, 2));
      this.showPayloadModal.set(true);
      return;
    }

    if (!settings?.gstin) {
      Swal.fire('Settings Missing', 'Configure company settings to preview the payload.', 'warning');
      return;
    }

    try {
      const payload = this.einvoiceService.preparePayload(invoice!, settings);
      this.payloadJson.set(JSON.stringify(payload, null, 2));
      this.showPayloadModal.set(true);
    } catch {
      Swal.fire('Error', 'Could not prepare e-Invoice payload.', 'error');
    }
  }

  downloadJson(): void {
    const json = this.payloadJson();
    const invoice = this.selectedInvoice();
    if (!json || !invoice) return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `EInvoice-${invoice.invoiceNo}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  printPdf(): void {
    const invoice = this.selectedInvoice();
    if (!invoice) return;
    const html = this.buildInvoiceHtml(invoice, this.companySettings());
    const win = window.open('', '_blank', 'width=1100,height=860');
    if (win) {
      win.document.write(html);
      win.document.close();
      setTimeout(() => win.print(), 700);
    }
  }

  openSettingsModal(): void {
    const s = this.companySettings();
    this.settingsForm.set({
      legalName: s?.legalName || '',
      tradeName: s?.tradeName || '',
      gstin: s?.gstin || '',
      address1: s?.address1 || '',
      address2: s?.address2 || '',
      place: s?.place || '',
      pinCode: s?.pinCode || '',
      stateCode: s?.stateCode || '33',
      phone: s?.phone || '',
      email: s?.email || '',
      bankAccountName: s?.bankAccountName || '',
      bankAccountNo: s?.bankAccountNo || '',
      bankIfscCode: s?.bankIfscCode || '',
      bankName: s?.bankName || '',
    });
    this.showSettingsModal.set(true);
  }

  closeSettingsModal(): void {
    this.showSettingsModal.set(false);
  }

  async saveSettings(): Promise<void> {
    const form = this.settingsForm();
    if (!form.legalName?.trim()) {
      Swal.fire('Required', 'Legal/company name is required.', 'warning');
      return;
    }
    if (!form.gstin?.trim()) {
      Swal.fire('Required', 'GSTIN is required.', 'warning');
      return;
    }
    const gstinPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    if (!gstinPattern.test(form.gstin.toUpperCase().trim())) {
      Swal.fire('Invalid GSTIN', 'Please enter a valid 15-character GSTIN (e.g. 33AAAAA0000A1ZA).', 'warning');
      return;
    }

    this.isSavingSettings.set(true);
    try {
      await this.loadingService.run(async () => {
        await this.companySettingsService.saveCompanySettings({
          legalName: form.legalName!.trim(),
          tradeName: form.tradeName?.trim() || undefined,
          gstin: form.gstin!.toUpperCase().trim(),
          address1: form.address1?.trim() || '',
          address2: form.address2?.trim() || undefined,
          place: form.place?.trim() || '',
          pinCode: form.pinCode?.trim() || '',
          stateCode: form.stateCode || '33',
          phone: form.phone?.trim() || undefined,
          email: form.email?.trim() || undefined,
          bankAccountName: form.bankAccountName?.trim() || undefined,
          bankAccountNo: form.bankAccountNo?.trim() || undefined,
          bankIfscCode: form.bankIfscCode?.trim() || undefined,
          bankName: form.bankName?.trim() || undefined,
        });
        this.showSettingsModal.set(false);
        Swal.fire({ title: 'Saved', text: 'Company settings updated.', icon: 'success', timer: 1500, showConfirmButton: false });
      });
    } catch {
      Swal.fire('Error', 'Failed to save settings. Please try again.', 'error');
    } finally {
      this.isSavingSettings.set(false);
    }
  }

  updateSettingsField(field: keyof CompanySettings, value: string): void {
    this.settingsForm.update((f) => ({ ...f, [field]: value }));
  }

  setFilterTab(tab: FilterTab): void {
    this.filterTab.set(tab);
  }

  getStatusClass(status: string): string {
    const map: Record<string, string> = {
      generated: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
      cancelled: 'bg-rose-100 text-rose-700 border border-rose-200',
      pending: 'bg-amber-100 text-amber-700 border border-amber-200',
    };
    return map[status] ?? map['pending'];
  }

  getStatusLabel(status: string): string {
    return { generated: 'Generated', cancelled: 'Cancelled', pending: 'Pending' }[status] ?? 'Pending';
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

  private buildAckNo(): string {
    const ts = Date.now().toString();
    return ts.substring(ts.length - 13);
  }

  private buildAckDt(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ─── HTML Invoice Builder ──────────────────────────────────────────────────

  private buildInvoiceHtml(invoice: Invoice, company: CompanySettings | null): string {
    const B = 'border:1px solid #ccc;';
    const th = (txt: string, extra = '') =>
      `<th style="padding:4px 6px;${B}background:#e8e8e8;font-size:9px;font-weight:700;text-align:center;${extra}">${txt}</th>`;
    const td = (txt: string | number, extra = '') =>
      `<td style="padding:4px 6px;${B}font-size:9px;text-align:center;${extra}">${txt}</td>`;

    const fmtDate = (raw: any): string => {
      if (!raw) return '-';
      try {
        const d = raw?.toDate ? raw.toDate() : new Date(raw?.seconds ? raw.seconds * 1000 : raw);
        return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
      } catch { return '-'; }
    };

    const co = company;
    const companyName = co?.legalName || 'TMG Clothings';
    const companyAddr1 = co?.address1 || 'Door No.334/2, Serayampalaym, Vellanaipatti Post, Coimbatore - 641048';
    const companyAddr2 = co?.address2 ? `, ${co.address2}` : '';
    const companyPlace = co?.place ? `, ${co.place} - ${co.pinCode}` : '';
    const companyPhone = co?.phone || '9842211787';
    const companyEmail = co?.email || 'order@tmggarments.in';
    const companyGstin = co?.gstin || '33AAYFT2559B1ZY';

    const addrLines = [
      invoice.clientAddress,
      [invoice.clientPlace, invoice.clientState].filter(Boolean).join(', ') + (invoice.clientZipCode ? ' - ' + invoice.clientZipCode : ''),
      invoice.clientPhone ? 'Mobile: ' + invoice.clientPhone : '',
    ].filter(Boolean);
    const clientAddrHtml = addrLines.map((l) => `<div style="font-size:9px;margin-top:1px">${l}</div>`).join('');

    const itemRows = invoice.items.map((item, i) =>
      `<tr style="background:${i % 2 === 0 ? '#fff' : '#f9f9f9'}">` +
      td(i + 1) + td(item.description, 'text-align:left;font-weight:600') + td(item.hsnSac) +
      td(item.discountPct) + td(item.taxRate) + td(item.mrp.toFixed(2)) + td(item.uom) +
      td(item.quantity) + td(item.price.toFixed(2), 'font-weight:700') +
      td(item.amount.toFixed(2), 'font-weight:700') + '</tr>'
    ).join('');

    const taxSummaryRows = invoice.taxSummary.map((t) =>
      '<tr>' +
      td(t.hsnSac) + td(t.taxableValue.toFixed(2), 'font-weight:700') +
      td(t.cgstRate) + td(t.cgstAmount.toFixed(2), 'font-weight:700') +
      td(t.sgstRate) + td(t.sgstAmount.toFixed(2), 'font-weight:700') +
      td(t.igstRate || '-') + td(t.igstAmount ? t.igstAmount.toFixed(2) : '-') + '</tr>'
    ).join('');

    const isEInvoice = invoice.eInvoiceStatus === 'generated' && !!invoice.irn;

    // Top-right corner: QR code (if e-invoice) else copy type
    const topRightHtml = isEInvoice && invoice.signedQrCode
      ? `<div style="text-align:right;min-width:90px">
           <div style="font-size:8px;color:#666;margin-bottom:2px">Triplicate-For Assessee</div>
           <img src="${invoice.signedQrCode}" style="width:80px;height:80px;border:1px solid #ddd;border-radius:3px" alt="QR">
         </div>`
      : `<div style="text-align:right;font-size:8px;color:#666;min-width:100px">Triplicate-For Assessee</div>`;

    // IRN row in invoice details (only for e-invoice)
    const irnRow = isEInvoice
      ? `<tr><td style="padding:2px 4px;font-size:8px;color:#555;white-space:nowrap">IRN</td>
           <td style="padding:2px 4px;font-size:7px;font-family:monospace;color:#166534;word-break:break-all;max-width:170px">: ${invoice.irn}</td></tr>
         <tr><td style="padding:2px 4px;font-size:8px;color:#555">Ack No.</td>
           <td style="padding:2px 4px;font-size:9px;font-weight:600">: ${invoice.ackNo || '-'}</td></tr>
         <tr><td style="padding:2px 4px;font-size:8px;color:#555">Ack Date</td>
           <td style="padding:2px 4px;font-size:9px">: ${invoice.ackDt || '-'}</td></tr>`
      : '';

    // Bank details
    const hasBankDetails = co?.bankAccountName || co?.bankAccountNo || co?.bankIfscCode || co?.bankName;
    const bankSection = hasBankDetails
      ? `<div style="border:1px solid #ccc;padding:5px 8px;margin-bottom:8px;font-size:9px">
           <div style="font-weight:700;margin-bottom:3px">Company's Bank Details :</div>
           ${co?.bankAccountName ? `<div>Name of the Account : ${co.bankAccountName}</div>` : ''}
           ${co?.bankAccountNo ? `<div>A/C No : ${co.bankAccountNo}</div>` : ''}
           ${co?.bankIfscCode ? `<div>IFSC Code : ${co.bankIfscCode}</div>` : ''}
           ${co?.bankName ? `<div>Bank Name : ${co.bankName}</div>` : ''}
         </div>`
      : `<div style="border:1px solid #ccc;padding:5px 8px;margin-bottom:8px;font-size:9px">
           <div style="font-weight:700;margin-bottom:3px">Company's Bank Details :</div>
           <div>Name of the Account : TMG Clothings</div>
           <div>A/C No : 44358238258</div>
           <div>IFSC Code : SBIN0061170</div>
           <div>Bank Name : STATE BANK OF INDIA / Branch : Siruthozhil Branch, Kovilpatti</div>
         </div>`;

    const eInvoiceBadge = isEInvoice
      ? `<span style="display:inline-block;margin-left:8px;padding:1px 6px;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:3px;font-size:8px;font-weight:700;vertical-align:middle">✓ E-INVOICE</span>`
      : '';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice - ${invoice.invoiceNo}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;font-size:10px;color:#000}
  table{width:100%;border-collapse:collapse}
  @media print{@page{size:A4;margin:10mm}}
</style>
</head><body><div style="padding:10px 14px">

<div style="display:flex;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:6px">
  <div style="width:62px;height:62px;border:1.5px solid #1e3a8a;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:900;color:#1e3a8a;text-align:center;flex-shrink:0;margin-right:10px;line-height:1.3">
    TMG<br>CLOTHINGS
  </div>
  <div style="flex:1;text-align:center">
    <div style="font-size:22px;font-weight:900;letter-spacing:0.5px">${companyName}</div>
    <div style="font-size:9px;color:#333;margin-top:2px">${companyAddr1}${companyAddr2}${companyPlace}</div>
    <div style="font-size:9px;color:#333">Phone: ${companyPhone} | Email: ${companyEmail} | GSTIN: ${companyGstin}</div>
  </div>
  ${topRightHtml}
</div>

<div style="font-size:13px;font-weight:700;text-align:center;letter-spacing:2px;text-decoration:underline;margin-bottom:8px">
  TAX INVOICE${eInvoiceBadge}
</div>

<div style="display:flex;border:1px solid #aaa;margin-bottom:8px">
  <div style="flex:1;padding:6px 8px;border-right:1px solid #aaa">
    <div style="font-size:10px;font-weight:700;margin-bottom:3px">M/S : ${invoice.clientName}</div>
    ${clientAddrHtml}
    ${invoice.clientGstin ? `<div style="font-size:9px;margin-top:3px;font-weight:600">GSTIN: ${invoice.clientGstin}</div>` : ''}
  </div>
  <div style="flex:1;padding:6px 8px;border-right:1px solid #aaa">
    <div style="font-size:9px;font-weight:700;margin-bottom:2px">Ship To : ${invoice.clientName}</div>
    ${clientAddrHtml}
    ${invoice.clientPhone ? `<div style="font-size:9px;margin-top:2px">Mobile: ${invoice.clientPhone}</div>` : ''}
  </div>
  <div style="min-width:215px;padding:4px 8px">
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:2px 4px;font-size:9px;color:#555;white-space:nowrap">Invoice No.</td><td style="padding:2px 4px;font-size:9px;font-weight:700">: ${invoice.invoiceNo}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Invoice Date</td><td style="padding:2px 4px;font-size:9px">: ${fmtDate(invoice.invoiceDate)}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">DC No.</td><td style="padding:2px 4px;font-size:9px;font-weight:700">: ${invoice.dcNo || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Order No.</td><td style="padding:2px 4px;font-size:9px;font-weight:600">: ${invoice.orderNo || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Destination</td><td style="padding:2px 4px;font-size:9px">: ${invoice.destination || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Transport</td><td style="padding:2px 4px;font-size:9px">: ${invoice.transport || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Doc No.</td><td style="padding:2px 4px;font-size:9px">: ${invoice.docNo || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Vehicle No.</td><td style="padding:2px 4px;font-size:9px">: ${invoice.vehicleNo || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Total Pkgs</td><td style="padding:2px 4px;font-size:9px;font-weight:700">: ${invoice.totalPkgs}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Agent</td><td style="padding:2px 4px;font-size:9px">: ${invoice.agentName || '—'}</td></tr>
      ${irnRow}
    </table>
  </div>
</div>

<table style="margin-bottom:8px"><thead><tr>
  ${th('S.No')}${th('Description', 'text-align:left')}${th('HSN/SAC')}${th('Disc(%)')}${th('Tax(%)')}${th('MRP')}${th('UOM')}${th('Quantity')}${th('Price')}${th('Amount')}
</tr></thead><tbody>
  ${itemRows}
  <tr>
    <td colspan="9" style="padding:4px 6px;${B}font-weight:700;font-size:9px;text-align:right;background:#f0f0f0">Gross</td>
    <td style="padding:4px 6px;${B}font-weight:900;font-size:10px;text-align:center;background:#f0f0f0">${invoice.grossAmount.toFixed(2)}</td>
  </tr>
</tbody></table>

<div style="display:flex;justify-content:flex-end;margin-bottom:8px">
  <table style="width:280px;border-collapse:collapse">
    <tr><td style="padding:3px 8px;font-size:9px;border:1px solid #ddd">Discount (${invoice.discountPct}%)</td><td style="padding:3px 8px;font-size:9px;font-weight:700;text-align:right;border:1px solid #ddd">${invoice.discountAmount.toFixed(2)}</td></tr>
    <tr><td style="padding:3px 8px;font-size:9px;border:1px solid #ddd">Taxable Value</td><td style="padding:3px 8px;font-size:9px;font-weight:700;text-align:right;border:1px solid #ddd">${invoice.taxableValue.toFixed(2)}</td></tr>
    ${invoice.cgstAmount > 0 ? `<tr><td style="padding:3px 8px;font-size:9px;border:1px solid #ddd">CGST (${invoice.cgstRate}%)</td><td style="padding:3px 8px;font-size:9px;text-align:right;border:1px solid #ddd">${invoice.cgstAmount.toFixed(2)}</td></tr>` : ''}
    ${invoice.sgstAmount > 0 ? `<tr><td style="padding:3px 8px;font-size:9px;border:1px solid #ddd">SGST (${invoice.sgstRate}%)</td><td style="padding:3px 8px;font-size:9px;text-align:right;border:1px solid #ddd">${invoice.sgstAmount.toFixed(2)}</td></tr>` : ''}
    ${invoice.igstAmount > 0 ? `<tr><td style="padding:3px 8px;font-size:9px;border:1px solid #ddd">IGST (${invoice.igstRate}%)</td><td style="padding:3px 8px;font-size:9px;text-align:right;border:1px solid #ddd">${invoice.igstAmount.toFixed(2)}</td></tr>` : ''}
    <tr><td style="padding:3px 8px;font-size:9px;border:1px solid #ddd;font-weight:700">Total Tax Amount</td><td style="padding:3px 8px;font-size:9px;font-weight:700;text-align:right;border:1px solid #ddd">${invoice.totalTaxAmount.toFixed(2)}</td></tr>
    <tr><td style="padding:3px 8px;font-size:9px;border:1px solid #ddd">Round Off</td><td style="padding:3px 8px;font-size:9px;text-align:right;border:1px solid #ddd">${invoice.roundOff.toFixed(2)}</td></tr>
    <tr style="background:#0f172a;color:#fff">
      <td style="padding:5px 8px;font-size:11px;font-weight:900;border:1px solid #0f172a">TOTAL</td>
      <td style="padding:5px 8px;font-size:12px;font-weight:900;text-align:right;border:1px solid #0f172a">&#x20B9; ${invoice.totalAmount.toLocaleString('en-IN')}</td>
    </tr>
  </table>
</div>

<div style="border:1px solid #ccc;padding:5px 8px;margin-bottom:8px;font-size:9px">
  <strong>Rupees :</strong> ${invoice.amountInWords}
</div>

<table style="margin-bottom:8px"><thead><tr>
  ${th('HSN/SAC')}${th('Taxable Value')}${th('CGST %')}${th('CGST Amt')}${th('SGST %')}${th('SGST Amt')}${th('IGST %')}${th('IGST Amt')}
</tr></thead><tbody>
  ${taxSummaryRows}
  <tr style="background:#f0f0f0">
    ${td('Total', 'font-weight:700')}${td(invoice.taxableValue.toFixed(2), 'font-weight:700')}${td('')}${td(invoice.cgstAmount.toFixed(2), 'font-weight:700')}${td('')}${td(invoice.sgstAmount.toFixed(2), 'font-weight:700')}${td('')}${td(invoice.igstAmount ? invoice.igstAmount.toFixed(2) : '-')}
  </tr>
</tbody></table>

<div style="font-size:8px;border:1px solid #ccc;padding:4px 8px;margin-bottom:8px">
  Amount of Tax (in words) : ${this.amountToWords(invoice.totalTaxAmount)}
</div>

${bankSection}

<div style="font-size:9px;margin-bottom:12px">Remarks :</div>

<div style="display:flex;justify-content:space-between;margin-top:30px">
  <div style="text-align:center">
    <div style="border-top:1px solid #555;padding-top:4px;font-size:9px;color:#444;width:120px">Checked By</div>
  </div>
  <div style="text-align:center">
    <div style="font-size:10px;font-weight:700;color:#0f172a;margin-bottom:2px">For ${companyName}</div>
    <div style="border-top:1px solid #555;padding-top:4px;font-size:9px;color:#444;width:150px;margin-top:30px">Authorised Signatory</div>
  </div>
</div>

</div></body></html>`;
  }

  private amountToWords(amount: number): string {
    const rounded = Math.round(amount);
    const parts = amount.toFixed(2).split('.');
    const paisa = parseInt(parts[1], 10);
    const rupeeWords = this.numberToWords(rounded);
    if (paisa > 0) return rupeeWords + ' AND ' + this.numberToWords(paisa) + ' PAISE ONLY';
    return rupeeWords + ' RUPEES ONLY';
  }

  private numberToWords(n: number): string {
    if (n === 0) return 'ZERO';
    const ones = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
      'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
    const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
    const twoD = (num: number): string => num < 20 ? ones[num] : (tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '')).trim();
    const threeD = (num: number): string => num >= 100 ? ones[Math.floor(num / 100)] + ' HUNDRED' + (num % 100 ? ' ' + twoD(num % 100) : '') : twoD(num);
    const p: string[] = [];
    if (n >= 10000000) { p.push(threeD(Math.floor(n / 10000000)) + ' CRORE'); n %= 10000000; }
    if (n >= 100000) { p.push(twoD(Math.floor(n / 100000)) + ' LAKH'); n %= 100000; }
    if (n >= 1000) { p.push(twoD(Math.floor(n / 1000)) + ' THOUSAND'); n %= 1000; }
    if (n > 0) p.push(threeD(n));
    return p.join(' ');
  }

}
