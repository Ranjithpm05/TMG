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
import { PickList, PickListLine, PickListOrderSummary } from '../../models/pick-list.model';
import { PackingCarton, PackingList, PackingListLine, PackingMode } from '../../models/packing-list.model';
import { PickListService } from '../../services/pick-list.service';
import { PackingListService } from '../../services/packing-list.service';

type ViewMode = 'list' | 'select-mode' | 'view' | 'live-pack';

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL', '6XL', 'Free Size'];

@Component({
  selector: 'app-packing-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './packing-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PackingListComponent implements OnInit, OnDestroy {
  private pickListService = inject(PickListService);
  private packingListService = inject(PackingListService);
  private subscriptions: Subscription[] = [];

  // ─── Navigation ────────────────────────────────────────────────────────────
  mode = signal<ViewMode>('list');
  listTab = signal<'ready' | 'packing'>('ready');
  searchTerm = signal('');

  // ─── Data ──────────────────────────────────────────────────────────────────
  pickLists = signal<PickList[]>([]);
  packingLists = signal<PackingList[]>([]);

  // ─── View state ────────────────────────────────────────────────────────────
  viewPackingList = signal<PackingList | null>(null);
  viewLines = signal<PackingListLine[]>([]);

  // ─── Live-pack state ───────────────────────────────────────────────────────
  livePackingList = signal<PackingList | null>(null);
  liveLines = signal<PackingListLine[]>([]);

  isLoading = signal(true);
  isSubmitting = signal(false);
  packFeedback = signal<'idle' | 'success' | 'error'>('idle');
  scannerMessage = signal('Scan carton box no to begin packing.');

  cartonInput = signal('');
  activeCartonNo = signal('');
  barcodeInput = signal('');
  scanQty = signal(1);

  // ─── Select-mode state ─────────────────────────────────────────────────────
  pendingPickList = signal<PickList | null>(null);
  pendingPackableLines = signal<PickListLine[]>([]);
  selectedModeForPending = signal<PackingMode | null>(null);
  selectedOrderIdForPending = signal<string>('');
  isSavingPackingList = signal(false);

  // ─── Computed ──────────────────────────────────────────────────────────────

  completedPickLists = computed(() =>
    this.pickLists().filter((pl) => pl.status === 'Completed' && (pl.totalPickedQty ?? 0) > 0)
  );

  filteredReadyPickLists = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    return this.completedPickLists().filter((pl) => {
      if (!term) return true;
      return pl.pickListNo.toLowerCase().includes(term)
        || (pl.salesNos ?? []).some((s) => s.toLowerCase().includes(term))
        || pl.clientName.toLowerCase().includes(term);
    });
  });

  filteredPackingLists = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    return this.packingLists().filter((pl) => {
      if (!term) return true;
      return pl.packingListNo.toLowerCase().includes(term)
        || pl.pickListNo.toLowerCase().includes(term)
        || (pl.salesNos ?? []).some((s) => s.toLowerCase().includes(term))
        || pl.clientName.toLowerCase().includes(term);
    });
  });

  activeCarton = computed(() => {
    const cartonNo = this.activeCartonNo().trim().toLowerCase();
    if (!cartonNo) return null;
    return this.livePackingList()?.cartons.find((c) => c.cartonNo.toLowerCase() === cartonNo) ?? null;
  });

  liveTotals = computed(() => {
    const pl = this.livePackingList();
    return {
      totalRequiredQty: pl?.totalRequiredQty ?? 0,
      totalPackedQty: pl?.totalPackedQty ?? 0,
      lineCount: pl?.lineCount ?? 0,
      completedLineCount: pl?.completedLineCount ?? 0,
      cartonCount: pl?.cartonCount ?? 0,
      partCount: pl?.partSummaries?.length ?? 0,
    };
  });

  /** Orders available for per-order selection in select-mode */
  pendingPickListOrders = computed<PickListOrderSummary[]>(() => {
    const pl = this.pendingPickList();
    if (!pl) return [];
    if (pl.orderSummaries?.length) return pl.orderSummaries;
    // Fallback from salesNos/salesOrderIds arrays
    return (pl.salesNos ?? []).map((sno, i) => ({
      salesOrderId: (pl.salesOrderIds ?? [])[i] ?? '',
      salesNo: sno,
      clientId: pl.clientId,
      clientName: pl.clientName,
      requiredQty: 0,
      pickedQty: 0,
      pendingQty: 0,
    })).filter((o) => !!o.salesOrderId);
  });

  pendingOrderCount = computed(() => this.pendingPickListOrders().length);

  canConfirmGenerate = computed(() => {
    const mode = this.selectedModeForPending();
    if (!mode) return false;
    if (mode === 'customer') return true;
    // order-wise: if multiple orders, one must be selected
    if (this.pendingOrderCount() <= 1) return true;
    return !!this.selectedOrderIdForPending();
  });

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit() {
    this.isLoading.set(true);
    let doneCount = 0;
    const done = () => { if (++doneCount >= 2) this.isLoading.set(false); };

    this.subscriptions.push(
      this.pickListService.getPickLists().subscribe({ next: (v) => { this.pickLists.set(v); done(); }, error: done })
    );
    this.subscriptions.push(
      this.packingListService.getPackingLists().subscribe({
        next: (v) => {
          this.packingLists.set(v);

          const currentView = this.viewPackingList();
          if (currentView?.id) {
            const fresh = v.find((pl) => pl.id === currentView.id);
            if (fresh) this.viewPackingList.set(fresh);
          }
          const currentLive = this.livePackingList();
          if (currentLive?.id) {
            const fresh = v.find((pl) => pl.id === currentLive.id);
            if (fresh) this.livePackingList.set(fresh);
          }
          done();
        },
        error: done,
      })
    );
  }

  ngOnDestroy() {
    this.subscriptions.forEach((s) => s.unsubscribe());
  }

  // ─── Navigation helpers ────────────────────────────────────────────────────

  cancel() {
    this.mode.set('list');
    this.viewPackingList.set(null);
    this.viewLines.set([]);
    this.livePackingList.set(null);
    this.liveLines.set([]);
    this.barcodeInput.set('');
    this.scanQty.set(1);
    this.cartonInput.set('');
    this.activeCartonNo.set('');
    this.packFeedback.set('idle');
    this.scannerMessage.set('Scan carton box no to begin packing.');
    this._clearPendingState();
  }

  private _clearPendingState() {
    this.pendingPickList.set(null);
    this.pendingPackableLines.set([]);
    this.selectedModeForPending.set(null);
    this.selectedOrderIdForPending.set('');
  }

  // ─── Generate flow: Step 1 — Initiate ──────────────────────────────────────

  /**
   * Entry point from the "Generate Packing List" button.
   * Fetches packable lines and navigates to the mode-selection screen.
   */
  async initiateGenerate(pickList: PickList) {
    if (!pickList.id) return;

    // Check for any existing packing list tied to this pick list
    const existingPackingLists = this.packingLists().filter((pl) => pl.pickListId === pickList.id);
    if (existingPackingLists.length) {
      const existing = existingPackingLists[0];
      const result = await Swal.fire({
        icon: 'info',
        title: 'Packing List Already Exists',
        html: `<p style="font-size:13px">${existing.packingListNo} already exists for ${pickList.pickListNo}.</p>`,
        showCancelButton: true,
        confirmButtonText: existing.status === 'Completed' ? 'View Packing List' : 'Continue Packing',
        cancelButtonText: 'Close',
        confirmButtonColor: existing.status === 'Completed' ? '#4f46e5' : '#16a34a',
      });
      if (result.isConfirmed) {
        if (existing.status === 'Completed') await this.openView(existing);
        else await this.startPacking(existing);
      }
      return;
    }

    // Fetch packable lines
    await this.pickListService.ensureLegacyPickListLines(pickList);
    const lines = await this.pickListService.getPickListLinesOnce(pickList.id);
    const packableLines = lines.filter((l) => (l.pickedQty || 0) > 0 && !!l.barcode);

    if (!packableLines.length) {
      await Swal.fire({
        icon: 'warning',
        title: 'No Packable Items',
        text: 'This Pick List has no scanned barcode items ready to pack.',
      });
      return;
    }

    // Navigate to mode selection
    this.pendingPickList.set(pickList);
    this.pendingPackableLines.set(packableLines);
    this.selectedModeForPending.set(null);
    this.selectedOrderIdForPending.set('');
    this.mode.set('select-mode');
  }

  // ─── Generate flow: Step 2 — Select mode ───────────────────────────────────

  selectModeForPending(mode: PackingMode) {
    this.selectedModeForPending.set(mode);
    this.selectedOrderIdForPending.set('');
  }

  selectOrderForPending(orderId: string) {
    this.selectedOrderIdForPending.set(orderId);
  }

  // ─── Generate flow: Step 3 — Confirm & create ──────────────────────────────

  async confirmAndGenerate() {
    const pickList = this.pendingPickList();
    const packableLines = this.pendingPackableLines();
    const mode = this.selectedModeForPending();
    if (!pickList?.id || !mode || !packableLines.length) return;

    // Resolve lines and scope for the chosen mode
    let linesToPack = packableLines;
    let salesOrderIds = [...(pickList.salesOrderIds ?? [])];
    let salesNos = [...(pickList.salesNos ?? [])];

    if (mode === 'order') {
      const orders = this.pendingPickListOrders();
      let targetOrderId = this.selectedOrderIdForPending();
      // Auto-select if only one order
      if (!targetOrderId && orders.length === 1) {
        targetOrderId = orders[0].salesOrderId;
      }
      if (targetOrderId) {
        linesToPack = packableLines.filter((l) => l.salesOrderId === targetOrderId);
        const targetOrder = orders.find((o) => o.salesOrderId === targetOrderId);
        salesOrderIds = [targetOrderId];
        salesNos = targetOrder ? [targetOrder.salesNo] : salesNos;
      }
    }

    if (!linesToPack.length) {
      await Swal.fire({
        icon: 'warning',
        title: 'No Lines for Selected Order',
        text: 'The selected order has no packable barcode items.',
      });
      return;
    }

    const totalQty = linesToPack.reduce((s, l) => s + (l.pickedQty || 0), 0);
    const partCount = new Set(linesToPack.map((l) => String(l.group ?? '').trim() || 'General')).size;
    const modeLabel = mode === 'customer' ? 'Customer-wise' : 'Order-wise';
    const scopeLabel = mode === 'customer' ? pickList.clientName : salesNos.join(', ');

    const result = await Swal.fire({
      icon: 'question',
      title: 'Generate Packing List?',
      html: `
        <div style="text-align:left;font-size:13px">
          <p><strong>Mode:</strong> ${modeLabel}</p>
          <p><strong>Scope:</strong> ${scopeLabel}</p>
          <p><strong>Pick List:</strong> ${pickList.pickListNo}</p>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px">
            <div style="background:#ecfeff;border-radius:10px;padding:10px;text-align:center">
              <div style="font-size:11px;color:#0f766e;font-weight:700;text-transform:uppercase">Lines</div>
              <div style="font-size:24px;font-weight:700;color:#0f766e">${linesToPack.length}</div>
            </div>
            <div style="background:#eef2ff;border-radius:10px;padding:10px;text-align:center">
              <div style="font-size:11px;color:#4338ca;font-weight:700;text-transform:uppercase">Qty to Pack</div>
              <div style="font-size:24px;font-weight:700;color:#4338ca">${totalQty}</div>
            </div>
            <div style="background:#f0fdf4;border-radius:10px;padding:10px;text-align:center">
              <div style="font-size:11px;color:#15803d;font-weight:700;text-transform:uppercase">Parts</div>
              <div style="font-size:24px;font-weight:700;color:#15803d">${partCount}</div>
            </div>
          </div>
          <p style="margin-top:10px;color:#64748b">Scan a carton box number to start, then scan item barcodes to pack.</p>
        </div>`,
      showCancelButton: true,
      confirmButtonText: 'Generate Packing List',
      confirmButtonColor: '#0f766e',
    });

    if (!result.isConfirmed) return;

    this.isSavingPackingList.set(true);
    try {
      const packingListId = await this.packingListService.createGeneratedPackingList({
        packingListNo: `PK-${Date.now()}`,
        pickListId: pickList.id,
        pickListNo: pickList.pickListNo,
        salesOrderIds,
        salesNos,
        clientId: pickList.clientId,
        clientName: pickList.clientName,
        packingMode: mode,
        lines: linesToPack,
      });

      this._clearPendingState();
      this.listTab.set('packing');

      const created = await this.packingListService.getPackingListByIdOnce(packingListId);
      if (!created) {
        this.mode.set('list');
        return;
      }

      const nextStep = await Swal.fire({
        icon: 'success',
        title: 'Packing List Generated',
        text: 'You can start carton packing now or review the list first.',
        showCancelButton: true,
        confirmButtonText: 'Start Packing Now',
        cancelButtonText: 'Review List',
        confirmButtonColor: '#16a34a',
        cancelButtonColor: '#64748b',
      });

      if (nextStep.isConfirmed) await this.startPacking(created);
      else await this.openView(created);
    } catch (error: any) {
      const msg = error?.message === 'no_packable_lines'
        ? 'No packable lines found for the selected scope.'
        : error?.message ?? 'Unable to generate the Packing List.';
      await Swal.fire({ icon: 'error', title: 'Generation Failed', text: msg });
    } finally {
      this.isSavingPackingList.set(false);
    }
  }

  // ─── Open / Start packing ──────────────────────────────────────────────────

  async openView(packingList: PackingList) {
    if (!packingList.id) return;
    const [fresh, lines] = await Promise.all([
      this.packingListService.getPackingListByIdOnce(packingList.id),
      this.packingListService.getPackingListLinesOnce(packingList.id),
    ]);
    this.viewPackingList.set(fresh ?? packingList);
    this.viewLines.set(lines);
    this.mode.set('view');
  }

  async startPacking(packingList: PackingList) {
    if (!packingList.id) return;
    const [fresh, lines] = await Promise.all([
      this.packingListService.getPackingListByIdOnce(packingList.id),
      this.packingListService.getPackingListLinesOnce(packingList.id),
    ]);
    this.livePackingList.set(fresh ?? packingList);
    this.liveLines.set(lines);
    this.mode.set('live-pack');
    this.packFeedback.set('idle');
    this.barcodeInput.set('');
    this.scanQty.set(1);
    this.cartonInput.set('');
    this.activeCartonNo.set('');
    this.scannerMessage.set('Scan carton box no to begin packing.');
  }

  // ─── Carton & scan actions ─────────────────────────────────────────────────

  activateCarton() {
    const cartonNo = this.cartonInput().trim();
    if (!cartonNo) {
      this.flashPackFeedback('error', 'Scan or enter a carton box number first.');
      return;
    }
    const existing = this.livePackingList()?.cartons.find(
      (c) => c.cartonNo.toLowerCase() === cartonNo.toLowerCase()
    );
    this.activeCartonNo.set(existing?.cartonNo ?? cartonNo);
    this.cartonInput.set(existing?.cartonNo ?? cartonNo);
    this.flashPackFeedback(
      'success',
      existing
        ? `Continuing carton ${existing.cartonNo}. Scan an item barcode next.`
        : `Carton ${cartonNo} is ready. Scan an item barcode next.`
    );
  }

  setActiveCarton(cartonNo: string) {
    this.activeCartonNo.set(cartonNo);
    this.cartonInput.set(cartonNo);
    this.flashPackFeedback('success', `Carton ${cartonNo} is active. Scan an item barcode next.`);
  }

  onScanQtyChange(value: any) {
    this.scanQty.set(Math.max(1, Math.floor(Number(value) || 1)));
  }

  async submitPackingScan() {
    const packingList = this.livePackingList();
    if (!packingList?.id) return;

    const cartonNo = this.activeCartonNo().trim() || this.cartonInput().trim();
    const barcode = this.barcodeInput().trim();
    const qty = Math.max(1, Math.floor(Number(this.scanQty()) || 1));

    if (!cartonNo) { this.flashPackFeedback('error', 'Scan carton box no before scanning items.'); return; }
    if (!barcode) { this.flashPackFeedback('error', 'Scan or enter an item barcode.'); return; }

    this.isSubmitting.set(true);
    try {
      const result = await this.packingListService.processScan(packingList.id, cartonNo, barcode, qty);

      this.activeCartonNo.set(result.carton.cartonNo);
      this.cartonInput.set(result.carton.cartonNo);
      this.barcodeInput.set('');
      this.scanQty.set(1);

      this.liveLines.update((lines) =>
        lines
          .map((l) => (l.lineId === result.line.lineId ? result.line : l))
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      );

      this.livePackingList.update((current) => {
        if (!current) return current;
        return {
          ...current,
          totalPackedQty: result.totalPackedQty,
          completedLineCount: result.completedLineCount,
          cartonCount: result.cartonCount,
          status: result.status,
          partSummaries: result.partSummaries,
          cartons: this.mergeCarton(current.cartons ?? [], result.carton),
          items: this.liveLines().map((l) => (l.lineId === result.line.lineId ? result.line : l)),
        };
      });

      this.flashPackFeedback('success', `${qty} pc packed into carton ${result.carton.cartonNo}.`);

      if (result.packingListCompleted) {
        await Swal.fire({
          icon: 'success',
          title: 'Packing Completed!',
          text: 'All items in this Packing List have been fully packed.',
          timer: 2500,
          showConfirmButton: false,
        });
      }
    } catch (error: any) {
      const msg = this.mapPackError(error?.message ?? '');
      this.flashPackFeedback('error', msg);
      await this.showToast('error', 'Packing Failed', msg);
    } finally {
      this.isSubmitting.set(false);
    }
  }

  // ─── Print ─────────────────────────────────────────────────────────────────

  async printPackingList(packingList: PackingList) {
    if (!packingList.id) return;
    const [fresh, lines] = await Promise.all([
      this.packingListService.getPackingListByIdOnce(packingList.id),
      this.packingListService.getPackingListLinesOnce(packingList.id),
    ]);
    const html = this.buildPrintHtml(fresh ?? packingList, lines);
    const win = window.open('', '_blank', 'width=1100,height=780');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
  }

  // ─── Display helpers ───────────────────────────────────────────────────────

  formatDate(raw: any): string {
    if (!raw) return '-';
    try {
      const date = raw?.toDate ? raw.toDate() : new Date(raw);
      return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return '-'; }
  }

  formatDateTime(raw: any): string {
    if (!raw) return '-';
    try {
      const date = raw?.toDate ? raw.toDate() : new Date(raw);
      return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return '-'; }
  }

  getPackingForPickList(pickListId: string): PackingList | null {
    return this.packingLists().find((pl) => pl.pickListId === pickListId) ?? null;
  }

  getPartCountFromPickList(pickList: PickList): number {
    const parts = new Set(
      (pickList.items ?? []).map((l) => String(l.group ?? '').trim() || 'General').filter(Boolean)
    );
    return parts.size;
  }

  getCartonEntryCount(carton: PackingCarton): number {
    return carton.entries.length;
  }

  packingModeLabel(mode: PackingMode | undefined): string {
    if (mode === 'order') return 'Order-wise';
    return 'Customer-wise';
  }

  packingModeBadge(mode: PackingMode | undefined): string {
    if (mode === 'order') return 'bg-teal-100 text-teal-800';
    return 'bg-purple-100 text-purple-800';
  }

  packingStatusBadge(status: PackingList['status'] | PickList['status']): string {
    if (status === 'Completed') return 'bg-green-100 text-green-800';
    if (status === 'Partial') return 'bg-yellow-100 text-yellow-800';
    if (status === 'Pending') return 'bg-orange-100 text-orange-700';
    return 'bg-gray-100 text-gray-600';
  }

  lineStatusBadge(line: PackingListLine): string {
    return ({
      ready: 'bg-indigo-100 text-indigo-800',
      in_progress: 'bg-blue-100 text-blue-800',
      completed: 'bg-green-100 text-green-800',
    } as Record<PackingListLine['status'], string>)[line.status];
  }

  lineStatusLabel(line: PackingListLine): string {
    return ({
      ready: 'Ready',
      in_progress: 'In Progress',
      completed: 'Completed',
    } as Record<PackingListLine['status'], string>)[line.status];
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private mergeCarton(cartons: PackingCarton[], updated: PackingCarton): PackingCarton[] {
    const idx = cartons.findIndex((c) => c.cartonNo.toLowerCase() === updated.cartonNo.toLowerCase());
    if (idx === -1) return [...cartons, updated];
    const next = [...cartons];
    next[idx] = updated;
    return next;
  }

  private flashPackFeedback(type: 'success' | 'error', message: string) {
    this.packFeedback.set(type);
    this.scannerMessage.set(message);
    setTimeout(() => {
      this.packFeedback.set('idle');
      this.scannerMessage.set(
        this.activeCartonNo()
          ? `Carton ${this.activeCartonNo()} is active. Scan an item barcode next.`
          : 'Scan carton box no to begin packing.'
      );
    }, 1200);
  }

  private mapPackError(code: string): string {
    switch (code) {
      case 'carton_required': return 'Scan carton box no first.';
      case 'qty_invalid': return 'Enter a valid quantity.';
      case 'barcode_not_found': return 'Barcode not found in this Packing List.';
      case 'qty_exceeds_remaining': return 'Quantity exceeds remaining packing quantity.';
      case 'line_completed': return 'This item is already fully packed.';
      default: return 'Unable to complete packing scan. Please try again.';
    }
  }

  private async showToast(icon: 'success' | 'error' | 'info' | 'warning', title: string, text?: string) {
    await Swal.fire({ toast: true, position: 'top-end', icon, title, text, timer: 1800, showConfirmButton: false, timerProgressBar: true });
  }

  private buildPrintHtml(packingList: PackingList, lines: PackingListLine[]): string {
    const rankSize = (size: string) => {
      const idx = SIZE_ORDER.indexOf(size);
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };

    const printLines = [...lines]
      .map((l) => ({ ...l, salesText: (l.salesNos ?? []).join(', ') }))
      .sort((a, b) => {
        const pc = a.partName.localeCompare(b.partName, undefined, { numeric: true });
        if (pc !== 0) return pc;
        const sc = a.styleNo.localeCompare(b.styleNo, undefined, { numeric: true });
        if (sc !== 0) return sc;
        const cc = a.color.localeCompare(b.color, undefined, { numeric: true });
        if (cc !== 0) return cc;
        const szc = rankSize(a.size) - rankSize(b.size);
        if (szc !== 0) return szc;
        return (a.sleeveType ?? '').localeCompare(b.sleeveType ?? '', undefined, { numeric: true });
      });

    const summary = {
      lineCount: printLines.length,
      totalRequiredQty: printLines.reduce((s, l) => s + l.requiredQty, 0),
      totalPackedQty: printLines.reduce((s, l) => s + l.packedQty, 0),
      totalRemainingQty: printLines.reduce((s, l) => s + l.remainingQty, 0),
      cartonCount: packingList.cartons.length,
    };

    const statusStyle = packingList.status === 'Completed'
      ? { bg: '#d1fae5', fg: '#047857' }
      : packingList.status === 'Partial'
        ? { bg: '#fef3c7', fg: '#b45309' }
        : { bg: '#e5e7eb', fg: '#4b5563' };

    const modeStyle = packingList.packingMode === 'order'
      ? { bg: '#ccfbf1', fg: '#0f766e' }
      : { bg: '#ede9fe', fg: '#6d28d9' };

    const lineRows = printLines.map((l, i) => {
      const lineBadge = l.status === 'completed'
        ? { bg: '#d1fae5', fg: '#047857' }
        : l.status === 'in_progress'
          ? { bg: '#dbeafe', fg: '#1d4ed8' }
          : { bg: '#e0e7ff', fg: '#3730a3' };
      return `
        <tr style="background:${i % 2 === 0 ? '#f8fafc' : '#ffffff'}">
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;color:#64748b">${i + 1}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea">${l.partName}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;font-weight:700">${l.styleNo}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea">${l.color}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center">${l.size}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center">${l.sleeveType ?? '-'}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;font-family:monospace;font-size:11px">${l.barcode ?? '-'}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;font-size:11px">${l.salesText}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700">${l.requiredQty}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:#15803d">${l.packedQty}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:${l.remainingQty > 0 ? '#d97706' : '#94a3b8'}">${l.remainingQty}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center">${l.lastCartonNo ?? '-'}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea">
            <span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:10px;font-weight:700;background:${lineBadge.bg};color:${lineBadge.fg}">${l.status}</span>
          </td>
        </tr>`;
    }).join('');

    const cartonRows = packingList.cartons.map((c, i) => `
      <tr style="background:${i % 2 === 0 ? '#f8fafc' : '#ffffff'}">
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center">${i + 1}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;font-weight:700">${c.cartonNo}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center">${c.entries.length}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:#047857">${c.totalQty}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;font-size:11px">${c.entries.map((e) => `${e.styleNo} / ${e.color} / ${e.size} × ${e.qty}`).join(', ')}</td>
      </tr>`).join('');

    return `
      <!DOCTYPE html><html>
      <head><meta charset="utf-8"><title>${packingList.packingListNo}</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:12px;margin:18px;color:#0f172a}
        h1,p{margin:0}
        .header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:2px solid #0f172a;padding-bottom:12px}
        .meta{margin-top:4px;color:#64748b;font-size:11px;line-height:1.5}
        .badge{display:inline-block;margin-top:8px;margin-right:6px;padding:4px 10px;border-radius:999px;font-size:10px;font-weight:700}
        .summary{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:14px 0 10px}
        .box{border:1px solid #d7deea;background:#f8fafc;border-radius:10px;padding:10px 12px}
        .label{font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700;letter-spacing:.04em}
        .value{margin-top:5px;font-size:20px;font-weight:700}
        table{width:100%;border-collapse:collapse;margin-top:10px}
        .section-title{margin-top:18px;font-size:14px;font-weight:700;color:#0f172a}
        .signatures{display:flex;justify-content:space-between;gap:24px;margin-top:28px}
        .signatures div{flex:1;border-top:1px solid #334155;padding-top:6px;text-align:center;color:#475569;font-size:11px}
      </style></head>
      <body>
        <div class="header">
          <div>
            <h1 style="font-size:24px">${packingList.packingListNo}</h1>
            <p class="meta">Pick List: ${packingList.pickListNo}</p>
            <p class="meta">Orders: ${(packingList.salesNos ?? []).join(', ')}</p>
            <p class="meta">Client: ${packingList.clientName}</p>
            <span class="badge" style="background:${modeStyle.bg};color:${modeStyle.fg}">${this.packingModeLabel(packingList.packingMode)}</span>
            <span class="badge" style="background:${statusStyle.bg};color:${statusStyle.fg}">${packingList.status}</span>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase">Printed At</div>
            <div style="margin-top:4px;font-size:12px">${new Date().toLocaleString('en-IN')}</div>
          </div>
        </div>
        <div class="summary">
          <div class="box"><div class="label">Lines</div><div class="value">${summary.lineCount}</div></div>
          <div class="box"><div class="label">To Pack</div><div class="value" style="color:#4338ca">${summary.totalRequiredQty}</div></div>
          <div class="box"><div class="label">Packed</div><div class="value" style="color:#15803d">${summary.totalPackedQty}</div></div>
          <div class="box"><div class="label">Remaining</div><div class="value" style="color:${summary.totalRemainingQty > 0 ? '#d97706' : '#94a3b8'}">${summary.totalRemainingQty}</div></div>
          <div class="box"><div class="label">Cartons</div><div class="value">${summary.cartonCount}</div></div>
        </div>
        <div class="section-title">Part-wise Packing Lines</div>
        <table>
          <thead><tr>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">#</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Part</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Style No</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Color</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Size</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Sleeve</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Barcode</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Orders</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">To Pack</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Packed</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Remaining</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Last Carton</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Status</th>
          </tr></thead>
          <tbody>${lineRows}</tbody>
        </table>
        <div class="section-title">Carton Summary</div>
        <table>
          <thead><tr>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">#</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Carton No</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Lines</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Packed Qty</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px;font-weight:700">Contents</th>
          </tr></thead>
          <tbody>${cartonRows || '<tr><td colspan="5" style="padding:12px;border:1px solid #d7deea;text-align:center;color:#94a3b8">No cartons packed yet.</td></tr>'}</tbody>
        </table>
        <div class="signatures">
          <div>Prepared By</div><div>Packed By</div><div>Checked By</div>
        </div>
      </body></html>`;
  }
}