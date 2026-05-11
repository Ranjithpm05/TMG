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
import { PickList, PickListLine } from '../../models/pick-list.model';
import { PackingCarton, PackingList, PackingListLine, PackingPartyProgress } from '../../models/packing-list.model';
import { PickListService } from '../../services/pick-list.service';
import { PackingListService } from '../../services/packing-list.service';
import { ClientService } from '../../services/client.service';

type ViewMode = 'list' | 'view' | 'live-pack';

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
  private clientService = inject(ClientService);
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
  isSealingCarton = signal(false);
  isGenerating = signal(false);
  packFeedback = signal<'idle' | 'success' | 'error'>('idle');
  scannerMessage = signal('Scan carton box no to begin packing.');

  cartonInput = signal('');
  activeCartonNo = signal('');
  barcodeInput = signal('');
  scanQty = signal(1);

  showCartons = signal(true);
  showPackingLines = signal(true);
  activePartyId = signal('');

  agentName = signal('');
  transport = signal('');
  isSavingDispatchInfo = signal(false);

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
    };
  });

  overallPackingProgress = computed(() => {
    const t = this.liveTotals();
    return t.totalRequiredQty > 0 ? Math.round((t.totalPackedQty / t.totalRequiredQty) * 100) : 0;
  });

  partyPackingProgress = computed((): PackingPartyProgress[] => {
    return this.livePackingList()?.partyProgress ?? [];
  });

  openCartonsCount = computed(() =>
    (this.livePackingList()?.cartons ?? []).filter((c) => c.cartonStatus !== 'sealed').length
  );

  sealedCartonsCount = computed(() =>
    (this.livePackingList()?.cartons ?? []).filter((c) => c.cartonStatus === 'sealed').length
  );

  filteredLiveLines = computed(() => {
    const partyId = this.activePartyId();
    const lines = this.liveLines();
    if (!partyId) return lines;
    return lines.filter((l) => l.salesOrderIds.includes(partyId));
  });

  activePartyLabel = computed(() => {
    const partyId = this.activePartyId();
    if (!partyId) return '';
    const p = this.partyPackingProgress().find((p) => p.salesOrderId === partyId);
    return p ? (p.clientName || p.salesNo) : '';
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
    this.activePartyId.set('');
    this.packFeedback.set('idle');
    this.scannerMessage.set('Scan carton box no to begin packing.');
    this.agentName.set('');
    this.transport.set('');
  }

  // ─── Generate flow ─────────────────────────────────────────────────────────

  async initiateGenerate(pickList: PickList) {
    if (!pickList.id) return;

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

    const totalQty = packableLines.reduce((s, l) => s + (l.pickedQty || 0), 0);
    const orderCount = new Set(packableLines.map((l) => l.salesOrderId)).size;
    const partCount = new Set(packableLines.map((l) => String(l.group ?? '').trim() || 'General')).size;

    const result = await Swal.fire({
      icon: 'question',
      title: 'Generate Packing List?',
      html: `
        <div style="text-align:left;font-size:13px">
          <p><strong>Client:</strong> ${pickList.clientName}</p>
          <p><strong>Pick List:</strong> ${pickList.pickListNo}</p>
          <p><strong>Orders:</strong> ${(pickList.salesNos ?? []).join(', ')}</p>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px">
            <div style="background:#ecfeff;border-radius:10px;padding:10px;text-align:center">
              <div style="font-size:11px;color:#0f766e;font-weight:700;text-transform:uppercase">Lines</div>
              <div style="font-size:24px;font-weight:700;color:#0f766e">${packableLines.length}</div>
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
          <p style="margin-top:10px;color:#64748b">${orderCount} order${orderCount !== 1 ? 's' : ''} · Party-wise tracking · Scan barcodes to pack.</p>
        </div>`,
      showCancelButton: true,
      confirmButtonText: 'Generate Packing List',
      confirmButtonColor: '#0f766e',
    });

    if (!result.isConfirmed) return;

    this.isGenerating.set(true);
    try {
      const packingListId = await this.packingListService.createGeneratedPackingList({
        packingListNo: `PK-${Date.now()}`,
        pickListId: pickList.id,
        pickListNo: pickList.pickListNo,
        salesOrderIds: [...(pickList.salesOrderIds ?? [])],
        salesNos: [...(pickList.salesNos ?? [])],
        clientId: pickList.clientId,
        clientName: pickList.clientName,
        packingMode: 'customer',
        lines: packableLines,
      });

      this.listTab.set('packing');
      const created = await this.packingListService.getPackingListByIdOnce(packingListId);
      if (!created) { this.mode.set('list'); return; }

      const nextStep = await Swal.fire({
        icon: 'success',
        title: 'Packing List Generated',
        text: 'Start carton packing now or review the list first.',
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
        ? 'No packable lines found.'
        : error?.message ?? 'Unable to generate the Packing List.';
      await Swal.fire({ icon: 'error', title: 'Generation Failed', text: msg });
    } finally {
      this.isGenerating.set(false);
    }
  }

  // ─── Open / Start packing ──────────────────────────────────────────────────

  async openView(packingList: PackingList) {
    if (!packingList.id) return;
    const [fresh, lines] = await Promise.all([
      this.packingListService.getPackingListByIdOnce(packingList.id),
      this.packingListService.getPackingListLinesOnce(packingList.id),
    ]);
    const loaded = fresh ?? packingList;
    this.viewPackingList.set(loaded);
    this.viewLines.set(lines);
    this.agentName.set(loaded.agentName ?? '');
    this.transport.set(loaded.transport ?? '');
    this.mode.set('view');
  }

  async startPacking(packingList: PackingList) {
    if (!packingList.id) return;
    const [fresh, lines] = await Promise.all([
      this.packingListService.getPackingListByIdOnce(packingList.id),
      this.packingListService.getPackingListLinesOnce(packingList.id),
    ]);
    const loaded = fresh ?? packingList;
    this.livePackingList.set(loaded);
    this.liveLines.set(lines);
    this.agentName.set(loaded.agentName ?? '');
    this.transport.set(loaded.transport ?? '');
    this.mode.set('live-pack');
    this.packFeedback.set('idle');
    this.barcodeInput.set('');
    this.scanQty.set(1);
    this.cartonInput.set('');
    this.activeCartonNo.set('');
    this.activePartyId.set('');
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
    if (existing?.cartonStatus === 'sealed') {
      this.flashPackFeedback('error', `Carton ${existing.cartonNo} is sealed. Create a new carton.`);
      return;
    }
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
    const carton = this.livePackingList()?.cartons.find((c) => c.cartonNo === cartonNo);
    if (carton?.cartonStatus === 'sealed') {
      this.flashPackFeedback('error', `Carton ${cartonNo} is sealed. Create a new carton to continue packing.`);
      return;
    }
    this.activeCartonNo.set(cartonNo);
    this.cartonInput.set(cartonNo);
    this.flashPackFeedback('success', `Carton ${cartonNo} is active. Scan an item barcode next.`);
  }

  setActiveParty(salesOrderId: string) {
    if (this.activePartyId() === salesOrderId) {
      this.activePartyId.set('');
    } else {
      this.activePartyId.set(salesOrderId);
    }
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

    const activeCarton = this.livePackingList()?.cartons.find((c) => c.cartonNo === cartonNo);
    if (activeCarton?.cartonStatus === 'sealed') {
      this.flashPackFeedback('error', `Carton ${cartonNo} is sealed. Activate a different carton.`);
      return;
    }

    this.isSubmitting.set(true);
    try {
      const activeSalesOrderId = this.activePartyId() || undefined;
      const result = await this.packingListService.processScan(packingList.id, cartonNo, barcode, qty, activeSalesOrderId);

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
          partyProgress: result.partyProgress,
          cartons: this.mergeCarton(current.cartons ?? [], result.carton),
          items: this.liveLines().map((l) => (l.lineId === result.line.lineId ? result.line : l)),
        };
      });

      this.flashPackFeedback('success', `${qty} pc packed into carton ${result.carton.cartonNo}.`);

      if (result.packingListCompleted) {
        await Swal.fire({
          icon: 'success',
          title: 'Packing Completed!',
          html: `<p style="font-size:13px">All items have been fully packed.</p>
            ${result.stockDeducted
              ? '<p style="font-size:12px;color:#047857;margin-top:6px">&#10003; Inventory stock has been automatically reduced.</p>'
              : '<p style="font-size:12px;color:#b45309;margin-top:6px">&#9888; Stock deduction could not be applied &mdash; please verify inventory manually.</p>'
            }`,
          timer: 3500,
          showConfirmButton: false,
        });
      }
    } catch (error: any) {
      const msg = this.mapPackError(error?.message ?? '');
      this.flashPackFeedback('error', msg);
    } finally {
      this.isSubmitting.set(false);
    }
  }

  async sealActiveCarton() {
    const packingList = this.livePackingList();
    const cartonNo = this.activeCartonNo().trim();
    if (!packingList?.id || !cartonNo) return;

    const carton = packingList.cartons.find((c) => c.cartonNo === cartonNo);
    if (!carton) return;
    if (carton.cartonStatus === 'sealed') {
      await Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Already sealed', timer: 1500, showConfirmButton: false });
      return;
    }

    const result = await Swal.fire({
      icon: 'question',
      title: `Seal Carton ${cartonNo}?`,
      html: `<p style="font-size:13px">This carton has <strong>${carton.entries.length}</strong> line${carton.entries.length !== 1 ? 's' : ''} and <strong>${carton.totalQty}</strong> pcs. Once sealed, no more items can be added.</p>`,
      showCancelButton: true,
      confirmButtonText: 'Seal Carton',
      confirmButtonColor: '#0f766e',
    });
    if (!result.isConfirmed) return;

    this.isSealingCarton.set(true);
    try {
      await this.packingListService.sealCarton(packingList.id, cartonNo);
      this.livePackingList.update((current) => {
        if (!current) return current;
        return {
          ...current,
          cartons: current.cartons.map((c) =>
            c.cartonNo === cartonNo ? { ...c, cartonStatus: 'sealed' as const } : c
          ),
        };
      });
      this.activeCartonNo.set('');
      this.cartonInput.set('');
      this.flashPackFeedback('success', `Carton ${cartonNo} sealed. Scan a new carton to continue.`);
    } catch {
      this.flashPackFeedback('error', 'Failed to seal carton. Please try again.');
    } finally {
      this.isSealingCarton.set(false);
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

  async saveDispatchInfo(packingList: PackingList) {
    if (!packingList.id) return;
    const agentName = this.agentName().trim();
    const transport = this.transport().trim();
    this.isSavingDispatchInfo.set(true);
    try {
      await this.packingListService.updateDispatchInfo(packingList.id, agentName, transport);
      const currentList = this.viewPackingList();
      const currentLive = this.livePackingList();
      if (currentList?.id === packingList.id) this.viewPackingList.update((p) => p ? { ...p, agentName, transport } : p);
      if (currentLive?.id === packingList.id) this.livePackingList.update((p) => p ? { ...p, agentName, transport } : p);
      await Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Dispatch info saved', timer: 1400, showConfirmButton: false });
    } catch {
      await Swal.fire({ icon: 'error', title: 'Save Failed', text: 'Unable to save dispatch information.' });
    } finally {
      this.isSavingDispatchInfo.set(false);
    }
  }

  async printDeliveryChallan(packingList: PackingList) {
    if (!packingList.id) return;

    const agentNameVal = this.agentName().trim();
    const transportVal = this.transport().trim();
    const sealedCount = (packingList.cartons ?? []).filter((c) => c.cartonStatus === 'sealed').length;
    const totalCartons = (packingList.cartons ?? []).length;

    const { isConfirmed, value } = await Swal.fire({
      title: 'QC Verification',
      html: `
        <div style="text-align:left;font-size:13px;line-height:1.7">
          <p style="margin-bottom:10px;font-weight:600;color:#0f172a">Confirm before printing Delivery Challan:</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:12px">
            <tr><td style="padding:4px 8px;color:#64748b">Client</td><td style="padding:4px 8px;font-weight:600">${packingList.clientName}</td></tr>
            <tr style="background:#f8fafc"><td style="padding:4px 8px;color:#64748b">Orders</td><td style="padding:4px 8px;font-weight:600">${(packingList.salesNos ?? []).join(', ')}</td></tr>
            <tr><td style="padding:4px 8px;color:#64748b">Total Qty</td><td style="padding:4px 8px;font-weight:700;color:#047857">${packingList.totalPackedQty}</td></tr>
            <tr style="background:#f8fafc"><td style="padding:4px 8px;color:#64748b">Cartons</td><td style="padding:4px 8px;font-weight:700;color:#0f766e">${totalCartons} (${sealedCount} sealed)</td></tr>
          </table>
          <div style="margin-bottom:8px">
            <label style="display:block;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">Agent Name</label>
            <input id="swal-agent" type="text" value="${agentNameVal}" placeholder="Enter agent name"
              style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none">
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">Transport</label>
            <input id="swal-transport" type="text" value="${transportVal}" placeholder="Enter transporter name"
              style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none">
          </div>
        </div>`,
      showCancelButton: true,
      confirmButtonText: 'Verify & Print DC',
      cancelButtonText: 'Cancel',
      confirmButtonColor: '#4f46e5',
      focusConfirm: false,
      preConfirm: () => ({
        agentName: (document.getElementById('swal-agent') as HTMLInputElement)?.value?.trim() ?? '',
        transport: (document.getElementById('swal-transport') as HTMLInputElement)?.value?.trim() ?? '',
      }),
    });

    if (!isConfirmed || !value) return;

    const finalAgent = value.agentName;
    const finalTransport = value.transport;
    this.agentName.set(finalAgent);
    this.transport.set(finalTransport);

    try {
      const [fresh, lines, client] = await Promise.all([
        this.packingListService.getPackingListByIdOnce(packingList.id),
        this.packingListService.getPackingListLinesOnce(packingList.id),
        this.clientService.getClientByIdOnce(packingList.clientId),
      ]);

      await Promise.all([
        this.packingListService.updateDispatchInfo(packingList.id, finalAgent, finalTransport),
        this.packingListService.markQcVerified(packingList.id),
      ]);

      const currentList = this.viewPackingList();
      const currentLive = this.livePackingList();
      if (currentList?.id === packingList.id) this.viewPackingList.update((p) => p ? { ...p, agentName: finalAgent, transport: finalTransport } : p);
      if (currentLive?.id === packingList.id) this.livePackingList.update((p) => p ? { ...p, agentName: finalAgent, transport: finalTransport } : p);

      const html = this.buildDCHtml(fresh ?? packingList, lines, client, finalAgent, finalTransport);
      const win = window.open('', '_blank', 'width=900,height=780');
      if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
    } catch {
      await Swal.fire({ icon: 'error', title: 'Print Failed', text: 'Unable to generate Delivery Challan.' });
    }
  }

  printCartonLabel(packingList: PackingList, carton: PackingCarton) {
    const html = this.buildCartonLabelHtml(packingList, carton);
    const win = window.open('', '_blank', 'width=600,height=500');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 400); }
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

  partyPackingPct(party: PackingPartyProgress): number {
    return party.requiredQty > 0 ? Math.round((party.packedQty / party.requiredQty) * 100) : 0;
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
    }, 1400);
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
        return rankSize(a.size) - rankSize(b.size);
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
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center">
          <span style="padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:${c.cartonStatus === 'sealed' ? '#d1fae5' : '#fef3c7'};color:${c.cartonStatus === 'sealed' ? '#047857' : '#b45309'}">${c.cartonStatus === 'sealed' ? 'Sealed' : 'Open'}</span>
        </td>
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
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">#</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Part</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Style No</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Color</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Size</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Sleeve</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Barcode</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Orders</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">To Pack</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Packed</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Remaining</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Last Carton</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Status</th>
          </tr></thead>
          <tbody>${lineRows}</tbody>
        </table>
        <div class="section-title">Carton Summary</div>
        <table>
          <thead><tr>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">#</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Carton No</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Lines</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Packed Qty</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Status</th>
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">Contents</th>
          </tr></thead>
          <tbody>${cartonRows || '<tr><td colspan="6" style="padding:12px;border:1px solid #d7deea;text-align:center;color:#94a3b8">No cartons packed yet.</td></tr>'}</tbody>
        </table>
        <div class="signatures">
          <div>Prepared By</div><div>Packed By</div><div>Checked By</div>
        </div>
      </body></html>`;
  }

  private buildDCHtml(
    packingList: PackingList,
    lines: PackingListLine[],
    client: import('../../models/client.model').Client | null,
    agentName: string,
    transport: string,
  ): string {
    const rankSize = (s: string) => {
      const idx = SIZE_ORDER.indexOf(s);
      if (idx !== -1) return idx;
      const n = parseInt(s, 10);
      return isNaN(n) ? 9999 : 1000 + n;
    };

    const packedLines = lines.filter((l) => l.packedQty > 0 || l.requiredQty > 0);

    const sizeSet = new Set(packedLines.map((l) => l.size));
    const sizes = [...sizeSet].sort((a, b) => rankSize(a) - rankSize(b));

    interface DCRow { partName: string; styleNo: string; color: string; sizeQty: Map<string, number>; total: number; }
    const rowMap = new Map<string, DCRow>();
    for (const line of packedLines) {
      const qty = line.packedQty > 0 ? line.packedQty : line.requiredQty;
      if (qty <= 0) continue;
      const key = `${line.partName}||${line.styleNo}||${line.color}`;
      if (!rowMap.has(key)) rowMap.set(key, { partName: line.partName, styleNo: line.styleNo, color: line.color, sizeQty: new Map(), total: 0 });
      const row = rowMap.get(key)!;
      row.sizeQty.set(line.size, (row.sizeQty.get(line.size) ?? 0) + qty);
      row.total += qty;
    }

    const sizeTotals = new Map<string, number>();
    let grandTotal = 0;
    for (const row of rowMap.values()) {
      for (const [sz, qty] of row.sizeQty) {
        sizeTotals.set(sz, (sizeTotals.get(sz) ?? 0) + qty);
        grandTotal += qty;
      }
    }

    const B = 'border:1px solid #bbb;';
    const th = (txt: string, extra = '') =>
      `<th style="padding:5px 7px;${B}background:#e8e8e8;font-size:10px;font-weight:700;text-align:center;${extra}">${txt}</th>`;
    const td = (txt: string | number, extra = '') =>
      `<td style="padding:5px 7px;${B}font-size:10px;text-align:center;${extra}">${txt}</td>`;

    const sizeHeaders = sizes.map((s) => th(s)).join('');
    const tableRows = [...rowMap.values()].map((row, i) => {
      const sizeCells = sizes.map((s) => td(row.sizeQty.get(s) ?? '')).join('');
      return `<tr style="background:${i % 2 === 0 ? '#fff' : '#f9f9f9'}">
        ${td(row.partName, 'text-align:left')}
        ${td('NOS')}
        ${td(row.styleNo, 'font-weight:700;text-align:left')}
        ${td(row.color || '-')}
        ${sizeCells}
        ${td(row.total, 'font-weight:700')}
      </tr>`;
    }).join('');

    const totalCells = sizes.map((s) => td(sizeTotals.get(s) ?? '', 'font-weight:700;background:#f0f0f0')).join('');
    const totalRow = `<tr>
      <td colspan="4" style="padding:5px 7px;${B}font-weight:700;font-size:10px;text-align:right;background:#f0f0f0">Total</td>
      ${totalCells}
      <td style="padding:5px 7px;${B}font-weight:900;font-size:11px;text-align:center;background:#f0f0f0">${grandTotal}</td>
    </tr>`;

    const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const clientLines: string[] = [];
    if (client?.billingAddress) clientLines.push(client.billingAddress);
    const cityState = [client?.place, client?.state].filter(Boolean).join(', ');
    if (cityState) clientLines.push(`${cityState}${client?.zipCode ? ' - ' + client.zipCode : ''}`);
    if (client?.mobile) clientLines.push(`PH: ${client.mobile}`);

    const clientAddrHtml = clientLines.map((l) => `<div style="font-size:10px;margin-top:1px">${l}</div>`).join('');
    const clientGst = client?.gstNo ?? '';

    return `<!DOCTYPE html><html>
