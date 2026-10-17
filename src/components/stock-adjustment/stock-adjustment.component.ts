import {
  Component, ChangeDetectionStrategy, signal, inject, OnInit, OnDestroy, computed, ViewChild, ElementRef, HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import Swal from 'sweetalert2';
import { InventoryItem } from '../../models/inventory.model';
import { ScanStatus, StockAdjustmentLine, StockAdjustmentSession } from '../../models/stock-adjustment.model';
import { InventoryService } from '../../services/inventory.service';
import { StockAdjustmentService } from '../../services/stock-adjustment.service';
import { AuthService } from '../../services/auth.service';
import { LoadingService } from '../../services/loading.service';
import {
  GroupRow, ScanLedger, classifyScan, indexByBarcode, normalizeGroup, rowFor, sameGroup, summarize,
} from '../../services/stock-adjustment.engine';
import { exportRowsToExcel, printReportRows, type ExportRowOpts } from '../reports/report-export.util';

type Mode = 'setup' | 'count' | 'history';
type RowFilter = 'all' | ScanStatus | 'variance';
type ScanFeedback = { kind: 'idle' | 'ok' | 'error'; message: string };
type RecentScan = { at: number; code: string; ok: boolean; message: string };

const PAGE_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;
const EXPORT_ROW_OPTS: ExportRowOpts = { isGrandTotalRow: (row) => row[0] === 'Grand Total' };

const STATUS_LABEL: Record<ScanStatus, string> = {
  'scanned': 'Scanned',
  'zero-confirmed': 'Confirmed Zero',
  'pending': 'Not Scanned',
  'no-stock': 'No Stock',
};

@Component({
  selector: 'app-stock-adjustment',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './stock-adjustment.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StockAdjustmentComponent implements OnInit, OnDestroy {
  private adjustmentService = inject(StockAdjustmentService);
  private inventoryService = inject(InventoryService);
  private authService = inject(AuthService);
  private loadingService = inject(LoadingService);

  @ViewChild('scanInput') scanInput?: ElementRef<HTMLInputElement>;

  readonly statusLabel = STATUS_LABEL;
  readonly pageSize = PAGE_SIZE;

  mode = signal<Mode>('setup');
  inventoryLoading = signal(true);
  sessionsLoading = signal(true);
  inventory = signal<InventoryItem[]>([]);
  sessions = signal<StockAdjustmentSession[]>([]);

  private readonly user = computed(() => this.authService.currentUser()?.username ?? '');
  readonly isSuperAdmin = computed(() => this.authService.currentUserGroup()?.isSuperAdmin === true);

  // ── Group selection ───────────────────────────────────────────────────────
  selectedGroup = signal('');

  readonly groups = computed(() => {
    const byName = new Map<string, { name: string; products: number; stock: number; withStock: number }>();
    for (const item of this.inventory()) {
      const name = normalizeGroup(item.group);
      if (!name) continue;
      const key = name.toUpperCase();
      const g = byName.get(key) ?? { name, products: 0, stock: 0, withStock: 0 };
      const stock = Number(item.currentStock) || 0;
      g.products++;
      g.stock += stock;
      if (stock !== 0) g.withStock++;
      byName.set(key, g);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  /** 'new' = group picker, 'history' = past adjustments (setup mode only). */
  setupTab = signal<'new' | 'history'>('new');

  activeSessionFor(group: string): StockAdjustmentSession | null {
    return this.activeSessions().find((s) => sameGroup(s.group, group)) ?? null;
  }

  readonly activeSessions = computed(() =>
    this.sessions().filter((s) => s.status === 'Counting' || s.status === 'Completing'));

  readonly activeSessionForSelectedGroup = computed(() =>
    this.activeSessions().find((s) => sameGroup(s.group, this.selectedGroup())) ?? null);

  // ── Active session ────────────────────────────────────────────────────────
  session = signal<StockAdjustmentSession | null>(null);
  private ledger = new ScanLedger();
  private ledgerVersion = signal(0);
  zeroConfirmed = signal<Set<string>>(new Set());
  private knownLineIds = new Set<string>();
  unsavedCount = signal(0);
  syncError = signal('');
  private flushing: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  reviewing = signal(false);
  scanValue = signal('');
  feedback = signal<ScanFeedback>({ kind: 'idle', message: 'Ready — scan a barcode.' });
  recentScans = signal<RecentScan[]>([]);
  completing = signal<{ done: number; total: number } | null>(null);

  /** The group shown in the grid: the session's group while counting, else the dropdown selection. */
  readonly activeGroup = computed(() => this.session()?.group ?? this.selectedGroup());

  readonly groupItems = computed(() => {
    const group = this.activeGroup();
    return group ? this.inventory().filter((i) => sameGroup(i.group, group)) : [];
  });

  private readonly groupIndex = computed(() => indexByBarcode(this.groupItems()));
  private readonly allIndex = computed(() => indexByBarcode(this.inventory()));

  readonly rows = computed<GroupRow[]>(() => {
    this.ledgerVersion();
    const counting = !!this.session();
    const zero = this.zeroConfirmed();
    return this.groupItems().map((item) =>
      rowFor(item, counting ? { scannedQty: this.ledger.count(item.id!), zeroConfirmed: zero.has(item.id!) } : undefined));
  });

  readonly summary = computed(() => summarize(this.rows()));

  /** Counted share of the products that need counting (everything except untouched zero-stock products). */
  readonly progress = computed(() => {
    const s = this.summary();
    const counted = s.scanned + s.zeroConfirmed;
    const toCount = counted + s.pending;
    return { counted, toCount, percent: toCount ? Math.round((counted / toCount) * 100) : 100 };
  });

  readonly topVariances = computed(() =>
    this.rows()
      .filter((r) => r.variance)
      .sort((a, b) => Math.abs(b.variance!) - Math.abs(a.variance!))
      .slice(0, 6));

  /** 1 Select group · 2 Count · 3 Review · 4 Done */
  readonly step = computed(() => {
    if (this.mode() === 'history') return this.historySession()?.status === 'Completed' ? 4 : 1;
    if (this.mode() === 'count') return this.reviewing() || this.session()?.status === 'Completing' ? 3 : 2;
    return 1;
  });

  readonly steps = ['Select Group', 'Count', 'Review', 'Complete'];

  lastScan = signal<{ item: InventoryItem; count: number } | null>(null);

  rowFilter = signal<RowFilter>('all');
  rowSearch = signal('');
  page = signal(1);

  readonly filteredRows = computed(() => {
    const filter = this.rowFilter();
    const term = this.rowSearch().trim().toLowerCase();
    return this.rows().filter((r) => {
      if (filter === 'variance' ? !r.variance : filter !== 'all' && r.status !== filter) return false;
      if (!term) return true;
      const i = r.item;
      return i.barcode.toLowerCase().includes(term) || i.styleNo.toLowerCase().includes(term) ||
        (i.color ?? '').toLowerCase().includes(term) || (i.size ?? '').toLowerCase().includes(term);
    });
  });

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.filteredRows().length / PAGE_SIZE)));
  readonly pagedRows = computed(() => {
    const start = (Math.min(this.page(), this.totalPages()) - 1) * PAGE_SIZE;
    return this.filteredRows().slice(start, start + PAGE_SIZE);
  });

  // ── History ──────────────────────────────────────────────────────────────
  historySession = signal<StockAdjustmentSession | null>(null);
  historyLines = signal<StockAdjustmentLine[]>([]);
  historyFilter = signal<'all' | 'variance'>('variance');
  historyPage = signal(1);

  readonly filteredHistoryLines = computed(() =>
    this.historyLines()
      .filter((l) => this.historyFilter() === 'all' || this.historyVariance(l) !== 0)
      .sort((a, b) => a.styleNo.localeCompare(b.styleNo) || a.color.localeCompare(b.color) || a.size.localeCompare(b.size)));
  readonly historyTotalPages = computed(() => Math.max(1, Math.ceil(this.filteredHistoryLines().length / PAGE_SIZE)));
  readonly pagedHistoryLines = computed(() => {
    const start = (Math.min(this.historyPage(), this.historyTotalPages()) - 1) * PAGE_SIZE;
    return this.filteredHistoryLines().slice(start, start + PAGE_SIZE);
  });

  ngOnInit(): void {
    void this.loadInventory(false);
    this.loadSessions();
    this.flushTimer = setInterval(() => { if (this.ledger.hasPending) void this.flush(); }, FLUSH_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.ledger.hasPending) void this.flush();
  }

  @HostListener('window:beforeunload', ['$event'])
  warnUnsaved(event: BeforeUnloadEvent): void {
    if (this.ledger.unsavedCount > 0) {
      void this.flush();
      event.preventDefault();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Loading
  // ═══════════════════════════════════════════════════════════════════════════
  /** fresh = re-sync the inventory cache first (delta query: only docs changed since the last sync are read). */
  private async loadInventory(fresh: boolean): Promise<InventoryItem[]> {
    if (fresh) this.inventoryService.invalidateCache();
    this.inventoryLoading.set(true);
    try {
      const items = await firstValueFrom(this.inventoryService.getInventory());
      this.inventory.set(items);
      return items;
    } finally {
      this.inventoryLoading.set(false);
    }
  }

  private loadSessions(): void {
    this.sessionsLoading.set(true);
    this.adjustmentService.getSessions().subscribe({
      next: (list) => {
        this.sessions.set(list);
        this.sessionsLoading.set(false);
        const current = this.session();
        if (current) {
          const fresh = list.find((s) => s.id === current.id);
          if (fresh) this.session.set(fresh);
        }
      },
      error: () => this.sessionsLoading.set(false),
    });
  }

  private reloadSessions(): void {
    this.adjustmentService.refreshSessions();
    this.loadSessions();
  }

  async refreshStock(): Promise<void> {
    await this.loadingService.run(() => this.loadInventory(true));
  }

  selectGroup(group: string): void {
    this.selectedGroup.set(group);
    this.rowFilter.set('all');
    this.rowSearch.set('');
    this.page.set(1);
  }

  setFilter(filter: RowFilter): void { this.rowFilter.set(filter); this.page.set(1); }
  setSearch(term: string): void { this.rowSearch.set(term); this.page.set(1); }
  changePage(p: number): void { if (p >= 1 && p <= this.totalPages()) this.page.set(p); }

  // ═══════════════════════════════════════════════════════════════════════════
  // Start / continue / cancel
  // ═══════════════════════════════════════════════════════════════════════════
  async startAdjustment(): Promise<void> {
    const group = this.selectedGroup();
    if (!group) { Swal.fire({ icon: 'warning', title: 'Select a Product Group', text: 'Choose the product group to count first.' }); return; }

    const existing = this.activeSessionForSelectedGroup();
    if (existing) { await this.continueSession(existing); return; }

    const items = await this.loadingService.run(() => this.loadInventory(true));
    const groupItems = items.filter((i) => sameGroup(i.group, group));
    const s = summarize(groupItems.map((i) => rowFor(i, undefined)));
    const r = await Swal.fire({
      icon: 'question',
      title: 'Start stock adjustment?',
      html: `<p>Product group <b>${this.escape(group)}</b></p>` +
        `<p class="mt-2">${s.totalProducts} products · ${s.pending} with stock to scan · ${s.existingTotal} pcs in inventory</p>` +
        `<p class="mt-3 text-sm text-gray-500">Inventory is <b>not</b> changed while scanning — only when you complete the adjustment. ` +
        `Pause inward/packing for this group while counting for an accurate result.</p>`,
      showCancelButton: true,
      confirmButtonText: 'Start Counting',
      confirmButtonColor: '#4f46e5',
    });
    if (!r.isConfirmed) return;

    try {
      const { id } = await this.loadingService.run(() => this.adjustmentService.startSession(group, this.user(), groupItems));
      this.reloadSessions();
      const session = await this.waitForSession(id);
      await this.openSession(session, []);
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Cannot Start', text: err?.message ?? 'Failed to start the stock adjustment.' });
      this.reloadSessions();
    }
  }

  async continueSession(session: StockAdjustmentSession): Promise<void> {
    try {
      const lines = await this.loadingService.run(async () => {
        await this.loadInventory(true);
        return this.adjustmentService.getLines(session.id!);
      });
      await this.openSession(session, lines);
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Cannot Open', text: err?.message ?? 'Failed to load the counting session.' });
    }
  }

  private async openSession(session: StockAdjustmentSession, lines: StockAdjustmentLine[]): Promise<void> {
    this.session.set(session);
    this.selectedGroup.set(session.group);
    this.ledger = new ScanLedger();
    this.applyServerLines(lines);
    this.reviewing.set(false);
    this.rowFilter.set('all');
    this.rowSearch.set('');
    this.page.set(1);
    this.recentScans.set([]);
    this.lastScan.set(null);
    this.syncError.set('');
    this.feedback.set({ kind: 'idle', message: 'Ready — scan a barcode.' });
    this.mode.set('count');
    this.focusScan();
  }

  private applyServerLines(lines: StockAdjustmentLine[]): void {
    this.ledger.load(lines);
    this.knownLineIds = new Set(lines.map((l) => l.id));
    this.zeroConfirmed.set(new Set(lines.filter((l) => l.zeroConfirmed).map((l) => l.id)));
    this.bump();
  }

  /** The sessions cache is refreshed asynchronously after a write; wait for the new session to show up. */
  private async waitForSession(id: string): Promise<StockAdjustmentSession> {
    for (let i = 0; i < 20; i++) {
      const found = this.sessions().find((s) => s.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 250));
    }
    const list = await firstValueFrom(this.adjustmentService.getSessions());
    const found = list.find((s) => s.id === id);
    if (!found) throw new Error('The session was created but could not be loaded — open it from the list.');
    return found;
  }

  async cancelAdjustment(): Promise<void> {
    const session = this.session();
    if (!session) return;
    const r = await Swal.fire({
      icon: 'warning',
      title: 'Cancel this stock adjustment?',
      html: `<p><b>${session.adjustmentNo}</b> · ${this.escape(session.group)}</p><p class="mt-2">All counts in this session are discarded. Inventory is not changed.</p>`,
      showCancelButton: true,
      confirmButtonText: 'Cancel Adjustment',
      cancelButtonText: 'Keep Counting',
      confirmButtonColor: '#e11d48',
    });
    if (!r.isConfirmed) return;
    try {
      await this.loadingService.run(() => this.adjustmentService.cancelSession(session.id!, this.user()));
      this.ledger = new ScanLedger();
      this.unsavedCount.set(0);
      this.session.set(null);
      this.mode.set('setup');
      this.reloadSessions();
      Swal.fire({ icon: 'success', title: 'Cancelled', timer: 1500, showConfirmButton: false });
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Cannot Cancel', text: err?.message ?? 'Failed to cancel.' });
    }
  }

  async leaveSession(): Promise<void> {
    await this.flush();
    this.session.set(null);
    this.reviewing.set(false);
    this.mode.set('setup');
    this.reloadSessions();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Scanning
  // ═══════════════════════════════════════════════════════════════════════════
  onScanKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.repeat) return; // a held/bouncing Enter key must not count the same scan twice
    this.submitScan();
  }

  submitScan(): void {
    const input = this.scanInput?.nativeElement;
    const raw = input?.value ?? this.scanValue();
    // Clear synchronously so the same scan can never be processed twice.
    this.scanValue.set('');
    if (input) input.value = '';
    const code = String(raw ?? '').trim();
    if (!code) return;

    const session = this.session();
    if (!session || session.status !== 'Counting') {
      this.reject(code, 'This session is not counting any more — scans are not accepted.');
      return;
    }
    const result = classifyScan(code, session.group, this.groupIndex(), this.allIndex());
    if ('message' in result) { // invalid / other group / duplicate barcode — never counted
      this.reject(code, result.message);
      return;
    }

    const item = result.item;
    const count = this.ledger.add(item.id!, 1);
    if (count === null) { this.reject(code, 'Could not record this scan.'); return; }
    this.bump();
    const stock = Number(item.currentStock) || 0;
    const message = `${item.styleNo} · ${item.color} · ${item.size}${item.sleeveType ? ' · ' + item.sleeveType : ''} — scanned ${count} / stock ${stock}`;
    this.feedback.set({ kind: 'ok', message });
    this.lastScan.set({ item, count });
    this.pushRecent({ at: Date.now(), code, ok: true, message });
    this.beep(true);
  }

  private reject(code: string, message: string): void {
    this.feedback.set({ kind: 'error', message });
    this.pushRecent({ at: Date.now(), code, ok: false, message });
    this.beep(false);
  }

  private pushRecent(entry: RecentScan): void {
    this.recentScans.update((list) => [entry, ...list].slice(0, 8));
  }

  async adjustCount(row: GroupRow, delta: number): Promise<void> {
    if (this.session()?.status !== 'Counting') return;
    const count = this.ledger.add(row.item.id!, delta);
    if (count === null) return;
    this.bump();
    if (this.lastScan()?.item.id === row.item.id) this.lastScan.set({ item: row.item, count });
  }

  /** Live count for the last-scanned card (it changes when −1 / Qty are used on that row). */
  countOf(item: InventoryItem): number {
    this.ledgerVersion();
    return this.ledger.count(item.id!);
  }

  /** For cartons counted in bulk — sets the scanned qty directly. */
  async setCount(row: GroupRow): Promise<void> {
    if (this.session()?.status !== 'Counting') return;
    const current = this.ledger.count(row.item.id!);
    const r = await Swal.fire({
      title: 'Set scanned quantity',
      html: `<p class="text-sm">${this.escape(this.itemName(row.item))}<br><span class="font-mono text-xs">${this.escape(row.item.barcode)}</span></p>`,
      input: 'number',
      inputValue: String(current),
      inputAttributes: { min: '0', step: '1' },
      showCancelButton: true,
      confirmButtonText: 'Set',
      confirmButtonColor: '#4f46e5',
      inputValidator: (v) => (/^\d+$/.test(String(v).trim()) ? null : 'Enter a whole number (0 or more).'),
    });
    if (!r.isConfirmed) return;
    const target = Number(r.value);
    const delta = target - this.ledger.count(row.item.id!);
    if (delta !== 0 && this.ledger.add(row.item.id!, delta) !== null) this.bump();
    this.focusScan();
  }

  async confirmZero(rows: GroupRow[], confirmed: boolean): Promise<void> {
    const session = this.session();
    if (!session || session.status !== 'Counting' || !rows.length) return;
    if (confirmed) {
      const units = rows.reduce((s, r) => s + r.existingStock, 0);
      const r = await Swal.fire({
        icon: 'warning',
        title: rows.length === 1 ? 'Confirm zero stock?' : `Confirm ${rows.length} products as zero?`,
        html: (rows.length === 1
          ? `<p>${this.escape(this.itemName(rows[0].item))}</p><p class="mt-2">Inventory shows <b>${rows[0].existingStock}</b> pcs but none were scanned.</p>`
          : `<p>Inventory shows <b>${units}</b> pcs across these products but none were scanned.</p>`) +
          `<p class="mt-2">On completion their stock will be set to <b>0</b>.</p>`,
        input: rows.length > 1 ? 'text' : undefined,
        inputPlaceholder: rows.length > 1 ? 'Type ZERO to confirm' : undefined,
        inputValidator: rows.length > 1 ? (v) => (String(v).trim().toUpperCase() === 'ZERO' ? null : 'Type ZERO to confirm.') : undefined,
        showCancelButton: true,
        confirmButtonText: 'Confirm Zero',
        confirmButtonColor: '#e11d48',
      });
      if (!r.isConfirmed) return;
    }
    try {
      await this.loadingService.run(() =>
        this.adjustmentService.setZeroConfirmed(session.id!, rows.map((r) => r.item), confirmed, this.user()));
      this.zeroConfirmed.update((set) => {
        const next = new Set(set);
        rows.forEach((r) => (confirmed ? next.add(r.item.id!) : next.delete(r.item.id!)));
        return next;
      });
      rows.forEach((r) => this.knownLineIds.add(r.item.id!));
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Save Failed', text: err?.message ?? 'Could not save the confirmation.' });
    }
    this.focusScan();
  }

  /** Authorized exception (Super Admin only): treat every remaining unscanned product as zero. */
  async confirmAllPendingZero(): Promise<void> {
    if (!this.isSuperAdmin()) return;
    await this.confirmZero(this.rows().filter((r) => r.status === 'pending'), true);
  }

  // ── Persisting scans (line docs only — never inventory) ──────────────────
  async flush(): Promise<void> {
    if (this.flushing) { await this.flushing; if (!this.ledger.hasPending) return; }
    const session = this.session();
    if (!session || !this.ledger.hasPending) return;

    const batch = this.ledger.takePending();
    const newItems = new Map<string, InventoryItem>();
    for (const id of batch.keys()) {
      if (this.knownLineIds.has(id)) continue;
      const item = this.groupItems().find((i) => i.id === id);
      if (item) newItems.set(id, item);
    }
    this.unsavedCount.set(this.ledger.unsavedCount);

    this.flushing = (async () => {
      try {
        await this.adjustmentService.saveScanDeltas(session.id!, batch, newItems, this.user());
        this.ledger.commit(batch);
        newItems.forEach((_, id) => this.knownLineIds.add(id));
        this.syncError.set('');
      } catch (err: any) {
        this.ledger.restore(batch);
        this.syncError.set(`Scans not saved yet (${err?.message ?? 'network error'}) — retrying automatically.`);
      } finally {
        this.unsavedCount.set(this.ledger.unsavedCount);
        this.flushing = null;
      }
    })();
    await this.flushing;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Review & complete
  // ═══════════════════════════════════════════════════════════════════════════
  /** Saves local scans, then reloads counts (incl. other scanners) and current stock from the server. */
  async openReview(): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      await this.loadingService.run(async () => {
        await this.flush();
        if (this.ledger.unsavedCount > 0) throw new Error(this.syncError() || 'Some scans could not be saved.');
        const [lines] = await Promise.all([this.adjustmentService.getLines(session.id!), this.loadInventory(true)]);
        this.applyServerLines(lines);
      });
      this.reviewing.set(true);
      this.setFilter(this.summary().pending ? 'pending' : 'variance');
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Cannot Review', text: err?.message ?? 'Failed to load the latest counts.' });
    }
  }

  backToScanning(): void {
    this.reviewing.set(false);
    this.setFilter('all');
    this.focusScan();
  }

  async completeAdjustment(): Promise<void> {
    const session = this.session();
    if (!session) return;
    try {
      await this.loadingService.run(async () => {
        await this.flush();
        if (this.ledger.unsavedCount > 0) throw new Error(this.syncError() || 'Some scans could not be saved.');
        const [lines] = await Promise.all([this.adjustmentService.getLines(session.id!), this.loadInventory(true)]);
        this.applyServerLines(lines);
      });
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Cannot Complete', text: err?.message ?? 'Failed to load the latest counts.' });
      return;
    }

    const s = this.summary();
    if (s.pending > 0) {
      this.reviewing.set(true);
      this.setFilter('pending');
      Swal.fire({
        icon: 'warning', title: 'Products not scanned',
        text: `${s.pending} product(s) with stock have not been scanned. Scan them, or confirm them as zero, before completing.`,
      });
      return;
    }

    const resuming = session.status === 'Completing';
    const r = await Swal.fire({
      icon: 'question',
      title: resuming ? 'Resume completing the adjustment?' : 'Complete stock adjustment?',
      html: `<p><b>${session.adjustmentNo}</b> · ${this.escape(session.group)}</p>` +
        `<table style="margin:12px auto;text-align:left;font-size:14px">` +
        `<tr><td style="padding:2px 12px">Products counted</td><td><b>${s.scanned + s.zeroConfirmed}</b></td></tr>` +
        `<tr><td style="padding:2px 12px">Products with variance</td><td><b>${s.varianceProducts}</b></td></tr>` +
        `<tr><td style="padding:2px 12px;color:#059669">Stock increase</td><td style="color:#059669"><b>+${s.increaseQty}</b></td></tr>` +
        `<tr><td style="padding:2px 12px;color:#e11d48">Stock decrease</td><td style="color:#e11d48"><b>−${s.decreaseQty}</b></td></tr>` +
        `</table>` +
        `<p class="text-sm">Inventory will be set to the scanned quantities. This cannot be undone.</p>`,
      input: 'checkbox',
      inputValue: 0,
      inputPlaceholder: 'I have reviewed the count and want to update inventory',
      inputValidator: (v) => (v ? null : 'Tick the box to confirm.'),
      showCancelButton: true,
      confirmButtonText: 'Complete Stock Adjustment',
      confirmButtonColor: '#059669',
    });
    if (!r.isConfirmed) return;

    this.completing.set({ done: 0, total: 0 });
    try {
      const outcome = await this.adjustmentService.completeSession(
        session.id!, this.user(), this.groupItems(), (done, total) => this.completing.set({ done, total }));
      this.completing.set(null);
      if (outcome.outcome === 'in-progress') {
        Swal.fire({ icon: 'info', title: 'Already Completing', text: 'Another session is completing this adjustment right now. Check back in a couple of minutes.' });
        this.reloadSessions();
        return;
      }
      if (outcome.outcome === 'already-completed') {
        await Swal.fire({ icon: 'info', title: 'Already Completed', text: 'This adjustment was already completed — inventory was not changed again.' });
      } else {
        const res = outcome.result;
        await Swal.fire({
          icon: 'success', title: 'Stock Adjustment Completed',
          html: `<p>${res.appliedLines} product(s) counted, ${res.changedLines} updated.</p>` +
            `<p class="mt-2"><span style="color:#059669">+${res.increaseQty}</span> · <span style="color:#e11d48">−${res.decreaseQty}</span> pcs</p>`,
        });
      }
      await this.loadInventory(true);
      this.reloadSessions();
      const done = await this.waitForStatus(session.id!, ['Completed']);
      this.session.set(null);
      if (done) await this.openHistory(done); else this.mode.set('setup');
    } catch (err: any) {
      this.completing.set(null);
      await Swal.fire({ icon: 'error', title: 'Stock Adjustment Failed', text: err?.message ?? 'Failed to complete the stock adjustment.' });
      this.reloadSessions();
      await this.loadInventory(true);
    }
  }

  private async waitForStatus(id: string, statuses: StockAdjustmentSession['status'][]): Promise<StockAdjustmentSession | null> {
    for (let i = 0; i < 20; i++) {
      const found = this.sessions().find((s) => s.id === id && statuses.includes(s.status));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // History
  // ═══════════════════════════════════════════════════════════════════════════
  async openHistory(session: StockAdjustmentSession): Promise<void> {
    try {
      const lines = await this.loadingService.run(() => this.adjustmentService.getLines(session.id!));
      this.historySession.set(session);
      this.historyLines.set(lines);
      this.historyFilter.set(session.status === 'Completed' ? 'variance' : 'all');
      this.historyPage.set(1);
      this.mode.set('history');
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Cannot Open', text: err?.message ?? 'Failed to load the adjustment.' });
    }
  }

  closeHistory(): void {
    this.historySession.set(null);
    this.historyLines.set([]);
    this.setupTab.set('history');
    this.mode.set('setup');
  }

  historyVariance(line: StockAdjustmentLine): number {
    return line.applied ? Number(line.variance) || 0 : 0;
  }

  async exportHistory(): Promise<void> {
    const s = this.historySession();
    if (!s) return;
    await this.loadingService.run(() =>
      exportRowsToExcel(this.historyExportRows(), `Stock Adjustment ${s.adjustmentNo}`, this.historySummaryText(s), { generatedAt: new Date() }));
  }

  printHistory(): void {
    const s = this.historySession();
    if (!s) return;
    printReportRows(this.historyExportRows(), `Stock Adjustment ${s.adjustmentNo}`, this.historySummaryText(s), EXPORT_ROW_OPTS, { generatedAt: new Date() });
  }

  private historyExportRows(): any[][] {
    const lines = this.filteredHistoryLines();
    const header = ['Item Code', 'Style No', 'Color', 'Size', 'Previous Stock', 'Scanned Qty', 'Variance', 'Status'];
    const body = lines.map((l) => [
      l.barcode, l.styleNo, l.color, `${l.size}${l.sleeveType ? ' ' + l.sleeveType : ''}`,
      l.applied ? l.previousStock ?? '' : l.startStock, l.applied ? l.countedQty ?? '' : l.scannedQty,
      l.applied ? l.variance ?? 0 : '', l.applied ? 'Applied' : l.zeroConfirmed ? 'Confirmed Zero' : 'Counted',
    ]);
    const sum = (f: (l: StockAdjustmentLine) => number) => lines.reduce((s, l) => s + f(l), 0);
    const total = ['Grand Total', '', '', '',
      sum((l) => (l.applied ? Number(l.previousStock) || 0 : l.startStock)),
      sum((l) => (l.applied ? Number(l.countedQty) || 0 : l.scannedQty)),
      sum((l) => this.historyVariance(l)), ''];
    return [header, ...body, total];
  }

  private historySummaryText(s: StockAdjustmentSession): string {
    const res = s.result;
    return `Group: ${s.group} · Status: ${s.status} · Started by ${s.startedBy || '–'}` +
      (s.completedBy ? ` · Completed by ${s.completedBy}` : '') +
      (res ? ` · Updated ${res.changedLines} · +${res.increaseQty} / −${res.decreaseQty}` : '');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════
  itemName(item: InventoryItem): string {
    return [item.styleNo, item.color, item.size, item.sleeveType].filter(Boolean).join(' · ');
  }

  signed(n: number | null): string {
    if (n === null) return '–';
    return n > 0 ? `+${n}` : String(n);
  }

  toDate(value: any): Date | null {
    if (value && typeof value.toDate === 'function') return value.toDate();
    if (value && typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    return null;
  }

  private bump(): void {
    this.ledgerVersion.update((v) => v + 1);
    this.unsavedCount.set(this.ledger.unsavedCount);
  }

  focusScan(): void {
    setTimeout(() => this.scanInput?.nativeElement.focus(), 50);
  }

  private audio: AudioContext | null = null;
  private beep(ok: boolean): void {
    try {
      this.audio ??= new AudioContext();
      const osc = this.audio.createOscillator();
      const gain = this.audio.createGain();
      osc.frequency.value = ok ? 1200 : 220;
      osc.type = ok ? 'sine' : 'square';
      gain.gain.value = 0.08;
      osc.connect(gain).connect(this.audio.destination);
      osc.start();
      osc.stop(this.audio.currentTime + (ok ? 0.08 : 0.35));
    } catch { /* audio unavailable — visual feedback still shown */ }
  }

  private escape(s: string): string {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }
}
