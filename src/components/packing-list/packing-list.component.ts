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
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { firstValueFrom, Subscription } from 'rxjs';
import Swal from 'sweetalert2';
import { PickList, PickListLine } from '../../models/pick-list.model';
import { PackingCarton, PackingList, PackingListLine, PackingPartyProgress } from '../../models/packing-list.model';
import { DCItem, DeliveryChallan } from '../../models/delivery-challan.model';
import { PickListService } from '../../services/pick-list.service';
import { PackingListService } from '../../services/packing-list.service';
import { ClientService } from '../../services/client.service';
import { Transport } from '../../models/transport.model';
import { TransportService } from '../../services/transport.service';
import { DeliveryChallanService } from '../../services/delivery-challan.service';
import { Invoice } from '../../models/invoice.model';
import { resolveHsnCode } from '../../models/hsn-code.model';
import { InvoiceService } from '../../services/invoice.service';
import { CompanySettingsService } from '../../services/company-settings.service';
import { resolveGstPlaceOfSupply } from '../../services/gst-state.util';
import { LrEntryService } from '../../services/lr-entry.service';
import { InventoryService } from '../../services/inventory.service';
import { DesignService } from '../../services/design.service';
import { LoadingService } from '../../services/loading.service';
import { priceAfterMargin } from '../../services/pricing.util';
import { QzTrayService } from '../../services/qz-tray.service';
import { getStageBadgeClass, getStageStatusLabel } from '../../services/document-stage.util';
import { fetchLogoDataUri } from '../../services/company-logo.util';
import {
  BoxLabelPrinterSettings,
  buildBoxLabelZplBatch,
  loadBoxLabelSettings,
  saveBoxLabelSettings,
} from '../../services/box-label-zpl.util';
import {
  MrpLabelData,
  MrpLabelPrinterSettings,
  buildMrpLabelDataForLines,
  buildMrpLabelZplBatch,
  buildRotationDiagnosticZpl,
  loadMrpLabelSettings,
  mrpLabelDataForLine,
  saveMrpLabelSettings,
} from '../../services/mrp-label-zpl.util';

