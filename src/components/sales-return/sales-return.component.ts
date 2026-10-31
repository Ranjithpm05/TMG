import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import Swal from 'sweetalert2';
import type { Invoice } from '../../models/invoice.model';
import type {
  DamageStockItem, ReturnCondition, SalesReturn, SalesReturnLine, SalesReturnMode, SalesReturnStatus,
} from '../../models/sales-return.model';
import { InvoiceService } from '../../services/invoice.service';
import { SalesReturnService, type InvoiceBill } from '../../services/sales-return.service';
import { SalesReturnEInvoiceService } from '../../services/sales-return-einvoice.service';
import { downloadSalesReturnPdf } from '../../services/sales-return-pdf.util';
import { CANCEL_REASONS } from '../../models/einvoice.model';
import { AuthService } from '../../services/auth.service';
import { LoadingService } from '../../services/loading.service';
import {
  BillRow, ReturnDraftInput, invoiceNotReturnableReason, lineLabel, makeLine, returnNetAmount, rowRef, summarizeLines, validateDraft,
} from '../../services/sales-return.engine';

type Tab = 'entry' | 'returns' | 'damage';
type Entry = { fresh: number; damage: number; location: string; remarks: string };
type ScanFeedback = { kind: 'idle' | 'ok' | 'error'; message: string };

const MAX_INVOICES_LISTED = 100;
const EMPTY_ENTRY: Entry = { fresh: 0, damage: 0, location: '', remarks: '' };

