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
import { CompanySettings } from '../../models/einvoice.model';
import { InvoiceService } from '../../services/invoice.service';
import { EwayBillService } from '../../services/eway-bill.service';
import { CompanySettingsService } from '../../services/company-settings.service';
import { LoadingService } from '../../services/loading.service';

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
    this.generateForm.set({
      distance: 0,
      transMode: '1',
      transporterId: '',
      transporterName: '',
      vehicleNo: '',
      vehicleType: 'R',
      transDocNo: '',
      transDocDt: '',
    });
    this.showGenerateModal.set(true);
  }

  closeGenerateModal(): void {
    this.showGenerateModal.set(false);
  }

  updateGenerateField<K extends keyof EwayBillTransportDetails>(field: K, value: EwayBillTransportDetails[K]): void {
    this.generateForm.update((f) => ({ ...f, [field]: value }));
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
    if (!form.distance || form.distance <= 0) {
      Swal.fire('Required', 'Please enter the transport distance (in km).', 'warning');
      return;
    }
    if (form.transMode === '1' && !form.vehicleNo?.trim()) {
      Swal.fire('Required', 'Vehicle number is required when the transport mode is Road.', 'warning');
      return;
    }
    if (form.transMode !== '1' && (!form.transDocNo?.trim() || !form.transDocDt?.trim())) {
      Swal.fire('Required', 'Transport document number and date are required for Rail/Air/Ship.', 'warning');
      return;
    }

    this.isGenerating.set(true);
    try {
      await this.loadingService.run(async () => {
        const stateCode = this.extractStateCodeFromGstin(invoice.clientGstin) || settings.stateCode;
        const result = await this.ewayBillService.generateEWayBill(invoice, form, settings.gstin, {
          addr1: invoice.clientAddress,
          loc: invoice.clientPlace || invoice.destination,
          pin: parseInt(invoice.clientZipCode) || undefined,
          stcd: stateCode,
        });

        const updated: Invoice = {
          ...invoice,
          ewbStatus: 'generated',
          ewbNo: result.ewbNo,
          ewbDate: result.ewbDate,
          ewbValidTill: result.ewbValidTill,
          ewbTransportDetails: form,
          ewbErrorMessage: undefined,
          ewbErrorCode: undefined,
        };
        this.selectedInvoice.set(updated);
        this.allInvoices.update((list) => list.map((i) => (i.id === invoice.id ? updated : i)));
        this.showGenerateModal.set(false);

        await Swal.fire({
          title: 'E-Way Bill Generated!',
          html: `<b>E-Way Bill No.:</b><br><code style="font-size:14px;display:block;background:#f1f5f9;padding:8px;border-radius:6px;margin-top:4px">${result.ewbNo}</code><p style="margin-top:8px;font-size:12px;color:#64748b">Valid till ${result.ewbValidTill}</p>`,
          icon: 'success',
          confirmButtonColor: '#10b981',
        });
      });
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
}
