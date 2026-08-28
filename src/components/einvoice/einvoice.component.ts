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
import { Transport } from '../../models/transport.model';
import { LrEntry } from '../../models/lr-entry.model';
import { InvoiceService } from '../../services/invoice.service';
import { EInvoiceService } from '../../services/einvoice.service';
import { CompanySettingsService } from '../../services/company-settings.service';
import { ClientService } from '../../services/client.service';
import { TransportService } from '../../services/transport.service';
import { LrEntryService } from '../../services/lr-entry.service';
import { LoadingService } from '../../services/loading.service';
import { exportInvoicesToTally } from './tally-export.util';
import { fetchLogoDataUri } from '../../services/company-logo.util';

interface TransportDetailsForm {
  transportId: string;
  transport: string;
  transportAddress: string;
  transportGstNo: string;
  vehicleNo: string;
  docNo: string;
  shipmentDate: string; // yyyy-MM-dd, for a native <input type="date">
  totalPkgs: number;
  agentName: string;
  destination: string;
}

type FilterTab = 'all' | 'pending' | 'generated' | 'failed' | 'cancelled';

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
  private clientService = inject(ClientService);
  private transportService = inject(TransportService);
  private lrEntryService = inject(LrEntryService);
  protected loadingService = inject(LoadingService);
  private subs: Subscription[] = [];

  clientCodeByClientId = signal<Map<string, string>>(new Map());
  isExportingTally = signal(false);

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
  showTransportModal = signal(false);
  showLrModal = signal(false);
  isMappingLr = signal(false);

  cancelReason = signal('');
  cancelReasonOther = signal('');
  payloadJson = signal('');

  lrEntries = signal<LrEntry[]>([]);

  transports = signal<Transport[]>([]);
  isSavingTransport = signal(false);
  transportForm = signal<TransportDetailsForm>({
    transportId: '',
    transport: '',
    transportAddress: '',
    transportGstNo: '',
    vehicleNo: '',
    docNo: '',
    shipmentDate: '',
    totalPkgs: 1,
    agentName: '',
    destination: '',
  });

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

  // "Eligible" LR Entries for the currently-selected invoice — same
  // Transport (case/whitespace-insensitive), per the mapping rule: one LR
  // commonly covers several invoices dispatched together with the same
  // transporter. Not filtered further by invoiceIds — an LR already holding
  // other invoices is still offered, since one LR -> many invoices is the
  // whole point (see LrEntry doc comment).
  eligibleLrEntries = computed(() => {
    const invoice = this.selectedInvoice();
    const transport = (invoice?.transport || '').trim().toLowerCase();
    if (!transport) return [];
    return this.lrEntries().filter((lr) => (lr.transport || '').trim().toLowerCase() === transport);
  });

  stats = computed(() => {
    const all = this.invoices();
    return {
      total: all.length,
      pending: all.filter((i) => !i.eInvoiceStatus || i.eInvoiceStatus === 'pending').length,
      generated: all.filter((i) => i.eInvoiceStatus === 'generated').length,
      failed: all.filter((i) => i.eInvoiceStatus === 'failed').length,
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
    this.subs.push(
      this.clientService.getClients().subscribe((clients) => {
        const map = new Map<string, string>();
        for (const c of clients) if (c.id) map.set(c.id, c.clientCode || '');
        this.clientCodeByClientId.set(map);
      })
    );
    this.subs.push(
      this.transportService.getTransports().subscribe((transports) => {
        this.transports.set(transports.filter((t) => t.status !== 'Inactive'));
      })
    );
    this.subs.push(
      this.lrEntryService.getLrEntries().subscribe((lrEntries) => {
        this.lrEntries.set(lrEntries);
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
      // The success dialog needs a user click to resolve — it must run
      // *after* loadingService.run() so the "Processing…" overlay (z-[9999]
      // in app.component.html, above SweetAlert2's own z-index) has already
      // closed. Awaiting Swal.fire() while still inside run() stacked the
      // overlay on top of the dialog and swallowed the OK click, so the
      // overlay never closed — a deadlock, not just a slow request.
      const { result, payload } = await this.loadingService.run(async () => {
        const { result, payload } = await this.einvoiceService.submitToIRP(invoice, settings);
        await this.einvoiceService.saveEInvoice(invoice.id!, result, payload);
        return { result, payload };
      });

      const updated: Invoice = {
        ...invoice,
        eInvoiceStatus: 'generated',
        irn: result.irn,
        ackNo: result.ackNo,
        ackDt: result.ackDt,
        signedQrCode: result.signedQrCode,
        signedInvoice: result.signedInvoice,
        eInvoicePayload: payload,
        eInvoiceErrorMessage: undefined,
        eInvoiceErrorCode: undefined,
      };
      this.selectedInvoice.set(updated);
      this.invoices.update((list) =>
        list.map((i) => (i.id === invoice.id ? updated : i))
      );

      await Swal.fire({
        title: 'E-Invoice Generated!',
        html: `<b>IRN:</b><br><code style="word-break:break-all;font-size:10px;display:block;background:#f1f5f9;padding:8px;border-radius:6px;margin-top:4px">${result.irn}</code>`,
        icon: 'success',
        confirmButtonColor: '#10b981',
      });
      // "IRN Generated Successfully → Show E-Invoice Print/Preview" — open it
      // right after the success dialog closes, using the just-updated
      // invoice object directly (don't rely on selectedInvoice() having
      // re-rendered from the signal update yet).
      await this.printEInvoicePdf(updated);
    } catch (err: any) {
      const message = err?.message || 'Could not generate e-Invoice. Please try again.';
      try {
        await this.einvoiceService.saveEInvoiceFailure(invoice.id!, message);
        const updated: Invoice = { ...invoice, eInvoiceStatus: 'failed', eInvoiceErrorMessage: message };
        this.selectedInvoice.set(updated);
        this.invoices.update((list) => list.map((i) => (i.id === invoice.id ? updated : i)));
      } catch {
        // Firestore write for the failure record itself failed — surface the
        // original error below regardless.
      }
      Swal.fire('Generation Failed', message, 'error');
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

    const settings = this.companySettings();
    if (!settings?.gstin) {
      Swal.fire('Settings Missing', 'Company GSTIN is required to cancel via the sandbox.', 'warning');
      return;
    }

    this.isCancelling.set(true);
    try {
      await this.loadingService.run(async () => {
        await this.einvoiceService.cancelEInvoiceRemote(invoice, reason, settings.gstin);
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

  // ─── Transport Details (editable before E-Invoice generation) ─────────────
  // Locked once an e-Invoice has been generated — the IRN/payload already
  // submitted to the IRP was built from these fields, so changing them
  // afterwards would make the printed invoice disagree with what's on record
  // with the IRP. Only available while eInvoiceStatus is pending/failed.

  private dateToInputValue(raw: any): string {
    if (!raw) return '';
    try {
      const d = raw?.toDate ? raw.toDate() : new Date(raw?.seconds ? raw.seconds * 1000 : raw);
      if (isNaN(d.getTime())) return '';
      return d.toISOString().slice(0, 10);
    } catch { return ''; }
  }

  openTransportModal(): void {
    const invoice = this.selectedInvoice();
    if (!invoice) return;
    this.transportForm.set({
      transportId: invoice.transportId || '',
      transport: invoice.transport || '',
      transportAddress: invoice.transportAddress || '',
      transportGstNo: invoice.transportGstNo || '',
      vehicleNo: invoice.vehicleNo || '',
      docNo: invoice.docNo || '',
      shipmentDate: this.dateToInputValue(invoice.shipmentDate),
      totalPkgs: invoice.totalPkgs || 1,
      agentName: invoice.agentName || '',
      destination: invoice.destination || '',
    });
    this.showTransportModal.set(true);
  }

  closeTransportModal(): void {
    this.showTransportModal.set(false);
  }

  // Applies the selected Transport Master record's Name/Address/GST No —
  // mirrors PackingListComponent.onTransportSelected so behavior matches the
  // rest of the app. An empty selection just clears back to free text.
  onTransportSelected(transportId: string): void {
    const selected = this.transports().find((t) => t.id === transportId);
    this.transportForm.update((f) => ({
      ...f,
      transportId: selected?.id ?? '',
      transport: selected?.transportName ?? f.transport,
      transportAddress: selected?.transportAddress ?? '',
      transportGstNo: selected?.gstNo ?? '',
    }));
  }

  updateTransportField<K extends keyof TransportDetailsForm>(field: K, value: TransportDetailsForm[K]): void {
    this.transportForm.update((f) => ({ ...f, [field]: value }));
  }

  async saveTransportDetails(): Promise<void> {
    const invoice = this.selectedInvoice();
    if (!invoice?.id) return;
    const form = this.transportForm();

    this.isSavingTransport.set(true);
    try {
      const updates: Partial<Invoice> = {
        transport: form.transport.trim(),
        transportId: form.transportId || undefined,
        transportAddress: form.transportAddress.trim() || undefined,
        transportGstNo: form.transportGstNo.trim() || undefined,
        vehicleNo: form.vehicleNo.trim(),
        docNo: form.docNo.trim(),
        shipmentDate: form.shipmentDate ? new Date(form.shipmentDate) : null,
        totalPkgs: Number(form.totalPkgs) || 0,
        agentName: form.agentName.trim(),
        destination: form.destination.trim(),
      };
      await this.loadingService.run(() => this.invoiceService.updateInvoice(invoice.id!, updates));
      const updated: Invoice = { ...invoice, ...updates };
      this.selectedInvoice.set(updated);
      this.invoices.update((list) => list.map((i) => (i.id === invoice.id ? updated : i)));
      this.showTransportModal.set(false);
      Swal.fire({ title: 'Saved', text: 'Transport details updated.', icon: 'success', timer: 1500, showConfirmButton: false });
    } catch (err: any) {
      Swal.fire('Error', err?.message || 'Failed to save transport details.', 'error');
    } finally {
      this.isSavingTransport.set(false);
    }
  }

  // ─── LR (Lorry Receipt) Mapping ────────────────────────────────────────────
  // Maps this invoice to one of the LR Entries captured at DC-dispatch time
  // (see PackingListComponent.generateAndPrintDC). At most one LR per
  // invoice; a single LR can be mapped to several invoices (see LrEntry doc
  // comment) — so re-picking a different LR here just moves this one invoice
  // across, it never touches other invoices already on either LR.

  openLrModal(): void {
    this.showLrModal.set(true);
  }

  closeLrModal(): void {
    this.showLrModal.set(false);
  }

  async mapLrEntry(lrEntry: LrEntry): Promise<void> {
    const invoice = this.selectedInvoice();
    if (!invoice?.id || !lrEntry.id || this.isMappingLr()) return;

    this.isMappingLr.set(true);
    try {
      await this.lrEntryService.mapInvoiceToLrEntry(
        { id: invoice.id, invoiceNo: invoice.invoiceNo, transport: invoice.transport, lrEntryId: invoice.lrEntryId },
        lrEntry
      );
      const updated: Invoice = { ...invoice, lrEntryId: lrEntry.id, lrNo: lrEntry.lrNo, lrDate: lrEntry.lrDate };
      this.selectedInvoice.set(updated);
      this.invoices.update((list) => list.map((i) => (i.id === invoice.id ? updated : i)));
      this.showLrModal.set(false);
      Swal.fire({ title: 'Mapped', text: `Invoice mapped to LR ${lrEntry.lrNo}.`, icon: 'success', timer: 1500, showConfirmButton: false });
    } catch (err: any) {
      Swal.fire('Error', err?.message || 'Failed to map LR Entry.', 'error');
    } finally {
      this.isMappingLr.set(false);
    }
  }

  async unmapLrEntry(): Promise<void> {
    const invoice = this.selectedInvoice();
    if (!invoice?.id || !invoice.lrEntryId || this.isMappingLr()) return;

    const confirm = await Swal.fire({
      title: 'Unmap LR Entry?',
      html: `Remove the mapping to LR <strong>${invoice.lrNo}</strong> from this invoice?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Unmap',
      confirmButtonColor: '#e11d48',
    });
    if (!confirm.isConfirmed) return;

    this.isMappingLr.set(true);
    try {
      await this.lrEntryService.unmapInvoiceFromLrEntry({ id: invoice.id, invoiceNo: invoice.invoiceNo, lrEntryId: invoice.lrEntryId });
      const updated: Invoice = { ...invoice, lrEntryId: undefined, lrNo: undefined, lrDate: undefined };
      this.selectedInvoice.set(updated);
      this.invoices.update((list) => list.map((i) => (i.id === invoice.id ? updated : i)));
    } catch (err: any) {
      Swal.fire('Error', err?.message || 'Failed to unmap LR Entry.', 'error');
    } finally {
      this.isMappingLr.set(false);
    }
  }

  async viewPayload(): Promise<void> {
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
      const payload = await this.loadingService.run(() => this.einvoiceService.preparePayload(invoice!, settings));
      this.payloadJson.set(JSON.stringify(payload, null, 2));
      this.showPayloadModal.set(true);
    } catch (err: any) {
      Swal.fire('Error', err?.message || 'Could not prepare e-Invoice payload.', 'error');
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
    // Opened synchronously, before the logo fetch below, so browsers don't
    // treat the popup as unrequested and block it.
    const win = window.open('', '_blank', 'width=1100,height=860');
    if (!win) {
      Swal.fire({ icon: 'warning', title: 'Popup Blocked', text: 'Please allow popups for this site, then try again.' });
      return;
    }
    try {
      const [logoDataUri, printInvoice] = await Promise.all([
        fetchLogoDataUri(),
        this.invoiceService.backfillItemDesignInfoIfNeeded(invoice),
      ]);
      if (printInvoice !== invoice) {
        this.selectedInvoice.set(printInvoice);
        this.invoices.update((list) => list.map((i) => (i.id === invoice.id ? printInvoice : i)));
      }
      const html = this.buildInvoiceHtml(printInvoice, this.companySettings(), logoDataUri);
      win.document.write(html);
      win.document.close();
      setTimeout(() => win.print(), 700);
    } catch (err: any) {
      // A blank popup with no explanation is worse than a visible error —
      // this is the same window already opened above, not a new one.
      win.document.write(`<pre style="padding:20px;color:#b91c1c;font-family:monospace;white-space:pre-wrap">Failed to render the invoice print.\n\n${err?.message || err}</pre>`);
      win.document.close();
    }
  }

  // The NIC/IRP standard "e-Invoice" acknowledgement print (IRN/QR/Transaction
  // Details/Party Details/E-Way Bill sections) — a distinct document from the
  // commercial Tax Invoice above. Only meaningful once an IRN actually
  // exists: never shown for a pending/failed generation, so this print can
  // never claim success when generateEInvoiceIrn didn't succeed.
  async printEInvoicePdf(invoiceOverride?: Invoice): Promise<void> {
    const invoice = invoiceOverride ?? this.selectedInvoice();
    if (!invoice?.irn || invoice.eInvoiceStatus !== 'generated') {
      Swal.fire('Not Available', 'Generate the e-Invoice successfully first to print this document.', 'warning');
      return;
    }
    // Opened synchronously, before the logo fetch below, so browsers don't
    // treat the popup as an unrequested one and block it.
    const win = window.open('', '_blank', 'width=1000,height=900');
    if (!win) {
      Swal.fire({ icon: 'warning', title: 'Popup Blocked', text: 'Please allow popups for this site, then try again.' });
      return;
    }
    try {
      const logoDataUri = await fetchLogoDataUri();
      const html = this.buildEInvoiceDocumentHtml(invoice, this.companySettings(), logoDataUri);
      win.document.write(html);
      win.document.close();
    } catch (err: any) {
      // A blank popup with no explanation is worse than a visible error —
      // this is the same window already opened above, not a new one.
      win.document.write(`<pre style="padding:20px;color:#b91c1c;font-family:monospace;white-space:pre-wrap">Failed to render the e-Invoice print.\n\n${err?.message || err}</pre>`);
      win.document.close();
    }
  }

  async exportInvoiceTally(invoice: Invoice): Promise<void> {
    await exportInvoicesToTally([invoice], this.clientCodeByClientId(), `TallyInvoice_${invoice.invoiceNo}`);
  }

  async exportAllInvoicesTally(): Promise<void> {
    const eligible = this.invoices().filter((i) => i.eInvoiceStatus !== 'cancelled');
    if (!eligible.length) {
      Swal.fire('No Invoices', 'There are no eligible invoices to export.', 'info');
      return;
    }
    this.isExportingTally.set(true);
    try {
      await exportInvoicesToTally(eligible, this.clientCodeByClientId(), 'TallyInvoice_All');
    } finally {
      this.isExportingTally.set(false);
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

  // Webtel's GenIRN2 (GetQRImg:'1') returns SignedQRCode as raw base64 PNG
  // bytes, not a data: URI — functions/src/einvoice.ts passes it through
  // verbatim as signedQrCode. An <img src="{raw base64}"> can never render
  // (browsers require the data: scheme prefix), which is why the QR showed
  // as a broken image everywhere this field is used. Defensive on an
  // already-prefixed value in case that ever changes upstream.
  qrImageSrc(raw: string | undefined | null): string {
    if (!raw) return '';
    return raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
  }

  // ─── HTML Invoice Builder ──────────────────────────────────────────────────

  private buildInvoiceHtml(invoice: Invoice, company: CompanySettings | null, logoDataUri: string): string {
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
      td(i + 1) + td(item.description, 'text-align:left;font-weight:600') +
      td(item.styleNo || '-') + td(item.sleeveType || '-') + td(item.hsnSac) +
      td(item.discountPct) + td(item.taxRate) + td(item.mrp.toFixed(2)) + td(item.uom) +
      td(item.quantity) + td(item.price.toFixed(2), 'font-weight:700') +
      td(item.amount.toFixed(2), 'font-weight:700') + '</tr>'
    ).join('');

    const taxSummaryRows = invoice.taxSummary.map((t, i) =>
      '<tr>' +
      td(i + 1) + td(t.hsnSac) + td(t.taxableValue.toFixed(2), 'font-weight:700') +
      td(t.cgstRate) + td(t.cgstAmount.toFixed(2), 'font-weight:700') +
      td(t.sgstRate) + td(t.sgstAmount.toFixed(2), 'font-weight:700') +
      td(t.igstRate || '-') + td(t.igstAmount ? t.igstAmount.toFixed(2) : '-') + '</tr>'
    ).join('');

    const isEInvoice = invoice.eInvoiceStatus === 'generated' && !!invoice.irn;
    const hasEwb = !!invoice.ewbNo;

    const logoHtml = logoDataUri
      ? `<img src="${logoDataUri}" style="width:62px;height:62px;object-fit:contain;border-radius:4px;flex-shrink:0;margin-right:10px" alt="Logo">`
      : `<div style="width:62px;height:62px;border:1.5px solid #1e3a8a;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:900;color:#1e3a8a;text-align:center;flex-shrink:0;margin-right:10px;line-height:1.3">TMG<br>CLOTHINGS</div>`;

    // Bank details
    const hasBankDetails = co?.bankAccountName || co?.bankAccountNo || co?.bankIfscCode || co?.bankName;
    const bankSection = hasBankDetails
      ? `<div style="border:1px solid #ccc;padding:5px 8px;font-size:9px">
           <div style="font-weight:700;margin-bottom:3px">Company's Bank Details :</div>
           ${co?.bankAccountName ? `<div>Name of the Account : ${co.bankAccountName}</div>` : ''}
           ${co?.bankAccountNo ? `<div>A/C No : ${co.bankAccountNo}</div>` : ''}
           ${co?.bankIfscCode ? `<div>IFSC Code : ${co.bankIfscCode}</div>` : ''}
           ${co?.bankName ? `<div>Bank Name : ${co.bankName}</div>` : ''}
         </div>`
      : `<div style="border:1px solid #ccc;padding:5px 8px;font-size:9px">
           <div style="font-weight:700;margin-bottom:3px">Company's Bank Details :</div>
           <div>Name of the Account : TMG Clothings</div>
           <div>A/C No : 44358238258</div>
           <div>IFSC Code : SBIN0061170</div>
           <div>Bank Name : STATE BANK OF INDIA / Branch : Siruthozhil Branch, Kovilpatti</div>
         </div>`;

    const eInvoiceBadge = isEInvoice
      ? `<span style="display:inline-block;margin-left:8px;padding:1px 6px;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:3px;font-size:8px;font-weight:700;vertical-align:middle">✓ E-INVOICE</span>`
      : '';

    // IRN / Ack No / Eway Bill No — only meaningful once the e-Invoice is
    // actually generated; never shown for a pending/failed one.
    const irnBlock = isEInvoice
      ? `<div style="border:1px solid #ccc;padding:5px 8px;font-size:9px">
           <div>IRN : <span style="font-family:monospace;font-size:7px;word-break:break-all">${invoice.irn}</span></div>
           <div style="display:flex;gap:20px;margin-top:2px;flex-wrap:wrap">
             <div>Ack No. : ${invoice.ackNo || '-'}</div>
             ${hasEwb ? `<div>Eway Bill No. : ${invoice.ewbNo}</div>` : ''}
           </div>
         </div>`
      : '';

    // One copy (Original-For Buyer / Duplicate-For Transport / Triplicate-For
    // Assesee) — same content on every copy, only the label (and, on the QR,
    // nothing at all) changes. Renders as one `.page` div; buildInvoiceHtml
    // below concatenates all three into a single print job so window.print()
    // produces the standard 3-copy commercial invoice in one go.
    const buildCopy = (copyLabel: string): string => {
      const qrHtml = isEInvoice && invoice.signedQrCode
        ? `<img src="${this.qrImageSrc(invoice.signedQrCode)}" style="width:80px;height:80px;border:1px solid #ddd;border-radius:3px;margin-top:2px" alt="QR">`
        : '';

      return `<div class="page">

<div style="display:flex;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:6px">
  ${logoHtml}
  <div style="flex:1;text-align:center">
    <div style="font-size:22px;font-weight:900;letter-spacing:0.5px">${companyName}</div>
    <div style="font-size:9px;color:#333;margin-top:2px">${companyAddr1}${companyAddr2}${companyPlace}</div>
    <div style="font-size:9px;color:#333">Phone: ${companyPhone} | Email: ${companyEmail} | GSTIN: ${companyGstin}</div>
  </div>
  <div style="text-align:right;min-width:90px">
    <div style="font-size:8px;color:#666;margin-bottom:2px">${copyLabel}</div>
    ${qrHtml}
  </div>
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
    ${invoice.clientGstin ? `<div style="font-size:9px;margin-top:2px;font-weight:600">GSTIN: ${invoice.clientGstin}</div>` : ''}
  </div>
  <div style="min-width:215px;padding:4px 8px">
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:2px 4px;font-size:9px;color:#555;white-space:nowrap">Invoice No.</td><td style="padding:2px 4px;font-size:9px;font-weight:700">: ${invoice.invoiceNo}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Invoice Date</td><td style="padding:2px 4px;font-size:9px">: ${fmtDate(invoice.invoiceDate)}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">DC No.</td><td style="padding:2px 4px;font-size:9px;font-weight:700">: ${invoice.dcNo || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Order No.</td><td style="padding:2px 4px;font-size:9px;font-weight:600">: ${invoice.orderNo || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Destination</td><td style="padding:2px 4px;font-size:9px">: ${invoice.destination || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Transport</td><td style="padding:2px 4px;font-size:9px">: ${invoice.transport || '—'}</td></tr>
      ${invoice.transportGstNo ? `<tr><td style="padding:2px 4px;font-size:9px;color:#555">Transport GSTIN</td><td style="padding:2px 4px;font-size:9px">: ${invoice.transportGstNo}</td></tr>` : ''}
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Doc No.</td><td style="padding:2px 4px;font-size:9px">: ${invoice.docNo || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Shipment Date</td><td style="padding:2px 4px;font-size:9px">: ${invoice.shipmentDate ? fmtDate(invoice.shipmentDate) : '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Vehicle No.</td><td style="padding:2px 4px;font-size:9px">: ${invoice.vehicleNo || '—'}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Total Pkgs</td><td style="padding:2px 4px;font-size:9px;font-weight:700">: ${invoice.totalPkgs}</td></tr>
      <tr><td style="padding:2px 4px;font-size:9px;color:#555">Agent</td><td style="padding:2px 4px;font-size:9px">: ${invoice.agentName || '—'}</td></tr>
    </table>
  </div>
</div>

<table style="margin-bottom:8px"><thead><tr>
  ${th('S.No')}${th('Description', 'text-align:left')}${th('Design No')}${th('Sleeve Type')}${th('HSN/SAC')}${th('Disc(%)')}${th('Tax(%)')}${th('MRP')}${th('UOM')}${th('Quantity')}${th('Price')}${th('Amount')}
</tr></thead><tbody>
  ${itemRows}
  <tr>
    <td colspan="11" style="padding:4px 6px;${B}font-weight:700;font-size:9px;text-align:right;background:#f0f0f0">Gross</td>
    <td style="padding:4px 6px;${B}font-weight:900;font-size:10px;text-align:center;background:#f0f0f0">${invoice.grossAmount.toFixed(2)}</td>
  </tr>
</tbody></table>

<div style="display:flex;gap:10px;margin-bottom:8px;align-items:flex-start">
  <div style="flex:1;display:flex;flex-direction:column;gap:8px">
    ${irnBlock}
    ${bankSection}
    <div style="border:1px solid #ccc;padding:5px 8px;font-size:9px">
      <strong>Rupees :</strong> ${invoice.amountInWords}
    </div>
  </div>
  <table style="width:280px;border-collapse:collapse;flex-shrink:0">
    ${invoice.discountAmount > 0 ? `<tr><td style="padding:3px 8px;font-size:9px;border:1px solid #ddd">Discount (${invoice.discountPct}%)</td><td style="padding:3px 8px;font-size:9px;font-weight:700;text-align:right;border:1px solid #ddd">${invoice.discountAmount.toFixed(2)}</td></tr>` : ''}
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

<table style="margin-bottom:8px"><thead><tr>
  ${th('S.No')}${th('HSN/SAC')}${th('Taxable Value')}${th('CGST %')}${th('CGST Amt')}${th('SGST %')}${th('SGST Amt')}${th('IGST %')}${th('IGST Amt')}
</tr></thead><tbody>
  ${taxSummaryRows}
  <tr style="background:#f0f0f0">
    ${td('')}${td('Total', 'font-weight:700')}${td(invoice.taxableValue.toFixed(2), 'font-weight:700')}${td('')}${td(invoice.cgstAmount.toFixed(2), 'font-weight:700')}${td('')}${td(invoice.sgstAmount.toFixed(2), 'font-weight:700')}${td('')}${td(invoice.igstAmount ? invoice.igstAmount.toFixed(2) : '-')}
  </tr>
</tbody></table>

<div style="font-size:8px;border:1px solid #ccc;padding:4px 8px;margin-bottom:8px">
  Amount of Tax (in words) : ${this.amountToWords(invoice.totalTaxAmount)}
</div>

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

</div>`;
    };

    const pages = ['Original-For Buyer', 'Duplicate-For Transport', 'Triplicate-For Assesee']
      .map(buildCopy)
      .join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice - ${invoice.invoiceNo}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;font-size:10px;color:#000}
  table{width:100%;border-collapse:collapse}
  .page{padding:10px 14px}
  @media print{
    @page{size:A4;margin:10mm}
    .page{page-break-after:always}
    .page:last-child{page-break-after:auto}
  }
</style>
</head><body>${pages}</body></html>`;
  }

  // ─── E-Invoice (NIC/IRP) Document Builder ──────────────────────────────────
  // Renders the standard NIC e-Invoice acknowledgement print — IRN/QR,
  // Transaction Details, Party Details, Goods/Services + GST summary, and
  // E-Way Bill Details — sourced entirely from invoice.eInvoicePayload (the
  // exact payload that was validated and sent to generateEInvoiceIrn) plus
  // the top-level irn/ackNo/ackDt/signedQrCode/ewb* fields returned by that
  // call. Never recomputes tax values — this document must always agree
  // with what was actually submitted and acknowledged.

  private stateNameFromCode(code: string | undefined): string {
    if (!code) return '-';
    return INDIA_STATE_CODES.find((s) => s.code === code)?.name.toUpperCase() || code;
  }

  private buildEInvoiceDocumentHtml(invoice: Invoice, company: CompanySettings | null, logoDataUri: string): string {
    const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const payload = (invoice.eInvoicePayload || {}) as {
      TranDtls?: { SupTyp?: string; IgstOnIntra?: string };
      DocDtls?: { Typ?: string; No?: string; Dt?: string };
      SellerDtls?: { Gstin?: string; LglNm?: string; TrdNm?: string; Addr1?: string; Addr2?: string; Loc?: string; Pin?: number; Ph?: string; Em?: string };
      BuyerDtls?: { Gstin?: string; LglNm?: string; Addr1?: string; Addr2?: string; Loc?: string; Pin?: number; Stcd?: string; Pos?: string; Ph?: string };
      ItemList?: Array<{
        SlNo: string; PrdDesc?: string; HsnCd: string; Qty?: number; Unit?: string; UnitPrice: number;
        Discount?: number; AssAmt: number; GstRt: number; CesRt?: number; StateCesRt?: number; StateCesNonAdvlAmt?: number;
        OthChrg?: number; TotItemVal: number;
      }>;
      ValDtls?: { AssVal: number; CgstVal: number; SgstVal: number; IgstVal: number; CesVal?: number; StCesVal?: number; Discount?: number; OthChrg?: number; RndOffAmt?: number; TotInvVal: number };
    };

    const B = 'border:1px solid #999;';
    const th = (txt: string, extra = '') =>
      `<th style="padding:5px 6px;${B}background:#e8e8e8;font-size:9px;font-weight:700;text-align:center;${extra}">${txt}</th>`;
    const td = (txt: string | number, extra = '') =>
      `<td style="padding:4px 6px;${B}font-size:9px;text-align:center;${extra}">${txt}</td>`;
    const row = (label: string, value: string) =>
      `<tr><td style="padding:2px 6px;font-size:9px;color:#555;white-space:nowrap;width:40%">${label}</td><td style="padding:2px 6px;font-size:9px;font-weight:600">: ${value}</td></tr>`;

    const now = new Date();
    const printDate = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()} `
      + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const logoHtml = logoDataUri
      ? `<img src="${logoDataUri}" style="width:64px;height:64px;object-fit:contain;border-radius:6px;flex-shrink:0;margin-right:10px" alt="Logo">`
      : `<div style="width:64px;height:64px;border:1.5px solid #1e3a8a;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:900;color:#1e3a8a;text-align:center;flex-shrink:0;margin-right:10px;line-height:1.3">TMG<br>CLOTHINGS</div>`;

    const qrHtml = invoice.signedQrCode
      ? `<img src="${this.qrImageSrc(invoice.signedQrCode)}" style="width:90px;height:90px;border:1px solid #ddd;border-radius:3px" alt="E-Invoice QR">`
      : `<div style="width:90px;height:90px;border:1px dashed #ccc;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:8px;color:#999;text-align:center">QR not<br>available</div>`;

    const seller = payload.SellerDtls;
    const buyer = payload.BuyerDtls;
    const posName = this.stateNameFromCode(buyer?.Pos);
    const igstDespiteSameState = payload.TranDtls?.IgstOnIntra === 'Y' ? 'Yes' : 'No';

    const items = payload.ItemList || [];
    const itemRows = items.map((it, i) => {
      const taxRate = `${it.GstRt ?? 0}+${it.CesRt ?? 0}|${it.StateCesRt ?? 0}+${it.StateCesNonAdvlAmt ?? 0}`;
      return `<tr style="background:${i % 2 === 0 ? '#fff' : '#f8fafc'}">` +
        td(it.SlNo) + td(esc(it.PrdDesc), 'text-align:left;font-weight:600') + td(it.HsnCd) +
        td(it.Qty ?? '-') + td(it.Unit ?? '-') + td((it.UnitPrice ?? 0).toFixed(2), 'text-align:right') +
        td((it.Discount ?? 0).toFixed(2), 'text-align:right') + td(it.AssAmt.toFixed(2), 'text-align:right;font-weight:600') +
        td(taxRate) + td((it.OthChrg ?? 0).toFixed(2), 'text-align:right') +
        td(it.TotItemVal.toFixed(2), 'text-align:right;font-weight:700') + '</tr>';
    }).join('');

    const val = payload.ValDtls;
    const valSummaryHtml = val
      ? `<table style="margin-top:6px"><thead><tr>
           ${th('Taxable Amt')}${th('CGST Amt')}${th('SGST Amt')}${th('IGST Amt')}${th('CESS Amt')}${th('State CESS Amt')}${th('Discount')}${th('Other Charges')}${th('Round Off')}${th('Total Inv. Amt')}
         </tr></thead><tbody><tr style="background:#f0f0f0;font-weight:700">
           ${td(val.AssVal.toFixed(2))}${td(val.CgstVal.toFixed(2))}${td(val.SgstVal.toFixed(2))}${td(val.IgstVal.toFixed(2))}
           ${td((val.CesVal ?? 0).toFixed(2))}${td((val.StCesVal ?? 0).toFixed(2))}${td((val.Discount ?? 0).toFixed(2))}
           ${td((val.OthChrg ?? 0).toFixed(2))}${td((val.RndOffAmt ?? 0).toFixed(2))}${td(val.TotInvVal.toFixed(2))}
         </tr></tbody></table>`
      : '';

    const hasEwb = !!invoice.ewbNo;
    const ewbSection = hasEwb
      ? `<div style="margin-top:10px;border:1px solid #999;padding:8px">
           <div style="font-size:11px;font-weight:700;margin-bottom:6px">5. E-Waybill Details</div>
           <table>
             ${row('Eway Bill No', esc(invoice.ewbNo))}
             ${row('Eway Bill Date', esc(invoice.ewbDate || '-'))}
             ${row('Valid Till Date', esc(invoice.ewbValidTill || '-'))}
             ${row('Generated By', esc(seller?.Gstin || company?.gstin || '-'))}
             ${row('Print Date', printDate)}
           </table>
         </div>`
      : '';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>E-Invoice - ${esc(invoice.invoiceNo)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;font-size:10px;color:#000;padding:14px}
  table{width:100%;border-collapse:collapse}
  thead{display:table-header-group}
  tr{page-break-inside:avoid}
  section{page-break-inside:avoid}
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

<div style="display:flex;align-items:flex-start;border:2px solid #000;padding:8px;margin-bottom:8px">
  ${logoHtml}
  <div style="flex:1">
    <div style="font-size:14px;font-weight:900">${esc(seller?.Gstin || company?.gstin || '-')}</div>
    <div style="font-size:16px;font-weight:700">${esc(seller?.LglNm || company?.legalName || '-')}</div>
  </div>
  <div>${qrHtml}</div>
</div>

<section style="border:1px solid #999;padding:8px;margin-bottom:8px">
  <div style="font-size:11px;font-weight:700;margin-bottom:6px">1. e-Invoice Details</div>
  <table>
    ${row('IRN', `<span style="font-family:monospace;font-size:8px;word-break:break-all">${esc(invoice.irn)}</span>`)}
    ${row('Ack. No', esc(invoice.ackNo || '-'))}
    ${row('Ack. Date', esc(invoice.ackDt || '-'))}
  </table>
</section>

<section style="border:1px solid #999;padding:8px;margin-bottom:8px">
  <div style="font-size:11px;font-weight:700;margin-bottom:6px">2. Transaction Details</div>
  <div style="display:flex;gap:20px">
    <table>
      ${row('Supply Type Code', esc(payload.TranDtls?.SupTyp || '-'))}
      ${row('Document No', esc(payload.DocDtls?.No || invoice.invoiceNo))}
      ${row('Document Type', esc(payload.DocDtls?.Typ || 'INV'))}
      ${row('Document Date', esc(payload.DocDtls?.Dt || '-'))}
    </table>
    <table>
      ${row('Place of Supply', posName)}
      ${row('IGST applicable despite same State', igstDespiteSameState)}
    </table>
  </div>
</section>

<section style="border:1px solid #999;padding:8px;margin-bottom:8px">
  <div style="font-size:11px;font-weight:700;margin-bottom:6px">3. Party Details</div>
  <div style="display:flex;gap:14px">
    <div style="flex:1;border:1px solid #ddd;padding:6px">
      <div style="font-size:10px;font-weight:700;margin-bottom:4px">Supplier</div>
      <div style="font-size:9px">GSTIN : ${esc(seller?.Gstin || '-')}</div>
      <div style="font-size:9px;font-weight:700;margin-top:2px">${esc(seller?.TrdNm || seller?.LglNm || '-')}</div>
      <div style="font-size:9px;margin-top:2px">${esc(seller?.Addr1 || '-')}${seller?.Addr2 ? ', ' + esc(seller.Addr2) : ''}</div>
      <div style="font-size:9px">${esc(seller?.Loc || '-')} - ${esc(seller?.Pin || '-')}</div>
      ${seller?.Ph ? `<div style="font-size:9px">Phone: ${esc(seller.Ph)}</div>` : ''}
      ${seller?.Em ? `<div style="font-size:9px">${esc(seller.Em)}</div>` : ''}
    </div>
    <div style="flex:1;border:1px solid #ddd;padding:6px">
      <div style="font-size:10px;font-weight:700;margin-bottom:4px">Recipient</div>
      <div style="font-size:9px">GSTIN : ${esc(buyer?.Gstin || '-')}</div>
      <div style="font-size:9px;font-weight:700;margin-top:2px">${esc(buyer?.LglNm || '-')}</div>
      <div style="font-size:9px;margin-top:2px">${esc(buyer?.Addr1 || '-')}${buyer?.Addr2 ? ', ' + esc(buyer.Addr2) : ''}</div>
      <div style="font-size:9px">${esc(buyer?.Loc || '-')} - ${esc(buyer?.Pin || '-')}</div>
      <div style="font-size:9px">${this.stateNameFromCode(buyer?.Stcd)}</div>
      <div style="font-size:9px">Place of Supply : ${posName}</div>
      ${buyer?.Ph ? `<div style="font-size:9px">Phone: ${esc(buyer.Ph)}</div>` : ''}
    </div>
  </div>
</section>

<section style="margin-bottom:8px">
  <div style="font-size:11px;font-weight:700;margin-bottom:6px">4. Details of Goods / Services</div>
  <table><thead><tr>
    ${th('Sl.No')}${th('Item Description', 'text-align:left')}${th('HSN')}${th('Qty')}${th('Unit')}${th('Unit Price')}${th('Discount')}${th('Taxable Amt')}${th('Tax Rate (GST+Cess|St.Cess+CessNonAdvl)')}${th('Other Chrg')}${th('Total')}
  </tr></thead><tbody>
    ${itemRows}
  </tbody></table>
  ${valSummaryHtml}
</section>

${ewbSection}

<div style="margin-top:16px;font-size:8px;color:#888;text-align:center;border-top:1px solid #eee;padding-top:6px">
  Print Date : ${printDate}
</div>

</body></html>`;
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