<head><meta charset="utf-8"><title>DC - ${packingList.packingListNo}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:11px;color:#000;padding:14px 18px}
table{width:100%;border-collapse:collapse}
</style></head>
<body>

<!-- Company Header -->
<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:6px;position:relative">
  <div style="position:absolute;right:0;top:0;font-size:9px;color:#666">Page: 1/1</div>
  <div style="font-size:21px;font-weight:900;letter-spacing:0.5px">TMG Clothings</div>
  <div style="font-size:10px;color:#333;margin-top:2px">Door No.334/2, Serayampalaym, Vellanaipatti Post,</div>
  <div style="font-size:10px;color:#333">Coimbatore - 641048, Phone: 9842211787</div>
  <div style="font-size:10px;color:#333">Email : order@tmggarments.in &nbsp;|&nbsp; GSTIN: 33AAYFT2559B1ZY</div>
</div>

<div style="font-size:14px;font-weight:700;text-align:center;letter-spacing:2px;text-decoration:underline;margin-bottom:8px">DELIVERY CHALLAN</div>

<!-- Customer info + DC details -->
<div style="display:flex;border:1px solid #aaa;margin-bottom:10px">
  <div style="flex:1;padding:8px 10px;border-right:1px solid #aaa">
    <div style="font-size:10px;font-weight:700">M/S : ${packingList.clientName}</div>
    ${clientAddrHtml}
    ${clientGst ? `<div style="font-size:10px;margin-top:4px">GSTIN: ${clientGst}</div>` : ''}
  </div>
  <div style="padding:6px 10px;min-width:250px">
    <table style="border-collapse:collapse">
      <tr><td style="padding:3px 6px;font-size:10px;color:#555;white-space:nowrap">DC No.</td><td style="padding:3px 6px;font-size:10px;font-weight:700">: ${packingList.packingListNo}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Packed On</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dateStr}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Order No.</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${(packingList.salesNos ?? []).join(', ')}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Order Date</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dateStr}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Total Qty</td><td style="padding:3px 6px;font-size:10px;font-weight:700">: ${grandTotal}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">No.of Box</td><td style="padding:3px 6px;font-size:10px;font-weight:700">: ${packingList.cartons.length}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Agent Name</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${agentName || '-'}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Transport</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${transport || '-'}</td></tr>
    </table>
  </div>