@Component({
  selector: 'app-sales-return',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './sales-return.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SalesReturnComponent implements OnInit {
  private salesReturnService = inject(SalesReturnService);
  private salesReturnEInvoiceService = inject(SalesReturnEInvoiceService);
  private invoiceService = inject(InvoiceService);
  private authService = inject(AuthService);
  private loadingService = inject(LoadingService);

  private readonly user = computed(() => this.authService.currentUser()?.username ?? '');

  tab = signal<Tab>('entry');

  // ── Invoices / customers ──────────────────────────────────────────────────
  invoicesLoading = signal(true);
  invoices = signal<Invoice[]>([]);

  readonly clients = computed(() => {
    const byId = new Map<string, { id: string; name: string; gstin: string; invoices: number }>();
    for (const inv of this.invoices()) {
      if (!inv.clientId) continue;
      const c = byId.get(inv.clientId) ?? { id: inv.clientId, name: inv.clientName, gstin: inv.clientGstin, invoices: 0 };
      c.invoices++;
      byId.set(inv.clientId, c);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  // ── Entry form ────────────────────────────────────────────────────────────
  mode = signal<SalesReturnMode>('single');
  inwardType = signal<ReturnCondition>('Fresh');
  clientId = signal('');
  returnDate = signal(this.today());
  defaultLocation = signal('');
  remarks = signal('');
  referenceNo = signal('');
  billSearch = signal('');
  selectedInvoiceIds = signal<string[]>([]);
  bills = signal<InvoiceBill[]>([]);
  billsLoading = signal(false);
  entries = signal<Record<string, Entry>>({});
  /** The Draft being edited (null = new entry). */
  editing = signal<SalesReturn | null>(null);
  private draftId = '';
  saving = signal(false);
  errors = signal<string[]>([]);
  scanValue = signal('');
  feedback = signal<ScanFeedback>({ kind: 'idle', message: 'Scan or type an item code to add one piece.' });

  readonly client = computed(() => this.clients().find((c) => c.id === this.clientId()) ?? null);

  readonly customerInvoices = computed(() => {
    const id = this.clientId();
    if (!id) return [];
    const term = this.billSearch().trim().toLowerCase();
    return this.invoices()
      .filter((inv) => inv.clientId === id)
      .filter((inv) => !term || inv.invoiceNo.toLowerCase().includes(term) || (inv.dcNo ?? '').toLowerCase().includes(term))
      .sort((a, b) => (this.toDate(b.invoiceDate)?.getTime() ?? 0) - (this.toDate(a.invoiceDate)?.getTime() ?? 0));
  });
  readonly listedInvoices = computed(() => this.customerInvoices().slice(0, MAX_INVOICES_LISTED));

  readonly rows = computed<BillRow[]>(() => this.bills().flatMap((b) => b.rows));
  private readonly rowsByRef = computed(() => new Map(this.rows().map((r) => [rowRef(r.invoiceId, r.lineKey), r])));
  private readonly invoiceById = computed(() => new Map(this.bills().map((b) => [b.invoice.id!, b.invoice])));

  readonly lines = computed<SalesReturnLine[]>(() => {
    const entries = this.entries();
    const invoices = this.invoiceById();
    const defaultLoc = this.defaultLocation();
    const lines: SalesReturnLine[] = [];
    for (const row of this.rows()) {
      const e = entries[rowRef(row.invoiceId, row.lineKey)];
      if (!e) continue;
      const rates = invoices.get(row.invoiceId)!;
      const location = e.location.trim() || defaultLoc;
      if (e.fresh > 0) lines.push(makeLine(row, rates, 'Fresh', e.fresh, location, e.remarks));
      if (e.damage > 0) lines.push(makeLine(row, rates, 'Damage', e.damage, location, e.remarks));
    }
    return lines;
  });

  readonly totals = computed(() => summarizeLines(this.lines()));

  // ── Returns list ──────────────────────────────────────────────────────────
  returnsLoading = signal(true);
  returns = signal<SalesReturn[]>([]);
  statusFilter = signal<'all' | SalesReturnStatus>('all');
  returnSearch = signal('');
  viewing = signal<SalesReturn | null>(null);

  readonly filteredReturns = computed(() => {
    const status = this.statusFilter();
    const term = this.returnSearch().trim().toLowerCase();
    return this.returns().filter((r) =>
      (status === 'all' || r.status === status) &&
      (!term || r.returnNo.toLowerCase().includes(term) || r.clientName.toLowerCase().includes(term) ||
        (r.invoiceNos ?? []).some((n) => n.toLowerCase().includes(term))));
  });

  readonly statusCounts = computed(() => {
    const counts: Record<'all' | SalesReturnStatus, number> = { all: 0, Draft: 0, Posted: 0, Cancelled: 0 };
    for (const r of this.returns()) { counts.all++; counts[r.status]++; }
    return counts;
  });

  // ── Damage stock ──────────────────────────────────────────────────────────
  damageLoading = signal(false);
  damageStock = signal<DamageStockItem[]>([]);
  damageSearch = signal('');
  readonly filteredDamage = computed(() => {
    const term = this.damageSearch().trim().toLowerCase();
    return this.damageStock().filter((d) => !term || d.barcode.toLowerCase().includes(term) ||
      d.styleNo.toLowerCase().includes(term) || d.color.toLowerCase().includes(term));
  });
  readonly damageTotal = computed(() => this.filteredDamage().reduce((s, d) => s + (Number(d.qty) || 0), 0));

  ngOnInit(): void {
    this.draftId = this.salesReturnService.newReturnId();
    void this.loadInvoices();
    this.loadReturns();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Loading
  // ═══════════════════════════════════════════════════════════════════════════
  private async loadInvoices(): Promise<void> {
    this.invoicesLoading.set(true);
    try {
      this.invoices.set(await firstValueFrom(this.invoiceService.getInvoices()));
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Cannot Load Invoices', text: err?.message ?? 'Failed to load invoices.' });
    } finally {
      this.invoicesLoading.set(false);
    }
  }

  private loadReturns(): void {
    this.returnsLoading.set(true);
    this.salesReturnService.getReturns().subscribe({
      next: (list) => { this.returns.set(list); this.returnsLoading.set(false); },
      error: () => this.returnsLoading.set(false),
    });
  }

  private reloadReturns(): void {
    this.salesReturnService.refreshReturns();
    this.loadReturns();
  }

  async refresh(): Promise<void> {
    await this.loadingService.run(async () => {
      this.invoiceService.invalidateCache();
      await this.loadInvoices();
      this.reloadReturns();
      if (this.selectedInvoiceIds().length) await this.loadBills();
      if (this.tab() === 'damage') await this.loadDamage();
    });
  }

  async loadDamage(): Promise<void> {
    this.damageLoading.set(true);
    try {
      this.damageStock.set(await this.salesReturnService.getDamageStock());
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Cannot Load Damage Stock', text: err?.message ?? 'Failed to load damage stock.' });
    } finally {
      this.damageLoading.set(false);
    }
  }

  setTab(tab: Tab): void {
    this.tab.set(tab);
    if (tab === 'damage') void this.loadDamage();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Entry: customer, mode, bills
  // ═══════════════════════════════════════════════════════════════════════════
  async selectClient(clientId: string, select?: HTMLSelectElement): Promise<void> {
    if (clientId === this.clientId()) return;
    if (this.lines().length && !(await this.confirmDiscard('Changing the customer clears the quantities entered.'))) {
      if (select) select.value = this.clientId(); // snap the dropdown back
      return;
    }
    this.clientId.set(clientId);
    this.billSearch.set('');
    this.selectedInvoiceIds.set([]);
    this.bills.set([]);
    this.entries.set({});
    this.errors.set([]);
  }

  async setMode(mode: SalesReturnMode): Promise<void> {
    if (mode === this.mode()) return;
    if (mode === 'single' && this.selectedInvoiceIds().length > 1) {
      if (!(await this.confirmDiscard('Single Bill Return keeps only the first selected bill.'))) return;
      this.selectedInvoiceIds.set(this.selectedInvoiceIds().slice(0, 1));
      this.mode.set(mode);
      await this.loadBills();
      return;
    }
    this.mode.set(mode);
  }

  isSelected(inv: Invoice): boolean {
    return this.selectedInvoiceIds().includes(inv.id!);
  }

  notReturnable(inv: Invoice): string | null {
    return invoiceNotReturnableReason(inv);
  }

  async toggleInvoice(inv: Invoice): Promise<void> {
    if (this.notReturnable(inv)) return;
    const selected = this.selectedInvoiceIds();
    let next: string[];
    if (this.isSelected(inv)) {
      const hasQty = this.lines().some((l) => l.invoiceId === inv.id);
      if (hasQty && !(await this.confirmDiscard(`Removing ${inv.invoiceNo} clears the quantities entered against it.`))) return;
      next = selected.filter((id) => id !== inv.id);
    } else if (this.mode() === 'single') {
      if (this.lines().length && !(await this.confirmDiscard('Single Bill Return — selecting another bill clears the quantities entered.'))) return;
      next = [inv.id!];
    } else {
      next = [...selected, inv.id!];
    }
    this.selectedInvoiceIds.set(next);
    await this.loadBills();
  }

  private async loadBills(): Promise<void> {
    const byId = new Map(this.invoices().map((inv) => [inv.id!, inv]));
    const invoices = this.selectedInvoiceIds().map((id) => byId.get(id) ?? this.bills().find((b) => b.invoice.id === id)?.invoice).filter((i): i is Invoice => !!i);
    this.billsLoading.set(true);
    try {
      const bills = await this.salesReturnService.loadBills(invoices);
      this.bills.set(bills);
      // Keep only entries whose bill line is still shown.
      const refs = new Set(bills.flatMap((b) => b.rows.map((r) => rowRef(r.invoiceId, r.lineKey))));
      this.entries.update((all) => Object.fromEntries(Object.entries(all).filter(([ref]) => refs.has(ref))));
      this.errors.set([]);
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Cannot Load Bill Items', text: err?.message ?? 'Failed to load the bill details.' });
    } finally {
      this.billsLoading.set(false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Entry: quantities
  // ═══════════════════════════════════════════════════════════════════════════
  entry(row: BillRow): Entry {
    return this.entries()[rowRef(row.invoiceId, row.lineKey)] ?? EMPTY_ENTRY;
  }

  /** Pieces of this bill line not yet entered in this return. */
  remaining(row: BillRow): number {
    const e = this.entry(row);
    return row.eligibleQty - e.fresh - e.damage;
  }

  isOver(row: BillRow): boolean {
    return this.remaining(row) < 0;
  }

  private patchEntry(row: BillRow, patch: Partial<Entry>): void {
    const ref = rowRef(row.invoiceId, row.lineKey);
    this.entries.update((all) => ({ ...all, [ref]: { ...(all[ref] ?? EMPTY_ENTRY), ...patch } }));
    this.errors.set([]);
  }

  setQty(row: BillRow, field: 'fresh' | 'damage', value: unknown): void {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    this.patchEntry(row, { [field]: n });
  }

  setText(row: BillRow, field: 'location' | 'remarks', value: string): void {
    this.patchEntry(row, { [field]: value ?? '' });
  }

  /** Adds every remaining piece of the row under the selected inward type (Fresh / Damage). */
  returnAll(row: BillRow): void {
    const left = this.remaining(row);
    if (left <= 0 || !row.inventoryId) return;
    const field = this.inwardType() === 'Damage' ? 'damage' : 'fresh';
    this.patchEntry(row, { [field]: this.entry(row)[field] + left });
  }

  returnAllOfBill(bill: InvoiceBill): void {
    for (const row of bill.rows) this.returnAll(row);
  }

  clearBill(bill: InvoiceBill): void {
    const refs = new Set(bill.rows.map((r) => rowRef(r.invoiceId, r.lineKey)));
    this.entries.update((all) => Object.fromEntries(Object.entries(all).filter(([ref]) => !refs.has(ref))));
  }

  billQty(bill: InvoiceBill): { sold: number; returned: number; eligible: number; entered: number } {
    const t = { sold: 0, returned: 0, eligible: 0, entered: 0 };
    for (const r of bill.rows) {
      const e = this.entry(r);
      t.sold += r.soldQty; t.returned += r.returnedQty; t.eligible += r.eligibleQty; t.entered += e.fresh + e.damage;
    }
    return t;
  }

  onScanKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.repeat) return;
    const input = event.target as HTMLInputElement;
    const code = String(input.value ?? '').trim().toUpperCase();
    input.value = '';
    this.scanValue.set('');
    if (!code) return;

    const matches = this.rows().filter((r) => (r.barcode ?? '').toUpperCase() === code);
    if (!matches.length) {
      this.feedback.set({ kind: 'error', message: `${code} is not on the selected bill(s).` });
      return;
    }
    const row = matches.find((r) => this.remaining(r) > 0);
    if (!row) {
      this.feedback.set({ kind: 'error', message: `${code}: all eligible pieces are already entered.` });
      return;
    }
    const field = this.inwardType() === 'Damage' ? 'damage' : 'fresh';
    this.patchEntry(row, { [field]: this.entry(row)[field] + 1 });
    this.feedback.set({ kind: 'ok', message: `+1 ${this.inwardType()} · ${row.invoiceNo} · ${lineLabel(row)} (${this.remaining(row)} left)` });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Save / post
  // ═══════════════════════════════════════════════════════════════════════════
  private draftInput(): ReturnDraftInput {
    const c = this.client();
    return {
      mode: this.mode(),
      returnDate: this.returnDate(),
      clientId: this.clientId(),
      clientName: c?.name ?? '',
      ...(c?.gstin ? { clientGstin: c.gstin } : {}),
      remarks: this.remarks(),
      referenceNo: this.referenceNo(),
      lines: this.lines(),
    };
  }

  private validate(): ReturnDraftInput | null {
    const input = this.draftInput();
    const errors = validateDraft(input, this.rowsByRef());
    this.errors.set(errors);
    if (errors.length) {
      Swal.fire({ icon: 'warning', title: 'Please check the return', html: this.errorHtml(errors) });
      return null;
    }
    return input;
  }

  async saveDraft(): Promise<void> {
    if (this.saving()) return;
    const input = this.validate();
    if (!input) return;
    this.saving.set(true);
    try {
      const res = await this.loadingService.run(() => this.salesReturnService.saveDraft(this.draftId, input, this.user()));
      this.editing.set({ ...(this.editing() ?? {}), id: res.id, returnNo: res.returnNo, status: 'Draft' } as SalesReturn);
      this.reloadReturns();
      Swal.fire({
        icon: 'success', title: res.created ? 'Draft Saved' : 'Draft Updated',
        text: `${res.returnNo} — stock is not changed until the return is posted.`, timer: 2200, showConfirmButton: false,
      });
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Save Failed', html: this.errorHtml(this.messageLines(err)) });
    } finally {
      this.saving.set(false);
    }
  }

  async saveAndPost(): Promise<void> {
    if (this.saving()) return;
    const input = this.validate();
    if (!input) return;
    const t = this.totals();
    const r = await Swal.fire({
      icon: 'question',
      title: 'Post this sales return?',
      html: `<p><b>${this.escape(input.clientName)}</b> · ${this.lines().length} line(s) from ${new Set(this.lines().map((l) => l.invoiceId)).size} bill(s)</p>` +
        `<p class="mt-2"><b class="text-emerald-700">${t.freshQty} Fresh</b> pcs back into inventory · <b class="text-rose-700">${t.damageQty} Damage</b> pcs to damage stock</p>` +
        `<p class="mt-1">Return value ₹${returnNetAmount(t).toFixed(2)}</p>` +
        `<p class="mt-3 text-sm text-gray-500">Stock is updated now. A posted return can only be reversed by cancelling it.</p>`,
      showCancelButton: true,
      confirmButtonText: 'Post Return',
      confirmButtonColor: '#059669',
    });
    if (!r.isConfirmed) return;

    this.saving.set(true);
    let returnNo = '';
    try {
      await this.loadingService.run(async () => {
        returnNo = (await this.salesReturnService.saveDraft(this.draftId, input, this.user())).returnNo;
        await this.salesReturnService.postReturn(this.draftId, this.user());
      });
      this.reloadReturns();
      await Swal.fire({ icon: 'success', title: 'Sales Return Posted', text: `${returnNo} posted — stock updated.` });
      this.resetForm();
      this.tab.set('returns');
    } catch (err: any) {
      const lines = this.messageLines(err);
      if (returnNo) {
        // The draft save succeeded; the post transaction changed nothing.
        this.editing.set({ ...(this.editing() ?? {}), id: this.draftId, returnNo, status: 'Draft' } as SalesReturn);
        lines.push(`${returnNo} is saved as a Draft — no stock was changed.`);
        this.reloadReturns();
        if (this.selectedInvoiceIds().length) await this.loadBills();
      }
      Swal.fire({ icon: 'error', title: 'Post Failed', html: this.errorHtml(lines) });
    } finally {
      this.saving.set(false);
    }
  }

  async discardEntry(): Promise<void> {
    if ((this.lines().length || this.selectedInvoiceIds().length) && !(await this.confirmDiscard('Unsaved changes in this entry are discarded.'))) return;
    this.resetForm();
  }

  private resetForm(): void {
    this.draftId = this.salesReturnService.newReturnId();
    this.editing.set(null);
    this.mode.set('single');
    this.inwardType.set('Fresh');
    this.clientId.set('');
    this.returnDate.set(this.today());
    this.defaultLocation.set('');
    this.remarks.set('');
    this.referenceNo.set('');
    this.billSearch.set('');
    this.selectedInvoiceIds.set([]);
    this.bills.set([]);
    this.entries.set({});
    this.errors.set([]);
    this.feedback.set({ kind: 'idle', message: 'Scan or type an item code to add one piece.' });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Returns list actions
  // ═══════════════════════════════════════════════════════════════════════════
  async view(ret: SalesReturn): Promise<void> {
    this.viewing.set(ret);
    const fresh = await this.salesReturnService.getReturnOnce(ret.id!).catch(() => null);
    if (fresh && this.viewing()?.id === ret.id) this.viewing.set(fresh);
  }

  async editDraft(ret: SalesReturn): Promise<void> {
    if (this.tab() === 'entry' && this.lines().length && this.editing()?.id !== ret.id &&
        !(await this.confirmDiscard('The entry you are working on is discarded.'))) return;
    const latest = await this.loadingService.run(() => this.salesReturnService.getReturnOnce(ret.id!));
    if (!latest || latest.status !== 'Draft') {
      Swal.fire({ icon: 'info', title: 'Not Editable', text: `${ret.returnNo} is ${latest?.status ?? 'missing'} — only a Draft can be edited.` });
      this.reloadReturns();
      return;
    }
    this.resetForm();
    this.draftId = latest.id!;
    this.editing.set(latest);
    this.mode.set(latest.mode);
    this.clientId.set(latest.clientId);
    this.returnDate.set(latest.returnDate);
    this.remarks.set(latest.remarks ?? '');
    this.referenceNo.set(latest.referenceNo ?? '');
    this.selectedInvoiceIds.set(latest.invoiceIds ?? []);
    this.viewing.set(null);
    this.tab.set('entry');
    await this.loadingService.run(() => this.loadBills());
    const entries: Record<string, Entry> = {};
    for (const l of latest.lines ?? []) {
      const ref = rowRef(l.invoiceId, l.lineKey);
      const e = entries[ref] ?? { ...EMPTY_ENTRY, location: l.location ?? '', remarks: l.remarks ?? '' };
      if (l.condition === 'Damage') e.damage += l.qty; else e.fresh += l.qty;
      entries[ref] = e;
    }
    this.entries.set(entries);
  }

  async postDraft(ret: SalesReturn): Promise<void> {
    const r = await Swal.fire({
      icon: 'question',
      title: `Post ${ret.returnNo}?`,
      html: `<p>${ret.totals?.freshQty ?? 0} Fresh pcs back into inventory · ${ret.totals?.damageQty ?? 0} Damage pcs to damage stock.</p>` +
        `<p class="mt-2 text-sm text-gray-500">Quantities are re-checked against the original bills before stock is updated.</p>`,
      showCancelButton: true,
      confirmButtonText: 'Post Return',
      confirmButtonColor: '#059669',
    });
    if (!r.isConfirmed) return;
    try {
      const outcome = await this.loadingService.run(() => this.salesReturnService.postReturn(ret.id!, this.user()));
      this.reloadReturns();
      this.refreshViewing(ret.id!);
      Swal.fire({ icon: 'success', title: outcome === 'posted' ? 'Posted' : 'Already Posted', text: `${ret.returnNo} — stock updated.`, timer: 2000, showConfirmButton: false });
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Post Failed', html: this.errorHtml([...this.messageLines(err), 'No stock was changed.']) });
    }
  }

  async cancelEntry(ret: SalesReturn): Promise<void> {
    const posted = ret.status === 'Posted';
    const r = await Swal.fire({
      icon: 'warning',
      title: `Cancel ${ret.returnNo}?`,
      html: posted
        ? `<p>Stock is reversed: ${ret.totals?.freshQty ?? 0} Fresh pcs come out of inventory and ${ret.totals?.damageQty ?? 0} Damage pcs out of damage stock. The bill quantities become returnable again.</p>`
        : '<p>This draft is closed. Stock is not affected.</p>',
      input: 'text',
      inputPlaceholder: posted ? 'Reason for cancelling (required)' : 'Reason (optional)',
      inputValidator: (value) => (posted && !String(value ?? '').trim() ? 'Enter a reason.' : null),
      showCancelButton: true,
      confirmButtonText: 'Cancel Return',
      cancelButtonText: 'Keep',
      confirmButtonColor: '#e11d48',
    });
    if (!r.isConfirmed) return;
    try {
      await this.loadingService.run(() => this.salesReturnService.cancelReturn(ret.id!, this.user(), String(r.value ?? '')));
      this.reloadReturns();
      this.refreshViewing(ret.id!);
      if (this.editing()?.id === ret.id) this.resetForm();
      Swal.fire({ icon: 'success', title: 'Cancelled', text: posted ? 'Stock reversed.' : undefined, timer: 1800, showConfirmButton: false });
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Cannot Cancel', html: this.errorHtml(this.messageLines(err)) });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PDF / Credit Note e-Invoice
  // ═══════════════════════════════════════════════════════════════════════════
  readonly netAmount = returnNetAmount;
  /** Return id whose PDF / e-Invoice call is in flight — blocks a second click. */
  busyId = signal<string | null>(null);

  async downloadPdf(ret: SalesReturn, mode: 'download' | 'print' = 'download'): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(ret.id!);
    try {
      await this.loadingService.run(async () => {
        const latest = (await this.salesReturnService.getReturnOnce(ret.id!)) ?? ret;
        const ctx = await this.salesReturnEInvoiceService.loadContext(latest);
        await downloadSalesReturnPdf(latest, ctx.creditNote, ctx.invoices, ctx.company, mode);
      });
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: mode === 'print' ? 'Print Failed' : 'PDF Failed', text: err?.message ?? 'Could not build the Sales Return PDF.' });
    } finally {
      this.busyId.set(null);
    }
  }

  async generateCreditNote(ret: SalesReturn): Promise<void> {
    if (this.busyId()) return;
    const r = await Swal.fire({
      icon: 'question',
      title: `Generate Credit Note e-Invoice for ${ret.returnNo}?`,
      html: `<p>Registers <b>${this.escape(ret.returnNo)}</b> with the GST portal (IRP) as a Credit Note against ` +
        `<b>${this.escape((ret.invoiceNos ?? []).join(', '))}</b> for ₹${returnNetAmount(ret.totals).toFixed(2)}.</p>` +
        `<p class="mt-2 text-sm text-gray-500">Once generated it can only be cancelled within 24 hours, and the same return number cannot be registered again.</p>`,
      showCancelButton: true,
      confirmButtonText: 'Generate',
      confirmButtonColor: '#4f46e5',
    });
    if (!r.isConfirmed) return;
    this.busyId.set(ret.id!);
    let generated: SalesReturn | null = null;
    let error = '';
    try {
      generated = await this.loadingService.run(() => this.salesReturnEInvoiceService.generate(ret.id!));
    } catch (err: any) {
      error = err?.message ?? 'Could not generate the Credit Note e-Invoice.';
    } finally {
      this.busyId.set(null);
      this.reloadReturns();
      this.refreshViewing(ret.id!);
    }
    // Dialogs open only after loadingService.run() has finished — its overlay sits above Swal.
    if (generated) {
      Swal.fire({ icon: 'success', title: 'Credit Note e-Invoice Generated', html: `IRN <code class="break-all text-xs">${this.escape(generated.irn ?? '')}</code><br>Ack No. ${this.escape(generated.ackNo ?? '')}` });
    } else {
      Swal.fire({ icon: 'error', title: 'e-Invoice Failed', html: this.errorHtml(error.split('\n').filter(Boolean)) });
    }
  }

  async cancelCreditNote(ret: SalesReturn): Promise<void> {
    if (this.busyId()) return;
    const r = await Swal.fire({
      icon: 'warning',
      title: `Cancel Credit Note e-Invoice of ${ret.returnNo}?`,
      html: '<p>The IRN is cancelled on the GST portal (allowed only within 24 hours of generation). Stock is not affected — cancel the return separately if needed.</p>',
      input: 'select',
      inputOptions: Object.fromEntries(CANCEL_REASONS.map((reason) => [reason, reason])),
      inputPlaceholder: 'Select a reason',
      inputValidator: (value) => (value ? null : 'Select a reason.'),
      showCancelButton: true,
      confirmButtonText: 'Cancel e-Invoice',
      cancelButtonText: 'Keep',
      confirmButtonColor: '#e11d48',
    });
    if (!r.isConfirmed) return;
    this.busyId.set(ret.id!);
    let error = '';
    try {
      await this.loadingService.run(() => this.salesReturnEInvoiceService.cancel(ret, String(r.value)));
    } catch (err: any) {
      error = err?.message ?? 'Could not cancel the Credit Note e-Invoice.';
    } finally {
      this.busyId.set(null);
      this.reloadReturns();
      this.refreshViewing(ret.id!);
    }
    if (error) Swal.fire({ icon: 'error', title: 'Cancel Failed', text: error });
    else Swal.fire({ icon: 'success', title: 'e-Invoice Cancelled', timer: 1800, showConfirmButton: false });
  }

  private refreshViewing(id: string): void {
    if (this.viewing()?.id === id) void this.view(this.viewing()!);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════
  locations(item: DamageStockItem): { name: string; qty: number }[] {
    return Object.entries(item.byLocation ?? {}).map(([name, qty]) => ({ name, qty: Number(qty) || 0 }));
  }

  private async confirmDiscard(text: string): Promise<boolean> {
    const r = await Swal.fire({ icon: 'warning', title: 'Discard changes?', text, showCancelButton: true, confirmButtonText: 'Continue', confirmButtonColor: '#4f46e5' });
    return r.isConfirmed;
  }

  private messageLines(err: any): string[] {
    return String(err?.message ?? 'Something went wrong.').split('\n').filter(Boolean);
  }

  private errorHtml(lines: string[]): string {
    const shown = lines.slice(0, 12);
    const more = lines.length - shown.length;
    return `<ul class="text-left text-sm space-y-1">${shown.map((l) => `<li>• ${this.escape(l)}</li>`).join('')}</ul>` +
      (more > 0 ? `<p class="mt-2 text-xs text-gray-500">…and ${more} more.</p>` : '');
  }

  toDate(raw: any): Date | null {
    if (!raw) return null;
    try {
      const date = raw?.toDate ? raw.toDate() : new Date(raw?.seconds ? raw.seconds * 1000 : raw);
      return Number.isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }

  private today(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private escape(text: string): string {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }
}
