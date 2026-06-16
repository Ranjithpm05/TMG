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
import jsPDF from 'jspdf';
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

  async printPdf(): Promise<void> {
    const invoice = this.selectedInvoice();
    if (!invoice) return;
    await this.loadingService.run(() => this.generatePdf(invoice, this.companySettings()));
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

  // ─── PDF Generation ────────────────────────────────────────────────────────

  private async generatePdf(invoice: Invoice, company: CompanySettings | null): Promise<void> {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const ML = 10, MR = 10, PW = 210;
    const CW = PW - ML - MR;
    let Y = 10;

    const sf = (style: string, size: number, r = 0, g = 0, b = 0) => {
      doc.setFont('helvetica', style);
      doc.setFontSize(size);
      doc.setTextColor(r, g, b);
    };
    const txt = (t: string, x: number, y: number, opts?: any) => doc.text(t, x, y, opts ?? {});
    const hline = (y: number, clr: [number, number, number] = [220, 220, 220], lw = 0.3) => {
      doc.setDrawColor(...clr);
      doc.setLineWidth(lw);
      doc.line(ML, y, ML + CW, y);
    };
    const fillRect = (x: number, y: number, w: number, h: number, r: number, g: number, b: number) => {
      doc.setFillColor(r, g, b);
      doc.roundedRect(x, y, w, h, 1.5, 1.5, 'F');
    };

    const isGenerated = invoice.eInvoiceStatus === 'generated';

    // ── Header band ─────────────────────────────────────────────────────────
    fillRect(ML, Y, CW, 22, 15, 23, 42);
    sf('bold', 13, 255, 255, 255);
    txt(company?.legalName || 'TMG Clothings', ML + 4, Y + 8);
    sf('normal', 7.5, 160, 180, 210);
    txt(company?.address1 || '', ML + 4, Y + 13.5);
    txt(`GSTIN: ${company?.gstin || 'Not Configured'}  |  Ph: ${company?.phone || 'N/A'}`, ML + 4, Y + 18.5);

    sf('bold', 15, 245, 158, 11);
    txt('TAX INVOICE', PW - MR - 2, Y + 9, { align: 'right' });
    sf('normal', 7.5, 180, 200, 220);
    if (isGenerated) {
      sf('normal', 7, 100, 220, 150);
      txt('✓ E-INVOICE', PW - MR - 2, Y + 16, { align: 'right' });
    }

    if (invoice.signedQrCode && isGenerated) {
      try {
        doc.addImage(invoice.signedQrCode, 'PNG', PW - MR - 30, Y + 1, 28, 28);
      } catch (_) {}
    }

    Y += 25;

    // ── Invoice & Buyer details ──────────────────────────────────────────────
    const halfW = CW / 2 - 1;
    fillRect(ML, Y, halfW, 28, 248, 250, 252);
    fillRect(ML + halfW + 2, Y, halfW, 28, 248, 250, 252);

    sf('bold', 7, 100, 116, 139);
    txt('INVOICE DETAILS', ML + 3, Y + 5);
    sf('normal', 8.5, 15, 23, 42);
    txt(`Invoice No:  ${invoice.invoiceNo}`, ML + 3, Y + 10.5);
    txt(`Date:  ${this.formatDate(invoice.invoiceDate)}`, ML + 3, Y + 16);
    txt(`DC No:  ${invoice.dcNo}`, ML + 3, Y + 21);
    txt(`Pkgs:  ${invoice.totalPkgs}`, ML + 3, Y + 26);

    sf('bold', 7, 100, 116, 139);
    txt('BILLED TO', ML + halfW + 5, Y + 5);
    sf('bold', 9, 15, 23, 42);
    txt(invoice.clientName, ML + halfW + 5, Y + 10.5);
    sf('normal', 7.5, 60, 70, 90);
    const addrLines = doc.splitTextToSize(invoice.clientAddress, halfW - 8);
    addrLines.slice(0, 2).forEach((line: string, i: number) => txt(line, ML + halfW + 5, Y + 16 + i * 4.5));
    sf('normal', 7.5, 60, 70, 90);
    txt(`${invoice.clientPlace}, ${invoice.clientState} - ${invoice.clientZipCode}`, ML + halfW + 5, Y + 25);
    sf('bold', 7.5, 60, 70, 90);
    txt(`GSTIN: ${invoice.clientGstin || 'N/A'}`, ML + halfW + 5, Y + 29.5);

    Y += 31;

    // ── IRN / Ack band ───────────────────────────────────────────────────────
    if (isGenerated && invoice.irn) {
      fillRect(ML, Y, CW, 13, 240, 253, 244);
      doc.setDrawColor(34, 197, 94);
      doc.setLineWidth(0.5);
      doc.rect(ML, Y, CW, 13, 'S');
      sf('bold', 7, 22, 163, 74);
      txt('E-INVOICE VERIFIED', ML + 3, Y + 5);
      sf('normal', 6.5, 30, 50, 40);
      txt(`IRN: ${invoice.irn}`, ML + 3, Y + 10);
      if (invoice.ackNo) {
        sf('normal', 7, 60, 100, 80);
        txt(`Ack No: ${invoice.ackNo}    Ack Dt: ${invoice.ackDt || ''}`, PW - MR - 3, Y + 10, { align: 'right' });
      }
      Y += 16;
    }

    // ── Items table ──────────────────────────────────────────────────────────
    fillRect(ML, Y, CW, 7, 30, 41, 59);
    sf('bold', 7, 255, 255, 255);
    const hdrCols = [
      { x: ML + 1, label: '#', w: 5 },
      { x: ML + 6, label: 'Description', w: 50 },
      { x: ML + 57, label: 'HSN', w: 14 },
      { x: ML + 72, label: 'UOM', w: 12 },
      { x: ML + 85, label: 'Qty', w: 13, r: true },
      { x: ML + 99, label: 'Rate', w: 18, r: true },
      { x: ML + 118, label: 'Disc%', w: 14, r: true },
      { x: ML + 133, label: 'Tax%', w: 13, r: true },
      { x: ML + 147, label: 'Amount', w: 24, r: true },
    ];
    hdrCols.forEach((c) => txt(c.label, c.r ? c.x + c.w : c.x, Y + 4.5, c.r ? { align: 'right' } : {}));
    Y += 8;

    invoice.items.forEach((item, i) => {
      if (i % 2 === 0) fillRect(ML, Y - 1.5, CW, 8, 249, 250, 251);
      sf('normal', 7.5, 30, 41, 59);
      txt(String(i + 1), ML + 1, Y + 4);
      const desc = doc.splitTextToSize(item.description, 49);
      txt(desc[0], ML + 6, Y + 4);
      txt(item.hsnSac, ML + 57, Y + 4);
      txt(item.uom || 'NOS', ML + 72, Y + 4);
      txt(item.quantity.toString(), ML + 98, Y + 4, { align: 'right' });
      txt(item.price.toFixed(2), ML + 116, Y + 4, { align: 'right' });
      txt(item.discountPct.toFixed(0) + '%', ML + 131, Y + 4, { align: 'right' });
      txt(item.taxRate.toFixed(0) + '%', ML + 145, Y + 4, { align: 'right' });
      txt(item.amount.toFixed(2), ML + 171, Y + 4, { align: 'right' });
      Y += 8;
    });
    hline(Y, [200, 200, 200], 0.4);
    Y += 4;

    // ── Tax summary ──────────────────────────────────────────────────────────
    if (invoice.taxSummary?.length) {
      fillRect(ML, Y, CW * 0.65, 6, 241, 245, 249);
      sf('bold', 7, 30, 41, 59);
      ['HSN/SAC', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total Tax'].forEach((h, i) => {
        txt(h, ML + 2 + i * 21, Y + 4);
      });
      Y += 7;
      invoice.taxSummary.forEach((ts) => {
        sf('normal', 7.5, 60, 70, 90);
        txt(ts.hsnSac, ML + 2, Y + 3.5);
        txt(ts.taxableValue.toFixed(2), ML + 23, Y + 3.5);
        txt(ts.cgstAmount > 0 ? `${ts.cgstRate}%: ${ts.cgstAmount.toFixed(2)}` : '-', ML + 44, Y + 3.5);
        txt(ts.sgstAmount > 0 ? `${ts.sgstRate}%: ${ts.sgstAmount.toFixed(2)}` : '-', ML + 65, Y + 3.5);
        txt(ts.igstAmount > 0 ? `${ts.igstRate}%: ${ts.igstAmount.toFixed(2)}` : '-', ML + 86, Y + 3.5);
        txt((ts.cgstAmount + ts.sgstAmount + ts.igstAmount).toFixed(2), ML + 107, Y + 3.5);
        Y += 5.5;
      });
      Y += 2;
    }

    // ── Totals ────────────────────────────────────────────────────────────────
    const totX = ML + CW * 0.55;
    const totW = CW * 0.45;
    const rows: [string, string][] = [
      ['Gross Amount', invoice.grossAmount.toFixed(2)],
      [`Discount (${invoice.discountPct}%)`, '- ' + invoice.discountAmount.toFixed(2)],
      ['Taxable Value', invoice.taxableValue.toFixed(2)],
    ];
    if (invoice.cgstAmount > 0) rows.push([`CGST @ ${invoice.cgstRate}%`, invoice.cgstAmount.toFixed(2)]);
    if (invoice.sgstAmount > 0) rows.push([`SGST @ ${invoice.sgstRate}%`, invoice.sgstAmount.toFixed(2)]);
    if (invoice.igstAmount > 0) rows.push([`IGST @ ${invoice.igstRate}%`, invoice.igstAmount.toFixed(2)]);
    rows.push(['Round Off', invoice.roundOff.toFixed(2)]);

    rows.forEach(([label, value]) => {
      sf('normal', 8, 60, 70, 90);
      txt(label, totX + 2, Y + 4);
      txt(`₹ ${value}`, ML + CW - 2, Y + 4, { align: 'right' });
      Y += 5.5;
    });

    fillRect(totX, Y, totW, 9, 15, 23, 42);
    sf('bold', 10, 255, 255, 255);
    txt('NET PAYABLE', totX + 3, Y + 6);
    txt(`₹ ${invoice.totalAmount.toFixed(2)}`, ML + CW - 2, Y + 6, { align: 'right' });
    Y += 12;

    sf('italic', 7.5, 80, 90, 110);
    txt(`Amount in Words: ${invoice.amountInWords}`, ML, Y);
    Y += 8;

    // ── Footer ────────────────────────────────────────────────────────────────
    hline(286, [200, 200, 200]);
    sf('normal', 6.5, 140, 140, 140);
    txt('This is a computer-generated invoice and does not require a signature.', ML, 291);
    if (isGenerated) {
      sf('bold', 7, 22, 163, 74);
      txt('✓ E-Invoice Authenticated', PW / 2, 291, { align: 'center' });
    }
    sf('normal', 6.5, 140, 140, 140);
    txt(company?.legalName || 'TMG Clothings', ML + CW, 291, { align: 'right' });

    doc.save(`Invoice-${invoice.invoiceNo}.pdf`);
  }
}
