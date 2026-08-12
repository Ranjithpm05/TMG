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
import { firstValueFrom, Subscription } from 'rxjs';
import Swal from 'sweetalert2';
import { PickList, PickListLine } from '../../models/pick-list.model';
import { PackingCarton, PackingList, PackingListLine, PackingPartyProgress } from '../../models/packing-list.model';
import { DCItem, DeliveryChallan } from '../../models/delivery-challan.model';
import { PickListService } from '../../services/pick-list.service';
import { PackingListService } from '../../services/packing-list.service';
import { ClientService } from '../../services/client.service';
import { DeliveryChallanService } from '../../services/delivery-challan.service';
import { Invoice } from '../../models/invoice.model';
import { InvoiceService } from '../../services/invoice.service';
import { InventoryService } from '../../services/inventory.service';
import { InventoryItem } from '../../models/inventory.model';

type ViewMode = 'list' | 'view' | 'live-pack' | 'combine';

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
  private dcService = inject(DeliveryChallanService);
  private invoiceService = inject(InvoiceService);
  private inventoryService = inject(InventoryService);
  private subscriptions: Subscription[] = [];

  // ─── Navigation ────────────────────────────────────────────────────────────
  mode = signal<ViewMode>('list');
  listTab = signal<'ready' | 'packing' | 'dc-history' | 'invoices'>('ready');
  searchTerm = signal('');

  // ─── Data ──────────────────────────────────────────────────────────────────
  pickLists = signal<PickList[]>([]);
  packingLists = signal<PackingList[]>([]);
  deliveryChallans = signal<DeliveryChallan[]>([]);

  // ─── View state ────────────────────────────────────────────────────────────
  viewPackingList = signal<PackingList | null>(null);
  viewLines = signal<PackingListLine[]>([]);

  // ─── Live-pack state ───────────────────────────────────────────────────────
  livePackingList = signal<PackingList | null>(null);
  liveLines = signal<PackingListLine[]>([]);
  liveMrpByBarcode = signal<Map<string, number>>(new Map());

  isLoading = signal(true);
  isSubmitting = signal(false);
  isSealingCarton = signal(false);
  isGenerating = signal(false);
  isGeneratingDC = signal(false);
  packFeedback = signal<'idle' | 'success' | 'error'>('idle');
  scannerMessage = signal('Scan carton box no to begin packing.');

  cartonInput = signal('');
  activeCartonNo = signal('');
  barcodeInput = signal('');
  scanQty = signal(1);

  showCartons = signal(true);
  showPackingLines = signal(true);
  activePartyId = signal('');
  currentCustomerIndex = signal(0);

  agentName = signal('');
  transport = signal('');
  isSavingDispatchInfo = signal(false);

  packingInProgress = signal<string[]>([]);
  activeBoxNo = signal('');
  boxInput = signal('');
  invoices = signal<Invoice[]>([]);
  isGeneratingInvoice = signal(false);

  // ─── Combine (multiple Pick Lists → one Packing List) ─────────────────────
  combineClientId = signal<string | null>(null);
  selectedPickListIdsForCombine = signal<Set<string>>(new Set());

  // ─── Computed ──────────────────────────────────────────────────────────────

  // How much of a Pick List's picked quantity hasn't been carried into any
  // Packing List yet. A Pick List may be packed in several batches over
  // time (many Packing Lists from one Pick List is normal — see
  // PickListService.computeEffectiveStatus), so having existing Packing
  // Lists does NOT make a Pick List ineligible; only running out of
  // un-packed quantity does.
  getRemainingToPackQty(pl: PickList): number {
    return Math.max(0, this.getEffectivePickedQty(pl) - (pl.totalPackedIntoPackingListsQty ?? 0));
  }

  // A Pick List is ready to pack once it's actually 'Completed', or once a
  // Party-wise "Complete Pick List" click marked it 'Partial' + finalizedAt —
  // the user has explicitly said "pack what's picked so far", so it must flow
  // to Packing/DC/Invoice even though not every requested unit was picked —
  // AND it still has some picked-but-not-yet-packed quantity to offer.
  completedPickLists = computed(() =>
    this.pickLists().filter((pl) =>
      (pl.status === 'Completed' || (pl.status === 'Partial' && !!pl.finalizedAt))
      && this.getRemainingToPackQty(pl) > 0
    )
  );

  // Same eligibility as "Ready to Pack" — a Pick List with existing Packing
  // Lists can still be combined again for its remaining un-packed quantity.
  combineEligiblePickLists = computed(() => this.completedPickLists());

  combineEligibleCustomers = computed((): { clientId: string; clientName: string }[] => {
    const map = new Map<string, string>();
    for (const pl of this.combineEligiblePickLists()) {
      if (!pl.clientId) continue;
      if (!map.has(pl.clientId)) map.set(pl.clientId, pl.clientName);
    }
    return [...map.entries()]
      .map(([clientId, clientName]) => ({ clientId, clientName }))
      .sort((a, b) => a.clientName.localeCompare(b.clientName, undefined, { numeric: true }));
  });

  combinePickListsForSelectedCustomer = computed(() => {
    const clientId = this.combineClientId();
    if (!clientId) return [];
    return this.combineEligiblePickLists().filter((pl) => pl.clientId === clientId);
  });

  selectedPickListsForCombine = computed(() =>
    this.combinePickListsForSelectedCustomer().filter((pl) => this.selectedPickListIdsForCombine().has(pl.id ?? ''))
  );

  combineSelectionTotals = computed(() => {
    const selected = this.selectedPickListsForCombine();
    return {
      count: selected.length,
      totalQty: selected.reduce((sum, pl) => sum + this.getEffectivePickedQty(pl), 0),
    };
  });

  // Actual packable quantity for a Pick List: SO-requested units picked plus
  // any additional/non-requested barcodes scanned — both flow into Packing.
  getEffectivePickedQty(pl: PickList): number {
    return (pl.totalPickedQty ?? 0) + (pl.totalAdditionalPickedQty ?? 0);
  }

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

  filteredDCList = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    return this.deliveryChallans().filter((dc) => {
      if (!term) return true;
      return dc.dcNo.toLowerCase().includes(term)
        || dc.clientName.toLowerCase().includes(term)
        || dc.salesNo.toLowerCase().includes(term)
        || dc.packingListNo.toLowerCase().includes(term);
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

  filteredInvoiceList = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    return this.invoices().filter((inv) => {
      if (!term) return true;
      return inv.invoiceNo.toLowerCase().includes(term)
        || inv.clientName.toLowerCase().includes(term)
        || inv.salesNos.some((s) => s.toLowerCase().includes(term));
    });
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

  liveLinesByCustomer = computed((): { salesOrderId: string; customerName: string; salesNo: string; lines: PackingListLine[] }[] => {
    const lines = this.liveLines();
    const pl = this.livePackingList();
    const partyProgress = pl?.partyProgress ?? [];
    if (partyProgress.length === 0) {
      return [{ salesOrderId: 'all', customerName: pl?.clientName ?? '-', salesNo: '-', lines }];
    }
    const groups = new Map<string, { salesOrderId: string; customerName: string; salesNo: string; lines: PackingListLine[] }>();
    for (const party of partyProgress) {
      groups.set(party.salesOrderId, {
        salesOrderId: party.salesOrderId,
        customerName: party.clientName || party.salesNo,
        salesNo: party.salesNo,
        lines: [],
      });
    }
    for (const line of lines) {
      let placed = false;
      for (const soId of line.salesOrderIds) {
        if (groups.has(soId)) { groups.get(soId)!.lines.push(line); placed = true; break; }
      }
      if (!placed) { const first = [...groups.values()][0]; if (first) first.lines.push(line); }
    }
    return [...groups.values()].filter((g) => g.lines.length > 0);
  });

  allLinesPacked = computed(() => {
    const lines = this.liveLines();
    return lines.length > 0 && lines.every((l) => l.status === 'completed');
  });

  currentCustomerGroup = computed((): { salesOrderId: string; customerName: string; salesNo: string; lines: PackingListLine[] } | null => {
    const groups = this.liveLinesByCustomer();
    const idx = this.currentCustomerIndex();
    return groups[idx] ?? null;
  });

  currentCustomerAllPacked = computed(() => {
    const group = this.currentCustomerGroup();
    if (!group) return false;
    return group.lines.length > 0 && group.lines.every((l) => l.status === 'completed');
  });

  isLastCustomer = computed(() => {
    return this.currentCustomerIndex() >= this.liveLinesByCustomer().length - 1;
  });

  customersCount = computed(() => this.liveLinesByCustomer().length);

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit() {
    this.isLoading.set(true);
    let doneCount = 0;
    const done = () => { if (++doneCount >= 4) this.isLoading.set(false); };

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
    this.subscriptions.push(
      this.dcService.getDeliveryChallans().subscribe({ next: (v) => { this.deliveryChallans.set(v); done(); }, error: done })
    );
    this.subscriptions.push(
      this.invoiceService.getInvoices().subscribe({ next: (v) => { this.invoices.set(v); done(); }, error: done })
    );
  }

  ngOnDestroy() {
    this.subscriptions.forEach((s) => s.unsubscribe());
  }

  // getPickLists()/getPackingLists()/getDeliveryChallans()/getInvoices() are
  // one-time reads (see their service-level comments) subscribed once in
  // ngOnInit — they never update on their own after a mutation elsewhere in
  // this component. Call the relevant refresh after any write that should be
  // reflected immediately (e.g. Packing List generation, DC generation)
  // instead of relying on a browser refresh to pick up the new state.
  private async refreshPickListsAndPackingLists(): Promise<void> {
    const [pickLists, packingLists] = await Promise.all([
      firstValueFrom(this.pickListService.getPickLists()),
      firstValueFrom(this.packingListService.getPackingLists()),
    ]);
    this.pickLists.set(pickLists);
    this.packingLists.set(packingLists);
  }

  private async refreshDeliveryChallans(): Promise<void> {
    this.deliveryChallans.set(await firstValueFrom(this.dcService.getDeliveryChallans()));
  }

  private async refreshInvoices(): Promise<void> {
    this.invoices.set(await firstValueFrom(this.invoiceService.getInvoices()));
  }

  // ─── Navigation helpers ────────────────────────────────────────────────────

  cancel() {
    // Leaving a view/live-pack session is exactly when packing progress may
    // have changed (cartons sealed, packing completed) without the list-level
    // `packingLists`/`pickLists` signals (one-time reads) knowing about it.
    // Fire-and-forget so the mode switch below isn't delayed by the read.
    void this.refreshPickListsAndPackingLists();
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
    this.currentCustomerIndex.set(0);
    this.packFeedback.set('idle');
    this.scannerMessage.set('Scan carton box no to begin packing.');
    this.agentName.set('');
    this.transport.set('');
    this.packingInProgress.set([]);
    this.activeBoxNo.set('');
    this.boxInput.set('');
    this.combineClientId.set(null);
    this.selectedPickListIdsForCombine.set(new Set());
  }

  // ─── Combine multiple Pick Lists into one Packing List ─────────────────────

  openCombineFlow() {
    this.combineClientId.set(null);
    this.selectedPickListIdsForCombine.set(new Set());
    this.mode.set('combine');
  }

  cancelCombine() {
    this.combineClientId.set(null);
    this.selectedPickListIdsForCombine.set(new Set());
    this.mode.set('list');
  }

  selectCombineCustomer(clientId: string) {
    this.combineClientId.set(clientId);
    this.selectedPickListIdsForCombine.set(new Set());
  }

  togglePickListForCombine(pickListId: string) {
    this.selectedPickListIdsForCombine.update((selected) => {
      const next = new Set(selected);
      if (next.has(pickListId)) next.delete(pickListId);
      else next.add(pickListId);
      return next;
    });
  }

  isPickListSelectedForCombine(pickListId: string): boolean {
    return this.selectedPickListIdsForCombine().has(pickListId);
  }

  async confirmCombinePackingList() {
    const pickLists = this.selectedPickListsForCombine();
    const clientId = this.combineClientId();
    if (!clientId || pickLists.length === 0) return;

    if (pickLists.some((pl) => pl.clientId !== clientId)) {
      await Swal.fire({ icon: 'error', title: 'Error', text: 'All selected Pick Lists must belong to the same customer.' });
      return;
    }

    this.isGenerating.set(true);
    try {
      const linesPerPickList = await Promise.all(pickLists.map(async (pl) => {
        await this.pickListService.ensureLegacyPickListLines(pl);
        const lines = await this.pickListService.getPickListLinesOnce(pl.id!);
        return lines
          .filter((l) => !!l.barcode && ((l.pickedQty || 0) - (l.packedIntoPackingListsQty || 0)) > 0)
          .map((l) => ({ ...l, sourcePickListId: pl.id! }));
      }));
      const allLines = linesPerPickList.flat();

      if (!allLines.length) {
        await Swal.fire({
          icon: 'info',
          title: 'Nothing New to Pack',
          text: 'Every picked unit on the selected Pick Lists has already been carried into a Packing List.',
        });
        return;
      }

      const remainingQty = (l: PickListLine) => Math.max(0, (l.pickedQty || 0) - (l.packedIntoPackingListsQty || 0));
      const totalQty = allLines.reduce((s, l) => s + remainingQty(l), 0);
      const pickListRows = pickLists.map((pl) => {
        const qty = this.getEffectivePickedQty(pl);
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-radius:8px;background:#f8fafc;margin-top:6px">
          <span style="font-size:12px;font-weight:600">${pl.pickListNo}</span>
          <span style="font-size:11px;color:#0f766e;font-weight:700">${qty} pcs</span>
        </div>`;
      }).join('');

      const clientName = pickLists[0].clientName;
      const result = await Swal.fire({
        icon: 'question',
        title: 'Combine into One Packing List?',
        html: `
          <div style="text-align:left;font-size:13px">
            <p><strong>Customer:</strong> ${clientName}</p>
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:12px 0">
              <div style="background:#eef2ff;border-radius:10px;padding:10px;text-align:center">
                <div style="font-size:11px;color:#4338ca;font-weight:700;text-transform:uppercase">Pick Lists</div>
                <div style="font-size:24px;font-weight:700;color:#4338ca">${pickLists.length}</div>
              </div>
              <div style="background:#ecfeff;border-radius:10px;padding:10px;text-align:center">
                <div style="font-size:11px;color:#0f766e;font-weight:700;text-transform:uppercase">Qty to Pack</div>
                <div style="font-size:24px;font-weight:700;color:#0f766e">${totalQty}</div>
              </div>
            </div>
            <p style="font-size:11px;color:#64748b;margin-bottom:2px">Duplicate items (same design/barcode/size) will be merged and quantities summed:</p>
            ${pickListRows}
          </div>`,
        showCancelButton: true,
        confirmButtonText: `Combine ${pickLists.length} Picking List${pickLists.length > 1 ? 's' : ''}`,
        confirmButtonColor: '#0f766e',
      });

      if (!result.isConfirmed) return;

      const salesOrderIds = [...new Set(allLines.map((l) => l.salesOrderId).filter(Boolean))];
      const salesNos = [...new Set(allLines.map((l) => l.salesNo).filter(Boolean))];

      const packingListId = await this.packingListService.createGeneratedPackingList({
        packingListNo: `PK-${Date.now()}`,
        pickListIds: pickLists.map((pl) => pl.id!),
        pickListNos: pickLists.map((pl) => pl.pickListNo),
        salesOrderIds,
        salesNos,
        clientId,
        clientName,
        packingMode: 'customer',
        lines: allLines,
      });

      const created = await this.packingListService.getPackingListByIdOnce(packingListId);
      await this.refreshPickListsAndPackingLists();
      this.combineClientId.set(null);
      this.selectedPickListIdsForCombine.set(new Set());
      this.listTab.set('packing');
      if (!created) { this.mode.set('list'); return; }

      const nextStep = await Swal.fire({
        icon: 'success',
        title: 'Packing List Generated',
        text: `${created.packingListNo} created from ${pickLists.length} Pick List${pickLists.length > 1 ? 's' : ''}. Start carton packing now or review the list first.`,
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

  // ─── Generate flow ─────────────────────────────────────────────────────────

  async initiateGenerate(pickList: PickList) {
    if (!pickList.id) return;

    // A Pick List can be packed in several batches, so existing Packing
    // Lists (shown separately via getPackingListsForPickList in the
    // template) do NOT block generating another one — only how much picked
    // quantity is still un-packed determines what's offered here.
    await this.pickListService.ensureLegacyPickListLines(pickList);
    const lines = await this.pickListService.getPickListLinesOnce(pickList.id);
    const packableLines = lines
      .filter((l) => !!l.barcode && ((l.pickedQty || 0) - (l.packedIntoPackingListsQty || 0)) > 0)
      .map((l) => ({ ...l, sourcePickListId: pickList.id! }));

    if (!packableLines.length) {
      await Swal.fire({
        icon: 'info',
        title: 'Nothing New to Pack',
        text: 'Every picked unit on this Pick List has already been carried into a Packing List. Pick more items to generate another batch.',
      });
      return;
    }

    // Group packable lines by customer (clientId) — one packing list per customer,
    // even when that customer spans multiple Sales Orders within this Pick List.
    const customerGroupMap = new Map<string, { salesOrderIds: Set<string>; salesNos: Set<string>; clientId: string; clientName: string; lines: Array<PickListLine & { sourcePickListId: string }> }>();
    for (const line of packableLines) {
      const clientId = line.clientId ?? pickList.clientId;
      const key = clientId;
      if (!customerGroupMap.has(key)) {
        customerGroupMap.set(key, {
          salesOrderIds: new Set(),
          salesNos: new Set(),
          clientId,
          clientName: line.clientName ?? pickList.clientName,
          lines: [],
        });
      }
      const group = customerGroupMap.get(key)!;
      if (line.salesOrderId) group.salesOrderIds.add(line.salesOrderId);
      if (line.salesNo) group.salesNos.add(line.salesNo);
      group.lines.push(line);
    }
    const customerGroups = [...customerGroupMap.values()].map((g) => ({
      ...g,
      salesOrderIds: [...g.salesOrderIds],
      salesNos: [...g.salesNos],
    }));
    const remainingQty = (l: PickListLine) => Math.max(0, (l.pickedQty || 0) - (l.packedIntoPackingListsQty || 0));

    const totalQty = packableLines.reduce((s, l) => s + remainingQty(l), 0);
    const partCount = new Set(packableLines.map((l) => String(l.group ?? '').trim() || 'General')).size;
    const customerRows = customerGroups.map((g) => {
      const qty = g.lines.reduce((s, l) => s + remainingQty(l), 0);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-radius:8px;background:#f8fafc;margin-top:6px">
        <span style="font-size:12px;font-weight:600">${g.clientName} — ${g.salesNos.join(', ')}</span>
        <span style="font-size:11px;color:#0f766e;font-weight:700">${g.lines.length} lines · ${qty} pcs</span>
      </div>`;
    }).join('');

    const result = await Swal.fire({
      icon: 'question',
      title: 'Generate Packing Lists?',
      html: `
        <div style="text-align:left;font-size:13px">
          <p><strong>Pick List:</strong> ${pickList.pickListNo}</p>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0">
            <div style="background:#ecfeff;border-radius:10px;padding:10px;text-align:center">
              <div style="font-size:11px;color:#0f766e;font-weight:700;text-transform:uppercase">Customers</div>
              <div style="font-size:24px;font-weight:700;color:#0f766e">${customerGroups.length}</div>
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
          <p style="font-size:11px;color:#64748b;margin-bottom:2px">A separate packing list will be created per customer:</p>
          ${customerRows}
        </div>`,
      showCancelButton: true,
      confirmButtonText: `Generate ${customerGroups.length} Packing List${customerGroups.length > 1 ? 's' : ''}`,
      confirmButtonColor: '#0f766e',
    });

    if (!result.isConfirmed) return;

    this.isGenerating.set(true);
    try {
      const createdIds: string[] = [];
      for (const group of customerGroups) {
        const packingListId = await this.packingListService.createGeneratedPackingList({
          packingListNo: `PK-${Date.now()}`,
          pickListIds: [pickList.id],
          pickListNos: [pickList.pickListNo],
          salesOrderIds: group.salesOrderIds,
          salesNos: group.salesNos,
          clientId: group.clientId,
          clientName: group.clientName,
          packingMode: 'customer',
          lines: group.lines,
        });
        createdIds.push(packingListId);
      }

      this.listTab.set('packing');
      const firstCreated = await this.packingListService.getPackingListByIdOnce(createdIds[0]);
      await this.refreshPickListsAndPackingLists();
      if (!firstCreated) { this.mode.set('list'); return; }

      const nextStep = await Swal.fire({
        icon: 'success',
        title: `${createdIds.length} Packing List${createdIds.length > 1 ? 's' : ''} Generated`,
        text: customerGroups.length > 1
          ? `One packing list per customer. Starting with ${customerGroups[0].clientName} — ${customerGroups[0].salesNos.join(', ')}.`
          : 'Start carton packing now or review the list first.',
        showCancelButton: true,
        confirmButtonText: 'Start Packing Now',
        cancelButtonText: 'Review List',
        confirmButtonColor: '#16a34a',
        cancelButtonColor: '#64748b',
      });

      if (nextStep.isConfirmed) await this.startPacking(firstCreated);
      else await this.openView(firstCreated);
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
    let agentName = loaded.agentName ?? '';
    if (!agentName && loaded.clientId) {
      const client = await this.clientService.getClientByIdOnce(loaded.clientId);
      agentName = client?.agentName ?? '';
    }
    this.agentName.set(agentName);
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

    const barcodes = [...new Set(lines.map((l) => l.barcode).filter(Boolean))] as string[];
    const invItems = barcodes.length ? await this.inventoryService.getInventoryByBarcodes(barcodes) : [];
    this.liveMrpByBarcode.set(new Map(invItems.map((inv) => [inv.barcode, Number(inv.price) || 0])));

    let agentName = loaded.agentName ?? '';
    if (!agentName && loaded.clientId) {
      const client = await this.clientService.getClientByIdOnce(loaded.clientId);
      agentName = client?.agentName ?? '';
    }
    this.agentName.set(agentName);
    this.transport.set(loaded.transport ?? '');
    this.mode.set('live-pack');
    this.packFeedback.set('idle');
    this.barcodeInput.set('');
    this.scanQty.set(1);
    this.cartonInput.set('');
    this.activeCartonNo.set('');
    this.activePartyId.set('');
    const groups = this.liveLinesByCustomer();
    const firstPending = groups.findIndex((g) => g.lines.some((l) => l.status !== 'completed'));
    this.currentCustomerIndex.set(firstPending >= 0 ? firstPending : 0);
    this.scannerMessage.set('Scan carton box no to begin packing.');
  }

  getLineMrp(line: PackingListLine): number {
    return this.liveMrpByBarcode().get(line.barcode ?? '') ?? 0;
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

  advanceToNextCustomer() {
    const nextGroups = this.liveLinesByCustomer();
    const next = this.currentCustomerIndex() + 1;
    if (next < nextGroups.length) {
      this.currentCustomerIndex.set(next);
      this.activeBoxNo.set('');
      this.boxInput.set('');
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

  // ─── Invoice Generation ────────────────────────────────────────────────────

  // A Packing List can produce several DCs (one per Sales Order — see
  // generateAndPrintDC). Each DC is invoiced independently, one Invoice per
  // DC, built directly from that DC's own items — so an Invoice's items and
  // quantities always exactly mirror the DC it came from, including any
  // additional/extra scanned items the DC already carries. A single click
  // here generates an invoice for every DC on this Packing List that doesn't
  // have one yet.
  async generateInvoice(packingList: PackingList): Promise<void> {
    if (!packingList.id || this.isGeneratingInvoice()) return;

    const dcs = await this.dcService.getDCsByPackingListIdOnce(packingList.id);
    if (!dcs.length) {
      await Swal.fire({ icon: 'warning', title: 'No Delivery Challan Yet', text: 'Generate the Delivery Challan before creating an Invoice.' });
      return;
    }

    // Set only on an explicit "Generate New Invoice" override below —
    // createInvoice() otherwise atomically rejects a second invoice for the
    // same DC, closing the double-click/two-tab race a plain pre-check can't.
    let allowDuplicateInvoice = false;

    const existingInvoices = await this.invoiceService.getInvoicesByDCIdsOnce(dcs.map((d) => d.id!));
    const invoicedDcIds = new Set(existingInvoices.map((inv) => inv.dcId).filter(Boolean));
    let dcsToInvoice = dcs.filter((dc) => !invoicedDcIds.has(dc.id));

    if (!dcsToInvoice.length) {
      const result = await Swal.fire({
        icon: 'info',
        title: 'Invoice Already Generated',
        html: '<p style="font-size:13px">Invoice(s) already exist: <strong>' + existingInvoices.map((i) => i.invoiceNo).join(', ') + '</strong></p>',
        showConfirmButton: true,
        showDenyButton: true,
        showCancelButton: true,
        confirmButtonText: 'Reprint Existing',
        denyButtonText: 'Generate New Invoice',
        cancelButtonText: 'Close',
        confirmButtonColor: '#4f46e5',
        denyButtonColor: '#d97706',
      });
      if (result.isConfirmed) { for (const inv of existingInvoices) await this.reprintInvoice(inv); return; }
      if (!result.isDenied) return;
      allowDuplicateInvoice = true;
      dcsToInvoice = dcs;
    }

    const primaryDc = dcsToInvoice[0];

    const { value: formValues } = await Swal.fire({
      title: 'Invoice Settings',
      html: '<div style="text-align:left;font-size:13px">'
        + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">HSN/SAC Code</label>'
        + '<input id="inv-hsn" class="swal2-input" style="margin:0;width:100%" value="62059090"></div>'
        + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Discount %</label>'
        + '<input id="inv-disc" type="number" class="swal2-input" style="margin:0;width:100%" value="10"></div>'
        + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Tax Rate % (total GST)</label>'
        + '<input id="inv-tax" type="number" class="swal2-input" style="margin:0;width:100%" value="5"></div>'
        + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Vehicle No.</label>'
        + '<input id="inv-vehicle" class="swal2-input" style="margin:0;width:100%" value=""></div>'
        + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Document No.</label>'
        + '<input id="inv-docno" class="swal2-input" style="margin:0;width:100%" value=""></div>'
        + '<div><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Destination</label>'
        + '<input id="inv-dest" class="swal2-input" style="margin:0;width:100%" value="' + (primaryDc?.place || packingList.clientName || '') + '"></div>'
        + '</div>',
      showCancelButton: true,
      confirmButtonText: 'Generate Invoice',
      confirmButtonColor: '#4f46e5',
      preConfirm: () => ({
        hsnSac: (document.getElementById('inv-hsn') as HTMLInputElement).value.trim() || '62059090',
        discountPct: Number((document.getElementById('inv-disc') as HTMLInputElement).value) || 0,
        taxRate: Number((document.getElementById('inv-tax') as HTMLInputElement).value) || 5,
        vehicleNo: (document.getElementById('inv-vehicle') as HTMLInputElement).value.trim(),
        docNo: (document.getElementById('inv-docno') as HTMLInputElement).value.trim(),
        destination: (document.getElementById('inv-dest') as HTMLInputElement).value.trim(),
      }),
    });
    if (!formValues) return;

    this.isGeneratingInvoice.set(true);
    try {
      const loaded = (await this.packingListService.getPackingListByIdOnce(packingList.id)) ?? packingList;
      const inventoryList = await firstValueFrom(this.inventoryService.getInventory());
      const { discountPct, taxRate, hsnSac } = formValues;
      const halfTax = taxRate / 2;

      const generatedInvoices: Invoice[] = [];
      for (const dc of dcsToInvoice) {
        const clientName = dc.clientName || loaded.clientName;
        const clientId = loaded.clientId;
        const client = await this.clientService.getClientForDC(clientId, clientName);

        // Mirrors the DC exactly: one InvoiceItem per DCItem, same quantity.
        const invoiceItems = dc.items.map((dcItem) => {
          const wsp = this.findWspForDCItem(inventoryList, dcItem);
          const amount = Math.round(dcItem.total * wsp * 100) / 100;
          return { description: dcItem.partName, hsnSac, discountPct, taxRate, mrp: dcItem.mrp, uom: 'NOS', quantity: dcItem.total, price: wsp, amount };
        });

        const grossAmount = Math.round(invoiceItems.reduce((s, i) => s + i.amount, 0) * 100) / 100;
        const discountAmount = Math.round(grossAmount * discountPct / 100 * 100) / 100;
        const taxableValue = Math.round((grossAmount - discountAmount) * 100) / 100;
        const cgstAmount = Math.round(taxableValue * halfTax / 100 * 100) / 100;
        const sgstAmount = cgstAmount;
        const totalTaxAmount = Math.round((cgstAmount + sgstAmount) * 100) / 100;
        const rawTotal = taxableValue + totalTaxAmount;
        const totalAmount = Math.round(rawTotal);
        const roundOff = Math.round((totalAmount - rawTotal) * 100) / 100;

        const invoice = await this.invoiceService.createInvoice({
          dcId: dc.id!,
          dcNo: dc.dcNo,
          packingListId: loaded.id!,
          packingListNo: loaded.packingListNo,
          salesOrderIds: dc.salesOrderId ? [dc.salesOrderId] : loaded.salesOrderIds,
          salesNos: dc.salesNo ? [dc.salesNo] : loaded.salesNos,
          orderNo: dc.salesNo || (loaded.salesNos ?? []).join(', '),
          clientId,
          clientName,
          clientAddress: client?.billingAddress ?? '',
          clientPlace: client?.place ?? '',
          clientState: client?.state ?? '',
          clientZipCode: client?.zipCode ?? '',
          clientPhone: client?.mobile ?? '',
          clientGstin: client?.gstNo ?? '',
          destination: formValues.destination,
          transport: dc.transport ?? loaded.transport ?? '',
          vehicleNo: formValues.vehicleNo,
          docNo: formValues.docNo,
          shipmentDate: dc.createdAt ?? null,
          totalPkgs: dc.boxCount,
          agentName: dc.agentName ?? loaded.agentName ?? '',
          items: invoiceItems,
          grossAmount, discountPct, discountAmount, taxableValue,
          cgstRate: halfTax, cgstAmount, sgstRate: halfTax, sgstAmount,
          igstRate: 0, igstAmount: 0, totalTaxAmount, roundOff, totalAmount,
          amountInWords: this.amountToWords(totalAmount),
          taxSummary: [{ hsnSac, taxableValue, cgstRate: halfTax, cgstAmount, sgstRate: halfTax, sgstAmount, igstRate: 0, igstAmount: 0 }],
        }, { allowDuplicate: allowDuplicateInvoice });
        generatedInvoices.push(invoice);
      }

      await this.refreshInvoices();

      const title = generatedInvoices.length > 1
        ? generatedInvoices.length + ' Invoices Generated!'
        : 'Invoice ' + generatedInvoices[0].invoiceNo + ' Generated!';
      const html = '<p style="font-size:13px">' + generatedInvoices
        .map((inv) => inv.invoiceNo + ': <strong>&#x20B9;' + inv.totalAmount.toLocaleString('en-IN') + '</strong>')
        .join('<br>') + '</p>';

      await Swal.fire({
        icon: 'success',
        title,
        html,
        showConfirmButton: true,
        showDenyButton: true,
        showCancelButton: true,
        confirmButtonText: generatedInvoices.length > 1 ? 'Print Invoices' : 'Print Invoice',
        denyButtonText: 'Download Excel',
        cancelButtonText: 'Close',
        confirmButtonColor: '#4f46e5',
        denyButtonColor: '#059669',
      }).then(async (res) => {
        if (res.isConfirmed) { for (const inv of generatedInvoices) await this.reprintInvoice(inv); }
        if (res.isDenied) { for (const inv of generatedInvoices) await this.downloadInvoiceExcel(inv); }
      });
    } catch (err: any) {
      const text = err?.message === 'already_has_invoice'
        ? 'An invoice has already been generated for one of these Delivery Challans.'
        : err?.message ?? 'Unable to generate invoice.';
      await Swal.fire({ icon: 'error', title: 'Invoice Generation Failed', text });
      await this.refreshInvoices();
    } finally {
      this.isGeneratingInvoice.set(false);
    }
  }

  // DCItem is grouped by style/color/sleeve, not by barcode, so its selling
  // price is resolved the same way pick-list.service.ts's inventory matching
  // does: exact styleNo+color+sleeveType match preferred, falling back to any
  // sleeve variant of that styleNo+color.
  private findWspForDCItem(inventoryList: InventoryItem[], dcItem: DCItem): number {
    const candidates = inventoryList.filter((inv) => inv.styleNo === dcItem.styleNo && inv.color === dcItem.color);
    const exact = candidates.find((inv) => (inv.sleeveType ?? '') === (dcItem.sleeveType ?? ''));
    if (exact) return Number(exact.WSP) || 0;
    const fallback = candidates.find((inv) => !dcItem.sleeveType || !inv.sleeveType);
    if (fallback) return Number(fallback.WSP) || 0;
    return candidates[0] ? Number(candidates[0].WSP) || 0 : 0;
  }

  async reprintInvoice(invoice: Invoice): Promise<void> {
    const logoDataUri = await this.fetchLogoDataUri();
    const html = this.buildInvoiceHtml(invoice, logoDataUri);
    const win = window.open('', '_blank', 'width=1100,height=820');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
  }

  private async fetchLogoDataUri(): Promise<string> {
    try {
      const res = await fetch('/assets/logo.jpeg');
      if (!res.ok) return '';
      const blob = await res.blob();
      return new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
      });
    } catch {
      return '';
    }
  }

  async downloadInvoiceExcel(invoice: Invoice): Promise<void> {
    try {
      const XLSX = await import('xlsx');
      const rows: any[][] = [
        ['TMG Clothings', '', '', '', 'GSTIN: 33AAYFT2559B1ZY'],
        ['Door No.334/2, Serayampalaym, Vellanaipatti Post, Coimbatore - 641048'],
        ['Phone: 9842211787 | Email: order@tmggarments.in'],
        [],
        ['TAX INVOICE'],
        [],
        ['Invoice No:', invoice.invoiceNo, '', 'Invoice Date:', this.formatDate(invoice.invoiceDate)],
        ['DC No:', invoice.dcNo, '', 'Order No:', invoice.orderNo],
        ['Vehicle No:', invoice.vehicleNo, '', 'Total Pkgs:', invoice.totalPkgs],
        ['Transport:', invoice.transport, '', 'Destination:', invoice.destination],
        ['Agent:', invoice.agentName],
        [],
        ['Customer:', invoice.clientName],
        ['Address:', [invoice.clientAddress, invoice.clientPlace, invoice.clientState, invoice.clientZipCode].filter(Boolean).join(', ')],
        ['GSTIN:', invoice.clientGstin, '', 'Phone:', invoice.clientPhone],
        [],
        ['S.No', 'Description', 'HSN/SAC', 'Disc%', 'Tax%', 'MRP', 'UOM', 'Qty', 'Price', 'Amount'],
        ...invoice.items.map((item, i) => [i + 1, item.description, item.hsnSac, item.discountPct, item.taxRate, item.mrp, item.uom, item.quantity, item.price, item.amount]),
        [],
        ['', '', '', '', '', '', '', '', 'Gross Amount:', invoice.grossAmount],
        ['', '', '', '', '', '', '', '', 'Discount (' + invoice.discountPct + '%):', invoice.discountAmount],
        ['', '', '', '', '', '', '', '', 'Taxable Value:', invoice.taxableValue],
        ['', '', '', '', '', '', '', '', 'CGST (' + invoice.cgstRate + '%):', invoice.cgstAmount],
        ['', '', '', '', '', '', '', '', 'SGST (' + invoice.sgstRate + '%):', invoice.sgstAmount],
        ['', '', '', '', '', '', '', '', 'Total Tax:', invoice.totalTaxAmount],
        ['', '', '', '', '', '', '', '', 'Round Off:', invoice.roundOff],
        ['', '', '', '', '', '', '', '', 'TOTAL:', invoice.totalAmount],
        [],
        ['Amount in Words:', invoice.amountInWords],
        [],
        ['Bank Details:'],
        ['Account Name: TMG Clothings', '', 'A/C No: 44358238258'],
        ['IFSC: SBIN0061170', '', 'Bank: STATE BANK OF INDIA, Siruthozhil Branch, Kovilpatti'],
      ];
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 6 }, { wch: 8 }, { wch: 14 }, { wch: 14 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Invoice');
      XLSX.writeFile(wb, invoice.invoiceNo + '.xlsx');
    } catch {
      await Swal.fire({ icon: 'error', title: 'Excel Export Failed', text: 'Unable to generate Excel. Please try printing the PDF instead.' });
    }
  }

  async printEnhancedBoxLabels(packingList: PackingList): Promise<void> {
    if (!packingList.id) return;
    const existingDCs = await this.dcService.getDCsByPackingListIdOnce(packingList.id);
    const dc = existingDCs.length > 0 ? existingDCs[0] : null;
    const existingInvoices = await this.invoiceService.getInvoicesByPackingListIdOnce(packingList.id);
    const invoiceNo = existingInvoices.length > 0 ? existingInvoices[0].invoiceNo : '';
    const cartons = packingList.cartons ?? [];
    if (!cartons.length) {
      await Swal.fire({ toast: true, position: 'top-end', icon: 'warning', title: 'No cartons to print', timer: 2000, showConfirmButton: false });
      return;
    }
    const totalBoxes = cartons.length;
    const labelsHtml = cartons.map((_, idx) => this.buildEnhancedBoxLabelHtml(packingList, idx, totalBoxes, dc, invoiceNo)).join('');
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Box Labels - ' + packingList.packingListNo + '</title>'
      + '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:10px;background:#fff}'
      + '.label-page{width:23cm;height:10.5cm;page-break-after:always;overflow:hidden;display:flex;flex-direction:column;border:1px solid #000}'
      + '@media print{@page{size:23cm 10.5cm;margin:0}body{margin:0}.label-page{border:none;page-break-after:always}}'
      + '</style></head><body>' + labelsHtml + '</body></html>';
    const win = window.open('', '_blank', 'width=900,height=500');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
  }

  // ─── Print ─────────────────────────────────────────────────────────────────

  async printReadyPickList(pickList: PickList) {
    const lines = pickList.id ? await this.pickListService.getPickListLinesOnce(pickList.id) : pickList.items;
    const html = this.buildReadyPickListPrintHtml(pickList, lines);
    const win = window.open('', '_blank', 'width=1050,height=750');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
  }

  private buildReadyPickListPrintHtml(pickList: PickList, lines: PickListLine[]): string {
    const toPackLines = lines
      .map((line) => {
        const pickedQty = Math.max(0, Number(line.pickedQty ?? 0) || 0);
        const packedQty = Math.max(0, Number(line.packedIntoPackingListsQty ?? 0) || 0);
        const toPackQty = Math.max(0, pickedQty - packedQty);
        return {
          styleNo: line.styleNo,
          color: line.color || '',
          part: String(line.group ?? '').trim() || 'General',
          size: String(line.size),
          sleeveType: line.sleeveType ?? '',
          pickedQty,
          packedQty,
          toPackQty,
        };
      })
      .filter((line) => line.toPackQty > 0);

    const totals = toPackLines.reduce((sum, line) => ({
      picked: sum.picked + line.pickedQty,
      packed: sum.packed + line.packedQty,
      toPack: sum.toPack + line.toPackQty,
    }), { picked: 0, packed: 0, toPack: 0 });

    // Pivot into one row per product (style/part/color/sleeve) with one
    // column per size, instead of one row per item+size — matches the
    // packer's physical picking sheet layout (product rows × size columns).
    interface ProductRow {
      styleNo: string;
      part: string;
      color: string;
      sleeveType: string;
      qtyBySize: Map<string, number>;
      total: number;
    }
    const productMap = new Map<string, ProductRow>();
    const sizeSet = new Set<string>();

    for (const line of toPackLines) {
      sizeSet.add(line.size);
      const key = `${line.styleNo}||${line.part}||${line.color}||${line.sleeveType}`;
      const existing = productMap.get(key);
      if (existing) {
        existing.qtyBySize.set(line.size, (existing.qtyBySize.get(line.size) ?? 0) + line.toPackQty);
        existing.total += line.toPackQty;
      } else {
        productMap.set(key, {
          styleNo: line.styleNo,
          part: line.part,
          color: line.color,
          sleeveType: line.sleeveType,
          qtyBySize: new Map([[line.size, line.toPackQty]]),
          total: line.toPackQty,
        });
      }
    }

    const sizes = [...sizeSet].sort((a, b) => this.rankSize(a) - this.rankSize(b));
    const productRows = [...productMap.values()].sort((a, b) => {
      const styleCompare = a.styleNo.localeCompare(b.styleNo, undefined, { numeric: true });
      if (styleCompare !== 0) return styleCompare;
      return a.color.localeCompare(b.color, undefined, { numeric: true });
    });
    const sizeTotals = sizes.map((size) => productRows.reduce((sum, row) => sum + (row.qtyBySize.get(size) ?? 0), 0));
    const grandTotal = productRows.reduce((sum, row) => sum + row.total, 0);
    const productLabel = (row: ProductRow) => [row.styleNo, row.part, row.color, row.sleeveType].filter(Boolean).join(' - ');

    const buildHeaderCell = (label: string, align: 'left' | 'center' | 'right' = 'left') =>
      `<th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700;text-transform:uppercase;text-align:${align};letter-spacing:0.04em">${label}</th>`;

    const htmlRows = productRows.map((row, index) => `
        <tr style="background:${index % 2 === 0 ? '#ffffff' : '#f8fafc'}">
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;color:#64748b">${index + 1}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;font-weight:700;color:#111827">${productLabel(row)}</td>
          ${sizes.map((size) => `<td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;color:#334155">${row.qtyBySize.get(size) || '-'}</td>`).join('')}
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:#0f766e">${row.total}</td>
        </tr>`).join('');

    const footerRow = `
        <tr>
          <td colspan="2" style="padding:9px 10px;border:1px solid #d7deea;text-align:right">Totals</td>
          ${sizeTotals.map((t) => `<td style="padding:9px 10px;border:1px solid #d7deea;text-align:center">${t}</td>`).join('')}
          <td style="padding:9px 10px;border:1px solid #d7deea;text-align:center">${grandTotal}</td>
        </tr>`;

    const printedAtLabel = new Date().toLocaleString('en-IN');

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Ready to Pack - ${pickList.pickListNo}</title>
          <style>
            body { font-family: Arial, sans-serif; font-size: 12px; margin: 18px; color: #0f172a; }
            h1, p { margin: 0; }
            .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 12px; }
            .meta { margin-top: 4px; color: #64748b; font-size: 11px; line-height: 1.5; }
            .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 14px 0 10px; }
            .box { border: 1px solid #d7deea; background: #f8fafc; border-radius: 10px; padding: 10px 12px; }
            .label { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.04em; }
            .value { margin-top: 5px; font-size: 20px; font-weight: 700; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            tfoot td { background: #eff6ff; font-weight: 700; }
            @media print { body { margin: 10px; } .summary { gap: 8px; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <h1 style="font-size:24px">Ready to Pack — ${pickList.pickListNo}</h1>
              <p class="meta">${(pickList.salesNos ?? []).join(', ')} · ${pickList.clientName}</p>
            </div>
            <div style="text-align:right">
              <div style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase">Printed At</div>
              <div style="margin-top:4px;font-size:12px;color:#0f172a">${printedAtLabel}</div>
            </div>
          </div>

          <div class="summary">
            <div class="box"><div class="label">Picked Qty</div><div class="value" style="color:#15803d">${totals.picked}</div></div>
            <div class="box"><div class="label">Already Packed</div><div class="value" style="color:#64748b">${totals.packed}</div></div>
            <div class="box"><div class="label">To Pack Now</div><div class="value" style="color:#0f766e">${totals.toPack}</div></div>
          </div>

          <table>
            <thead>
              <tr>
                ${buildHeaderCell('#', 'center')}
                ${buildHeaderCell('Product')}
                ${sizes.map((size) => buildHeaderCell(size, 'center')).join('')}
                ${buildHeaderCell('Qty (Pcs)', 'center')}
              </tr>
            </thead>
            <tbody>${htmlRows}</tbody>
            <tfoot>${footerRow}</tfoot>
          </table>
        </body>
      </html>`;
  }

  async printPackingList(packingList: PackingList) {
    if (!packingList.id) return;
    const [fresh, lines] = await Promise.all([
      this.packingListService.getPackingListByIdOnce(packingList.id),
      this.packingListService.getPackingListLinesOnce(packingList.id),
    ]);
    const barcodes = [...new Set(lines.map((l) => l.barcode).filter(Boolean))] as string[];
    const invItems = barcodes.length ? await this.inventoryService.getInventoryByBarcodes(barcodes) : [];
    const mrpByBarcode = new Map<string, number>();
    for (const inv of invItems) mrpByBarcode.set(inv.barcode, Number(inv.price) || 0);
    const html = this.buildPrintHtml(fresh ?? packingList, lines, mrpByBarcode);
    const win = window.open('', '_blank', 'width=1100,height=780');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
  }

  async exportPackingListToExcel(packingList: PackingList): Promise<void> {
    if (!packingList.id) return;
    try {
      const [fresh, lines] = await Promise.all([
        this.packingListService.getPackingListByIdOnce(packingList.id),
        this.packingListService.getPackingListLinesOnce(packingList.id),
      ]);
      const loaded = fresh ?? packingList;
      const XLSX = await import('xlsx');
      const rows: any[][] = [
        ['Packing List No:', loaded.packingListNo, '', 'Date:', this.formatDate(loaded.createdAt)],
        ['Source Pick List(s):', (loaded.pickListNos ?? []).join(', ')],
        ['Customer:', loaded.clientName, '', 'Orders:', (loaded.salesNos ?? []).join(', ')],
        [],
        ['S.No', 'Style No', 'Color', 'Part', 'Size', 'Sleeve', 'Barcode', 'Required Qty', 'Packed Qty'],
        ...lines.map((line, i) => [
          i + 1, line.styleNo, line.color, line.partName, line.size, line.sleeveType ?? '',
          line.barcode ?? '', line.requiredQty, line.packedQty,
        ]),
        [],
        ['', '', '', '', '', '', 'TOTAL:', loaded.totalRequiredQty, loaded.totalPackedQty],
      ];
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 16 }, { wch: 12 }, { wch: 12 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Packing List');
      XLSX.writeFile(wb, `${loaded.packingListNo}.xlsx`);
    } catch {
      await Swal.fire({ icon: 'error', title: 'Excel Export Failed', text: 'Unable to generate Excel. Please try printing the PDF instead.' });
    }
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

  // ─── DC Generation ─────────────────────────────────────────────────────────

  async generateAndPrintDC(packingList: PackingList) {
    if (!packingList.id || this.isGeneratingDC()) return;

    const existingDCs = await this.dcService.getDCsByPackingListIdOnce(packingList.id);

    // Set only when the user explicitly overrides an existing DC via
    // "Generate New DC" below — createDC() otherwise atomically rejects a
    // second DC for the same (Packing List, Sales Order), which is what
    // stops an accidental duplicate (e.g. a double-click firing two
    // near-simultaneous first-time generate calls before either completes).
    let allowDuplicate = false;

    if (existingDCs.length > 0) {
      const result = await Swal.fire({
        icon: 'info',
        title: 'DC Already Generated',
        html: `<p style="font-size:13px">DC(s) already exist: <strong>${existingDCs.map((d) => d.dcNo).join(', ')}</strong></p>`,
        showConfirmButton: true,
        showDenyButton: true,
        showCancelButton: true,
        confirmButtonText: 'Reprint Existing',
        denyButtonText: 'Generate New DC',
        cancelButtonText: 'Close',
        confirmButtonColor: '#4f46e5',
        denyButtonColor: '#d97706',
      });
      if (result.isConfirmed) {
        const refreshedDCs = await this.backfillDCSleeveTypes(existingDCs, packingList.id);
        await this.printDCsWithLabels(refreshedDCs.sort((a, b) => a.dcSeq - b.dcSeq), packingList);
        return;
      }
      if (!result.isDenied) return;
      allowDuplicate = true;
    }

    this.isGeneratingDC.set(true);
    try {
      const [fresh, lines] = await Promise.all([
        this.packingListService.getPackingListByIdOnce(packingList.id),
        this.packingListService.getPackingListLinesOnce(packingList.id),
      ]);
      const loaded = fresh ?? packingList;
      const agentName = this.agentName().trim();
      const transport = this.transport().trim();

      if (agentName || transport) {
        await this.packingListService.updateDispatchInfo(packingList.id, agentName, transport);
      }

      const partyProgress = loaded.partyProgress ?? [];
      const generatedDCs: DeliveryChallan[] = [];

      if (partyProgress.length === 0) {
        const client = await this.clientService.getClientForDC(loaded.clientId, loaded.clientName);
        const dc = await this.createDCForParty(loaded, lines, client, '', '', loaded.clientName, agentName, transport, allowDuplicate);
        generatedDCs.push(dc);
      } else {
        // A line can end up with no salesOrderId at all only in an edge case
        // (a source Pick List line with no Sales Order attribution) — rather
        // than let it match no party and vanish from every DC, it's billed
        // under the Packing List's primary Sales Order, same as where
        // PickListService.processPartyScan attributes an additional scan
        // with no explicit order of its own.
        const primarySalesOrderId = partyProgress[0]?.salesOrderId ?? '';
        for (const party of partyProgress) {
          const partyLines = lines.filter((l) =>
            l.salesOrderIds.includes(party.salesOrderId) ||
            (l.salesOrderIds.length === 0 && party.salesOrderId === primarySalesOrderId)
          );
          if (!partyLines.length) continue;
          const clientName = party.clientName || loaded.clientName;
          const clientId = party.clientId || loaded.clientId;
          const client = await this.clientService.getClientForDC(clientId, clientName);
          const dc = await this.createDCForParty(loaded, partyLines, client, party.salesOrderId, party.salesNo, clientName, agentName, transport, allowDuplicate);
          generatedDCs.push(dc);
        }
      }

      await this.refreshDeliveryChallans();
      await this.printDCsWithLabels(generatedDCs, loaded);
      this.cancel();
    } catch (err: any) {
      const text = err?.message === 'already_has_dc'
        ? 'A DC has already been generated for this Packing List.'
        : err?.message ?? 'Unable to generate Delivery Challan.';
      await Swal.fire({ icon: 'error', title: 'DC Generation Failed', text });
      await this.refreshDeliveryChallans();
    } finally {
      this.isGeneratingDC.set(false);
    }
  }

  async reprintDC(dc: DeliveryChallan) {
    const html = `<!DOCTYPE html><html>
<head><meta charset="utf-8"><title>DC - ${dc.dcNo}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:11px;color:#000}table{width:100%;border-collapse:collapse}</style></head>
<body>${this.buildCustomerDCHtml(dc, 1, 1)}</body></html>`;
    const win = window.open('', '_blank', 'width=960,height=820');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
  }

  // ─── Click-based packing ───────────────────────────────────────────────────

  setActiveBox() {
    const box = this.boxInput().trim().toUpperCase();
    if (!box) return;
    this.activeBoxNo.set(box);
    this.boxInput.set(box);
  }

  async markLinePacked(line: PackingListLine, packed: boolean) {
    const packingList = this.livePackingList();
    if (!packingList?.id || this.packingInProgress().includes(line.lineId)) return;

    if (packed && !this.activeBoxNo()) {
      await Swal.fire({ toast: true, position: 'top-end', icon: 'warning', title: 'Enter a box number first', timer: 2000, showConfirmButton: false });
      return;
    }

    this.packingInProgress.update((ids) => [...ids, line.lineId]);
    try {
      const cartonNo = packed ? this.activeBoxNo() : undefined;
      const result = await this.packingListService.markLinePacked(packingList.id, line.lineId, packed, cartonNo);
      this.liveLines.update((lines) => lines.map((l) => (l.lineId === result.line.lineId ? result.line : l)));
      this.livePackingList.update((current) => current ? {
        ...current,
        totalPackedQty: result.totalPackedQty,
        completedLineCount: result.completedLineCount,
        cartonCount: result.cartonCount,
        status: result.status,
        partyProgress: result.partyProgress,
        cartons: result.cartons,
      } : current);

      if (result.packingListCompleted) {
        await Swal.fire({
          icon: 'success',
          title: 'All Items Packed!',
          html: `<p style="font-size:13px">All items confirmed as packed.</p>
            ${result.stockDeducted ? '<p style="font-size:12px;color:#047857;margin-top:6px">&#10003; Inventory stock reduced automatically.</p>' : ''}`,
          timer: 3000,
          showConfirmButton: false,
        });
      } else if (packed) {
        const currentGroup = this.currentCustomerGroup();
        if (currentGroup && currentGroup.lines.every((l) => l.status === 'completed')) {
          const allGroups = this.liveLinesByCustomer();
          const nextIdx = this.currentCustomerIndex() + 1;
          if (nextIdx < allGroups.length) {
            await Swal.fire({
              icon: 'success',
              title: `${currentGroup.customerName} — Done!`,
              html: `<p style="font-size:13px">All items packed for <strong>${currentGroup.customerName}</strong>.</p>
                <p style="font-size:12px;color:#0f766e;margin-top:6px">Next: <strong>${allGroups[nextIdx].customerName}</strong></p>`,
              confirmButtonText: 'Pack Next Customer →',
              confirmButtonColor: '#0f766e',
              allowOutsideClick: false,
            });
            this.currentCustomerIndex.set(nextIdx);
            this.activeBoxNo.set('');
            this.boxInput.set('');
          }
        }
      }
    } catch {
      await Swal.fire({ toast: true, position: 'top-end', icon: 'error', title: 'Update failed', timer: 2000, showConfirmButton: false });
    } finally {
      this.packingInProgress.update((ids) => ids.filter((id) => id !== line.lineId));
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

  countPackedLines(lines: PackingListLine[]): number {
    return lines.filter((l) => l.status === 'completed').length;
  }

  sumRequiredQty(lines: PackingListLine[]): number {
    return lines.reduce((s, l) => s + l.requiredQty, 0);
  }

  getPackingForPickList(pickListId: string): PackingList | null {
    return this.packingLists().find((pl) => pl.pickListId === pickListId) ?? null;
  }

  getPackingListsForPickList(pickListId: string): PackingList[] {
    if (!pickListId) return [];
    return this.packingLists().filter((pl) => pl.pickListId === pickListId || pl.pickListIds?.includes(pickListId));
  }

  getFirstIncompletePacking(packingLists: PackingList[]): PackingList | null {
    return packingLists.find((pl) => pl.status !== 'Completed') ?? null;
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

  getViewCartonsGrouped(packingList: PackingList): { customerName: string; salesNo: string; cartons: PackingCarton[] }[] {
    const partyProgress = packingList.partyProgress ?? [];
    if (partyProgress.length <= 1) {
      return [{ customerName: packingList.clientName, salesNo: (packingList.salesNos ?? []).join(', '), cartons: packingList.cartons ?? [] }];
    }
    return partyProgress
      .map((party) => ({
        customerName: party.clientName || party.salesNo,
        salesNo: party.salesNo,
        cartons: (packingList.cartons ?? []).filter((c) =>
          c.entries.some((e) => e.salesOrderIds.includes(party.salesOrderId))
        ),
      }))
      .filter((g) => g.cartons.length > 0);
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

  // DCs generated before the Sleeve column existed have items with no
  // sleeveType in their stored data (the pick list/packing list lines they
  // were built from do carry it). Rather than silently recomputing an
  // already-issued DC's quantities, this only fills the missing sleeveType
  // per (partName, styleNo, color) from the current packing list lines and
  // persists that one field back onto the same DC document/number.
  private async backfillDCSleeveTypes(dcs: DeliveryChallan[], packingListId: string): Promise<DeliveryChallan[]> {
    const needsBackfill = dcs.some((dc) => dc.items.some((item) => !item.sleeveType));
    if (!needsBackfill) return dcs;

    const lines = await this.packingListService.getPackingListLinesOnce(packingListId);
    const sleeveByKey = new Map<string, string>();
    for (const line of lines) {
      if (!line.sleeveType) continue;
      sleeveByKey.set(`${line.partName}||${line.styleNo}||${line.color}`, line.sleeveType);
    }
    if (!sleeveByKey.size) return dcs;

    return Promise.all(dcs.map(async (dc) => {
      let changed = false;
      const items: DCItem[] = dc.items.map((item) => {
        if (item.sleeveType) return item;
        const sleeveType = sleeveByKey.get(`${item.partName}||${item.styleNo}||${item.color}`);
        if (!sleeveType) return item;
        changed = true;
        return { ...item, sleeveType };
      });
      if (changed && dc.id) await this.dcService.updateDCItems(dc.id, items);
      return changed ? { ...dc, items } : dc;
    }));
  }

  private async createDCForParty(
    packingList: PackingList,
    lines: PackingListLine[],
    client: any,
    salesOrderId: string,
    salesNo: string,
    clientName: string,
    agentName: string,
    transport: string,
    allowDuplicate = false,
  ): Promise<DeliveryChallan> {
    const packedLines = lines.filter((l) => l.packedQty > 0 || l.requiredQty > 0);

    const barcodes = [...new Set(packedLines.map((l) => l.barcode).filter(Boolean))] as string[];
    const invItems = barcodes.length ? await this.inventoryService.getInventoryByBarcodes(barcodes) : [];
    const mrpByBarcode = new Map<string, number>();
    for (const inv of invItems) mrpByBarcode.set(inv.barcode, Number(inv.price) || 0);

    const rowMap = new Map<string, { partName: string; styleNo: string; color: string; sleeveType?: string; sizeQty: Record<string, number>; total: number; mrp: number }>();
    const sizeSet = new Set<string>();

    for (const line of packedLines) {
      const qty = line.packedQty > 0 ? line.packedQty : line.requiredQty;
      if (qty <= 0) continue;
      sizeSet.add(line.size);
      const key = `${line.partName}||${line.styleNo}||${line.color}||${line.sleeveType ?? ''}`;
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          partName: line.partName,
          styleNo: line.styleNo,
          color: line.color,
          sleeveType: line.sleeveType,
          sizeQty: {},
          total: 0,
          mrp: mrpByBarcode.get(line.barcode ?? '') ?? 0,
        });
      }
      const row = rowMap.get(key)!;
      row.sizeQty[line.size] = (row.sizeQty[line.size] ?? 0) + qty;
      row.total += qty;
    }

    const sizes = [...sizeSet].sort((a, b) => this.rankSize(a) - this.rankSize(b));
    const totalQty = [...rowMap.values()].reduce((s, r) => s + r.total, 0);
    const boxCount = salesOrderId
      ? (packingList.cartons ?? []).filter((c) => c.entries.some((e) => e.salesOrderIds.includes(salesOrderId))).length
      : (packingList.cartons ?? []).length;

    return this.dcService.createDC({
      packingListId: packingList.id!,
      packingListNo: packingList.packingListNo,
      salesOrderId,
      salesNo,
      clientId: packingList.clientId,
      clientName: clientName || packingList.clientName,
      billingAddress: client?.billingAddress ?? '',
      place: client?.place ?? '',
      state: client?.state ?? '',
      zipCode: client?.zipCode ?? '',
      clientPhone: client?.mobile ?? '',
      clientGstin: client?.gstNo ?? '',
      totalQty,
      boxCount,
      agentName,
      transport,
      items: [...rowMap.values()],
      sizes,
    }, { allowDuplicate });
  }

  private async printDCsWithLabels(dcs: DeliveryChallan[], packingList: PackingList): Promise<void> {
    const total = dcs.length;
    const dcHtmlParts = dcs.map((dc, idx) => this.buildCustomerDCHtml(dc, idx + 1, total));
    const allDCHtml = dcHtmlParts.join('<div style="page-break-before:always"></div>');
    const labelsHtml = this.buildAllLabelsHtml(packingList);

    const combinedHtml = `<!DOCTYPE html><html>
<head><meta charset="utf-8"><title>DC - ${packingList.packingListNo}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:11px;color:#000}
table{width:100%;border-collapse:collapse}
@media print{.pg-break{page-break-before:always}}
</style></head>
<body>
${allDCHtml}
<div class="pg-break" style="page-break-before:always;padding:16px">
  <div style="text-align:center;font-size:15px;font-weight:900;letter-spacing:2px;text-decoration:underline;margin-bottom:14px">
    BOX LABELS &mdash; ${packingList.packingListNo}
  </div>
  ${labelsHtml}
</div>
</body></html>`;

    const win = window.open('', '_blank', 'width=960,height=820');
    if (win) { win.document.write(combinedHtml); win.document.close(); setTimeout(() => win.print(), 600); }
  }

  private buildCustomerDCHtml(dc: DeliveryChallan, pageNum: number, totalPages: number): string {
    const B = 'border:1px solid #bbb;';
    const th2 = (txt: string, extra = '') =>
      `<th style="padding:5px 7px;${B}background:#e8e8e8;font-size:10px;font-weight:700;text-align:center;${extra}">${txt}</th>`;
    const td2 = (txt: string | number, extra = '') =>
      `<td style="padding:5px 7px;${B}font-size:10px;text-align:center;${extra}">${txt}</td>`;

    // Group items by partName for rowspan
    const partGroups = new Map<string, typeof dc.items>();
    for (const item of dc.items) {
      const existing = partGroups.get(item.partName) ?? [];
      existing.push(item);
      partGroups.set(item.partName, existing);
    }

    // Size totals
    const sizeTotals: Record<string, number> = {};
    let grandTotal = 0;
    for (const item of dc.items) {
      for (const [sz, qty] of Object.entries(item.sizeQty)) {
        sizeTotals[sz] = (sizeTotals[sz] ?? 0) + qty;
        grandTotal += qty;
      }
    }

    // Two-row header: Description | Design | Sleeve | Shade | MRP | Size(colspan) | Total
    const sizeHeaderCells = dc.sizes.map((s) => th2(s)).join('');
    const rs2 = (label: string, extra = '') =>
      `<th rowspan="2" style="padding:5px 7px;${B}background:#e8e8e8;font-size:10px;font-weight:700;text-align:center;vertical-align:middle;${extra}">${label}</th>`;
    const thead = `<thead>
    <tr>
      ${rs2('Description', 'text-align:left')}
      ${rs2('Design', 'text-align:left')}
      ${rs2('Sleeve')}
      ${rs2('Shade')}
      ${rs2('MRP')}
      ${dc.sizes.length > 0 ? `<th colspan="${dc.sizes.length}" style="padding:5px 7px;${B}background:#e8e8e8;font-size:10px;font-weight:700;text-align:center">Size</th>` : ''}
      ${rs2('Total')}
    </tr>
    <tr>${sizeHeaderCells}</tr>
  </thead>`;

    // Body rows with partName rowspan
    const bodyRows: string[] = [];
    for (const [partName, items] of partGroups) {
      items.forEach((item, idx) => {
        const isFirst = idx === 0;
        const sizeCells = dc.sizes.map((s) => td2(item.sizeQty[s] ?? '')).join('');
        const rowBg = bodyRows.length % 2 === 0 ? '#fff' : '#f9f9f9';
        bodyRows.push(`<tr style="background:${rowBg}">
          ${isFirst
            ? `<td rowspan="${items.length}" style="padding:5px 7px;${B}font-size:10px;text-align:left;vertical-align:middle;font-weight:600">${partName}</td>`
            : ''}
          ${td2(item.styleNo, 'font-weight:700;text-align:left')}
          ${td2(item.sleeveType || '-')}
          ${td2(item.color || '-')}
          ${td2(item.mrp > 0 ? item.mrp.toFixed(2) : '-')}
          ${sizeCells}
          ${td2(item.total, 'font-weight:700')}
        </tr>`);
      });
    }

    const totalCells = dc.sizes.map((s) => td2(sizeTotals[s] ?? '', 'font-weight:700;background:#f0f0f0')).join('');
    const totalRow = `<tr>
      <td colspan="5" style="padding:5px 7px;${B}font-weight:700;font-size:10px;text-align:right;background:#f0f0f0">Total</td>
      ${totalCells}
      <td style="padding:5px 7px;${B}font-weight:900;font-size:11px;text-align:center;background:#f0f0f0">${grandTotal}</td>
    </tr>`;

    const addrLines: string[] = [];
    if (dc.billingAddress) addrLines.push(dc.billingAddress);
    const cityParts = [dc.place, dc.state].filter(Boolean);
    if (cityParts.length) addrLines.push(`${cityParts.join(', ')}${dc.zipCode ? ' - ' + dc.zipCode : ''}`);
    if (dc.clientPhone) addrLines.push(`PH: ${dc.clientPhone}`);
    const clientAddrHtml = addrLines.map((l) => `<div style="font-size:10px;margin-top:2px">${l}</div>`).join('');

    const toDateStr = (raw: any) => {
      if (!raw) return new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
      try {
        const d = raw?.toDate ? raw.toDate() : new Date(raw);
        return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
      } catch { return new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
    };
    const dateStr = toDateStr(dc.createdAt);

    return `<div style="padding:14px 18px;font-family:Arial,sans-serif;font-size:11px;color:#000">

<div style="display:flex;align-items:center;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:6px">
  <div style="flex:1"><!-- logo space --></div>
  <div style="flex:2;text-align:center">
    <div style="font-size:22px;font-weight:900;letter-spacing:0.5px">TMG Clothings</div>
    <div style="font-size:10px;color:#333;margin-top:2px">Door No.334/2, Serayampalaym, Vellanaipatti Post,</div>
    <div style="font-size:10px;color:#333">Coimbatore - 641048, Phone: 9842211787</div>
    <div style="font-size:10px;color:#333">Email : order@tmggarments.in &nbsp;|&nbsp; GSTIN: 33AAYFT2559B1ZY</div>
  </div>
  <div style="flex:1;text-align:right;font-size:9px;color:#666">Page ${pageNum}/${totalPages}</div>
</div>

<div style="font-size:14px;font-weight:700;text-align:center;letter-spacing:2px;text-decoration:underline;margin-bottom:8px">DELIVERY CHALLAN</div>

<div style="display:flex;border:1px solid #aaa;margin-bottom:10px">
  <div style="flex:1;padding:8px 10px;border-right:1px solid #aaa;min-height:90px">
    <div style="font-size:11px;font-weight:700;margin-bottom:4px">M/S : ${dc.clientName}</div>
    ${clientAddrHtml || '<div style="font-size:10px;color:#aaa;margin-top:2px">—</div>'}
    ${dc.clientGstin ? `<div style="font-size:10px;margin-top:4px;font-weight:600">GSTIN: ${dc.clientGstin}</div>` : ''}
  </div>
  <div style="padding:6px 10px;min-width:270px">
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:3px 6px;font-size:10px;color:#555;white-space:nowrap">DC No.</td><td style="padding:3px 6px;font-size:10px;font-weight:700">: ${dc.dcNo}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Packed On</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dateStr}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Order No.</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dc.salesNo || dc.packingListNo}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Order Date</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dateStr}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Total Qty</td><td style="padding:3px 6px;font-size:10px;font-weight:700">: ${grandTotal}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">No.of Box</td><td style="padding:3px 6px;font-size:10px;font-weight:700">: ${dc.boxCount}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Agent Name</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dc.agentName || '-'}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Transport</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dc.transport || '-'}</td></tr>
    </table>
  </div>
</div>

<table style="width:100%;border-collapse:collapse">
  ${thead}
  <tbody>
    ${bodyRows.join('') || `<tr><td colspan="${4 + dc.sizes.length + 1}" style="padding:10px;text-align:center;color:#888">No items packed.</td></tr>`}
    ${totalRow}
  </tbody>
</table>

<div style="margin-top:14px;font-size:10px">Remarks :</div>
<div style="display:flex;justify-content:space-between;margin-top:40px;gap:30px">
  <div style="flex:1;text-align:center">
    <div style="border-top:1px solid #555;padding-top:5px;font-size:10px;color:#444">Checked By</div>
  </div>
  <div style="flex:1;text-align:center">
    <div style="border-top:1px solid #555;padding-top:5px;font-size:10px;color:#444">Authorized By</div>
  </div>
</div>

</div>`;
  }

  private rankSize(size: string): number {
    const idx = SIZE_ORDER.indexOf(size);
    if (idx !== -1) return idx;
    const n = parseInt(size, 10);
    return isNaN(n) ? 9999 : 1000 + n;
  }

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

  private buildPrintHtml(packingList: PackingList, lines: PackingListLine[], mrpByBarcode: Map<string, number>): string {
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
      const mrp = mrpByBarcode.get(l.barcode ?? '') ?? 0;
      return `
        <tr style="background:${i % 2 === 0 ? '#f8fafc' : '#ffffff'}">
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;color:#64748b">${i + 1}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea">${l.partName}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;font-weight:700">${l.styleNo}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea">${l.color}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center">${l.size}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center">${l.sleeveType ?? '-'}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;font-family:monospace;font-size:11px">${l.barcode ?? '-'}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:right">${mrp > 0 ? mrp.toFixed(2) : '-'}</td>
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
            <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#fff;font-size:10px">MRP</th>
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

  private buildAllLabelsHtml(packingList: PackingList): string {
    const cartons = packingList.cartons ?? [];
    if (!cartons.length) {
      return '<p style="text-align:center;color:#94a3b8;padding:20px;font-size:12px">No boxes to print.</p>';
    }

    const partyProgress = packingList.partyProgress ?? [];
    const dateStr = new Date().toLocaleDateString('en-IN');

    const labelCards = cartons.map((carton) => {
      const soIds = [...new Set(carton.entries.flatMap((e) => e.salesOrderIds))];
      const soNos = [...new Set(carton.entries.flatMap((e) => e.salesNos))];
      const party = partyProgress.find((p) => soIds.includes(p.salesOrderId));
      const customerName = party?.clientName || packingList.clientName;
      const salesNosStr = soNos.length ? soNos.join(', ') : (packingList.salesNos ?? []).join(', ');

      const itemRows = carton.entries.map((e) =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid #e2e8f0;font-size:10px">
          <span>${e.styleNo} / ${e.color} / ${e.size}${e.sleeveType ? ' / ' + e.sleeveType : ''}</span>
          <strong style="margin-left:8px;white-space:nowrap">&times; ${e.qty}</strong>
        </div>`
      ).join('');

      return `<div style="border:2px solid #0f172a;border-radius:8px;padding:12px;page-break-inside:avoid;background:#fff;break-inside:avoid">
        <div style="text-align:center;border-bottom:2px solid #0f172a;padding-bottom:8px;margin-bottom:10px">
          <div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:700;letter-spacing:0.08em">Box Label</div>
          <div style="font-size:28px;font-weight:900;letter-spacing:2px;margin:2px 0;color:#0f172a">${carton.cartonNo}</div>
          <div style="font-size:10px;color:#64748b">${packingList.packingListNo}</div>
        </div>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px;margin-bottom:8px">
          <div style="font-size:9px;color:#1d4ed8;font-weight:700;text-transform:uppercase;letter-spacing:0.05em">Customer</div>
          <div style="font-size:14px;font-weight:900;color:#1e3a8a;margin-top:1px">${customerName}</div>
          <div style="font-size:10px;color:#3b82f6;font-weight:600;margin-top:1px">${salesNosStr}</div>
        </div>
        <div style="background:#f8fafc;border-radius:6px;padding:8px;margin-bottom:10px">
          ${itemRows || '<div style="font-size:10px;color:#94a3b8;text-align:center;padding:4px">No items</div>'}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:flex-end">
          <div>
            <div style="font-size:9px;color:#64748b;text-transform:uppercase;font-weight:700">Total Pieces</div>
            <div style="font-size:28px;font-weight:900;color:#0f766e;line-height:1">${carton.totalQty}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:9px;color:#64748b">Date</div>
            <div style="font-size:11px;font-weight:700">${dateStr}</div>
          </div>
        </div>
      </div>`;
    }).join('');

    return `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px">${labelCards}</div>`;
  }

  private buildCartonLabelHtml(packingList: PackingList, carton: PackingCarton): string {
    const partyProgress = packingList.partyProgress ?? [];
    const soIds = [...new Set(carton.entries.flatMap((e) => e.salesOrderIds))];
    const soNos = [...new Set(carton.entries.flatMap((e) => e.salesNos))];
    const party = partyProgress.find((p) => soIds.includes(p.salesOrderId));
    const customerName = party?.clientName || packingList.clientName;
    const salesNosStr = soNos.length ? soNos.join(', ') : (packingList.salesNos ?? []).join(', ');

    const itemRows = carton.entries.map((e) =>
      `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #e2e8f0;font-size:12px">
        <span>${e.styleNo} / ${e.color} / ${e.size}${e.sleeveType ? ' / ' + e.sleeveType : ''}</span>
        <strong>&times; ${e.qty}</strong>
      </div>`
    ).join('');

    return `<!DOCTYPE html><html>
      <head><meta charset="utf-8"><title>Box Label - ${carton.cartonNo}</title>
      <style>body{font-family:Arial,sans-serif;font-size:12px;margin:16px;color:#0f172a}</style></head>
      <body>
        <div style="border:2px solid #0f172a;border-radius:10px;padding:16px;max-width:400px;margin:auto">
          <div style="text-align:center;border-bottom:2px solid #0f172a;padding-bottom:10px;margin-bottom:12px">
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;letter-spacing:0.08em">Box Label</div>
            <div style="font-size:32px;font-weight:900;letter-spacing:2px;margin:4px 0">${carton.cartonNo}</div>
            <div style="font-size:11px;color:#64748b">${packingList.packingListNo}</div>
          </div>
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px;margin-bottom:10px">
            <div style="font-size:10px;color:#1d4ed8;font-weight:700;text-transform:uppercase;letter-spacing:0.05em">Customer</div>
            <div style="font-size:15px;font-weight:900;color:#1e3a8a;margin-top:2px">${customerName}</div>
            <div style="font-size:11px;color:#3b82f6;font-weight:600;margin-top:2px">${salesNosStr}</div>
          </div>
          <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px">
            ${itemRows || '<div style="font-size:11px;color:#94a3b8;text-align:center">No items</div>'}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-size:11px;color:#64748b">Total Pieces</div>
              <div style="font-size:30px;font-weight:900;color:#0f766e">${carton.totalQty}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:11px;color:#64748b">Date</div>
              <div style="font-size:12px;font-weight:700">${new Date().toLocaleDateString('en-IN')}</div>
            </div>
          </div>
        </div>
      </body></html>`;
  }

  private buildEnhancedBoxLabelHtml(packingList: PackingList, cartonIndex: number, totalBoxes: number, dc: DeliveryChallan | null, invoiceNo: string): string {
    const carton = packingList.cartons[cartonIndex];
    if (!carton) return '';
    const partyProgress = packingList.partyProgress ?? [];
    const soIds = [...new Set(carton.entries.flatMap((e) => e.salesOrderIds))];
    const party = partyProgress.find((p) => soIds.includes(p.salesOrderId));
    const customerName = party?.clientName || packingList.clientName;
    const addrParts: string[] = [];
    if (dc?.billingAddress) addrParts.push(dc.billingAddress);
    if (dc?.place || dc?.state) addrParts.push([dc.place, dc.state].filter(Boolean).join(', ') + (dc?.zipCode ? ' - ' + dc.zipCode : ''));
    if (dc?.clientPhone) addrParts.push('Ph: ' + dc.clientPhone);
    const addrHtml = addrParts.map((p) => '<div style="font-size:8px;color:#333;margin-top:1px">' + p + '</div>').join('');
    const qrData = 'INV:' + (invoiceNo || 'N/A') + '|BOX:' + (cartonIndex + 1) + 'of' + totalBoxes + '|CODE:' + (dc?.clientId || packingList.clientId).substring(0, 8).toUpperCase();
    return '<div class="label-page">'
      + '<div style="display:flex;align-items:center;padding:4px 8px;border-bottom:1.5px solid #000;background:#f8f8f8">'
      + '<div style="width:36px;height:36px;border:1px solid #ccc;border-radius:4px;display:flex;align-items:center;justify-content:center;margin-right:6px;background:#fff;font-size:7px;font-weight:900;color:#1e3a8a;text-align:center">TMG<br>CLG</div>'
      + '<div style="flex:1"><div style="font-size:13px;font-weight:900;color:#0f172a">TMG Clothings</div>'
      + '<div style="font-size:7px;color:#555">Door No.334/2, Serayampalaym, Coimbatore - 641048 | GSTIN: 33AAYFT2559B1ZY</div></div>'
      + '<div style="text-align:right;font-size:8px;color:#666;min-width:60px">'
      + '<div style="font-weight:700">Box ' + (cartonIndex + 1) + ' of ' + totalBoxes + '</div>'
      + '<div style="font-size:18px;font-weight:900;color:#0f172a;line-height:1.1">' + carton.cartonNo + '</div></div></div>'
      + '<div style="display:flex;border-bottom:1px solid #ccc;flex:1;min-height:0">'
      + '<div style="flex:1;padding:5px 8px;border-right:1px solid #ccc">'
      + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:#4f46e5">Ship To</div>'
      + '<div style="font-size:11px;font-weight:900;color:#0f172a;margin-top:1px">' + customerName + '</div>'
      + (addrHtml || '<div style="font-size:8px;color:#888">—</div>') + '</div>'
      + '<div style="width:90px;padding:5px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fafafa">'
      + '<div style="border:1.5px solid #0f172a;padding:5px;font-size:6px;font-family:monospace;word-break:break-all;text-align:center;width:76px;line-height:1.4">' + qrData + '</div>'
      + '<div style="font-size:6px;color:#666;margin-top:3px;text-align:center">Scan for details</div></div></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:1px solid #ccc">'
      + '<div style="padding:3px 6px;border-right:1px solid #ccc"><div style="font-size:7px;color:#666;font-weight:700;text-transform:uppercase">Pick List</div><div style="font-size:9px;font-weight:700">' + packingList.pickListNo + '</div></div>'
      + '<div style="padding:3px 6px;border-right:1px solid #ccc"><div style="font-size:7px;color:#666;font-weight:700;text-transform:uppercase">Order No.</div><div style="font-size:9px;font-weight:700">' + (packingList.salesNos ?? []).join(', ') + '</div></div>'
      + '<div style="padding:3px 6px"><div style="font-size:7px;color:#666;font-weight:700;text-transform:uppercase">Invoice No.</div><div style="font-size:9px;font-weight:700">' + (invoiceNo || '—') + '</div></div></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr">'
      + '<div style="padding:3px 6px;border-right:1px solid #ccc"><div style="font-size:7px;color:#666;font-weight:700;text-transform:uppercase">Destination</div><div style="font-size:9px;font-weight:700">' + (dc?.place || '—') + '</div></div>'
      + '<div style="padding:3px 6px;border-right:1px solid #ccc"><div style="font-size:7px;color:#666;font-weight:700;text-transform:uppercase">Transport</div><div style="font-size:9px;font-weight:700">' + (dc?.transport || packingList.transport || '—') + '</div></div>'
      + '<div style="padding:3px 6px;background:#f0fdf4"><div style="font-size:7px;color:#047857;font-weight:700;text-transform:uppercase">Total Qty</div>'
      + '<div style="font-size:16px;font-weight:900;color:#047857;line-height:1">' + carton.totalQty + ' PCS</div></div></div></div>';
  }

  private buildInvoiceHtml(invoice: Invoice, logoDataUri = ''): string {
    const B = 'border:1px solid #ccc;';
    const th = (txt: string, extra = '') => '<th style="padding:5px 7px;' + B + 'background:#e8e8e8;font-size:11px;font-weight:700;text-align:center;' + extra + '">' + txt + '</th>';
    const td = (txt: string | number, extra = '') => '<td style="padding:5px 7px;' + B + 'font-size:11px;text-align:center;' + extra + '">' + txt + '</td>';
    const fmtDate = (raw: any): string => {
      if (!raw) return '-';
      try { const d = raw?.toDate ? raw.toDate() : new (Function.prototype.bind.call(Date, null, raw))(); return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '-'; }
    };
    const logoHtml = logoDataUri
      ? '<img src="' + logoDataUri + '" style="width:90px;height:auto;border-radius:6px;flex-shrink:0;margin-right:14px;object-fit:contain" alt="TMG Logo">'
      : '<div style="width:80px;height:60px;border:1px solid #ccc;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:900;color:#1e3a8a;text-align:center;flex-shrink:0;margin-right:14px">TMG<br>CLOTHINGS</div>';
    const addrLines = [invoice.clientAddress, [invoice.clientPlace, invoice.clientState].filter(Boolean).join(', ') + (invoice.clientZipCode ? ' - ' + invoice.clientZipCode : ''), invoice.clientPhone ? 'Mobile: ' + invoice.clientPhone : ''].filter(Boolean);
    const clientAddrHtml = addrLines.map((l) => '<div style="font-size:11px;margin-top:2px">' + l + '</div>').join('');
    const itemRows = invoice.items.map((item, i) => '<tr style="background:' + (i % 2 === 0 ? '#fff' : '#f9f9f9') + '">'
      + td(i + 1) + td(item.description, 'text-align:left;font-weight:600') + td(item.hsnSac)
      + td(item.discountPct) + td(item.taxRate) + td(item.mrp.toFixed(2)) + td(item.uom)
      + td(item.quantity) + td(item.price.toFixed(2), 'font-weight:700') + td(item.amount.toFixed(2), 'font-weight:700') + '</tr>').join('');
    const taxSummaryRows = invoice.taxSummary.map((t) => '<tr>'
      + td(t.hsnSac) + td(t.taxableValue.toFixed(2), 'font-weight:700') + td(t.cgstRate) + td(t.cgstAmount.toFixed(2), 'font-weight:700')
      + td(t.sgstRate) + td(t.sgstAmount.toFixed(2), 'font-weight:700') + td(t.igstRate || '-') + td(t.igstAmount ? t.igstAmount.toFixed(2) : '-') + '</tr>').join('');
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice - ' + invoice.invoiceNo + '</title>'
      + '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:12px;color:#000}table{width:100%;border-collapse:collapse}@media print{@page{size:A4;margin:10mm}}</style>'
      + '</head><body><div style="padding:10px 14px">'
      + '<div style="display:flex;align-items:center;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:8px">'
      + logoHtml
      + '<div style="flex:1;text-align:center"><div style="font-size:22px;font-weight:900">TMG Clothings</div>'
      + '<div style="font-size:11px;color:#333;margin-top:2px">Door No.334/2, Serayampalaym, Vellanaipatti Post, Coimbatore - 641048</div>'
      + '<div style="font-size:11px;color:#333">Phone: 9842211787 | Email: order@tmggarments.in | GSTIN: 33AAYFT2559B1ZY</div></div>'
      + '<div style="text-align:right;font-size:10px;color:#666;min-width:110px">Triplicate-For Assessee</div></div>'
      + '<div style="font-size:15px;font-weight:700;text-align:center;letter-spacing:2px;text-decoration:underline;margin-bottom:10px">TAX INVOICE</div>'
      + '<div style="display:flex;border:1px solid #aaa;margin-bottom:10px">'
      + '<div style="flex:1;padding:7px 10px;border-right:1px solid #aaa">'
      + '<div style="font-size:12px;font-weight:700;margin-bottom:4px">M/S : ' + invoice.clientName + '</div>'
      + clientAddrHtml + (invoice.clientGstin ? '<div style="font-size:11px;margin-top:4px;font-weight:600">GSTIN: ' + invoice.clientGstin + '</div>' : '') + '</div>'
      + '<div style="flex:1;padding:7px 10px;border-right:1px solid #aaa">'
      + '<div style="font-size:11px;font-weight:700;margin-bottom:3px">Ship To : ' + invoice.clientName + '</div>'
      + clientAddrHtml + '</div>'
      + '<div style="min-width:210px;padding:5px 10px"><table style="border-collapse:collapse;width:100%">'
      + '<tr><td style="padding:3px 4px;font-size:11px;color:#555">Invoice No.</td><td style="padding:3px 4px;font-size:11px;font-weight:700">: ' + invoice.invoiceNo + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:11px;color:#555">Invoice Date</td><td style="padding:3px 4px;font-size:11px">: ' + fmtDate(invoice.invoiceDate) + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:11px;color:#555">DC No.</td><td style="padding:3px 4px;font-size:11px;font-weight:700">: ' + (invoice.dcNo || '—') + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:11px;color:#555">Order No.</td><td style="padding:3px 4px;font-size:11px;font-weight:600">: ' + invoice.orderNo + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:11px;color:#555">Destination</td><td style="padding:3px 4px;font-size:11px">: ' + (invoice.destination || '—') + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:11px;color:#555">Transport</td><td style="padding:3px 4px;font-size:11px">: ' + (invoice.transport || '—') + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:11px;color:#555">Doc No.</td><td style="padding:3px 4px;font-size:11px">: ' + (invoice.docNo || '—') + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:11px;color:#555">Vehicle No.</td><td style="padding:3px 4px;font-size:11px">: ' + (invoice.vehicleNo || '—') + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:11px;color:#555">Total Pkgs</td><td style="padding:3px 4px;font-size:11px;font-weight:700">: ' + invoice.totalPkgs + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:11px;color:#555">Agent</td><td style="padding:3px 4px;font-size:11px">: ' + (invoice.agentName || '—') + '</td></tr>'
      + '</table></div></div>'
      + '<table style="margin-bottom:10px"><thead><tr>'
      + th('S.No') + th('Description', 'text-align:left') + th('HSN/SAC') + th('Disc(%)') + th('Tax(%)') + th('MRP') + th('UOM') + th('Quantity') + th('Price') + th('Amount')
      + '</tr></thead><tbody>' + itemRows
      + '<tr><td colspan="9" style="padding:5px 7px;' + B + 'font-weight:700;font-size:11px;text-align:right;background:#f0f0f0">Gross</td>'
      + '<td style="padding:5px 7px;' + B + 'font-weight:900;font-size:12px;text-align:center;background:#f0f0f0">' + invoice.grossAmount.toFixed(2) + '</td></tr>'
      + '</tbody></table>'
      + '<div style="display:flex;justify-content:flex-end;margin-bottom:10px">'
      + '<table style="width:300px;border-collapse:collapse">'
      + '<tr><td style="padding:4px 10px;font-size:11px;border:1px solid #ddd">Discount (' + invoice.discountPct + '%)</td><td style="padding:4px 10px;font-size:11px;font-weight:700;text-align:right;border:1px solid #ddd">' + invoice.discountAmount.toFixed(2) + '</td></tr>'
      + '<tr><td style="padding:4px 10px;font-size:11px;border:1px solid #ddd">Taxable Value</td><td style="padding:4px 10px;font-size:11px;font-weight:700;text-align:right;border:1px solid #ddd">' + invoice.taxableValue.toFixed(2) + '</td></tr>'
      + '<tr><td style="padding:4px 10px;font-size:11px;border:1px solid #ddd">CGST (' + invoice.cgstRate + '%)</td><td style="padding:4px 10px;font-size:11px;text-align:right;border:1px solid #ddd">' + invoice.cgstAmount.toFixed(2) + '</td></tr>'
      + '<tr><td style="padding:4px 10px;font-size:11px;border:1px solid #ddd">SGST (' + invoice.sgstRate + '%)</td><td style="padding:4px 10px;font-size:11px;text-align:right;border:1px solid #ddd">' + invoice.sgstAmount.toFixed(2) + '</td></tr>'
      + '<tr><td style="padding:4px 10px;font-size:11px;border:1px solid #ddd;font-weight:700">Total Tax Amount</td><td style="padding:4px 10px;font-size:11px;font-weight:700;text-align:right;border:1px solid #ddd">' + invoice.totalTaxAmount.toFixed(2) + '</td></tr>'
      + '<tr><td style="padding:4px 10px;font-size:11px;border:1px solid #ddd">Round Off</td><td style="padding:4px 10px;font-size:11px;text-align:right;border:1px solid #ddd">' + invoice.roundOff.toFixed(2) + '</td></tr>'
      + '<tr style="background:#0f172a;color:#fff"><td style="padding:6px 10px;font-size:13px;font-weight:900;border:1px solid #0f172a">TOTAL</td>'
      + '<td style="padding:6px 10px;font-size:14px;font-weight:900;text-align:right;border:1px solid #0f172a">&#x20B9; ' + invoice.totalAmount.toLocaleString('en-IN') + '</td></tr>'
      + '</table></div>'
      + '<div style="border:1px solid #ccc;padding:6px 10px;margin-bottom:10px;font-size:11px"><strong>Rupees :</strong> ' + invoice.amountInWords + '</div>'
      + '<table style="margin-bottom:10px"><thead><tr>'
      + th('HSN/SAC') + th('Taxable Value') + th('CGST %') + th('CGST Amt') + th('SGST %') + th('SGST Amt') + th('IGST %') + th('IGST Amt')
      + '</tr></thead><tbody>' + taxSummaryRows
      + '<tr style="background:#f0f0f0">' + td('Total', 'font-weight:700') + td(invoice.taxableValue.toFixed(2), 'font-weight:700') + td('') + td(invoice.cgstAmount.toFixed(2), 'font-weight:700') + td('') + td(invoice.sgstAmount.toFixed(2), 'font-weight:700') + td('') + td(invoice.igstAmount ? invoice.igstAmount.toFixed(2) : '-') + '</tr>'
      + '</tbody></table>'
      + '<div style="font-size:10px;border:1px solid #ccc;padding:5px 10px;margin-bottom:10px">Amount of Tax (in words) : ' + this.amountToWords(invoice.totalTaxAmount) + '</div>'
      + '<div style="border:1px solid #ccc;padding:6px 10px;margin-bottom:10px;font-size:11px"><div style="font-weight:700;margin-bottom:4px">Company\'s Bank Details :</div>'
      + '<div>Name of the Account : TMG Clothings</div><div>A/C No : 44358238258</div>'
      + '<div>IFSC Code : SBIN0061170</div><div>Bank Name : STATE BANK OF INDIA / Branch : Siruthozhil Branch, Kovilpatti</div></div>'
      + '<div style="font-size:11px;margin-bottom:14px">Remarks :</div>'
      + '<div style="display:flex;justify-content:space-between;margin-top:34px">'
      + '<div style="text-align:center"><div style="border-top:1px solid #555;padding-top:5px;font-size:11px;color:#444;width:130px">Checked By</div></div>'
      + '<div style="text-align:center"><div style="font-size:12px;font-weight:700;color:#0f172a;margin-bottom:2px">For TMG Clothings</div>'
      + '<div style="border-top:1px solid #555;padding-top:5px;font-size:11px;color:#444;width:160px;margin-top:34px">Authorised Signatory</div></div>'
      + '</div></div></body></html>';
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
    const parts: string[] = [];
    if (n >= 10000000) { parts.push(threeD(Math.floor(n / 10000000)) + ' CRORE'); n %= 10000000; }
    if (n >= 100000) { parts.push(twoD(Math.floor(n / 100000)) + ' LAKH'); n %= 100000; }
    if (n >= 1000) { parts.push(twoD(Math.floor(n / 1000)) + ' THOUSAND'); n %= 1000; }
    if (n > 0) parts.push(threeD(n));
    return parts.join(' ');
  }
}