type ViewMode = 'list' | 'view' | 'live-pack' | 'combine' | 'box-label-print' | 'mrp-label-print';

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
  private transportService = inject(TransportService);
  private dcService = inject(DeliveryChallanService);
  private invoiceService = inject(InvoiceService);
  private companySettingsService = inject(CompanySettingsService);
  private lrEntryService = inject(LrEntryService);
  private inventoryService = inject(InventoryService);
  private designService = inject(DesignService);
  private loadingService = inject(LoadingService);
  private qzTrayService = inject(QzTrayService);
  private sanitizer = inject(DomSanitizer);
  private subscriptions: Subscription[] = [];

  // ─── Navigation ────────────────────────────────────────────────────────────
  mode = signal<ViewMode>('list');
  listTab = signal<'ready' | 'packing' | 'dc-history' | 'invoices'>('ready');
  searchTerm = signal('');

  // ─── Invoices tab filters (date range + client) ────────────────────────────
  invoiceFilterFromDate = signal<string>('');
  invoiceFilterToDate = signal<string>('');
  invoiceFilterClientId = signal<string>('');

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
  // Transport Master selection for Dispatch Info — transport holds the
  // transporter's name (kept for backward compatibility with older
  // free-text values), transportId/transportAddress/transportGstNo are
  // looked up from Transport Master when a transport is selected and carry
  // through to the DC and Invoice generated from this Packing List.
  transports = signal<Transport[]>([]);
  transport = signal('');
  transportId = signal('');
  transportAddress = signal('');
  transportGstNo = signal('');
  isSavingDispatchInfo = signal(false);

  packingInProgress = signal<string[]>([]);
  activeBoxNo = signal('');
  boxInput = signal('');
  invoices = signal<Invoice[]>([]);
  isGeneratingInvoice = signal(false);

  // ─── Combine (multiple Pick Lists → one Packing List) ─────────────────────
  combineClientId = signal<string | null>(null);
  selectedPickListIdsForCombine = signal<Set<string>>(new Set());

  // ─── Box Label print (QZ Tray + ZPL thermal printing) ──────────────────────
  boxLabelPackingList = signal<PackingList | null>(null);
  boxLabelDc = signal<DeliveryChallan | null>(null);
  boxLabelSettings = signal<BoxLabelPrinterSettings>(loadBoxLabelSettings());
  boxLabelPrinters = signal<string[]>([]);
  boxLabelSelected = signal<Set<number>>(new Set());
  boxLabelPreviewIndex = signal(0);
  isDetectingBoxLabelPrinters = signal(false);
  isPrintingBoxLabels = signal(false);
  boxLabelQzStatus = signal<'unknown' | 'connected' | 'error'>('unknown');
  boxLabelQzError = signal('');

  // ─── MRP Label print (QZ Tray + ZPL thermal printing, one label per piece) ─
  // Sourced from the Packing List's own lines/requiredQty, NOT cartons — a
  // garment's MRP tag doesn't depend on which box it lands in, so this must
  // work as soon as a Packing List is generated, whether or not packing
  // (carton creation) has started yet. See closeMrpLabelPrintModal/
  // printMrpLabels below for why cartons play no part in this feature.
  mrpLabelPackingList = signal<PackingList | null>(null);
  mrpLabelLines = signal<PackingListLine[]>([]);
  mrpLabelSettings = signal<MrpLabelPrinterSettings>(loadMrpLabelSettings());
  mrpLabelPrinters = signal<string[]>([]);
  mrpLabelSelected = signal<Set<number>>(new Set());
  mrpLabelPreviewLineIndex = signal(0);
  mrpLabelMrpByBarcode = signal<Map<string, number>>(new Map());
  isDetectingMrpLabelPrinters = signal(false);
  isPrintingMrpLabels = signal(false);
  mrpLabelQzStatus = signal<'unknown' | 'connected' | 'error'>('unknown');
  mrpLabelQzError = signal('');

  mrpLabelPreviewLine = computed<PackingListLine | null>(() => {
    const lines = this.mrpLabelLines();
    if (!lines.length) return null;
    const idx = Math.min(this.mrpLabelPreviewLineIndex(), lines.length - 1);
    return lines[idx] ?? null;
  });

  // The 80×70mm sheet is a 2-up layout (see mrp-label-zpl.util.ts) — preview
  // the selected line paired with the next line in the list (wrapping back
  // to itself if it's the last one) so the preview shows a representative
  // sample of what one physical sheet actually contains.
  mrpLabelPreviewPair = computed<[MrpLabelData, MrpLabelData] | null>(() => {
    const lines = this.mrpLabelLines();
    const line = this.mrpLabelPreviewLine();
    if (!line) return null;
    const idx = Math.min(this.mrpLabelPreviewLineIndex(), lines.length - 1);
    const rightLine = lines[idx + 1] ?? line;
    const mrpByBarcode = this.mrpLabelMrpByBarcode();
    return [mrpLabelDataForLine(line, mrpByBarcode), mrpLabelDataForLine(rightLine, mrpByBarcode)];
  });

  // Total physical labels (one per piece) the selected lines would print — shown next to Print Selected/All.
  mrpLabelSelectedPieceCount = computed(() => {
    const lines = this.mrpLabelLines();
    let total = 0;
    for (const idx of this.mrpLabelSelected()) total += lines[idx]?.requiredQty ?? 0;
    return total;
  });

  mrpLabelTotalPieceCount = computed(() => {
    return this.mrpLabelLines().reduce((sum, l) => sum + l.requiredQty, 0);
  });

  // Physical 80x70mm sheets a piece count would consume — 2 garment tags per sheet (see mrp-label-zpl.util.ts).
  mrpLabelSheetCount(pieceCount: number): number {
    return Math.ceil(pieceCount / 2);
  }

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

  // O(1) per-row lookup for the Packing Lists tab's DC/Invoice status column
  // — built once per deliveryChallans()/invoices() change instead of
  // filtering the full list on every row on every change-detection cycle.
  private dcsByPackingListId = computed(() => {
    const map = new Map<string, DeliveryChallan[]>();
    for (const dc of this.deliveryChallans()) {
      const arr = map.get(dc.packingListId);
      if (arr) arr.push(dc); else map.set(dc.packingListId, [dc]);
    }
    return map;
  });

  private invoiceByPackingListId = computed(() => {
    const map = new Map<string, Invoice>();
    for (const inv of this.invoices()) map.set(inv.packingListId, inv);
    return map;
  });

  getDCsForPackingList(packingListId?: string): DeliveryChallan[] {
    return packingListId ? this.dcsByPackingListId().get(packingListId) ?? [] : [];
  }

  getInvoiceForPackingList(packingListId?: string): Invoice | undefined {
    return packingListId ? this.invoiceByPackingListId().get(packingListId) : undefined;
  }

  filteredDCList = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    return this.deliveryChallans().filter((dc) => {
      if (!term) return true;
      return dc.dcNo.toLowerCase().includes(term)
        || dc.clientName.toLowerCase().includes(term)
        || dc.salesNos.some((s) => s.toLowerCase().includes(term))
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

  // Distinct clients from the currently loaded invoices, for the client
  // filter dropdown — no separate ClientService call needed since every
  // invoice already carries its own clientId/clientName.
  invoiceFilterClientOptions = computed((): { clientId: string; clientName: string }[] => {
    const map = new Map<string, string>();
    for (const inv of this.invoices()) {
      if (!inv.clientId) continue;
      if (!map.has(inv.clientId)) map.set(inv.clientId, inv.clientName);
    }
    return [...map.entries()]
      .map(([clientId, clientName]) => ({ clientId, clientName }))
      .sort((a, b) => a.clientName.localeCompare(b.clientName, undefined, { numeric: true }));
  });

  filteredInvoiceList = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const clientId = this.invoiceFilterClientId();
    const fromMs = this.invoiceFilterFromDate() ? new Date(this.invoiceFilterFromDate()).setHours(0, 0, 0, 0) : -Infinity;
    const toMs = this.invoiceFilterToDate() ? new Date(this.invoiceFilterToDate()).setHours(23, 59, 59, 999) : Infinity;

    return this.invoices().filter((inv) => {
      if (term
        && !inv.invoiceNo.toLowerCase().includes(term)
        && !inv.clientName.toLowerCase().includes(term)
        && !inv.salesNos.some((s) => s.toLowerCase().includes(term))
      ) return false;

      if (clientId && inv.clientId !== clientId) return false;

      if (fromMs !== -Infinity || toMs !== Infinity) {
        const raw = inv.invoiceDate;
        const ms = raw ? (raw?.toDate ? raw.toDate() : new Date(raw)).getTime() : NaN;
        if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) return false;
      }

      return true;
    });
  });

  clearInvoiceFilters(): void {
    this.invoiceFilterFromDate.set('');
    this.invoiceFilterToDate.set('');
    this.invoiceFilterClientId.set('');
  }

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
    // Same global "Processing…" overlay the Pick List screen uses — this
    // screen's initial fetch (pickLists/packingLists/deliveryChallans/invoices)
    // can take a visible moment, so make that unmistakable rather than looking stuck.
    this.loadingService.start();
    let doneCount = 0;
    const done = () => {
      if (++doneCount >= 4) {
        this.isLoading.set(false);
        // Hold the overlay through the paint that follows this data arriving —
        // signals flipping doesn't mean the table has actually rendered yet.
        requestAnimationFrame(() => requestAnimationFrame(() => this.loadingService.stop()));
      }
    };

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
    this.subscriptions.push(
      this.transportService.getTransports().subscribe({ next: (v) => this.transports.set(v) })
    );
  }

  // Applies the selected Transport Master record's Name/Address/GST No to
  // the Dispatch Info signals — the only place Transport is chosen; DC and
  // Invoice both inherit it from here (see saveDispatchInfo/generateAndPrintDC/
  // generateInvoice) rather than re-selecting it themselves.
  onTransportSelected(transportId: string): void {
    const selected = this.transports().find((t) => t.id === transportId);
    this.transportId.set(selected?.id ?? '');
    this.transport.set(selected?.transportName ?? '');
    this.transportAddress.set(selected?.transportAddress ?? '');
    this.transportGstNo.set(selected?.gstNo ?? '');
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
    this.transportId.set('');
    this.transportAddress.set('');
    this.transportGstNo.set('');
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
    this.transportId.set(loaded.transportId ?? '');
    this.transportAddress.set(loaded.transportAddress ?? '');
    this.transportGstNo.set(loaded.transportGstNo ?? '');
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

    this.liveMrpByBarcode.set(await this.designService.getMrpByBarcodeMap());

    let agentName = loaded.agentName ?? '';
    if (!agentName && loaded.clientId) {
      const client = await this.clientService.getClientByIdOnce(loaded.clientId);
      agentName = client?.agentName ?? '';
    }
    this.agentName.set(agentName);
    this.transport.set(loaded.transport ?? '');
    this.transportId.set(loaded.transportId ?? '');
    this.transportAddress.set(loaded.transportAddress ?? '');
    this.transportGstNo.set(loaded.transportGstNo ?? '');
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

  // Business rule: ONE Packing List / DC = ONE Invoice. Going forward a
  // Packing List produces exactly one DC (see generateAndPrintDC), but a
  // Packing List created before that fix can still carry several legacy
  // per-Sales-Order DC docs — so this always consolidates every DC on the
  // Packing List into a single Invoice covering all their items, rather than
  // looping one Invoice per DC. InvoiceService.createInvoice() gates on the
  // Packing List's own `invoiceId`, so at most one Invoice is ever created
  // per Packing List no matter how many DC docs it has or how many times
  // this is clicked/retried.
  // Entry point from the DC History tab — Invoice generation happens off the
  // Delivery Challan now (DC must exist first), not off the Packing List
  // screen. Resolves the owning Packing List and delegates to the existing
  // generateInvoice() flow, which is unchanged.
  async generateInvoiceForDC(dc: DeliveryChallan): Promise<void> {
    if (!dc.packingListId || this.isGeneratingInvoice()) return;
    const packingList = await this.packingListService.getPackingListByIdOnce(dc.packingListId);
    if (!packingList) {
      await Swal.fire({ icon: 'error', title: 'Packing List Not Found', text: 'The Packing List for this Delivery Challan could not be found.' });
      return;
    }
    await this.generateInvoice(packingList);
  }

  async generateInvoice(packingList: PackingList): Promise<void> {
    if (!packingList.id || this.isGeneratingInvoice()) return;

    const dcs = await this.dcService.getDCsByPackingListIdOnce(packingList.id);
    if (!dcs.length) {
      await Swal.fire({ icon: 'warning', title: 'No Delivery Challan Yet', text: 'Generate the Delivery Challan before creating an Invoice.' });
      return;
    }

    // Set only on an explicit "Generate New Invoice" override below —
    // createInvoice() otherwise atomically rejects a second invoice for the
    // same Packing List, closing the double-click/two-tab race a plain
    // pre-check can't.
    let allowDuplicateInvoice = false;

    const existingInvoices = await this.invoiceService.getInvoicesByPackingListIdOnce(packingList.id);
    let dcsToInvoice = dcs;

    if (existingInvoices.length) {
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
    }

    const primaryDc = dcsToInvoice[0];

    // Every DC on this Packing List belongs to the same client — margin and
    // discount are read once here, from Client Master, and applied
    // automatically (no manual entry / override).
    const invoiceClient = await this.clientService.getClientForDC(packingList.clientId, packingList.clientName);
    const marginPct = invoiceClient?.marginPct ?? 0;
    const clientDiscountPct = invoiceClient?.discountPct ?? 0;

    const { value: formValues } = await Swal.fire({
      title: 'Invoice Settings',
      html: '<div style="text-align:left;font-size:13px">'
        + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Default HSN/SAC Code (used only if a product isn\'t in the standard list)</label>'
        + '<input id="inv-hsn" class="swal2-input" style="margin:0;width:100%" value="62059090"></div>'
        + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Discount % (from Client Master)</label>'
        + '<input class="swal2-input" style="margin:0;width:100%;background:#f3f4f6" value="' + clientDiscountPct + '" disabled></div>'
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
      const { taxRate, hsnSac: defaultHsnSac } = formValues;
      const discountPct = clientDiscountPct;
      const halfTax = taxRate / 2;

      // Consolidate every DC on this Packing List into ONE Invoice: items,
      // Sales Orders and package count are merged across all of dcsToInvoice
      // (normally just one DC; several only for pre-fix legacy Packing Lists —
      // see the doc comment above) so the Invoice's items/quantities exactly
      // mirror everything packed under this Packing List, including any
      // additional/extra scanned items each DC already carries.
      const clientName = primaryDc.clientName || loaded.clientName;
      const clientId = loaded.clientId;

      // Price = MRP after Margin (Client Master), same basis as the DC —
      // Discount is layered on top only here, at the invoice-total level below.
      // A DC item can carry more than one MRP across its sizes (mrpBySize),
      // but an Invoice line has no size columns to show that in — so split
      // each DC item into one Invoice line per distinct MRP, quantity being
      // the sum of just the sizes billed at that MRP.
      const invoiceItems = dcsToInvoice.flatMap((dc) => dc.items.flatMap((dcItem) => {
        const qtyByMrp = new Map<number, number>();
        for (const [size, qty] of Object.entries(dcItem.sizeQty)) {
          const mrp = dcItem.mrpBySize?.[size] ?? dcItem.mrp;
          qtyByMrp.set(mrp, (qtyByMrp.get(mrp) ?? 0) + qty);
        }
        if (qtyByMrp.size === 0) qtyByMrp.set(dcItem.mrp, dcItem.total);
        // HSN/SAC is looked up per product (Design.group, carried through as
        // partName) from the standard list, not typed in by hand — the
        // dialog's HSN field is only a fallback for a product not in it.
        const hsnSac = resolveHsnCode(dcItem.partName, defaultHsnSac);
        return [...qtyByMrp.entries()].map(([mrp, quantity]) => {
          const price = priceAfterMargin(mrp, marginPct);
          const amount = Math.round(quantity * price * 100) / 100;
          return {
            description: dcItem.partName,
            styleNo: dcItem.styleNo || undefined,
            sleeveType: dcItem.sleeveType || undefined,
            hsnSac, discountPct, taxRate, mrp, uom: 'NOS', quantity, price, amount,
          };
        });
      }));

      const grossAmount = Math.round(invoiceItems.reduce((s, i) => s + i.amount, 0) * 100) / 100;
      const discountAmount = Math.round(grossAmount * discountPct / 100 * 100) / 100;
      const taxableValue = Math.round((grossAmount - discountAmount) * 100) / 100;

      // GST type (CGST+SGST for an intra-state sale vs IGST for inter-state)
      // depends on the seller's own state (Company Settings) vs the client's
      // Place of Supply — the client's Ship To state when it genuinely
      // differs from the Bill To Address, otherwise their Bill To state.
      // Shared with the E-Invoice/IRN payload builder (einvoice.service.ts)
      // via resolveGstPlaceOfSupply so the printed Invoice and its e-Invoice
      // always agree on which tax type was charged.
      const company = await this.companySettingsService.getCompanySettingsOnce();
      const shipToDiffers = !!invoiceClient?.shipToAddress && !invoiceClient.shipToSameAsBilling &&
        invoiceClient.shipToAddress.trim() !== (invoiceClient?.billingAddress ?? '').trim();
      const { isInterState } = resolveGstPlaceOfSupply(
        company?.stateCode ?? '',
        invoiceClient?.gstNo,
        invoiceClient?.state,
        shipToDiffers,
        invoiceClient?.shipToState
      );

      const cgstAmount = isInterState ? 0 : Math.round(taxableValue * halfTax / 100 * 100) / 100;
      const sgstAmount = cgstAmount;
      const igstAmount = isInterState ? Math.round(taxableValue * taxRate / 100 * 100) / 100 : 0;
      const totalTaxAmount = Math.round((cgstAmount + sgstAmount + igstAmount) * 100) / 100;
      const rawTotal = taxableValue + totalTaxAmount;
      const totalAmount = Math.round(rawTotal);
      const roundOff = Math.round((totalAmount - rawTotal) * 100) / 100;

      // GST invoices break the tax summary down per HSN/SAC code, not one
      // blended row — items can now carry different codes (see
      // resolveHsnCode above). Each group's own gross gets the same
      // Discount%/Tax% applied as the invoice-level totals above; the
      // invoice's own taxableValue/cgstAmount/sgstAmount (used for the
      // printed "Total" row) stay computed from the overall gross, not a sum
      // of these per-group roundings.
      const grossByHsn = new Map<string, number>();
      for (const item of invoiceItems) grossByHsn.set(item.hsnSac, (grossByHsn.get(item.hsnSac) ?? 0) + item.amount);
      const taxSummary = [...grossByHsn.entries()].map(([hsn, groupGross]) => {
        const groupTaxable = Math.round((groupGross - groupGross * discountPct / 100) * 100) / 100;
        const groupCgst = isInterState ? 0 : Math.round(groupTaxable * halfTax / 100 * 100) / 100;
        const groupIgst = isInterState ? Math.round(groupTaxable * taxRate / 100 * 100) / 100 : 0;
        return {
          hsnSac: hsn,
          taxableValue: groupTaxable,
          cgstRate: isInterState ? 0 : halfTax, cgstAmount: groupCgst,
          sgstRate: isInterState ? 0 : halfTax, sgstAmount: groupCgst,
          igstRate: isInterState ? taxRate : 0, igstAmount: groupIgst,
        };
      });

      const mergedSalesOrderIds = [...new Set(dcsToInvoice.flatMap((dc) => dc.salesOrderIds.length ? dc.salesOrderIds : loaded.salesOrderIds))];
      const mergedSalesNos = [...new Set(dcsToInvoice.flatMap((dc) => dc.salesNos.length ? dc.salesNos : loaded.salesNos))];

      const invoice = await this.invoiceService.createInvoice({
        dcIds: dcsToInvoice.map((dc) => dc.id!),
        dcId: primaryDc.id!,
        dcNo: dcsToInvoice.map((dc) => dc.dcNo).join(', '),
        packingListId: loaded.id!,
        packingListNo: loaded.packingListNo,
        salesOrderIds: mergedSalesOrderIds,
        salesNos: mergedSalesNos,
        orderNo: mergedSalesNos.join(', '),
        clientId,
        clientName,
        // Invoice is a billing document — the client's Bill To Address.
        clientAddress: invoiceClient?.billingAddress ?? '',
        clientPlace: invoiceClient?.place ?? '',
        clientState: invoiceClient?.state ?? '',
        clientZipCode: invoiceClient?.zipCode ?? '',
        clientPhone: invoiceClient?.mobile ?? '',
        clientGstin: invoiceClient?.gstNo ?? '',
        // Ship To Address — from Client Master, falling back to the billing
        // address when the client has no distinct shipping address.
        clientShipToAddress: invoiceClient?.shipToAddress || invoiceClient?.billingAddress || '',
        clientShipToPlace: invoiceClient?.shipToPlace || invoiceClient?.place || '',
        clientShipToState: invoiceClient?.shipToState || invoiceClient?.state || '',
        clientShipToZipCode: invoiceClient?.shipToZipCode || invoiceClient?.zipCode || '',
        destination: formValues.destination,
        transport: primaryDc.transport ?? loaded.transport ?? '',
        transportId: primaryDc.transportId ?? loaded.transportId ?? undefined,
        transportAddress: primaryDc.transportAddress ?? loaded.transportAddress ?? undefined,
        transportGstNo: primaryDc.transportGstNo ?? loaded.transportGstNo ?? undefined,
        vehicleNo: formValues.vehicleNo,
        docNo: formValues.docNo,
        shipmentDate: primaryDc.createdAt ?? null,
        totalPkgs: dcsToInvoice.reduce((s, dc) => s + dc.boxCount, 0),
        agentName: primaryDc.agentName ?? loaded.agentName ?? '',
        items: invoiceItems,
        grossAmount, discountPct, discountAmount, taxableValue,
        cgstRate: isInterState ? 0 : halfTax, cgstAmount,
        sgstRate: isInterState ? 0 : halfTax, sgstAmount,
        igstRate: isInterState ? taxRate : 0, igstAmount, totalTaxAmount, roundOff, totalAmount,
        amountInWords: this.amountToWords(totalAmount),
        taxSummary,
      }, { allowDuplicate: allowDuplicateInvoice });

      await this.refreshInvoices();

      await Swal.fire({
        icon: 'success',
        title: 'Invoice ' + invoice.invoiceNo + ' Generated!',
        html: '<p style="font-size:13px">' + invoice.invoiceNo + ': <strong>&#x20B9;' + invoice.totalAmount.toLocaleString('en-IN') + '</strong></p>',
        showConfirmButton: true,
        showDenyButton: true,
        showCancelButton: true,
        confirmButtonText: 'Print Invoice',
        denyButtonText: 'Download Excel',
        cancelButtonText: 'Close',
        confirmButtonColor: '#4f46e5',
        denyButtonColor: '#059669',
      }).then(async (res) => {
        if (res.isConfirmed) await this.reprintInvoice(invoice);
        if (res.isDenied) await this.downloadInvoiceExcel(invoice);
      });
    } catch (err: any) {
      const text = err?.message === 'already_has_invoice'
        ? 'An invoice has already been generated for this Packing List.'
        : err?.message ?? 'Unable to generate invoice.';
      await Swal.fire({ icon: 'error', title: 'Invoice Generation Failed', text });
      await this.refreshInvoices();
    } finally {
      this.isGeneratingInvoice.set(false);
    }
  }

  async reprintInvoice(invoice: Invoice): Promise<void> {
    // Opened synchronously, before any await — see printEnhancedBoxLabels.
    const win = window.open('', '_blank', 'width=1100,height=820');
    await this.loadingService.run(async () => {
      if (!win) {
        await Swal.fire({ icon: 'warning', title: 'Popup Blocked', text: 'Please allow popups for this site, then try printing again.' });
        return;
      }
      try {
        const [logoDataUri, invoiceWithDesign] = await Promise.all([
          fetchLogoDataUri(),
          this.invoiceService.backfillItemDesignInfoIfNeeded(invoice),
        ]);
        const printInvoice = await this.invoiceService.backfillClientShipToIfNeeded(invoiceWithDesign);
        const html = this.buildInvoiceHtml(printInvoice, logoDataUri);
        win.document.write(html);
        win.document.close();
        setTimeout(() => win.print(), 600);
      } catch (err: any) {
        // A blank popup with no explanation is worse than a visible error —
        // this is the same window already opened above, not a new one.
        win.document.write(`<pre style="padding:20px;color:#b91c1c;font-family:monospace;white-space:pre-wrap">Failed to render the invoice print.\n\n${err?.message || err}</pre>`);
        win.document.close();
      }
    });
  }

  async downloadInvoiceExcel(invoice: Invoice): Promise<void> {
    try {
      await this.loadingService.run(async () => {
        const XLSX = await import('xlsx');
        invoice = await this.invoiceService.backfillClientShipToIfNeeded(invoice);
        const taxRows: any[][] = [
          ...(invoice.cgstAmount > 0 ? [['', '', '', '', '', '', '', '', 'CGST (' + invoice.cgstRate + '%):', invoice.cgstAmount]] : []),
          ...(invoice.sgstAmount > 0 ? [['', '', '', '', '', '', '', '', 'SGST (' + invoice.sgstRate + '%):', invoice.sgstAmount]] : []),
          ...(invoice.igstAmount > 0 ? [['', '', '', '', '', '', '', '', 'IGST (' + invoice.igstRate + '%):', invoice.igstAmount]] : []),
        ];
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
          ['Ship To:', [invoice.clientShipToAddress || invoice.clientAddress, invoice.clientShipToPlace || invoice.clientPlace, invoice.clientShipToState || invoice.clientState, invoice.clientShipToZipCode || invoice.clientZipCode].filter(Boolean).join(', ')],
          ['GSTIN:', invoice.clientGstin, '', 'Phone:', invoice.clientPhone],
          [],
          ['S.No', 'Description', 'HSN/SAC', 'Disc%', 'Tax%', 'MRP', 'UOM', 'Qty', 'Price', 'Amount'],
          ...invoice.items.map((item, i) => [i + 1, item.description, item.hsnSac, item.discountPct, item.taxRate, item.mrp, item.uom, item.quantity, item.price, item.amount]),
          [],
          ['', '', '', '', '', '', '', '', 'Gross Amount:', invoice.grossAmount],
          ['', '', '', '', '', '', '', '', 'Discount (' + invoice.discountPct + '%):', invoice.discountAmount],
          ['', '', '', '', '', '', '', '', 'Taxable Value:', invoice.taxableValue],
          ...taxRows,
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
      });
    } catch {
      await Swal.fire({ icon: 'error', title: 'Excel Export Failed', text: 'Unable to generate Excel. Please try printing the PDF instead.' });
    }
  }

  // Opens the Box Label print screen (QZ Tray + raw ZPL to a thermal
  // printer) instead of the browser's print dialog used by every other
  // print action in this app — thermal label printers need exact
  // width/height/gap/density/speed control that only a direct print-agent
  // connection (QZ Tray) can give, and the browser's own print dialog can't.
  async printBoxLabelsForDC(dc: DeliveryChallan): Promise<void> {
    if (!dc.packingListId) return;
    const packingList = await this.packingListService.getPackingListByIdOnce(dc.packingListId);
    if (!packingList) return;
    await this.printEnhancedBoxLabels(packingList);
  }

  async printEnhancedBoxLabels(packingList: PackingList): Promise<void> {
    if (!packingList.id) return;
    await this.loadingService.run(async () => {
      const existingDCs = await this.dcService.getDCsByPackingListIdOnce(packingList.id!);
      const cartons = packingList.cartons ?? [];
      if (!cartons.length) {
        await Swal.fire({ toast: true, position: 'top-end', icon: 'warning', title: 'No cartons to print', timer: 2000, showConfirmButton: false });
        return;
      }
      this.boxLabelPackingList.set(packingList);
      this.boxLabelDc.set(existingDCs[0] ?? null);
      this.boxLabelSelected.set(new Set(cartons.map((_, idx) => idx)));
      this.boxLabelPreviewIndex.set(0);
      this.boxLabelQzStatus.set('unknown');
      this.boxLabelQzError.set('');
      this.mode.set('box-label-print');
    });
    // Detect printers right away so the dropdown isn't empty on open — errors
    // here (QZ Tray not running) surface in the panel, not as a blocking Swal.
    this.detectBoxLabelPrinters();
  }

  closeBoxLabelPrintModal(): void {
    this.boxLabelPackingList.set(null);
    this.mode.set('view');
  }

  // Returns a full standalone HTML document (not a fragment) so it can be
  // dropped straight into an <iframe [srcdoc]> — an emulated-encapsulation
  // Angular <style> block would never reach this markup, since [innerHTML]/
  // srcdoc content is inserted outside Angular's template compiler and never
  // receives its scoping attribute.
  //
  // The label media is loaded portrait (labelWidthMm < labelHeightMm, e.g.
  // 105×235mm) but buildEnhancedBoxLabelHtml lays its content out as a
  // landscape design — matching the actual ZPL print (see the rotation
  // comment on buildBoxLabelZpl). So `.label-page` (the div that function
  // returns) is sized to the landscape content canvas and rotated 90°
  // clockwise inside a `.label-frame` sized to the true physical label, the
  // same transform the printer applies natively.
  boxLabelPreviewHtml(): SafeHtml {
    const packingList = this.boxLabelPackingList();
    if (!packingList) return this.sanitizer.bypassSecurityTrustHtml('');
    const cartons = packingList.cartons ?? [];
    const idx = Math.min(this.boxLabelPreviewIndex(), Math.max(0, cartons.length - 1));
    const labelHtml = this.buildEnhancedBoxLabelHtml(packingList, idx, cartons.length, this.boxLabelDc());
    const settings = this.boxLabelSettings();
    const contentW = Math.max(settings.labelWidthMm, settings.labelHeightMm);
    const contentH = Math.min(settings.labelWidthMm, settings.labelHeightMm);
    const doc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
      + '*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:10px;background:#fff}'
      + `.label-frame{position:relative;width:${settings.labelWidthMm}mm;height:${settings.labelHeightMm}mm;overflow:hidden;border:1px solid #000}`
      + `.label-page{position:absolute;top:0;left:0;width:${contentW}mm;height:${contentH}mm;overflow:hidden;display:flex;flex-direction:column;`
      + `transform-origin:top left;transform:translate(${contentH}mm,0) rotate(90deg)}`
      + '</style></head><body>' + `<div class="label-frame">${labelHtml}</div>` + '</body></html>';
    return this.sanitizer.bypassSecurityTrustHtml(doc);
  }

  setBoxLabelPreviewIndex(idx: number): void {
    this.boxLabelPreviewIndex.set(idx);
  }

  async detectBoxLabelPrinters(): Promise<void> {
    this.isDetectingBoxLabelPrinters.set(true);
    this.boxLabelQzError.set('');
    try {
      const printers = await this.qzTrayService.listPrinters();
      this.boxLabelPrinters.set(printers);
      this.boxLabelQzStatus.set('connected');
      const current = this.boxLabelSettings();
      if (!current.printerName && printers.length) {
        this.updateBoxLabelSetting('printerName', printers[0]);
      }
    } catch (err: any) {
      this.boxLabelQzStatus.set('error');
      this.boxLabelQzError.set(err?.message ?? 'Could not connect to QZ Tray. Make sure it is installed and running.');
    } finally {
      this.isDetectingBoxLabelPrinters.set(false);
    }
  }

  updateBoxLabelSetting<K extends keyof BoxLabelPrinterSettings>(key: K, value: BoxLabelPrinterSettings[K]): void {
    const next = { ...this.boxLabelSettings(), [key]: value };
    this.boxLabelSettings.set(next);
    saveBoxLabelSettings(next);
  }

  isBoxLabelCartonSelected(index: number): boolean {
    return this.boxLabelSelected().has(index);
  }

  toggleBoxLabelCarton(index: number): void {
    const next = new Set(this.boxLabelSelected());
    if (next.has(index)) next.delete(index); else next.add(index);
    this.boxLabelSelected.set(next);
  }

  selectAllBoxLabelCartons(): void {
    const total = this.boxLabelPackingList()?.cartons.length ?? 0;
    this.boxLabelSelected.set(new Set(Array.from({ length: total }, (_, i) => i)));
  }

  clearBoxLabelCartonSelection(): void {
    this.boxLabelSelected.set(new Set());
  }

  async printSelectedBoxLabels(): Promise<void> {
    await this.runBoxLabelPrint([...this.boxLabelSelected()].sort((a, b) => a - b));
  }

  async printAllBoxLabels(): Promise<void> {
    const total = this.boxLabelPackingList()?.cartons.length ?? 0;
    await this.runBoxLabelPrint(Array.from({ length: total }, (_, i) => i));
  }

  private async runBoxLabelPrint(cartonIndexes: number[]): Promise<void> {
    const packingList = this.boxLabelPackingList();
    const settings = this.boxLabelSettings();
    if (!packingList || !cartonIndexes.length) return;
    if (!settings.printerName) {
      await Swal.fire({ icon: 'warning', title: 'No Printer Selected', text: 'Detect and select a thermal printer first.' });
      return;
    }

    this.isPrintingBoxLabels.set(true);
    try {
      const commands = buildBoxLabelZplBatch(
        packingList,
        cartonIndexes,
        packingList.cartons.length,
        this.boxLabelDc(),
        settings,
      );
      await this.qzTrayService.printRaw(settings.printerName, commands);
      this.boxLabelQzStatus.set('connected');
      await Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `Sent ${cartonIndexes.length} label(s) to ${settings.printerName}`, timer: 2200, showConfirmButton: false });
    } catch (err: any) {
      this.boxLabelQzStatus.set('error');
      const message = err?.message ?? 'Unable to reach QZ Tray or the selected printer.';
      this.boxLabelQzError.set(message);
      await Swal.fire({ icon: 'error', title: 'Print Failed', text: message });
    } finally {
      this.isPrintingBoxLabels.set(false);
    }
  }

  // Opens the MRP Label print screen — same QZ Tray/raw-ZPL approach as Box
  // Label Print, but one label per physical garment piece (80×70mm) instead
  // of one address label per carton. The carton table doubles as the
  // selection UI for *which cartons'* pieces to print; printing itself
  // expands each selected carton's entries into one label per unit of qty.
  async printMrpLabels(packingList: PackingList): Promise<void> {
    if (!packingList.id) return;
    await this.loadingService.run(async () => {
      const [lines, mrpByBarcode] = await Promise.all([
        this.packingListService.getPackingListLinesOnce(packingList.id!),
        this.designService.getMrpByBarcodeMap(),
      ]);
      if (!lines.length) {
        await Swal.fire({ toast: true, position: 'top-end', icon: 'warning', title: 'No lines to print', timer: 2000, showConfirmButton: false });
        return;
      }
      this.mrpLabelMrpByBarcode.set(mrpByBarcode);
      this.mrpLabelPackingList.set(packingList);
      this.mrpLabelLines.set(lines);
      this.mrpLabelSelected.set(new Set(lines.map((_, idx) => idx)));
      this.mrpLabelPreviewLineIndex.set(0);
      this.mrpLabelQzStatus.set('unknown');
      this.mrpLabelQzError.set('');
      this.mode.set('mrp-label-print');
    });
    this.detectMrpLabelPrinters();
  }

  closeMrpLabelPrintModal(): void {
    this.mrpLabelPackingList.set(null);
    this.mrpLabelLines.set([]);
    this.mode.set('view');
  }

  // Mirrors buildMrpLabelZpl's 2-up layout in mm-based absolute-positioned
  // HTML inside an <iframe [srcdoc]> — no rotation is involved (unlike the
  // Box Label preview), since this label's media orientation already
  // matches the design's landscape layout.
  mrpLabelPreviewHtml(): SafeHtml {
    const settings = this.mrpLabelSettings();
    const pair = this.mrpLabelPreviewPair();
    const inner = pair
      ? this.buildMrpLabelPreviewInnerHtml(pair[0], pair[1], settings)
      : '<div style="padding:10px;color:#999;font-size:11px;font-family:Arial,sans-serif">No entries to preview</div>';
    const doc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
      + '*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#fff}'
      + `.label-frame{position:relative;width:${settings.labelWidthMm}mm;height:${settings.labelHeightMm}mm;overflow:hidden;border:1px solid #000}`
      + '</style></head><body>' + `<div class="label-frame">${inner}</div>` + '</body></html>';
    return this.sanitizer.bypassSecurityTrustHtml(doc);
  }

  // Mirrors mrpLabelTagFields in mrp-label-zpl.util.ts exactly — same field
  // content/order (Design/Style/Shade/Size/Qty/MRP/tax as separate
  // columns), same `^A0B`-confirmed rotation, and the same layout: QR as a
  // full-width band across the TOP 25% of the tag's height (sized to
  // nearly fill it, also rotated), fields anchored just below the QR band
  // and growing downward through the remaining 75%.
  private buildMrpLabelPreviewInnerHtml(left: MrpLabelData, right: MrpLabelData, settings: MrpLabelPrinterSettings): string {
    const REF_HALF_W = 39;

    const W = settings.labelWidthMm;
    const H = settings.labelHeightMm;
    const DIVIDER_GAP_MM = 2;
    const halfW = (W - DIVIDER_GAP_MM) / 2;
    const scaleW = halfW / REF_HALF_W;

    const buildHalf = (offsetXMm: number, data: MrpLabelData): string => {
      // QR + code text — full-width band, top 25% of the tag's height, sized to nearly fill it.
      const qrBandHMm = H * 0.25;
      const qrZoneMm = Math.min(qrBandHMm - 1, halfW - 2);
      const qrX = (halfW - qrZoneMm) / 2;
      const qrY = (qrBandHMm - qrZoneMm) / 2;
      const qrHtml = `<div style="position:absolute;left:${offsetXMm + qrX}mm;top:${qrY}mm;width:${qrZoneMm}mm;height:${qrZoneMm}mm;border:0.3mm solid #0f172a;display:flex;align-items:center;justify-content:center;font-size:${2 * scaleW}mm;color:#888">QR</div>`;
      const codeHtml = `<div style="position:absolute;left:${offsetXMm + qrX}mm;top:${qrY + qrZoneMm + 1}mm;width:${qrZoneMm}mm;font-size:${1.2 * scaleW}mm;color:#555;text-align:center;word-break:break-all">${data.code}</div>`;

      // Design / Style / Size / Qty / Shade / MRP / tax — each its OWN
      // rotated column (not combined — matches mrp-label-zpl.util.ts
      // exactly), anchored just BELOW the QR band and growing DOWNWARD —
      // matching the ACTUAL confirmed ZPL behavior (`^A0B` text grows
      // downward from its origin; an earlier revision anchored at the
      // tag's bottom edge assuming upward growth, which broke the real
      // print entirely since there was no room left to grow into).
      // rotate(90deg) (CW) with a top-left origin (no centering translate)
      // extends text downward from the literal anchor point.
      const topYMm = qrBandHMm + 4;
      const col = (xMm: number, heightMm: number, value: string, bold = false): string => {
        const scaledH = heightMm * scaleW;
        const leftX = offsetXMm + xMm * scaleW;
        return `<div style="position:absolute;left:${leftX}mm;top:${topYMm}mm;transform:rotate(90deg);transform-origin:top left;color:#0f172a;font-weight:${bold ? 900 : 600};font-size:${scaledH}mm;white-space:nowrap;line-height:1">${value}</div>`;
      };

      let x = 1.5;
      const fieldsHtml: string[] = [];
      const push = (heightMm: number, value: string, bold = false) => {
        fieldsHtml.push(col(x, heightMm, value, bold));
        x += (heightMm * scaleW + 0.5) / scaleW;
      };
      push(2.8, `Design : ${data.design || '-'}`);
      push(2.4, `Style : ${data.style}`);
      push(2.4, `Shade : ${data.shade}`);
      push(2.4, `Size : ${data.size || '-'}`);
      push(2.4, 'Qty : 1 No');
      push(4.2, `MRP : ₹ ${data.mrp.toFixed(2)}`, true);
      push(1.8, '(Incl. of all Taxes)');

      return qrHtml + codeHtml + fieldsHtml.join('');
    };

    const rightOffsetXMm = halfW + DIVIDER_GAP_MM;
    const dividerHtml = `<div style="position:absolute;left:${halfW + DIVIDER_GAP_MM / 2}mm;top:0;width:0.3mm;height:100%;background:#999"></div>`;

    return `<div style="position:relative;width:100%;height:100%">${buildHalf(0, left)}${buildHalf(rightOffsetXMm, right)}${dividerHtml}</div>`;
  }

  setMrpLabelPreviewLine(idx: number): void {
    this.mrpLabelPreviewLineIndex.set(idx);
  }

  async detectMrpLabelPrinters(): Promise<void> {
    this.isDetectingMrpLabelPrinters.set(true);
    this.mrpLabelQzError.set('');
    try {
      const printers = await this.qzTrayService.listPrinters();
      this.mrpLabelPrinters.set(printers);
      this.mrpLabelQzStatus.set('connected');
      const current = this.mrpLabelSettings();
      if (!current.printerName && printers.length) {
        this.updateMrpLabelSetting('printerName', printers[0]);
      }
    } catch (err: any) {
      this.mrpLabelQzStatus.set('error');
      this.mrpLabelQzError.set(err?.message ?? 'Could not connect to QZ Tray. Make sure it is installed and running.');
    } finally {
      this.isDetectingMrpLabelPrinters.set(false);
    }
  }

  updateMrpLabelSetting<K extends keyof MrpLabelPrinterSettings>(key: K, value: MrpLabelPrinterSettings[K]): void {
    const next = { ...this.mrpLabelSettings(), [key]: value };
    this.mrpLabelSettings.set(next);
    saveMrpLabelSettings(next);
  }

  isMrpLabelLineSelected(index: number): boolean {
    return this.mrpLabelSelected().has(index);
  }

  toggleMrpLabelLine(index: number): void {
    const next = new Set(this.mrpLabelSelected());
    if (next.has(index)) next.delete(index); else next.add(index);
    this.mrpLabelSelected.set(next);
  }

  selectAllMrpLabelLines(): void {
    const total = this.mrpLabelLines().length;
    this.mrpLabelSelected.set(new Set(Array.from({ length: total }, (_, i) => i)));
  }

  clearMrpLabelLineSelection(): void {
    this.mrpLabelSelected.set(new Set());
  }

  async printSelectedMrpLabels(): Promise<void> {
    await this.runMrpLabelPrint([...this.mrpLabelSelected()].sort((a, b) => a - b));
  }

  async printAllMrpLabels(): Promise<void> {
    const total = this.mrpLabelLines().length;
    await this.runMrpLabelPrint(Array.from({ length: total }, (_, i) => i));
  }

  // Diagnostic-only print — see buildRotationDiagnosticZpl's own doc
  // comment. Two consecutive rotation techniques (^A0R, then ^ADR) both
  // failed on the real printer per physical test prints; this isolates the
  // rotation question from the rest of the label so one more physical
  // print can settle which technique (if any) actually works on this
  // hardware, instead of guessing a third full-label redesign.
  async printMrpRotationTest(): Promise<void> {
    const settings = this.mrpLabelSettings();
    if (!settings.printerName) {
      await Swal.fire({ icon: 'warning', title: 'No Printer Selected', text: 'Detect and select a thermal printer first.' });
      return;
    }
    this.isPrintingMrpLabels.set(true);
    try {
      await this.qzTrayService.printRaw(settings.printerName, [buildRotationDiagnosticZpl(settings)]);
      this.mrpLabelQzStatus.set('connected');
      await Swal.fire({
        icon: 'info',
        title: 'Rotation Test Sent',
        html: 'Check the printed label: 6 columns, each with an unrotated caption (A0R / A0B / ADR / ADB / AER / A0R-big) above a "TEST" sample using that technique. Whichever "TEST" prints sideways (not upright like its caption) tells us which technique to use — let me know which one(s) rotated, and which direction.',
      });
    } catch (err: any) {
      this.mrpLabelQzStatus.set('error');
      const message = err?.message ?? 'Unable to reach QZ Tray or the selected printer.';
      this.mrpLabelQzError.set(message);
      await Swal.fire({ icon: 'error', title: 'Print Failed', text: message });
    } finally {
      this.isPrintingMrpLabels.set(false);
    }
  }

  private async runMrpLabelPrint(lineIndexes: number[]): Promise<void> {
    const lines = this.mrpLabelLines();
    const settings = this.mrpLabelSettings();
    if (!lines.length || !lineIndexes.length) return;
    if (!settings.printerName) {
      await Swal.fire({ icon: 'warning', title: 'No Printer Selected', text: 'Detect and select a thermal printer first.' });
      return;
    }

    this.isPrintingMrpLabels.set(true);
    try {
      const mrpByBarcode = this.mrpLabelMrpByBarcode();
      const selectedLines = lineIndexes.map((idx) => lines[idx]).filter((l): l is PackingListLine => !!l);
      const dataList = buildMrpLabelDataForLines(selectedLines, mrpByBarcode);
      if (!dataList.length) {
        await Swal.fire({ toast: true, position: 'top-end', icon: 'warning', title: 'No pieces to print in the selected line(s)', timer: 2000, showConfirmButton: false });
        return;
      }
      const commands = buildMrpLabelZplBatch(dataList, settings);
      await this.qzTrayService.printRaw(settings.printerName, commands);
      this.mrpLabelQzStatus.set('connected');
      await Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `Sent ${dataList.length} label(s) to ${settings.printerName}`, timer: 2200, showConfirmButton: false });
    } catch (err: any) {
      this.mrpLabelQzStatus.set('error');
      const message = err?.message ?? 'Unable to reach QZ Tray or the selected printer.';
      this.mrpLabelQzError.set(message);
      await Swal.fire({ icon: 'error', title: 'Print Failed', text: message });
    } finally {
      this.isPrintingMrpLabels.set(false);
    }
  }

  // ─── Print ─────────────────────────────────────────────────────────────────

  // Downloads a PDF directly (via jsPDF, same as Reports' export) instead of
  // opening a print-preview window — window.open()+document.write() into a
  // popup that's pre-opened before the Firestore reads below turned out to
  // still render blank in some browser/profile combinations, with no error
  // surfaced. A direct file download has no such popup-timing dependency.
  async printReadyPickList(pickList: PickList) {
    await this.loadingService.run(async () => {
      const lines = pickList.id ? await this.pickListService.getPickListLinesOnce(pickList.id) : pickList.items;
      const mrpByBarcode = await this.designService.getMrpByBarcodeMap();

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
            mrp: mrpByBarcode.get(line.barcode ?? '') ?? 0,
            pickedQty,
            packedQty,
            toPackQty,
          };
        })
        .filter((line) => line.toPackQty > 0);

      if (!toPackLines.length) {
        await Swal.fire({ icon: 'info', title: 'Nothing to Pack', text: 'There is no picked-but-unpacked quantity on this Pick List.' });
        return;
      }

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
        mrpBySize: Map<string, number>;
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
          if (line.mrp > 0) existing.mrpBySize.set(line.size, line.mrp);
          existing.total += line.toPackQty;
        } else {
          productMap.set(key, {
            styleNo: line.styleNo,
            part: line.part,
            color: line.color,
            sleeveType: line.sleeveType,
            qtyBySize: new Map([[line.size, line.toPackQty]]),
            mrpBySize: line.mrp > 0 ? new Map([[line.size, line.mrp]]) : new Map(),
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

      const filterSummary = `${(pickList.salesNos ?? []).join(', ')} · ${pickList.clientName} · `
        + `Picked ${totals.picked} · Already Packed ${totals.packed} · To Pack Now ${totals.toPack}`;

      await this.printReadyToPackPdf(pickList, productRows, sizes, sizeTotals, grandTotal, filterSummary);
    });
  }

  // Custom jsPDF layout (not the shared exportRowsToPdf/report-export util) —
  // that util draws every row at a fixed height and overlaps text once a
  // "Product" label wraps past one line, and it auto-switches to landscape
  // past 6 columns which this print must never do (always portrait for
  // packers on the floor). Row height here is computed per-row from the
  // actual wrapped line count, and each size column stacks Qty over MRP so
  // MRP can differ by size without adding a separate column per size.
  private async printReadyToPackPdf(
    pickList: PickList,
    productRows: {
      styleNo: string;
      part: string;
      color: string;
      sleeveType: string;
      qtyBySize: Map<string, number>;
      mrpBySize: Map<string, number>;
      total: number;
    }[],
    sizes: string[],
    sizeTotals: number[],
    grandTotal: number,
    filterSummaryText: string
  ): Promise<void> {
    const { default: JsPDF } = await import('jspdf');
    const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 10;
    const usableW = pageW - margin * 2;

    const colW = { no: 8, style: 34, color: 22, sleeve: 16, total: 14 };
    const fixedW = colW.no + colW.style + colW.color + colW.sleeve + colW.total;
    const sizeColW = Math.max(11, (usableW - fixedW) / sizes.length);

    const lineH = 3.4;
    const padY = 1.6;

    let y = margin;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(`Ready to Pack - ${pickList.pickListNo}`, margin, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(filterSummaryText, margin, y, { maxWidth: usableW });
    y += 6;

    const headerCols: { label: string; w: number }[] = [
      { label: '#', w: colW.no },
      { label: 'Product No.', w: colW.style },
      { label: 'Color', w: colW.color },
      { label: 'Sleeve', w: colW.sleeve },
      ...sizes.map((s) => ({ label: s, w: sizeColW })),
      { label: 'Qty', w: colW.total },
    ];

    const drawHeaderRow = () => {
      const h = lineH + padY * 2;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setDrawColor(200, 200, 200);
      let x = margin;
      for (const col of headerCols) {
        doc.setFillColor(30, 41, 59);
        doc.rect(x, y, col.w, h, 'F');
        doc.rect(x, y, col.w, h, 'S');
        doc.setTextColor(255, 255, 255);
        doc.text(col.label, x + col.w / 2, y + h / 2 + 1.1, { align: 'center', maxWidth: col.w - 2 });
        x += col.w;
      }
      y += h;
    };

    const ensureSpace = (h: number) => {
      if (y + h > pageH - margin - 6) {
        doc.addPage();
        y = margin;
        drawHeaderRow();
      }
    };

    drawHeaderRow();

    productRows.forEach((row, i) => {
      doc.setFontSize(7);
      const partSuffix = row.part && row.part !== 'General' ? ` (${row.part})` : '';
      const styleLines = doc.splitTextToSize(`${row.styleNo}${partSuffix}`, colW.style - 3);
      const colorLines = doc.splitTextToSize(row.color || '-', colW.color - 3);
      const sleeveLines = doc.splitTextToSize(row.sleeveType || '-', colW.sleeve - 3);
      const textLineCount = Math.max(styleLines.length, colorLines.length, sleeveLines.length, 1);
      const rowH = Math.max(textLineCount, 2) * lineH + padY * 2;

      ensureSpace(rowH);

      if (i % 2 === 0) { doc.setFillColor(248, 250, 252); doc.rect(margin, y, usableW, rowH, 'F'); }
      doc.setDrawColor(215, 222, 234);

      let x = margin;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.rect(x, y, colW.no, rowH, 'S');
      doc.text(String(i + 1), x + colW.no / 2, y + rowH / 2 + 1, { align: 'center' });
      x += colW.no;

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(15, 23, 42);
      doc.rect(x, y, colW.style, rowH, 'S');
      styleLines.forEach((ln: string, li: number) => doc.text(ln, x + 1.5, y + padY + lineH * (li + 1) - 1, { maxWidth: colW.style - 3 }));
      x += colW.style;

      doc.setFont('helvetica', 'normal');
      doc.rect(x, y, colW.color, rowH, 'S');
      colorLines.forEach((ln: string, li: number) => doc.text(ln, x + 1.5, y + padY + lineH * (li + 1) - 1, { maxWidth: colW.color - 3 }));
      x += colW.color;

      doc.rect(x, y, colW.sleeve, rowH, 'S');
      sleeveLines.forEach((ln: string, li: number) => doc.text(ln, x + colW.sleeve / 2, y + padY + lineH * (li + 1) - 1, { align: 'center', maxWidth: colW.sleeve - 3 }));
      x += colW.sleeve;

      for (const size of sizes) {
        const qty = row.qtyBySize.get(size) ?? 0;
        const mrp = row.mrpBySize.get(size) ?? 0;
        doc.rect(x, y, sizeColW, rowH, 'S');
        if (qty > 0) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          doc.setTextColor(15, 23, 42);
          doc.text(String(qty), x + sizeColW / 2, y + padY + lineH - 0.6, { align: 'center' });
          if (mrp > 0) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(6);
            doc.setTextColor(100, 116, 139);
            const mrpText = mrp.toFixed(2).replace(/\.00$/, '');
            doc.text(mrpText, x + sizeColW / 2, y + padY + lineH * 2 - 0.6, { align: 'center', maxWidth: sizeColW - 2 });
          }
        } else {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(203, 213, 225);
          doc.text('-', x + sizeColW / 2, y + rowH / 2 + 1, { align: 'center' });
        }
        x += sizeColW;
      }

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(21, 128, 61);
      doc.rect(x, y, colW.total, rowH, 'S');
      doc.text(String(row.total), x + colW.total / 2, y + rowH / 2 + 1, { align: 'center' });

      y += rowH;
    });

    const totalRowH = 8;
    ensureSpace(totalRowH);
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, y, usableW, totalRowH, 'F');
    doc.setDrawColor(200, 200, 200);
    let tx = margin;
    const labelW = colW.no + colW.style + colW.color + colW.sleeve;
    doc.rect(tx, y, labelW, totalRowH, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(15, 23, 42);
    doc.text('Totals', tx + 3, y + totalRowH / 2 + 1);
    tx += labelW;
    for (let idx = 0; idx < sizes.length; idx++) {
      doc.rect(tx, y, sizeColW, totalRowH, 'S');
      doc.text(String(sizeTotals[idx]), tx + sizeColW / 2, y + totalRowH / 2 + 1, { align: 'center' });
      tx += sizeColW;
    }
    doc.rect(tx, y, colW.total, totalRowH, 'S');
    doc.setTextColor(21, 128, 61);
    doc.text(String(grandTotal), tx + colW.total / 2, y + totalRowH / 2 + 1, { align: 'center' });
    y += totalRowH;

    y += 16;
    if (y > pageH - margin - 10) { doc.addPage(); y = margin + 10; }
    const sigLabels = ['Prepared By', 'Checked By', 'Packed By'];
    const segW = usableW / sigLabels.length;
    doc.setDrawColor(51, 65, 85);
    doc.setLineWidth(0.3);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    sigLabels.forEach((label, i) => {
      const x1 = margin + i * segW + 5;
      const x2 = margin + (i + 1) * segW - 5;
      doc.line(x1, y, x2, y);
      doc.text(label, (x1 + x2) / 2, y + 4, { align: 'center' });
    });

    doc.save(`Ready_to_Pack_${pickList.pickListNo}.pdf`);
  }

  // Opens a print PREVIEW (not an instant window.print()) — the popup itself
  // carries on-screen Print/Close actions (hidden from the physical printout
  // via @media print) so the user reviews the exact layout before picking a
  // printer through the browser's own print dialog. Layout mirrors
  // printReadyToPackPdf's product/size pivot (same Qty-over-MRP per size
  // cell, Totals row, signatures) — just rendered as HTML instead of a
  // downloaded PDF, and scoped to this Packing List's own lines.
  async printPackingList(packingList: PackingList) {
    if (!packingList.id) return;
    // Opened synchronously, before any await — see printEnhancedBoxLabels.
    const win = window.open('', '_blank', 'width=1150,height=820');
    await this.loadingService.run(async () => {
      const [fresh, lines, client, mrpByBarcode] = await Promise.all([
        this.packingListService.getPackingListByIdOnce(packingList.id!),
        this.packingListService.getPackingListLinesOnce(packingList.id!),
        this.clientService.getClientByIdOnce(packingList.clientId),
        this.designService.getMrpByBarcodeMap(),
      ]);
      const html = this.buildPackingListPrintHtml(fresh ?? packingList, lines, mrpByBarcode, client?.place ?? '');
      if (win) { win.document.write(html); win.document.close(); }
      else await Swal.fire({ icon: 'warning', title: 'Popup Blocked', text: 'Please allow popups for this site, then try printing again.' });
    });
  }

  async exportPackingListToExcel(packingList: PackingList): Promise<void> {
    if (!packingList.id) return;
    try {
      await this.loadingService.run(async () => {
        const [fresh, lines] = await Promise.all([
          this.packingListService.getPackingListByIdOnce(packingList.id!),
          this.packingListService.getPackingListLinesOnce(packingList.id!),
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
      });
    } catch {
      await Swal.fire({ icon: 'error', title: 'Excel Export Failed', text: 'Unable to generate Excel. Please try printing the PDF instead.' });
    }
  }

  async saveDispatchInfo(packingList: PackingList) {
    if (!packingList.id) return;
    const agentName = this.agentName().trim();
    const transport = this.transport().trim();
    const transportId = this.transportId().trim();
    const transportAddress = this.transportAddress().trim();
    const transportGstNo = this.transportGstNo().trim();
    this.isSavingDispatchInfo.set(true);
    try {
      await this.packingListService.updateDispatchInfo(packingList.id, agentName, transport, transportId, transportAddress, transportGstNo);
      const currentList = this.viewPackingList();
      const currentLive = this.livePackingList();
      if (currentList?.id === packingList.id) this.viewPackingList.update((p) => p ? { ...p, agentName, transport, transportId, transportAddress, transportGstNo } : p);
      if (currentLive?.id === packingList.id) this.livePackingList.update((p) => p ? { ...p, agentName, transport, transportId, transportAddress, transportGstNo } : p);
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

    // Opened synchronously, before any await, so the browser still ties this
    // popup to the click that triggered it — see printEnhancedBoxLabels. Closed
    // below on any path that ends up not printing.
    const win = window.open('', '_blank', 'width=960,height=820');

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
        await this.loadingService.run(async () => {
          const refreshedDCs = await this.backfillDCSleeveTypes(existingDCs, packingList.id!);
          await this.printDCsWithLabels(refreshedDCs.sort((a, b) => a.dcSeq - b.dcSeq), packingList, win);
        });
        return;
      }
      if (!result.isDenied) { win?.close(); return; }
      allowDuplicate = true;
    }

    // LR (Lorry Receipt) capture — only asked when a transporter is actually
    // set (self/door delivery has no LR to record), and always skippable:
    // Cancel/dismiss just means "no LR for this dispatch", it never aborts DC
    // generation itself. Asked before the loading overlay so the interactive
    // form isn't hidden behind it.
    const transportForLr = this.transport().trim();
    let lrNo = '';
    let lrDate = '';
    let lrVehicleNo = '';
    if (transportForLr) {
      const today = new Date().toISOString().slice(0, 10);
      const { value } = await Swal.fire({
        title: 'LR Details (optional)',
        html: '<div style="text-align:left;font-size:13px">'
          + '<p style="font-size:11px;color:#64748b;margin-bottom:10px">If the transporter issued an LR / Consignment Note for this dispatch, enter it here — it can then be mapped to the invoice from the Invoice screen. Leave blank for self/door delivery.</p>'
          + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">LR No.</label>'
          + '<input id="lr-no" class="swal2-input" style="margin:0;width:100%" placeholder="e.g. LR-4521"></div>'
          + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">LR Date</label>'
          + `<input id="lr-date" type="date" class="swal2-input" style="margin:0;width:100%" value="${today}"></div>`
          + '<div><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Vehicle No. (optional)</label>'
          + '<input id="lr-vehicle" class="swal2-input" style="margin:0;width:100%" placeholder="e.g. TN37AB1234"></div>'
          + '</div>',
        showCancelButton: true,
        confirmButtonText: 'Continue',
        cancelButtonText: 'Skip (No LR)',
        confirmButtonColor: '#4f46e5',
        preConfirm: () => ({
          lrNo: (document.getElementById('lr-no') as HTMLInputElement).value.trim(),
          lrDate: (document.getElementById('lr-date') as HTMLInputElement).value,
          vehicleNo: (document.getElementById('lr-vehicle') as HTMLInputElement).value.trim().toUpperCase(),
        }),
      });
      if (value?.lrNo) { lrNo = value.lrNo; lrDate = value.lrDate; }
      lrVehicleNo = value?.vehicleNo || '';
    }

    this.isGeneratingDC.set(true);
    try {
      await this.loadingService.run(async () => {
        const [fresh, lines] = await Promise.all([
          this.packingListService.getPackingListByIdOnce(packingList.id!),
          this.packingListService.getPackingListLinesOnce(packingList.id!),
        ]);
        const loaded = fresh ?? packingList;
        const agentName = this.agentName().trim();
        const transport = this.transport().trim();
        const transportId = this.transportId().trim();
        const transportAddress = this.transportAddress().trim();
        const transportGstNo = this.transportGstNo().trim();

        if (agentName || transport) {
          await this.packingListService.updateDispatchInfo(packingList.id!, agentName, transport, transportId, transportAddress, transportGstNo);
        }

        // A Packing List always belongs to exactly one customer (generation
        // groups by clientId, and combining Pick Lists blocks mixing
        // clients) — partyProgress only ever varies by salesOrderId/salesNo
        // under that one client. So every packed line goes into a single DC
        // covering the whole Packing List, with all its Sales Orders listed.
        const partyProgress = loaded.partyProgress ?? [];
        const salesOrderIds = partyProgress.length
          ? [...new Set(partyProgress.map((p) => p.salesOrderId).filter(Boolean))]
          : (loaded.salesOrderIds ?? []);
        const salesNos = partyProgress.length
          ? [...new Set(partyProgress.map((p) => p.salesNo).filter(Boolean))]
          : (loaded.salesNos ?? []);
        const client = await this.clientService.getClientForDC(loaded.clientId, loaded.clientName);
        const dc = await this.createDCForPackingList(loaded, lines, client, salesOrderIds, salesNos, loaded.clientName, agentName, transport, transportId, transportAddress, transportGstNo, allowDuplicate);
        const generatedDCs: DeliveryChallan[] = [dc];

        if (lrNo) {
          await this.lrEntryService.createLrEntry({
            lrNo,
            lrDate: lrDate ? new Date(lrDate) : new Date(),
            transport,
            transportId: transportId || undefined,
            vehicleNo: lrVehicleNo || undefined,
            packingListId: loaded.id!,
            packingListNo: loaded.packingListNo,
            dcId: dc.id!,
            dcNo: dc.dcNo,
            clientId: loaded.clientId,
            clientName: loaded.clientName,
          });
        }

        await this.refreshDeliveryChallans();
        await this.printDCsWithLabels(generatedDCs, loaded, win);
        this.cancel();
      });
    } catch (err: any) {
      win?.close();
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

  // ─── Line Edit (pre-DC correction) ─────────────────────────────────────────

  // Editing is locked out the moment any DC exists for this Packing List —
  // dcGeneratedKeys/invoiceId are the same fields the backend transaction in
  // PackingListService.updatePackingListLine() checks, so this is just the UI
  // mirror of that authoritative gate (not a substitute for it).
  canEditPackingListLines(packingList: PackingList | null): boolean {
    if (!packingList) return false;
    return (packingList.dcGeneratedKeys ?? []).length === 0 && !packingList.invoiceId;
  }

  // Adds an item that wasn't part of the original Pick List (e.g. a
  // forgotten extra) directly to this Packing List — resolved by barcode
  // against Inventory, then added as already packed via
  // PackingListService.addPackingListLine. Same DC-lock gate as edit/delete.
  async addItemToPackingList(packingList: PackingList) {
    if (!packingList.id) return;

    const fresh = await this.packingListService.getPackingListByIdOnce(packingList.id);
    if (!fresh || !this.canEditPackingListLines(fresh)) {
      await Swal.fire({ icon: 'error', title: 'Adding Locked', text: 'A DC has already been generated for this Packing List — items can no longer be added.' });
      if (fresh) await this.openView(fresh);
      return;
    }

    const salesOrderIds = fresh.salesOrderIds ?? [];
    const salesNos = fresh.salesNos ?? [];
    const soOptionsHtml = salesOrderIds.length > 1
      ? salesOrderIds.map((id, i) => `<option value="${i}">${salesNos[i] ?? id}</option>`).join('')
      : '';

    const { value: formValues } = await Swal.fire({
      title: 'Add Item to Packing List',
      html: '<div style="text-align:left;font-size:13px">'
        + '<p style="font-size:11px;color:#64748b;margin-bottom:10px">Scan or enter the barcode of the item to add. It will be added as already packed and ready for dispatch.</p>'
        + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Barcode</label>'
        + '<input id="add-barcode" class="swal2-input" style="margin:0;width:100%" placeholder="Scan or type barcode" autofocus></div>'
        + '<div><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Qty</label>'
        + '<input id="add-qty" type="number" min="1" class="swal2-input" style="margin:0;width:100%" value="1"></div>'
        + (soOptionsHtml
          ? '<div style="margin-top:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Sales Order</label>'
            + `<select id="add-so" class="swal2-select" style="margin:0;width:100%">${soOptionsHtml}</select></div>`
          : '')
        + '</div>',
      showCancelButton: true,
      confirmButtonText: 'Add',
      confirmButtonColor: '#4f46e5',
      preConfirm: () => {
        const barcode = (document.getElementById('add-barcode') as HTMLInputElement).value.trim();
        const qty = Number((document.getElementById('add-qty') as HTMLInputElement).value);
        const soSelect = document.getElementById('add-so') as HTMLSelectElement | null;
        const soIndex = soSelect ? Number(soSelect.value) : (salesOrderIds.length === 1 ? 0 : -1);
        if (!barcode) { Swal.showValidationMessage('Enter or scan a barcode.'); return; }
        if (!Number.isFinite(qty) || qty <= 0) { Swal.showValidationMessage('Enter a valid quantity.'); return; }
        return { barcode, qty: Math.floor(qty), soIndex };
      },
    });
    if (!formValues) return;

    const inventoryList = await firstValueFrom(this.inventoryService.getInventory());
    const match = inventoryList.find((inv) => inv.barcode === formValues.barcode);
    if (!match) {
      await Swal.fire({ icon: 'error', title: 'Item Not Found', text: `No inventory item found for barcode "${formValues.barcode}".` });
      return;
    }

    const salesOrderId = formValues.soIndex >= 0 ? salesOrderIds[formValues.soIndex] : undefined;
    const salesNo = formValues.soIndex >= 0 ? salesNos[formValues.soIndex] : undefined;

    await this.loadingService.run(async () => {
      try {
        await this.packingListService.addPackingListLine(packingList.id!, {
          styleNo: match.styleNo,
          color: match.color,
          partName: match.group,
          size: match.size,
          sleeveType: match.sleeveType,
          barcode: match.barcode,
          inventoryId: match.id!,
          designId: match.designId,
          qty: formValues.qty,
          salesOrderId,
          salesNo,
        });
        await this.refreshPickListsAndPackingLists();
        const refreshed = await this.packingListService.getPackingListByIdOnce(packingList.id!);
        if (refreshed) await this.openView(refreshed);
        await Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Item added to Packing List', timer: 2000, showConfirmButton: false });
      } catch (err: any) {
        const messages: Record<string, string> = {
          dc_already_generated: 'A DC has already been generated for this Packing List — items can no longer be added.',
          insufficient_stock: 'This item does not have enough stock available.',
          inventory_not_found: 'The item could not be found in Inventory.',
          item_not_resolved: 'Could not resolve this barcode to an inventory item.',
        };
        await Swal.fire({ icon: 'error', title: 'Add Failed', text: messages[err?.message] ?? err?.message ?? 'Unable to add the item.' });
        const refreshed = await this.packingListService.getPackingListByIdOnce(packingList.id!);
        if (refreshed) await this.openView(refreshed);
      }
    });
  }

  async editPackingListLine(packingList: PackingList, line: PackingListLine) {
    if (!packingList.id) return;

    // Re-check against a fresh read — the viewed packingList signal can be
    // stale if a DC was generated (e.g. from another tab/user) since it was loaded.
    const fresh = await this.packingListService.getPackingListByIdOnce(packingList.id);
    if (!fresh || !this.canEditPackingListLines(fresh)) {
      await Swal.fire({ icon: 'error', title: 'Editing Locked', text: 'A DC has already been generated for this Packing List — Style/Size/Qty can no longer be edited.' });
      if (fresh) await this.openView(fresh);
      return;
    }

    const { value: formValues } = await Swal.fire({
      title: 'Edit Packing Line',
      html: '<div style="text-align:left;font-size:13px">'
        + '<p style="font-size:11px;color:#64748b;margin-bottom:10px">Changing Style/Size re-identifies these physical units against Design Master/Inventory.</p>'
        + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Style No</label>'
        + `<input id="edit-style" class="swal2-input" style="margin:0;width:100%" value="${line.styleNo}"></div>`
        + '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Size</label>'
        + `<input id="edit-size" class="swal2-input" style="margin:0;width:100%" value="${line.size}"></div>`
        + '<div><label style="display:block;font-size:11px;font-weight:700;color:#555;margin-bottom:3px">Qty</label>'
        + '<div style="display:flex;align-items:center;gap:8px">'
        + '<button type="button" id="edit-qty-minus" style="width:36px;height:36px;border-radius:8px;border:1px solid #d1d5db;background:#f9fafb;font-size:18px;font-weight:700;color:#374151;cursor:pointer">&minus;</button>'
        + `<input id="edit-qty" type="number" min="1" class="swal2-input" style="margin:0;width:100%;text-align:center" value="${line.requiredQty}">`
        + '<button type="button" id="edit-qty-plus" style="width:36px;height:36px;border-radius:8px;border:1px solid #d1d5db;background:#f9fafb;font-size:18px;font-weight:700;color:#374151;cursor:pointer">+</button>'
        + '</div></div>'
        + '</div>',
      showCancelButton: true,
      confirmButtonText: 'Save',
      confirmButtonColor: '#4f46e5',
      didOpen: () => {
        const qtyInput = document.getElementById('edit-qty') as HTMLInputElement;
        document.getElementById('edit-qty-minus')?.addEventListener('click', () => {
          qtyInput.value = String(Math.max(1, (Math.floor(Number(qtyInput.value)) || 1) - 1));
        });
        document.getElementById('edit-qty-plus')?.addEventListener('click', () => {
          qtyInput.value = String((Math.floor(Number(qtyInput.value)) || 0) + 1);
        });
      },
      preConfirm: () => {
        const styleNo = (document.getElementById('edit-style') as HTMLInputElement).value.trim();
        const size = (document.getElementById('edit-size') as HTMLInputElement).value.trim();
        const requiredQty = Number((document.getElementById('edit-qty') as HTMLInputElement).value);
        if (!styleNo || !size) { Swal.showValidationMessage('Style No and Size are required.'); return; }
        if (!Number.isFinite(requiredQty) || requiredQty <= 0) { Swal.showValidationMessage('Enter a quantity of at least 1 (use Delete to remove the line entirely).'); return; }
        return { styleNo, size, requiredQty };
      },
    });
    if (!formValues) return;

    const identityChanged = formValues.styleNo !== line.styleNo || formValues.size !== line.size;
    let barcode = line.barcode;
    let inventoryId = line.inventoryId;
    let designId = line.designId;

    if (identityChanged) {
      const inventoryList = await firstValueFrom(this.inventoryService.getInventory());
      const match = inventoryList.find((inv) =>
        inv.styleNo === formValues.styleNo
        && inv.color === line.color
        && inv.size === formValues.size
        && (inv.sleeveType ?? '') === (line.sleeveType ?? '')
      );
      if (!match) {
        await Swal.fire({
          icon: 'error',
          title: 'No Matching Inventory Item',
          text: `No inventory item found for Style "${formValues.styleNo}", Size "${formValues.size}", Color "${line.color}". Add it in Design Master first.`,
        });
        return;
      }
      barcode = match.barcode;
      inventoryId = match.id;
      designId = match.designId;
    }

    await this.loadingService.run(async () => {
      try {
        await this.packingListService.updatePackingListLine(packingList.id!, line.lineId, {
          styleNo: formValues.styleNo,
          size: formValues.size,
          requiredQty: formValues.requiredQty,
          barcode,
          inventoryId,
          designId,
        });
        await this.refreshPickListsAndPackingLists();
        const refreshed = await this.packingListService.getPackingListByIdOnce(packingList.id!);
        if (refreshed) await this.openView(refreshed);
        await Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Packing line updated', timer: 2000, showConfirmButton: false });
      } catch (err: any) {
        const messages: Record<string, string> = {
          dc_already_generated: 'A DC has already been generated for this Packing List — editing is locked.',
          qty_invalid: 'Enter a quantity of at least 1 (use Delete to remove the line entirely).',
          insufficient_stock: 'The corrected item does not have enough stock available.',
          inventory_not_found: 'The corrected item could not be found in Inventory.',
          inventory_not_resolved: 'Could not resolve the new Style/Size against Inventory.',
        };
        await Swal.fire({ icon: 'error', title: 'Update Failed', text: messages[err?.message] ?? err?.message ?? 'Unable to update the packing line.' });
        const refreshed = await this.packingListService.getPackingListByIdOnce(packingList.id!);
        if (refreshed) await this.openView(refreshed);
      }
    });
  }

  async deletePackingListLine(packingList: PackingList, line: PackingListLine) {
    if (!packingList.id) return;

    // Re-check against a fresh read — see editPackingListLine for why.
    const fresh = await this.packingListService.getPackingListByIdOnce(packingList.id);
    if (!fresh || !this.canEditPackingListLines(fresh)) {
      await Swal.fire({ icon: 'error', title: 'Editing Locked', text: 'A DC has already been generated for this Packing List — rows can no longer be deleted.' });
      if (fresh) await this.openView(fresh);
      return;
    }

    const result = await Swal.fire({
      icon: 'warning',
      title: 'Delete this item?',
      text: 'This permanently removes the quantity from this Packing List and its source Pick List — it will not be offered again in any future Packing List for this order.',
      showCancelButton: true,
      confirmButtonText: 'Delete',
      confirmButtonColor: '#dc2626',
      cancelButtonText: 'Cancel',
    });
    if (!result.isConfirmed) return;

    await this.loadingService.run(async () => {
      try {
        await this.packingListService.deletePackingListLine(packingList.id!, line.lineId);
        await this.refreshPickListsAndPackingLists();
        const refreshed = await this.packingListService.getPackingListByIdOnce(packingList.id!);
        if (refreshed) await this.openView(refreshed);
        await Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Item deleted from Packing List', timer: 2000, showConfirmButton: false });
      } catch (err: any) {
        const messages: Record<string, string> = {
          dc_already_generated: 'A DC has already been generated for this Packing List — rows can no longer be deleted.',
        };
        await Swal.fire({ icon: 'error', title: 'Delete Failed', text: messages[err?.message] ?? err?.message ?? 'Unable to delete this packing line.' });
        const refreshed = await this.packingListService.getPackingListByIdOnce(packingList.id!);
        if (refreshed) await this.openView(refreshed);
      }
    });
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

  // Compact E-Invoice / E-Way Bill status badges on the Invoices tab — reads
  // the same status fields the E-Invoice/E-Way Bill screens use, via the
  // shared document-stage util, so this list stays in sync with them without
  // duplicating the status logic.
  invoiceQty(invoice: Invoice): number {
    return invoice.items.reduce((sum, item) => sum + item.quantity, 0);
  }

  eInvoiceBadgeClass(invoice: Invoice): string {
    return getStageBadgeClass(invoice.eInvoiceStatus || 'pending');
  }

  eInvoiceBadgeLabel(invoice: Invoice): string {
    return getStageStatusLabel(invoice.eInvoiceStatus || 'pending');
  }

  ewbBadgeClass(invoice: Invoice): string {
    if (invoice.eInvoiceStatus !== 'generated') return getStageBadgeClass('not-started');
    return getStageBadgeClass(invoice.ewbStatus || 'pending');
  }

  ewbBadgeLabel(invoice: Invoice): string {
    if (invoice.eInvoiceStatus !== 'generated') return getStageStatusLabel('not-started');
    return getStageStatusLabel(invoice.ewbStatus || 'pending');
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

  // Indexed by pickListId via a memoized computed() map instead of a raw
  // `.filter()` over the entire packingLists() array — this is called once
  // per row of the "Ready to Pack" table (via @let) on every change-detection
  // cycle, an O(readyPickLists × totalPackingLists) scan that only grows as
  // packing history accumulates. Same fix pattern as pick-list.component.ts's
  // inventoryIndex/alreadyPickedIndex.
  private packingListsByPickListId = computed(() => {
    const map = new Map<string, PackingList[]>();
    for (const pl of this.packingLists()) {
      const keys = new Set<string>();
      if (pl.pickListId) keys.add(pl.pickListId);
      for (const id of pl.pickListIds ?? []) {
        if (id) keys.add(id);
      }
      for (const key of keys) {
        const list = map.get(key);
        if (list) list.push(pl);
        else map.set(key, [pl]);
      }
    }
    return map;
  });

  getPackingListsForPickList(pickListId: string): PackingList[] {
    if (!pickListId) return [];
    return this.packingListsByPickListId().get(pickListId) ?? [];
  }

  getFirstIncompletePacking(packingLists: PackingList[]): PackingList | null {
    return packingLists.find((pl) => pl.status !== 'Completed') ?? null;
  }

  // Reads the partGroups aggregate (distinct group names, maintained
  // server-side by PickListService) rather than scanning the legacy per-line
  // `items` array — see PickList.items doc comment for why that array is no
  // longer populated on new/updated docs.
  getPartCountFromPickList(pickList: PickList): number {
    return pickList.partGroups?.length ?? 0;
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

  private async createDCForPackingList(
    packingList: PackingList,
    lines: PackingListLine[],
    client: any,
    salesOrderIds: string[],
    salesNos: string[],
    clientName: string,
    agentName: string,
    transport: string,
    transportId: string,
    transportAddress: string,
    transportGstNo: string,
    allowDuplicate = false,
  ): Promise<DeliveryChallan> {
    // DC quantity must reflect what was actually packed, not what the Pick
    // List/Packing List line was carrying as its to-pack (requiredQty) amount
    // — a line with zero packedQty contributes nothing to the DC, full stop.
    // (Previously this fell back to requiredQty for unpacked lines, which
    // billed pending/unpacked quantity into the DC.)
    const packedLines = lines.filter((l) => l.packedQty > 0);

    const mrpByBarcode = await this.designService.getMrpByBarcodeMap();

    const rowMap = new Map<string, { partName: string; styleNo: string; color: string; sleeveType?: string; sizeQty: Record<string, number>; mrpBySize: Record<string, number>; total: number; mrp: number }>();
    const sizeSet = new Set<string>();

    for (const line of packedLines) {
      const qty = line.packedQty;
      if (qty <= 0) continue;
      sizeSet.add(line.size);
      const mrp = mrpByBarcode.get(line.barcode ?? '') ?? 0;
      // MRP is part of the row key (not just an annotation on the size
      // cell) — the same design/sleeve/shade prints as separate rows when
      // its MRP changes across sizes, instead of one row with a per-size
      // MRP subscript.
      const key = `${line.partName}||${line.styleNo}||${line.color}||${line.sleeveType ?? ''}||${mrp}`;
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          partName: line.partName,
          styleNo: line.styleNo,
          color: line.color,
          sleeveType: line.sleeveType,
          sizeQty: {},
          mrpBySize: {},
          total: 0,
          mrp,
        });
      }
      const row = rowMap.get(key)!;
      row.sizeQty[line.size] = (row.sizeQty[line.size] ?? 0) + qty;
      // Row is keyed by MRP too, so every size folded into it already shares
      // row.mrp — mrpBySize is kept only for older call sites/documents that
      // still read it (e.g. invoice generation), populated uniformly here.
      if (mrp > 0) row.mrpBySize[line.size] = mrp;
      row.total += qty;
    }

    const sizes = [...sizeSet].sort((a, b) => this.rankSize(a) - this.rankSize(b));
    // DC applies Margin only — never Discount, which is Invoice-only.
    const marginPct = client?.marginPct ?? 0;
    const items: DCItem[] = [...rowMap.values()].map((row) => {
      const price = priceAfterMargin(row.mrp, marginPct);
      const amount = row.total * price;
      return { ...row, price, amount: Math.round(amount * 100) / 100 };
    });
    const totalQty = items.reduce((s, r) => s + r.total, 0);
    const totalAmount = Math.round(items.reduce((s, r) => s + (r.amount ?? 0), 0) * 100) / 100;
    const boxCount = (packingList.cartons ?? []).length;

    return this.dcService.createDC({
      packingListId: packingList.id!,
      packingListNo: packingList.packingListNo,
      salesOrderIds,
      salesNos,
      clientId: packingList.clientId,
      clientName: clientName || packingList.clientName,
      // DC is a shipping document — always use the client's Ship To Address, not Bill To.
      billingAddress: client?.shipToAddress ?? '',
      place: client?.shipToPlace ?? '',
      state: client?.shipToState ?? '',
      zipCode: client?.shipToZipCode ?? '',
      clientPhone: client?.mobile ?? '',
      clientGstin: client?.gstNo ?? '',
      totalQty,
      totalAmount,
      boxCount,
      agentName,
      transport,
      transportId: transportId || undefined,
      transportAddress: transportAddress || undefined,
      transportGstNo: transportGstNo || undefined,
      items,
      sizes,
    }, { allowDuplicate });
  }

  private async printDCsWithLabels(dcs: DeliveryChallan[], packingList: PackingList, preOpenedWin: Window | null = null): Promise<void> {
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

    const win = preOpenedWin ?? window.open('', '_blank', 'width=960,height=820');
    if (win) { win.document.write(combinedHtml); win.document.close(); setTimeout(() => win.print(), 600); }
    else await Swal.fire({ icon: 'warning', title: 'Popup Blocked', text: 'Please allow popups for this site, then try printing again.' });
  }

  private buildCustomerDCHtml(dc: DeliveryChallan, pageNum: number, totalPages: number): string {
    const B = 'border:1px solid #bbb;';
    const th2 = (txt: string, extra = '') =>
      `<th style="padding:5px 7px;${B}background:#e8e8e8;font-size:10px;font-weight:700;text-align:center;${extra}">${txt}</th>`;
    const td2 = (txt: string | number, extra = '') =>
      `<td style="padding:5px 7px;${B}font-size:10px;text-align:center;${extra}">${txt}</td>`;

    // Older DCs (created before the DC row was keyed by MRP) can still carry
    // one item whose sizes span more than one MRP via mrpBySize — split those
    // into one display row per distinct MRP so a stray size at a different
    // MRP never gets silently shown under the item's single flat `mrp`.
    // Margin factor (price/mrp) is assumed uniform across an item's sizes,
    // which holds since it's the same client's Margin% for the whole DC.
    const items: DCItem[] = dc.items.flatMap((item) => {
      const byMrp = new Map<number, Record<string, number>>();
      for (const [size, qty] of Object.entries(item.sizeQty)) {
        if (qty <= 0) continue;
        const mrp = item.mrpBySize?.[size] ?? item.mrp;
        const bucket = byMrp.get(mrp) ?? {};
        bucket[size] = (bucket[size] ?? 0) + qty;
        byMrp.set(mrp, bucket);
      }
      if (byMrp.size <= 1) return [item];
      const factor = item.mrp > 0 && item.price != null ? item.price / item.mrp : 1;
      return [...byMrp.entries()].map(([mrp, sizeQty]) => {
        const total = Object.values(sizeQty).reduce((s, q) => s + q, 0);
        const price = Math.round(mrp * factor * 100) / 100;
        const amount = Math.round(total * price * 100) / 100;
        return { ...item, mrp, sizeQty, total, price, amount };
      });
    });

    // Group items by partName for rowspan
    const partGroups = new Map<string, typeof items>();
    for (const item of items) {
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

    // Two-row header: Description | Design | Sleeve | Shade | MRP | Amount | Size(colspan, Qty only) | Total
    // MRP is its own column (one flat value per row) instead of a per-size
    // subscript — a design/sleeve/shade that carries more than one MRP
    // across its sizes now prints as separate rows (see the row key in
    // createDCForPackingList), each with a single MRP.
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
      ${rs2('Amount')}
      ${dc.sizes.length > 0 ? `<th colspan="${dc.sizes.length}" style="padding:5px 7px;${B}background:#e8e8e8;font-size:10px;font-weight:700;text-align:center">Size (Qty)</th>` : ''}
      ${rs2('Total')}
    </tr>
    <tr>${sizeHeaderCells}</tr>
  </thead>`;

    // Body rows with partName rowspan
    const bodyRows: string[] = [];
    for (const [partName, items] of partGroups) {
      items.forEach((item, idx) => {
        const isFirst = idx === 0;
        const sizeCells = dc.sizes.map((s) => {
          const qty = item.sizeQty[s] ?? 0;
          if (qty <= 0) return td2('-');
          return `<td style="padding:5px 7px;${B}font-size:10px;text-align:center;font-weight:700">${qty}</td>`;
        }).join('');
        const rowBg = bodyRows.length % 2 === 0 ? '#fff' : '#f9f9f9';
        bodyRows.push(`<tr style="background:${rowBg}">
          ${isFirst
            ? `<td rowspan="${items.length}" style="padding:5px 7px;${B}font-size:10px;text-align:left;vertical-align:middle;font-weight:600">${partName}</td>`
            : ''}
          ${td2(item.styleNo, 'font-weight:700;text-align:left')}
          ${td2(item.sleeveType || '-')}
          ${td2(item.color || '-')}
          ${td2(item.mrp ? item.mrp.toFixed(2).replace(/\.00$/, '') : '-')}
          ${td2(item.amount ? item.amount.toFixed(2) : '-')}
          ${sizeCells}
          ${td2(item.total, 'font-weight:700')}
        </tr>`);
      });
    }

    const totalAmount = dc.totalAmount || dc.items.reduce((s, i) => s + (i.amount ?? 0), 0);
    const totalCells = dc.sizes.map((s) => td2(sizeTotals[s] ?? '', 'font-weight:700;background:#f0f0f0')).join('');
    const totalRow = `<tr>
      <td colspan="5" style="padding:5px 7px;${B}font-weight:700;font-size:10px;text-align:right;background:#f0f0f0">Total</td>
      <td style="padding:5px 7px;${B}font-weight:900;font-size:10px;text-align:center;background:#f0f0f0">${totalAmount > 0 ? totalAmount.toFixed(2) : '-'}</td>
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
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Order No.</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dc.salesNos.length ? dc.salesNos.join(', ') : dc.packingListNo}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Order Date</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dateStr}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Total Qty</td><td style="padding:3px 6px;font-size:10px;font-weight:700">: ${grandTotal}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">No.of Box</td><td style="padding:3px 6px;font-size:10px;font-weight:700">: ${dc.boxCount}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Agent Name</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dc.agentName || '-'}</td></tr>
      <tr><td style="padding:3px 6px;font-size:10px;color:#555">Transport</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dc.transport || '-'}</td></tr>
      ${dc.transportGstNo ? `<tr><td style="padding:3px 6px;font-size:10px;color:#555">Transport GSTIN</td><td style="padding:3px 6px;font-size:10px;font-weight:600">: ${dc.transportGstNo}</td></tr>` : ''}
    </table>
  </div>
</div>

<table style="width:100%;border-collapse:collapse">
  ${thead}
  <tbody>
    ${bodyRows.join('') || `<tr><td colspan="${6 + dc.sizes.length + 1}" style="padding:10px;text-align:center;color:#888">No items packed.</td></tr>`}
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

  // Pivots this Packing List's own lines into the same product/size-matrix
  // layout as printReadyToPackPdf (one row per style/color/sleeve, one
  // column per size, Qty stacked over MRP per cell, Totals row, signatures)
  // — but as an HTML print PREVIEW page instead of a downloaded PDF, per the
  // Packing List tab's print requirement. requiredQty is the pivoted Qty
  // (what this specific Packing List is assigned to pack per size, frozen at
  // generation time — the direct analogue of "To Pack Now" on the Ready to
  // Pack view); Packed/Remaining appear alongside it in the header stats so
  // in-progress packing status isn't lost.
  private buildPackingListPrintHtml(
    packingList: PackingList,
    lines: PackingListLine[],
    mrpByBarcode: Map<string, number>,
    location: string
  ): string {
    interface ProductRow {
      styleNo: string;
      part: string;
      color: string;
      sleeveType: string;
      qtyBySize: Map<string, number>;
      mrpBySize: Map<string, number>;
      total: number;
    }
    const productMap = new Map<string, ProductRow>();
    const sizeSet = new Set<string>();

    for (const line of lines) {
      const qty = Math.max(0, Number(line.requiredQty) || 0);
      if (qty <= 0) continue;
      sizeSet.add(line.size);
      const mrp = mrpByBarcode.get(line.barcode ?? '') ?? 0;
      const key = `${line.styleNo}||${line.partName}||${line.color}||${line.sleeveType ?? ''}`;
      const existing = productMap.get(key);
      if (existing) {
        existing.qtyBySize.set(line.size, (existing.qtyBySize.get(line.size) ?? 0) + qty);
        if (mrp > 0) existing.mrpBySize.set(line.size, mrp);
        existing.total += qty;
      } else {
        productMap.set(key, {
          styleNo: line.styleNo,
          part: line.partName,
          color: line.color,
          sleeveType: line.sleeveType ?? '',
          qtyBySize: new Map([[line.size, qty]]),
          mrpBySize: mrp > 0 ? new Map([[line.size, mrp]]) : new Map(),
          total: qty,
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

    const totalRequiredQty = lines.reduce((s, l) => s + (Number(l.requiredQty) || 0), 0);
    const totalPackedQty = lines.reduce((s, l) => s + (Number(l.packedQty) || 0), 0);
    const totalRemainingQty = lines.reduce((s, l) => s + (Number(l.remainingQty) || 0), 0);

    const summaryLine = [
      (packingList.salesNos ?? []).join(', '),
      location ? `${packingList.clientName} - ${location}` : packingList.clientName,
      `Required ${totalRequiredQty}`,
      `Packed ${totalPackedQty}`,
      `Remaining ${totalRemainingQty}`,
    ].filter(Boolean).join(' · ');

    const esc = (value: string) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const fixedColsPct = { no: 5, style: 24, color: 11, sleeve: 9, total: 8 };
    const fixedTotalPct = fixedColsPct.no + fixedColsPct.style + fixedColsPct.color + fixedColsPct.sleeve + fixedColsPct.total;
    const sizeColPct = sizes.length ? (100 - fixedTotalPct) / sizes.length : 0;

    const colGroup = `
      <col style="width:${fixedColsPct.no}%">
      <col style="width:${fixedColsPct.style}%">
      <col style="width:${fixedColsPct.color}%">
      <col style="width:${fixedColsPct.sleeve}%">
      ${sizes.map(() => `<col style="width:${sizeColPct}%">`).join('')}
      <col style="width:${fixedColsPct.total}%">`;

    const headerRow = `
      <tr>
        <th>#</th>
        <th style="text-align:left">Product No.</th>
        <th style="text-align:left">Color</th>
        <th>Sleeve</th>
        ${sizes.map((s) => `<th>${esc(s)}</th>`).join('')}
        <th>Qty</th>
      </tr>`;

    const dataRows = productRows.map((row, i) => {
      const partSuffix = row.part && row.part !== 'General' ? ` (${esc(row.part)})` : '';
      const sizeCells = sizes.map((size) => {
        const qty = row.qtyBySize.get(size) ?? 0;
        const mrp = row.mrpBySize.get(size) ?? 0;
        if (qty <= 0) return `<td class="qty-cell"><span class="dash">-</span></td>`;
        const mrpHtml = mrp > 0 ? `<span class="mrp">${mrp.toFixed(2).replace(/\.00$/, '')}</span>` : '';
        return `<td class="qty-cell"><span class="qty">${qty}</span>${mrpHtml}</td>`;
      }).join('');
      return `
        <tr style="background:${i % 2 === 0 ? '#f8fafc' : '#ffffff'}">
          <td style="text-align:center;color:#64748b">${i + 1}</td>
          <td style="font-weight:700">${esc(row.styleNo)}${partSuffix}</td>
          <td>${esc(row.color) || '-'}</td>
          <td style="text-align:center">${esc(row.sleeveType) || '-'}</td>
          ${sizeCells}
          <td class="row-total">${row.total}</td>
        </tr>`;
    }).join('');

    const totalsRow = `
      <tr class="totals-row">
        <td colspan="4" style="text-align:right;padding-right:10px">Totals</td>
        ${sizeTotals.map((t) => `<td style="text-align:center">${t}</td>`).join('')}
        <td class="row-total">${grandTotal}</td>
      </tr>`;

    return `
      <!DOCTYPE html><html>
      <head><meta charset="utf-8"><title>Packing List - ${esc(packingList.packingListNo)}</title>
      <style>
        @page { size: A4; margin: 12mm; }
        * { box-sizing: border-box; }
        body { font-family: Arial, Helvetica, sans-serif; color:#0f172a; margin:0; padding:20px; }
        h1 { font-size:16px; margin:0 0 4px; }
        .summary-line { font-size:11px; color:#475569; margin-bottom:14px; }
        .toolbar { display:flex; justify-content:flex-end; gap:8px; margin-bottom:14px; }
        .toolbar button { padding:8px 18px; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; border:1px solid transparent; }
        .toolbar .btn-print { background:#4f46e5; color:#fff; }
        .toolbar .btn-close { background:#fff; color:#334155; border-color:#cbd5e1; }
        table { width:100%; border-collapse:collapse; font-size:10.5px; table-layout:fixed; }
        thead { display: table-header-group; }
        tr { page-break-inside: avoid; }
        th { background:#0f172a; color:#fff; padding:7px 4px; font-size:9.5px; text-transform:uppercase; letter-spacing:.02em; border:1px solid #0f172a; }
        td { border:1px solid #d7deea; padding:5px 4px; vertical-align:middle; word-break:break-word; }
        .qty-cell { text-align:center; }
        .qty-cell .qty { font-weight:700; font-size:12px; display:block; }
        .qty-cell .mrp { font-size:8.5px; color:#64748b; display:block; margin-top:1px; }
        .qty-cell .dash { color:#cbd5e1; }
        .row-total { text-align:center; font-weight:700; color:#15803d; }
        .totals-row td { background:#f1f5f9; font-weight:700; }
        .signatures { display:flex; justify-content:space-between; gap:24px; margin-top:40px; }
        .signatures div { flex:1; border-top:1px solid #334155; padding-top:6px; text-align:center; color:#475569; font-size:11px; }
        @media print {
          .toolbar { display:none !important; }
          body { padding:0; }
        }
      </style></head>
      <body>
        <div class="toolbar">
          <button class="btn-close" onclick="window.close()">Close</button>
          <button class="btn-print" onclick="window.print()">Print</button>
        </div>
        <h1>Packing List - ${esc(packingList.packingListNo)}</h1>
        <div class="summary-line">${esc(summaryLine)}</div>
        <table>
          <colgroup>${colGroup}</colgroup>
          <thead>${headerRow}</thead>
          <tbody>${dataRows}${totalsRow}</tbody>
        </table>
        <div class="signatures">
          <div>Prepared By</div><div>Checked By</div><div>Packed By</div>
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

  // Mirrors buildBoxLabelZpl's layout: no company/header block, no Invoice
  // No. (the QR encodes the DC number instead), and every value (name, sales
  // order no., DC no., box no., destination, transport, qty) uses the same
  // "value" style — matching that function's single '3' font tier applied
  // uniformly instead of a per-field size hierarchy.
  private buildEnhancedBoxLabelHtml(packingList: PackingList, cartonIndex: number, totalBoxes: number, dc: DeliveryChallan | null): string {
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
    const addrHtml = addrParts.map((p) => '<div style="font-size:14px;line-height:1.3;color:#333;margin-top:2px">' + p + '</div>').join('');
    const qrData = 'DC:' + (dc?.dcNo || 'N/A') + '|BOX:' + (cartonIndex + 1) + 'of' + totalBoxes + '|CODE:' + (dc?.clientId || packingList.clientId).substring(0, 8).toUpperCase();
    const value = 'font-size:16px;font-weight:900;color:#0f172a;line-height:1.15;margin-top:1px';
    const nameValue = 'font-size:24px;font-weight:900;color:#0f172a;line-height:1.15;margin-top:2px';
    const caption = 'font-size:7px;color:#666;font-weight:700;text-transform:uppercase';
    // Ship To gets ~57% of the label's height (flex-basis), matching
    // buildBoxLabelZpl's 0–60mm-of-105mm row budget — the other two rows
    // split the remaining ~43% between them (22%/22%), down from a roughly
    // even 3-way split, at the user's request to make Ship To dominant.
    return '<div class="label-page">'
      + '<div style="flex:0 0 57%;padding:8px;border-bottom:1px solid #ccc;overflow:hidden">'
      + '<div style="' + caption + ';color:#4f46e5">Ship To</div>'
      + '<div style="' + nameValue + '">' + customerName + '</div>'
      + (addrHtml || '<div style="font-size:14px;color:#888">—</div>') + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:1px solid #ccc;flex:0 0 21%">'
      + '<div style="padding:5px 6px;border-right:1px solid #ccc"><div style="' + caption + '">Sales Order No.</div><div style="' + value + '">' + ((packingList.salesNos ?? []).join(', ') || '—') + '</div></div>'
      + '<div style="padding:5px 6px;border-right:1px solid #ccc"><div style="' + caption + '">DC No.</div><div style="' + value + '">' + (dc?.dcNo || '—') + '</div></div>'
      + '<div style="padding:5px 6px"><div style="' + caption + '">Box No.</div><div style="' + value + '">' + carton.cartonNo + '</div>'
      + '<div style="font-size:7px;color:#666;margin-top:2px">Box ' + (cartonIndex + 1) + ' of ' + totalBoxes + '</div></div></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;flex:1;min-height:0">'
      + '<div style="padding:5px 6px;border-right:1px solid #ccc"><div style="' + caption + '">Destination</div><div style="' + value + '">' + (dc?.place || '—') + '</div></div>'
      + '<div style="padding:5px 6px;border-right:1px solid #ccc"><div style="' + caption + '">Transport</div><div style="' + value + '">' + (dc?.transport || packingList.transport || '—') + '</div></div>'
      + '<div style="padding:5px 6px;background:#f0fdf4"><div style="' + caption + ';color:#047857">Total Qty</div><div style="' + value + ';color:#047857">' + carton.totalQty + ' PCS</div></div></div>'
      + '<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-top:1px solid #ccc">'
      + '<div style="border:1.5px solid #0f172a;padding:4px;font-size:6px;font-family:monospace;word-break:break-all;text-align:center;width:76px;line-height:1.4">' + qrData + '</div>'
      + '<div style="font-size:7px;color:#666">Scan for details</div></div></div>';
  }

  private buildInvoiceHtml(invoice: Invoice, logoDataUri = ''): string {
    const B = 'border:1px solid #ccc;';
    const th = (txt: string, extra = '') => '<th style="padding:5px 7px;' + B + 'background:#e8e8e8;font-size:13px;font-weight:700;text-align:center;' + extra + '">' + txt + '</th>';
    const td = (txt: string | number, extra = '') => '<td style="padding:5px 7px;' + B + 'font-size:13px;text-align:center;' + extra + '">' + txt + '</td>';
    const fmtDate = (raw: any): string => {
      if (!raw) return '-';
      try { const d = raw?.toDate ? raw.toDate() : new (Function.prototype.bind.call(Date, null, raw))(); return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '-'; }
    };
    const logoHtml = logoDataUri
      ? '<img src="' + logoDataUri + '" style="width:90px;height:auto;border-radius:6px;flex-shrink:0;margin-right:14px;object-fit:contain" alt="TMG Logo">'
      : '<div style="width:80px;height:60px;border:1px solid #ccc;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;color:#1e3a8a;text-align:center;flex-shrink:0;margin-right:14px">TMG<br>CLOTHINGS</div>';
    const addrLines = [invoice.clientAddress, [invoice.clientPlace, invoice.clientState].filter(Boolean).join(', ') + (invoice.clientZipCode ? ' - ' + invoice.clientZipCode : ''), invoice.clientPhone ? 'Mobile: ' + invoice.clientPhone : ''].filter(Boolean);
    const clientAddrHtml = addrLines.map((l) => '<div style="font-size:13px;margin-top:2px">' + l + '</div>').join('');
    const shipToAddrLines = [invoice.clientShipToAddress || invoice.clientAddress, [invoice.clientShipToPlace || invoice.clientPlace, invoice.clientShipToState || invoice.clientState].filter(Boolean).join(', ') + ((invoice.clientShipToZipCode || invoice.clientZipCode) ? ' - ' + (invoice.clientShipToZipCode || invoice.clientZipCode) : '')].filter(Boolean);
    const shipToAddrHtml = shipToAddrLines.map((l) => '<div style="font-size:13px;margin-top:2px">' + l + '</div>').join('');
    const itemRows = invoice.items.map((item, i) => '<tr style="background:' + (i % 2 === 0 ? '#fff' : '#f9f9f9') + '">'
      + td(i + 1) + td(item.description, 'text-align:left;font-weight:600')
      + td(item.styleNo || '-') + td(item.sleeveType || '-') + td(item.hsnSac)
      + td(item.mrp.toFixed(2)) + td(item.uom)
      + td(item.quantity) + td(item.price.toFixed(2), 'font-weight:700;text-align:right') + td(item.amount.toFixed(2), 'font-weight:700;text-align:right') + '</tr>').join('');
    const totalQty = invoice.items.reduce((sum, item) => sum + item.quantity, 0);
    const taxSummaryRows = invoice.taxSummary.map((t) => '<tr>'
      + td(t.hsnSac) + td(t.taxableValue.toFixed(2), 'font-weight:700') + td(t.cgstRate) + td(t.cgstAmount.toFixed(2), 'font-weight:700')
      + td(t.sgstRate) + td(t.sgstAmount.toFixed(2), 'font-weight:700') + td(t.igstRate || '-') + td(t.igstAmount ? t.igstAmount.toFixed(2) : '-') + '</tr>').join('');
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice - ' + invoice.invoiceNo + '</title>'
      + '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:14px;color:#000}table{width:100%;border-collapse:collapse}@media print{@page{size:A4;margin:10mm}}</style>'
      + '</head><body><div style="padding:10px 14px">'
      + '<div style="display:flex;align-items:center;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:8px">'
      + logoHtml
      + '<div style="flex:1;text-align:center"><div style="font-size:24px;font-weight:900">TMG Clothings</div>'
      + '<div style="font-size:13px;color:#333;margin-top:2px">Door No.334/2, Serayampalaym, Vellanaipatti Post, Coimbatore - 641048</div>'
      + '<div style="font-size:13px;color:#333">Phone: 9842211787 | Email: order@tmggarments.in | GSTIN: 33AAYFT2559B1ZY</div></div>'
      + '<div style="text-align:right;font-size:12px;color:#666;min-width:110px">Triplicate-For Assessee</div></div>'
      + '<div style="font-size:17px;font-weight:700;text-align:center;letter-spacing:2px;text-decoration:underline;margin-bottom:10px">TAX INVOICE</div>'
      + '<div style="display:flex;border:1px solid #aaa;margin-bottom:10px">'
      + '<div style="flex:1;padding:7px 10px;border-right:1px solid #aaa">'
      + '<div style="font-size:14px;font-weight:700;margin-bottom:4px">M/S : ' + invoice.clientName + '</div>'
      + clientAddrHtml + (invoice.clientGstin ? '<div style="font-size:13px;margin-top:4px;font-weight:600">GSTIN: ' + invoice.clientGstin + '</div>' : '') + '</div>'
      + '<div style="flex:1;padding:7px 10px;border-right:1px solid #aaa">'
      + '<div style="font-size:13px;font-weight:700;margin-bottom:3px">Ship To : ' + invoice.clientName + '</div>'
      + shipToAddrHtml + '</div>'
      + '<div style="min-width:210px;padding:5px 10px"><table style="border-collapse:collapse;width:100%">'
      + '<tr><td style="padding:3px 4px;font-size:13px;color:#555">Invoice No.</td><td style="padding:3px 4px;font-size:13px;font-weight:700">: ' + invoice.invoiceNo + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:13px;color:#555">Invoice Date</td><td style="padding:3px 4px;font-size:13px">: ' + fmtDate(invoice.invoiceDate) + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:13px;color:#555">DC No.</td><td style="padding:3px 4px;font-size:13px;font-weight:700">: ' + (invoice.dcNo || '—') + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:13px;color:#555">Order No.</td><td style="padding:3px 4px;font-size:13px;font-weight:600">: ' + invoice.orderNo + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:13px;color:#555">Destination</td><td style="padding:3px 4px;font-size:13px">: ' + (invoice.destination || '—') + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:13px;color:#555">Transport</td><td style="padding:3px 4px;font-size:13px">: ' + (invoice.transport || '—') + '</td></tr>'
      + (invoice.transportGstNo ? '<tr><td style="padding:3px 4px;font-size:13px;color:#555">Transport GSTIN</td><td style="padding:3px 4px;font-size:13px">: ' + invoice.transportGstNo + '</td></tr>' : '')
      + '<tr><td style="padding:3px 4px;font-size:13px;color:#555">Doc No.</td><td style="padding:3px 4px;font-size:13px">: ' + (invoice.docNo || '—') + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:13px;color:#555">Vehicle No.</td><td style="padding:3px 4px;font-size:13px">: ' + (invoice.vehicleNo || '—') + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:13px;color:#555">Total Pkgs</td><td style="padding:3px 4px;font-size:13px;font-weight:700">: ' + invoice.totalPkgs + '</td></tr>'
      + '<tr><td style="padding:3px 4px;font-size:13px;color:#555">Agent</td><td style="padding:3px 4px;font-size:13px">: ' + (invoice.agentName || '—') + '</td></tr>'
      + '</table></div></div>'
      + '<table style="margin-bottom:10px"><thead><tr>'
      + th('S.No') + th('Description', 'text-align:left') + th('Design No') + th('Sleeve Type') + th('HSN/SAC') + th('MRP') + th('UOM') + th('Quantity') + th('Price') + th('Amount')
      + '</tr></thead><tbody>' + itemRows
      + '<tr><td colspan="7" style="padding:5px 7px;' + B + 'font-weight:700;font-size:13px;text-align:right;background:#f0f0f0">Gross</td>'
      + '<td style="padding:5px 7px;' + B + 'font-weight:900;font-size:14px;text-align:center;background:#f0f0f0">' + totalQty + '</td>'
      + '<td style="padding:5px 7px;' + B + 'background:#f0f0f0"></td>'
      + '<td style="padding:5px 7px;' + B + 'font-weight:900;font-size:14px;text-align:center;background:#f0f0f0">' + invoice.grossAmount.toFixed(2) + '</td></tr>'
      + '</tbody></table>'
      + '<div style="display:flex;justify-content:flex-end;margin-bottom:10px">'
      + '<table style="width:300px;border-collapse:collapse">'
      + '<tr><td style="padding:4px 10px;font-size:13px;border:1px solid #ddd">Discount (' + invoice.discountPct + '%)</td><td style="padding:4px 10px;font-size:13px;font-weight:700;text-align:right;border:1px solid #ddd">' + invoice.discountAmount.toFixed(2) + '</td></tr>'
      + '<tr><td style="padding:4px 10px;font-size:13px;border:1px solid #ddd">Taxable Value</td><td style="padding:4px 10px;font-size:13px;font-weight:700;text-align:right;border:1px solid #ddd">' + invoice.taxableValue.toFixed(2) + '</td></tr>'
      + (invoice.cgstAmount > 0 ? '<tr><td style="padding:4px 10px;font-size:13px;border:1px solid #ddd">CGST (' + invoice.cgstRate + '%)</td><td style="padding:4px 10px;font-size:13px;text-align:right;border:1px solid #ddd">' + invoice.cgstAmount.toFixed(2) + '</td></tr>' : '')
      + (invoice.sgstAmount > 0 ? '<tr><td style="padding:4px 10px;font-size:13px;border:1px solid #ddd">SGST (' + invoice.sgstRate + '%)</td><td style="padding:4px 10px;font-size:13px;text-align:right;border:1px solid #ddd">' + invoice.sgstAmount.toFixed(2) + '</td></tr>' : '')
      + (invoice.igstAmount > 0 ? '<tr><td style="padding:4px 10px;font-size:13px;border:1px solid #ddd">IGST (' + invoice.igstRate + '%)</td><td style="padding:4px 10px;font-size:13px;text-align:right;border:1px solid #ddd">' + invoice.igstAmount.toFixed(2) + '</td></tr>' : '')
      + '<tr><td style="padding:4px 10px;font-size:13px;border:1px solid #ddd;font-weight:700">Total Tax Amount</td><td style="padding:4px 10px;font-size:13px;font-weight:700;text-align:right;border:1px solid #ddd">' + invoice.totalTaxAmount.toFixed(2) + '</td></tr>'
      + '<tr><td style="padding:4px 10px;font-size:13px;border:1px solid #ddd">Round Off</td><td style="padding:4px 10px;font-size:13px;text-align:right;border:1px solid #ddd">' + invoice.roundOff.toFixed(2) + '</td></tr>'
      + '<tr style="background:#0f172a;color:#fff"><td style="padding:6px 10px;font-size:15px;font-weight:900;border:1px solid #0f172a">TOTAL</td>'
      + '<td style="padding:6px 10px;font-size:16px;font-weight:900;text-align:right;border:1px solid #0f172a">&#x20B9; ' + invoice.totalAmount.toLocaleString('en-IN') + '</td></tr>'
      + '</table></div>'
      + '<div style="border:1px solid #ccc;padding:6px 10px;margin-bottom:10px;font-size:13px"><strong>Rupees :</strong> ' + invoice.amountInWords + '</div>'
      + '<table style="margin-bottom:10px"><thead><tr>'
      + th('HSN/SAC') + th('Taxable Value') + th('CGST %') + th('CGST Amt') + th('SGST %') + th('SGST Amt') + th('IGST %') + th('IGST Amt')
      + '</tr></thead><tbody>' + taxSummaryRows
      + '<tr style="background:#f0f0f0">' + td('Total', 'font-weight:700') + td(invoice.taxableValue.toFixed(2), 'font-weight:700') + td('') + td(invoice.cgstAmount.toFixed(2), 'font-weight:700') + td('') + td(invoice.sgstAmount.toFixed(2), 'font-weight:700') + td('') + td(invoice.igstAmount ? invoice.igstAmount.toFixed(2) : '-') + '</tr>'
      + '</tbody></table>'
      + '<div style="font-size:12px;border:1px solid #ccc;padding:5px 10px;margin-bottom:10px">Amount of Tax (in words) : ' + this.amountToWords(invoice.totalTaxAmount) + '</div>'
      + '<div style="border:1px solid #ccc;padding:6px 10px;margin-bottom:10px;font-size:13px"><div style="font-weight:700;margin-bottom:4px">Company\'s Bank Details :</div>'
      + '<div>Name of the Account : TMG Clothings</div><div>A/C No : 44358238258</div>'
      + '<div>IFSC Code : SBIN0061170</div><div>Bank Name : STATE BANK OF INDIA / Branch : Siruthozhil Branch, Kovilpatti</div></div>'
      + '<div style="font-size:13px;margin-bottom:14px">Remarks :</div>'
      + '<div style="display:flex;justify-content:space-between;margin-top:34px">'
      + '<div style="text-align:center"><div style="border-top:1px solid #555;padding-top:5px;font-size:13px;color:#444;width:130px">Checked By</div></div>'
      + '<div style="text-align:center"><div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:2px">For TMG Clothings</div>'
      + '<div style="border-top:1px solid #555;padding-top:5px;font-size:13px;color:#444;width:160px;margin-top:34px">Authorised Signatory</div></div>'
      + '</div></div></body></html>';
  }

  private amountToWords(amount: number): string {
    const parts = amount.toFixed(2).split('.');
    const rupees = parseInt(parts[0], 10);
    const paisa = parseInt(parts[1], 10);
    const rupeeWords = this.numberToWords(rupees);
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