</div>

<!-- Items table -->
<table>
  <thead>
    <tr>
      ${th('Description', 'text-align:left')}
      ${th('UOM')}
      ${th('Design', 'text-align:left')}
      ${th('Shade')}
      ${sizeHeaders}
      ${th('Total')}
    </tr>
  </thead>
  <tbody>
    ${tableRows || `<tr><td colspan="${4 + sizes.length + 1}" style="padding:10px;text-align:center;color:#888">No items packed.</td></tr>`}
    ${totalRow}
  </tbody>
</table>

<!-- Remarks + Signatures -->
<div style="margin-top:14px;font-size:10px">Remarks :</div>
<div style="display:flex;justify-content:space-between;margin-top:40px;gap:30px">
  <div style="flex:1;text-align:center">
    <div style="border-top:1px solid #555;padding-top:5px;font-size:10px;color:#444">Checked By</div>
  </div>
  <div style="flex:1;text-align:center">
    <div style="border-top:1px solid #555;padding-top:5px;font-size:10px;color:#444">Authorized By</div>
  </div>
</div>

</body></html>`;
  }

  private buildCartonLabelHtml(packingList: PackingList, carton: PackingCarton): string {
    const lines = carton.entries.map((e) =>
      `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #e2e8f0">
        <span>${e.styleNo} / ${e.color} / ${e.size}${e.sleeveType ? ' / ' + e.sleeveType : ''}</span>
        <strong>×${e.qty}</strong>
      </div>`
    ).join('');

    return `
      <!DOCTYPE html><html>
      <head><meta charset="utf-8"><title>Carton Label</title>
      <style>body{font-family:Arial,sans-serif;font-size:12px;margin:16px;color:#0f172a}</style></head>
      <body>
        <div style="border:2px solid #0f172a;border-radius:10px;padding:16px;max-width:380px;margin:auto">
          <div style="text-align:center;border-bottom:2px solid #0f172a;padding-bottom:10px;margin-bottom:12px">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700">Carton Label</div>
            <div style="font-size:28px;font-weight:900;letter-spacing:2px;margin:4px 0">${carton.cartonNo}</div>
            <div style="font-size:11px;color:#64748b">${packingList.packingListNo}</div>
          </div>
          <div style="margin-bottom:10px">
            <div style="font-size:11px;color:#64748b;font-weight:700">CLIENT</div>
            <div style="font-size:14px;font-weight:700">${packingList.clientName}</div>
            <div style="font-size:11px;color:#64748b">${(packingList.salesNos ?? []).join(', ')}</div>
          </div>
          <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px">
            ${lines}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-size:11px;color:#64748b">Total Pieces</div>
              <div style="font-size:26px;font-weight:900;color:#0f766e">${carton.totalQty}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:11px;color:#64748b">Date</div>
              <div style="font-size:12px;font-weight:700">${new Date().toLocaleDateString('en-IN')}</div>
            </div>
          </div>
        </div>
      </body></html>`;
  }
}
