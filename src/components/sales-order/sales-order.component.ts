import { Component, ChangeDetectionStrategy, signal, inject, OnInit, OnDestroy, ViewChild, ElementRef, computed, effect, HostListener } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Client } from '../../models/client.model';
import { Design, SizePrice } from '../../models/design.model';
import { OrderItem, OrderItemSize, SalesOrder } from '../../models/sales-order.model';
import { ClientService } from '../../services/client.service';
import { DesignService } from '../../services/design.service';
import { SalesOrderService } from '../../services/sales-order.service';
import Swal from 'sweetalert2';
import { Timestamp } from '@angular/fire/firestore';
import jsPDF from 'jspdf';

declare const jsQR: any;

type ViewMode = 'list' | 'form';

// --- State for Consolidated Entry (group-based) ---
type SleeveAvailability = { full: boolean; half: boolean };

// The catalog's own Fabric Description per sleeve type — a design's Full and Half
// sizeVars can carry different Fabric Description strings (e.g. "...FS" vs "...HS").
type SleeveFabricDescriptions = { full: string | null; half: string | null };

type DesignRatio = {
  design: Design;
  sizeQuantities: Record<string, string>;
  shirtSizeQuantities: Record<string, { full: string; half: string }>;
  scannedSleeveTypes: SleeveAvailability;
  sleeveFabricDescriptions: SleeveFabricDescriptions;
};

type FabricGroupEntry = {
  fabricDescription: string;
  containsShirt: boolean;
  allPossibleSizes: string[];
  designRatios: DesignRatio[];
  groupSizeQuantities: Record<string, string>;
  groupShirtSizeQuantities: Record<string, { full: string; half: string }>;
  groupScannedSleeveTypes: SleeveAvailability;
  groupSleeveFabricDescriptions: SleeveFabricDescriptions;
};

type ConsolidatedEntryState = {
  isActive: boolean;
  scannedBarcodes: string[];
  groups: FabricGroupEntry[];
};

// One card per (fabric description, sleeve type) shown in the shirt section of the entry modal
type ShirtSleeveDisplayCard = {
  group: FabricGroupEntry;
  groupIndex: number;
  sleeveType: 'Full' | 'Half';
};

const EMPTY_CONSOLIDATED_ENTRY_STATE: ConsolidatedEntryState = {
  isActive: false,
  scannedBarcodes: [],
  groups: [],
};

// --- State for Manual Design Selection ---
type ManualDesignSelectionState = {
  isActive: boolean;
  styleSearchTerm: string;
  selectedStyleNos: string[];      // multiple style numbers can be checked
  expandedStyleNo: string | null;  // which style's color panel is currently open
  confirmedDesigns: Design[];
};

const EMPTY_MANUAL_SELECTION_STATE: ManualDesignSelectionState = {
  isActive: false,
  styleSearchTerm: '',
  selectedStyleNos: [],
  expandedStyleNo: null,
  confirmedDesigns: [],
};

// --- Auto-saved local draft for an in-progress (unsubmitted) new Sales Order ---
type SalesOrderDraft = {
  selectedClientId: string | null;
  deliveryDate: string;
  orderItems: OrderItem[];
  scannedBarcodes: string[];
  consolidatedEntryState: ConsolidatedEntryState;
  manualDesignSelectionState: ManualDesignSelectionState;
  savedAt: number;
};

const SALES_ORDER_DRAFT_KEY = 'salesOrderEntryDraft';
const DRAFT_SAVE_DEBOUNCE_MS = 500;


@Component({
  selector: 'app-sales-order',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './sales-order.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SalesOrderComponent implements OnInit, OnDestroy {
    private clientService = inject(ClientService);
    private designService = inject(DesignService);
    private salesOrderService = inject(SalesOrderService);

    @ViewChild('video') videoElement?: ElementRef<HTMLVideoElement>;
    @ViewChild('canvas') canvasElement?: ElementRef<HTMLCanvasElement>;

    // --- State for both views ---
    mode = signal<ViewMode>('list');
    clients = signal<Client[]>([]);
    salesOrders = signal<SalesOrder[]>([]);
    orderToDelete = signal<SalesOrder | null>(null);
    designs = signal<Design[]>([]); // All available designs

    // --- Date filter (defaults to current month) ---
    filterFromDate = signal<string>(this.currentMonthStart());
    filterToDate   = signal<string>(this.currentMonthEnd());

    // --- State for form view ---
    editableOrder = signal<SalesOrder | null>(null);
    isEditMode = computed(() => !!this.editableOrder());
    orderItems = signal<OrderItem[]>([]);
    selectedClientId = signal<string | null>(null);
    deliveryDate = signal<string>('');

    // --- State for new batch item addition ---
    isBatchScanning = signal(false);
    scannedBarcodes = signal<string[]>([]);
    consolidatedEntryState = signal<ConsolidatedEntryState>(EMPTY_CONSOLIDATED_ENTRY_STATE);
    scanFeedback = signal<'idle' | 'success' | 'duplicate'>('idle');
    lastAddedBarcode = signal<string | null>(null);
    collapsedScanGroups = signal<Set<string>>(new Set());

    // --- Shirt groups: displayed as one card per (fabric description, sleeve type) ---
    shirtSleeveDisplayCards = computed<ShirtSleeveDisplayCard[]>(() => {
      const groups = this.consolidatedEntryState().groups;
      const cards: ShirtSleeveDisplayCard[] = [];
      groups.forEach((g, groupIndex) => {
        if (g.containsShirt && g.groupScannedSleeveTypes.full) cards.push({ group: g, groupIndex, sleeveType: 'Full' });
      });
      groups.forEach((g, groupIndex) => {
        if (g.containsShirt && g.groupScannedSleeveTypes.half) cards.push({ group: g, groupIndex, sleeveType: 'Half' });
      });
      return cards;
    });

    // --- Fabric Description card accordion: at most one card expanded at a time ---
    expandedCardKey = signal<string | null>(null);

    // --- State for Manual Design Selection ---
    manualDesignSelectionState = signal<ManualDesignSelectionState>(EMPTY_MANUAL_SELECTION_STATE);

    // --- Auto-save draft (new, unsubmitted Sales Orders only) ---
    private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private autoSaveDraftEffect = effect(() => {
      const mode = this.mode();
      const isEdit = this.isEditMode();
      const selectedClientId = this.selectedClientId();
      const deliveryDate = this.deliveryDate();
      const orderItems = this.orderItems();
      const scannedBarcodes = this.scannedBarcodes();
      const consolidatedEntryState = this.consolidatedEntryState();
      const manualDesignSelectionState = this.manualDesignSelectionState();

      // Only auto-save while creating a brand-new (not-yet-submitted) order.
      if (mode !== 'form' || isEdit) return;

      if (this.draftSaveTimer) clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = setTimeout(() => {
        this.persistDraft({
          selectedClientId,
          deliveryDate,
          orderItems,
          scannedBarcodes,
          consolidatedEntryState,
          manualDesignSelectionState,
        });
      }, DRAFT_SAVE_DEBOUNCE_MS);
    });

    /**
     * Mobile browsers can suspend/kill a backgrounded tab (e.g. an incoming call taking
     * over the camera) before a pending debounce fires — flush synchronously whenever the
     * page is hidden or about to be torn down so a mid-scan session is never lost.
     */
    @HostListener('document:visibilitychange')
    onVisibilityChange() {
      if (document.visibilityState === 'hidden') this.flushDraftSaveImmediately();
    }

    @HostListener('window:pagehide')
    onPageHide() {
      this.flushDraftSaveImmediately();
    }

    private flushDraftSaveImmediately() {
      if (this.draftSaveTimer) {
        clearTimeout(this.draftSaveTimer);
        this.draftSaveTimer = null;
      }
      if (this.mode() !== 'form' || this.isEditMode()) return;
      this.persistDraft({
        selectedClientId: this.selectedClientId(),
        deliveryDate: this.deliveryDate(),
        orderItems: this.orderItems(),
        scannedBarcodes: this.scannedBarcodes(),
        consolidatedEntryState: this.consolidatedEntryState(),
        manualDesignSelectionState: this.manualDesignSelectionState(),
      });
    }

    viewfinderBorderClass = computed(() => {
        switch (this.scanFeedback()) {
        case 'success':
            return 'border-green-400';
        case 'duplicate':
            return 'border-yellow-400';
        default:
            return 'border-white/80';
        }
    });

    scanLineFeedbackClass = computed(() => {
        switch (this.scanFeedback()) {
        case 'success':
            return 'success';
        case 'duplicate':
            return 'duplicate';
        default:
            return '';
        }
    });
    
    scannerMessage = computed(() => {
        switch (this.scanFeedback()) {
        case 'duplicate':
            return 'Item already scanned';
        default:
            return 'Align QR code within the frame';
        }
    });

    // --- State for printing ---
    orderToPrint = signal<SalesOrder | null>(null);
    clientForPrint = signal<Client | null>(null);

    // --- Print-specific computed signals and properties ---
    private ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    private tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    printableOrderItems = computed(() => this.orderToPrint()?.items || []);
    printableUniqueSizes = computed(() => {
        const allSizes = this.printableOrderItems().flatMap(item => (item.design?.sizes || []).map(s => s.size));
        const unique = [...new Set(allSizes)];
        return unique.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    });

  // --- State for searchable client dropdown ---
  clientSearchTerm = signal('');
  isClientDropdownOpen = signal(false);

  isConsolidatedAddDisabled = computed(() => {
    const state = this.consolidatedEntryState();
    if (!state.isActive || state.groups.length === 0) return true;
    return !state.groups.some(group =>
      group.designRatios.some(dr => {
        if (group.containsShirt) {
          return Object.values(dr.shirtSizeQuantities).some(
            sq => this.parseFractionalQuantity(sq.full) > 0 || this.parseFractionalQuantity(sq.half) > 0
          );
        }
        return Object.values(dr.sizeQuantities).some(qty => this.parseFractionalQuantity(qty) > 0);
      })
    );
  });

  filteredClientsForDropdown = computed(() => {
    const term = this.clientSearchTerm().toLowerCase();
    if (!term) return this.clients();
    return this.clients().filter(c =>
      c.clientName.toLowerCase().includes(term) ||
      c.clientCode?.toLowerCase().includes(term)
    );
  });

  selectedClientName = computed(() => {
    const selectedId = this.selectedClientId();
    if (!selectedId) return 'Select a client...';
    return this.clients().find(c => c.id === selectedId)?.clientName ?? 'Select a client...';
  });

  // --- Manual Entry Computed Properties ---

  /** Unique style numbers, filtered by the search term */
  uniqueStyleNosForManual = computed(() => {
    const term = this.manualDesignSelectionState().styleSearchTerm.toLowerCase().trim();
    const allStyles = [...new Set(this.designs().map(d => d.styleNo))].sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { numeric: true })
    );
    if (!term) return allStyles;
    return allStyles.filter(s => s.toLowerCase().includes(term));
  });

  /** Colors (Design records) for the currently expanded style */
  colorsForManualStyle = computed(() => {
    const styleNo = this.manualDesignSelectionState().expandedStyleNo;
    if (!styleNo) return [];
    return this.designs().filter(d => d.styleNo === styleNo);
  });

  /** Set of design IDs confirmed so far */
  confirmedDesignIds = computed(() =>
    new Set(this.manualDesignSelectionState().confirmedDesigns.map(d => d.id))
  );

  /** IDs of colors selected under the currently expanded style */
  selectedColorIdsForCurrentStyle = computed(() => {
    const styleNo = this.manualDesignSelectionState().expandedStyleNo;
    if (!styleNo) return new Set<string>();
    return new Set(
      this.manualDesignSelectionState().confirmedDesigns
        .filter(d => d.styleNo === styleNo)
        .map(d => d.id)
    );
  });

  /** True if every color of the expanded style is selected */
  isAllColorsSelectedForCurrentStyle = computed(() => {
    const colors = this.colorsForManualStyle();
    if (colors.length === 0) return false;
    const selected = this.selectedColorIdsForCurrentStyle();
    return colors.every(d => selected.has(d.id!));
  });

  /** True if some (but not all) colors of the expanded style are selected */
  isSomeColorsSelectedForCurrentStyle = computed(() => {
    const colors = this.colorsForManualStyle();
    const selected = this.selectedColorIdsForCurrentStyle();
    const count = colors.filter(d => selected.has(d.id!)).length;
    return count > 0 && count < colors.length;
  });

  /** Returns count of confirmed colors for a given style number */
  getSelectedColorCountForStyle(styleNo: string): number {
    return this.manualDesignSelectionState().confirmedDesigns.filter(d => d.styleNo === styleNo).length;
  }

  canProceedFromManual = computed(() =>
    this.manualDesignSelectionState().confirmedDesigns.length > 0
  );

  private stream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  private lastScannedTime = 0;
  private lastTickTime = 0;
  private readonly SCAN_INTERVAL = 60;          // scan every 60 ms (was 150)
  private readonly SCAN_DEBOUNCE = 800;         // ms before same code accepted again
  private torchEnabled = false;
  private torchTrack: MediaStreamTrack | null = null;
  isTorchAvailable = signal(false);
  isTorchOn = signal(false);
  // offscreen canvas reused across frames to avoid GC pressure
  private enhanceCanvas: HTMLCanvasElement | null = null;
  private audioCtx: AudioContext | null = null;

  // --- Print state ---
  printOrder = signal<SalesOrder | null>(null);

  scannedBarcodesGroupedByItemGroup = computed(() => {
    const barcodes = this.scannedBarcodes();
    if (barcodes.length === 0) return [];

    const barcodeToDesign = new Map<string, Design>();
    this.designs().forEach(d => d.sizes.forEach(s => barcodeToDesign.set(s.BARCODE, d)));

    const groups = new Map<string, { barcode: string; index: number }[]>();
    barcodes.forEach((barcode, index) => {
      const design = barcodeToDesign.get(barcode.trim());
      const group = design?.group || 'Unknown';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push({ barcode, index });
    });

    return Array.from(groups.entries()).map(([group, items]) => ({ group, items }));
  });

  orderItemsGroupedByDesign = computed(() => {
    const items = this.orderItems();
    const groups = new Map<string, OrderItem[]>();
    for (const item of items) {
      const key = item.design.styleNo;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    return Array.from(groups.values());
  });

  /** Orders filtered by the selected date range (based on createdAt), sorted oldest-first by createdAt */
  filteredSalesOrders = computed(() => {
    const orders = this.salesOrders();
    const from = this.filterFromDate();
    const to   = this.filterToDate();

    const fromMs = from ? new Date(from).setHours(0, 0, 0, 0)    : -Infinity;
    const toMs   = to   ? new Date(to).setHours(23, 59, 59, 999)  :  Infinity;

    const filtered = (!from && !to)
      ? orders
      : orders.filter(order => {
          const ms = this.getOrderCreatedAtDate(order).getTime();
          return ms >= fromMs && ms <= toMs;
        });

    return [...filtered].sort(
      (a, b) => this.getOrderCreatedAtDate(a).getTime() - this.getOrderCreatedAtDate(b).getTime()
    );
  });

  /** Robustly resolves an order's created date, whatever shape it comes back from Firestore as. */
  private getOrderCreatedAtDate(order: SalesOrder): Date {
    const raw: any = order.createdAt;
    if (raw && typeof raw.toDate === 'function') return raw.toDate();
    if (raw instanceof Date) return raw;
    if (raw) return new Date(raw);
    // fall back to deliveryDate if createdAt is missing
    return new Date(order.deliveryDate);
  }

  /** Formatted "Created Date" for display in the Sales Orders table. */
  getOrderCreatedAtDisplay(order: SalesOrder): string {
    try {
      return formatDate(this.getOrderCreatedAtDate(order), 'dd MMM yyyy, hh:mm a', 'en-US');
    } catch {
      return '';
    }
  }

  isCurrentMonthFilter = computed(() =>
    this.filterFromDate() === this.currentMonthStart() &&
    this.filterToDate()   === this.currentMonthEnd()
  );

  // --- Date helpers ---
  private currentMonthStart(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  private currentMonthEnd(): string {
    const d = new Date();
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  }

  resetToCurrentMonth() {
    this.filterFromDate.set(this.currentMonthStart());
    this.filterToDate.set(this.currentMonthEnd());
  }

  clearDateFilter() {
    this.filterFromDate.set('');
    this.filterToDate.set('');
  }

    ngOnInit() {
        Swal.fire({ title: 'Loading data...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        let clientsLoaded = false;
        let designsLoaded = false;
        let ordersLoaded = false;

        const tryClose = () => {
            if (clientsLoaded && designsLoaded && ordersLoaded) Swal.close();
        };

        this.clientService.getClients().subscribe({
            next: clients => { this.clients.set(clients); clientsLoaded = true; tryClose(); },
            error: () => { clientsLoaded = true; tryClose(); Swal.fire('Error', 'Failed to load clients', 'error'); }
        });

        this.designService.getDesigns().subscribe({
            next: designs => { this.designs.set(designs); designsLoaded = true; tryClose(); },
            error: () => { designsLoaded = true; tryClose(); Swal.fire('Error', 'Failed to load designs', 'error'); }
        });

        this.salesOrderService.getSalesOrders().subscribe({
            next: orders => { this.salesOrders.set(orders); ordersLoaded = true; tryClose(); },
            error: () => { ordersLoaded = true; tryClose(); Swal.fire('Error', 'Failed to load orders', 'error'); }
        });
    }

    loadSalesOrders() {
        Swal.fire({ title: 'Refreshing orders...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        this.salesOrderService.getSalesOrders().subscribe({
            next: orders => { this.salesOrders.set(orders); Swal.close(); },
            error: () => { Swal.close(); Swal.fire('Error', 'Failed to load orders', 'error'); }
        });
    }

  ngOnDestroy() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.draftSaveTimer) clearTimeout(this.draftSaveTimer);
  }

  switchToListView() {
    this.mode.set('list');
    this.editableOrder.set(null);
    this.orderItems.set([]);
    this.selectedClientId.set(null);
    this.deliveryDate.set('');
  }

  async showAddForm() {
    const draft = this.loadDraftFromStorage();
    if (draft) {
      const result = await Swal.fire({
        icon: 'question',
        title: 'Resume Draft?',
        text: 'A draft Sales Order was found. Would you like to continue where you left off?',
        showCancelButton: true,
        confirmButtonText: 'Resume',
        cancelButtonText: 'Discard',
        reverseButtons: true,
        allowOutsideClick: false,
      });

      if (result.isConfirmed) {
        this.resumeDraft(draft);
        return;
      }
      this.clearDraft();
    }
    this.startBlankOrderForm();
  }

  private startBlankOrderForm() {
    this.editableOrder.set(null);
    this.orderItems.set([]);
    this.selectedClientId.set(null);
    this.deliveryDate.set('');
    this.scannedBarcodes.set([]);
    this.consolidatedEntryState.set(EMPTY_CONSOLIDATED_ENTRY_STATE);
    this.manualDesignSelectionState.set(EMPTY_MANUAL_SELECTION_STATE);
    this.expandedCardKey.set(null);
    this.mode.set('form');
  }

  private resumeDraft(draft: SalesOrderDraft) {
    this.editableOrder.set(null);
    this.selectedClientId.set(draft.selectedClientId);
    this.deliveryDate.set(draft.deliveryDate);
    this.orderItems.set(draft.orderItems);
    this.scannedBarcodes.set(draft.scannedBarcodes ?? []);
    this.manualDesignSelectionState.set(draft.manualDesignSelectionState);

    // Scanning was interrupted (e.g. incoming call, app backgrounded) before "Process"
    // was pressed — rebuild the Enter Quantities groups from what was already scanned
    // so nothing has to be re-scanned. If "Process" had already been pressed, the saved
    // consolidatedEntryState already reflects that and is restored as-is.
    if (!draft.consolidatedEntryState.isActive && draft.scannedBarcodes?.length) {
      const matchedDesigns = this.matchDesignsFromBarcodes(draft.scannedBarcodes);
      this.consolidatedEntryState.set(
        matchedDesigns.length > 0
          ? {
              isActive: true,
              scannedBarcodes: draft.scannedBarcodes,
              groups: this.buildGroupsFromDesigns(matchedDesigns, draft.scannedBarcodes),
            }
          : EMPTY_CONSOLIDATED_ENTRY_STATE
      );
    } else {
      this.consolidatedEntryState.set(draft.consolidatedEntryState);
    }

    this.expandedCardKey.set(null);
    this.mode.set('form');
  }

  /** Matches raw scanned barcode strings to their designs — mirrors processScannedBarcodes()'s lookup. */
  private matchDesignsFromBarcodes(barcodes: string[]): Design[] {
    const barcodeToDesign = new Map<string, Design>();
    this.designs().forEach(d => d.sizes.forEach(s => barcodeToDesign.set(s.BARCODE, d)));

    const uniqueDesigns = new Map<string, Design>();
    for (const barcode of barcodes) {
      const design = barcodeToDesign.get(barcode.trim());
      if (design) uniqueDesigns.set(design.id!, design);
    }
    return Array.from(uniqueDesigns.values());
  }

  private loadDraftFromStorage(): SalesOrderDraft | null {
    try {
      const raw = localStorage.getItem(SALES_ORDER_DRAFT_KEY);
      return raw ? (JSON.parse(raw) as SalesOrderDraft) : null;
    } catch {
      return null;
    }
  }

  private persistDraft(data: Omit<SalesOrderDraft, 'savedAt'>) {
    const hasContent = !!data.selectedClientId
      || !!data.deliveryDate
      || data.orderItems.length > 0
      || data.scannedBarcodes.length > 0
      || data.consolidatedEntryState.isActive
      || data.manualDesignSelectionState.isActive;

    try {
      if (!hasContent) {
        localStorage.removeItem(SALES_ORDER_DRAFT_KEY);
        return;
      }
      const draft: SalesOrderDraft = { ...data, savedAt: Date.now() };
      localStorage.setItem(SALES_ORDER_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // localStorage unavailable/full — auto-save is best-effort, in-memory entry is unaffected
    }
  }

  private clearDraft() {
    try { localStorage.removeItem(SALES_ORDER_DRAFT_KEY); } catch {}
  }

  showEditForm(order: SalesOrder) {
    this.editableOrder.set(order);
    this.orderItems.set(JSON.parse(JSON.stringify(order.items)));
    this.selectedClientId.set(order.clientId);
    const rawDate = order.deliveryDate as any;
    const date = rawDate instanceof Timestamp
      ? formatDate(rawDate.toDate(), 'yyyy-MM-dd', 'en-US')
      : order.deliveryDate;
    this.deliveryDate.set(date);
    this.mode.set('form');
  }

  showPrintView(order: SalesOrder) {
    const client = this.clients().find(c => c.id === order.clientId);
    if (client) {
      this.orderToPrint.set(order);
      this.clientForPrint.set(client);
    } else {
      Swal.fire({ icon: 'error', title: 'Client Not Found', text: 'Could not find client details for this order.' });
    }
  }
  
  closePrintView() {
    this.orderToPrint.set(null);
    this.clientForPrint.set(null);
  }

  printInvoice(): void {
    const order  = this.orderToPrint();
    const client = this.clientForPrint();
    if (!order || !client) return;

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    // ── CONSTANTS ──────────────────────────────────────────────────────────
    const PW = 210, PH = 297, ML = 10, MR = 10, CW = 190;
    let Y = 10;

    const DARK  : [number,number,number] = [44, 62, 80];
    const GREY  : [number,number,number] = [245,245,245];
    const LGREY : [number,number,number] = [200,200,200];
    const WHITE : [number,number,number] = [255,255,255];
    const BLACK : [number,number,number] = [0,0,0];

    const sf = (style: string, size: number, color: [number,number,number] = BLACK) => {
      doc.setFont('helvetica', style);
      doc.setFontSize(size);
      doc.setTextColor(color[0], color[1], color[2]);
    };
    const fr = (x: number, y: number, w: number, h: number, c: [number,number,number]) => {
      doc.setFillColor(c[0], c[1], c[2]);
      doc.rect(x, y, w, h, 'F');
    };
    const dr = (x: number, y: number, w: number, h: number, c: [number,number,number] = LGREY) => {
      doc.setDrawColor(c[0], c[1], c[2]);
      doc.rect(x, y, w, h, 'S');
    };
    const hl = (y: number, x1 = ML, x2 = PW - MR, c: [number,number,number] = LGREY, t = 0.3) => {
      doc.setDrawColor(c[0], c[1], c[2]);
      doc.setLineWidth(t);
      doc.line(x1, y, x2, y);
    };
    const txt = (s: string, x: number, y: number, opts: any = {}) => doc.text(s, x, y, opts);

    // ── 1. HEADER ──────────────────────────────────────────────────────────
    fr(ML, Y, CW, 14, DARK);
    sf('bold',   14, WHITE);             txt('TMG CLOTHINGS',           ML + 4,   Y + 9);
    sf('normal',  7, [180,200,220]);     txt('Garment Order Management', ML + 4,   Y + 13.5);
    sf('bold',    9, WHITE);             txt('SALES ORDER',              PW-MR-4,  Y + 6,  { align: 'right' });
    sf('normal',  8, [180,200,220]);     txt(`#${order.salesNo}`,        PW-MR-4,  Y + 11, { align: 'right' });
    Y += 18;

    // ── 2. PARTY INFO ──────────────────────────────────────────────────────
    const boxH = 26, colW = CW / 3;

    // Bill To
    fr(ML, Y, colW - 1, boxH, GREY);
    dr(ML, Y, colW - 1, boxH);
    sf('bold', 7.5, DARK); txt('BILL TO', ML + 3, Y + 5);
    hl(Y + 6.5, ML + 3, ML + colW - 4);
    sf('normal', 7, BLACK);
    txt(client.clientName,                 ML + 3, Y + 10);
    txt(client.billingAddress,             ML + 3, Y + 14);
    txt(`State: ${client.state}`,          ML + 3, Y + 18);
    txt(`Phone: ${client.mobile}`,         ML + 3, Y + 22);

    // Ship To
    const sx = ML + colW + 1;
    fr(sx, Y, colW - 1, boxH, GREY);
    dr(sx, Y, colW - 1, boxH);
    sf('bold', 7.5, DARK); txt('SHIP TO', sx + 3, Y + 5);
    hl(Y + 6.5, sx + 3, sx + colW - 4);
    sf('normal', 7, BLACK);
    txt(client.clientName,        sx + 3, Y + 10);
    txt(client.billingAddress,    sx + 3, Y + 14);
    txt(`State: ${client.state}`, sx + 3, Y + 18);

    // Order Details
    const ox = ML + colW * 2 + 2, ow = CW - colW * 2 - 2;
    fr(ox, Y, ow, boxH, GREY);
    dr(ox, Y, ow, boxH);
    sf('bold', 7.5, DARK); txt('ORDER DETAILS', ox + 3, Y + 5);
    hl(Y + 6.5, ox + 3, ox + ow - 3);
    const details: [string, string][] = [
      ['Sales No:',   order.salesNo],
      ['Date:',       this.printFormattedOrderDate],
      ['Challan No:', order.salesNo],
    ];
    details.forEach(([label, val], i) => {
      sf('bold',   7, [80,80,80]);   txt(label, ox + 3,      Y + 11 + i * 5);
      sf('normal', 7, BLACK);        txt(val,   ox + ow - 3, Y + 11 + i * 5, { align: 'right' });
    });
    Y += boxH + 4;

    // ── 3. ITEMS TABLE ─────────────────────────────────────────────────────
    const items = this.printableOrderItems();
    const sizes = this.printableUniqueSizes();

    interface ColDef { label: string; width: number; align: 'left'|'center'|'right'; }

    const fixedRight = 10 + 16 + 16 + 18; // Qty + Rate + MRP + Total = 60mm
    const sizeColW   = sizes.length > 0 ? Math.min(10, Math.max(6, Math.floor(60 / sizes.length))) : 8;
    const descW      = CW - 8 - (sizes.length * sizeColW) - fixedRight;

    const COLS: ColDef[] = [
      { label: '#',        width: 8,       align: 'center' },
      { label: 'Product',  width: descW,   align: 'left'   },
      ...sizes.map(s => ({ label: s, width: sizeColW, align: 'center' as const })),
      { label: 'Qty',      width: 10,      align: 'center' },
      { label: 'Rate(Rs)', width: 16,      align: 'right'  },
      { label: 'MRP(Rs)',  width: 16,      align: 'right'  },
      { label: 'Total(Rs)',width: 18,      align: 'right'  },
    ];

    const HEAD_H = 8, ROW_H = 7;

    // Draw header
    fr(ML, Y, CW, HEAD_H, DARK);
    sf('bold', 6.5, WHITE);
    let cx = ML;
    COLS.forEach(col => {
      const tx2 = col.align === 'right'  ? cx + col.width - 1.5
                : col.align === 'center' ? cx + col.width / 2
                : cx + 1.5;
      txt(col.label, tx2, Y + 5.2, { align: col.align === 'center' ? 'center' : col.align });
      cx += col.width;
    });
    Y += HEAD_H;

    // Draw item rows
    items.forEach((item, idx) => {
      if (Y > PH - 50) { doc.addPage(); Y = 12; }

      fr(ML, Y, CW, ROW_H, idx % 2 === 0 ? WHITE : GREY);
      hl(Y + ROW_H, ML, PW - MR, LGREY, 0.2);

      const descLines: string[] = [item.design?.styleNo ?? ''];
      if (item.design?.color)  descLines.push(item.design.color);
      if (item.sleeveType)     descLines.push(this.printGetSleeveTypeAbbreviation(item.sleeveType));

      const rowVals: string[] = [
        String(idx + 1),
        descLines.join('\n'),
        ...sizes.map(s => String(this.printGetItemQtyForSize(item, s))),
        String(this.printGetItemTotalQty(item)),
        this.printGetItemPrice(item).toFixed(2),
        this.printGetItemMRP(item).toFixed(2),
        this.printGetItemTotalPrice(item).toFixed(2),
      ];

      cx = ML;
      COLS.forEach((col, ci) => {
        const val = rowVals[ci] ?? '';
        if (ci === 1) {
          const lines = val.split('\n');
          sf('bold', 6.5, BLACK);
          txt(lines[0], cx + 1.5, Y + 3.5);
          lines.slice(1).forEach((ln, li) => {
            sf('normal', 5.5, [100,100,100]);
            txt(ln, cx + 1.5, Y + 3.5 + (li + 1) * 2.5);
          });
        } else {
          sf('normal', 6.5, BLACK);
          const tx2 = col.align === 'right'  ? cx + col.width - 1.5
                    : col.align === 'center' ? cx + col.width / 2
                    : cx + 1.5;
          txt(val, tx2, Y + 4.5, { align: col.align === 'center' ? 'center' : col.align });
        }
        // Vertical separator
        doc.setDrawColor(LGREY[0], LGREY[1], LGREY[2]);
        doc.setLineWidth(0.2);
        doc.line(cx + col.width, Y, cx + col.width, Y + ROW_H);
        cx += col.width;
      });

      Y += ROW_H;
    });

    // Total footer row
    fr(ML, Y, CW, ROW_H + 1, [235,235,235]);
    hl(Y, ML, PW - MR, DARK, 0.5);
    sf('bold', 7, DARK);
    const labelEndX = ML + COLS.slice(0, 2 + sizes.length).reduce((s, c) => s + c.width, 0);
    txt('TOTAL', labelEndX - 2, Y + 5, { align: 'right' });
    const qtyX = labelEndX, qtyW = COLS[2 + sizes.length].width;
    txt(`${this.printOverallTotalQty} Pcs`, qtyX + qtyW / 2, Y + 5, { align: 'center' });
    txt(this.printOverallTotalPrice.toFixed(2), PW - MR - 1.5, Y + 5, { align: 'right' });
    hl(Y + ROW_H + 1, ML, PW - MR, DARK, 0.5);
    Y += ROW_H + 5;

    // ── 4. TOTALS ──────────────────────────────────────────────────────────
    const totW = 85, totX = PW - MR - totW;
    sf('normal', 7.5, BLACK);
    txt('Round Off', totX + 3, Y);
    txt('Rs.0.00',   PW - MR - 2, Y, { align: 'right' });
    Y += 7;
    fr(totX, Y - 4, totW, 9, DARK);
    sf('bold', 9, WHITE);
    txt('NET PAYABLE',                           totX + 3,   Y + 2.5);
    txt(`Rs.${this.printOverallTotalPrice.toFixed(2)}`, PW - MR - 2, Y + 2.5, { align: 'right' });
    Y += 12;

    // ── 5. AMOUNT IN WORDS ────────────────────────────────────────────────
    fr(ML, Y, CW, 8, [240,244,248]);
    dr(ML, Y, CW, 8);
    sf('bold',   7, DARK);  txt('Amount in Words (INR):',  ML + 3,  Y + 5);
    sf('normal', 7, BLACK); txt(this.printAmountInWords,   ML + 50, Y + 5);
    Y += 13;

    // ── 6. TERMS & SIGNATURE ──────────────────────────────────────────────
    const termsW = 120, sigW = CW - termsW - 2, sigX = ML + termsW + 2, blkH = 30;

    fr(ML,  Y, termsW, blkH, GREY); dr(ML,  Y, termsW, blkH);
    sf('bold', 7, DARK); txt('Terms & Conditions', ML + 3, Y + 5);
    hl(Y + 6.5, ML + 3, ML + termsW - 3);
    [
      "• MRP's are indicative and are subject to change.",
      '• Goods once sold will not be taken back.',
      '• This is a system generated order pdf, hence does not require a signature.',
      '• Interest @24% P.A. will be charged after due date.',
    ].forEach((t, i) => {
      sf('normal', 6.5, [60,60,60]);
      txt(t, ML + 3, Y + 11 + i * 4.5);
    });

    fr(sigX, Y, sigW, blkH, GREY); dr(sigX, Y, sigW, blkH);
    sf('bold', 7, DARK); txt('For TMG CLOTHINGS', sigX + sigW / 2, Y + 5, { align: 'center' });
    hl(Y + 6.5, sigX + 3, sigX + sigW - 3);
    hl(Y + blkH - 7, sigX + 5, sigX + sigW - 5, [120,120,120], 0.4);
    sf('normal', 6.5, [80,80,80]);
    txt('Authorised Signatory', sigX + sigW / 2, Y + blkH - 3, { align: 'center' });
    Y += blkH + 4;

    // ── 7. FOOTER ─────────────────────────────────────────────────────────
    hl(Y, ML, PW - MR, DARK, 0.5);
    sf('normal', 6.5, [120,120,120]);
    txt('Generated by TMG Clothings Garment Order Management System', PW / 2, Y + 4, { align: 'center' });
    txt('Page 1 of 1', PW - MR, Y + 4, { align: 'right' });

    // ── SAVE ──────────────────────────────────────────────────────────────
    doc.save(`SalesOrder-${order.salesNo}.pdf`);
  }

  get printFormattedOrderDate(): string {
    const order = this.orderToPrint();
    if (!order || !order.createdAt) return '';

    try {
      let date: Date;

      if (order.createdAt instanceof Timestamp) {
        date = order.createdAt.toDate();
      }
      else if (order.createdAt instanceof Date) {
        date = order.createdAt;
      }
      else {
        date = new Date(order.createdAt);
      }

      return formatDate(date, 'dd MMMM yyyy', 'en-US');
    } catch (e) {
      return '';
    }
  }


  printGetSleeveTypeAbbreviation(sleeveType): string {
    if (sleeveType === 'Full') return 'F/s';
    if (sleeveType === 'Half') return 'H/s';
    return '';
  }

  printGetItemQtyForSize(item: OrderItem, size: string): number | string {
    return (item.itemSizes || []).find(s => s.size === size)?.quantity ?? '-';
  }

  printGetItemTotalQty(item: OrderItem): number {
    return (item.itemSizes || []).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  }

  printGetItemPrice(item: OrderItem): number {
    return item.itemSizes?.[0]?.WSP ?? 0;
  }

  printGetItemMRP(item: OrderItem): number {
    return item.itemSizes?.[0]?.price ?? 0;
  }

  printGetItemTotalPrice(item: OrderItem): number {
    return (item.itemSizes || []).reduce((sum, s) => sum + (Number(s.quantity || 0) * Number(s.WSP || 0)), 0);
  }

  get printOverallTotalQty(): number {
    return this.printableOrderItems().reduce((sum, item) => sum + this.printGetItemTotalQty(item), 0);
  }

  get printOverallTotalPrice(): number {
    return this.printableOrderItems().reduce((sum, item) => sum + this.printGetItemTotalPrice(item), 0);
  }

  get printAmountInWords(): string {
    const total = this.printOverallTotalPrice;
    const words = this.privateNumberToWords(Math.floor(total));
    return `${words} Rupees only`;
  }
  private privateNumberToWords(num: number): string {
    if (num === 0) return 'Zero';
    if (num > 9999999) return 'Number too large';

    const convertLessThanOneThousand = (n: number): string => {
        let result = '';
        if (n >= 100) {
            result += this.ones[Math.floor(n / 100)] + ' Hundred';
            n %= 100;
            if (n > 0) result += ' ';
        }
        if (n >= 20) {
            result += this.tens[Math.floor(n / 10)];
            n %= 10;
            if (n > 0) result += ' ';
        }
        if (n > 0) {
            result += this.ones[n];
        }
        return result;
    };

    let words = '';
    const millions = Math.floor(num / 1000000);
    const thousands = Math.floor((num % 1000000) / 1000);
    const remainder = num % 1000;

    if (millions > 0) {
      words += convertLessThanOneThousand(millions) + ' Million ';
    }
    if (thousands > 0) {
      words += convertLessThanOneThousand(thousands) + ' Thousand ';
    }
    if (remainder > 0) {
      words += convertLessThanOneThousand(remainder);
    }

    return words.trim().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  selectClient(client: Client) {
    this.selectedClientId.set(client.id!);
    this.isClientDropdownOpen.set(false);
    this.clientSearchTerm.set('');
  }

  removeOrderItem(designId: string, sleeveType?: string) {
    this.orderItems.update(items =>
      items.filter(item =>
        !(item.design.id === designId && item.sleeveType === sleeveType)
      )
    );
  }

  getClientName(clientId: string): string {
    return this.clients().find(c => c.id === clientId)?.clientName ?? 'Unknown Client';
  }

  getOrderTotalQuantity(order: SalesOrder): number {
    return order.items.reduce((total, item) => total + item.itemSizes.reduce((itemTotal, size) => itemTotal + (Number(size.quantity) || 0), 0), 0);
  }

  getOrderTotalPrice(order: SalesOrder): number {
    return order.items.reduce((total, item) => total + item.itemSizes.reduce((itemTotal, size) => itemTotal + ((Number(size.quantity) || 0) * (Number(size.WSP) || 0)), 0), 0);
  }

  // --- New Item Addition Logic ---
  addOrUpdateOrderItem(design: Design, sizeVar: SizePrice, quantity: number) {
    this.orderItems.update(currentItems => {
      const itemsCopy = JSON.parse(JSON.stringify(currentItems));
      let existingItem;
      const isShirt = design.group.toUpperCase().includes('SHIRT');

      if (isShirt) {
        existingItem = itemsCopy.find((item: OrderItem) =>
          item.design.id === design.id && item.sleeveType === sizeVar.sleeveType
        );
      } else {
        existingItem = itemsCopy.find((item: OrderItem) => item.design.id === design.id);
      }

      if (existingItem) {
        const existingSize = existingItem.itemSizes.find((s: OrderItemSize) => s.size === sizeVar.size);
        if (existingSize) {
          existingSize.quantity = (Number(existingSize.quantity) || 0) + quantity;
          existingSize.price = sizeVar.price;
          existingSize.WSP = sizeVar.WSP;
        } 
        else {
          existingItem.itemSizes.push({ size: sizeVar.size, quantity: quantity, price: sizeVar.price, WSP: sizeVar.WSP });
          existingItem.itemSizes.sort((a: OrderItemSize, b: OrderItemSize) =>
            String(a.size).localeCompare(String(b.size), undefined, { numeric: true })
          );
        }
      } else {
        // Exclude the design catalog's own createdAt/updatedAt Firestore Timestamps — once
        // embedded here, a later JSON.stringify/parse round-trip (e.g. re-cloning currentItems
        // above, or the local draft auto-save) strips their Timestamp type, and Firestore then
        // persists them as a plain {seconds, nanoseconds, type} map instead of a real timestamp.
        const { createdAt, updatedAt, ...designForOrder } = design;
        const newOrderItem: OrderItem = {
          design: designForOrder as Design,
          itemSizes: [{ size: sizeVar.size, quantity: quantity, price: sizeVar.price, WSP: sizeVar.WSP  }]
        };
        if (isShirt) newOrderItem.sleeveType = sizeVar.sleeveType;
        itemsCopy.push(newOrderItem);
      }
      return itemsCopy;
    });
  }

  // ============================================================
  // --- Manual Design Selection ---
  // ============================================================

  startManualEntry() {
    this.manualDesignSelectionState.set({ ...EMPTY_MANUAL_SELECTION_STATE, isActive: true });
  }

  cancelManualEntry() {
    this.manualDesignSelectionState.set(EMPTY_MANUAL_SELECTION_STATE);
  }

  setManualStyleSearch(term: string) {
    this.manualDesignSelectionState.update(s => ({
      ...s, styleSearchTerm: term, expandedStyleNo: null
    }));
  }

  /** Expands/collapses the color panel for a style number */
  toggleExpandedStyle(styleNo: string) {
    this.manualDesignSelectionState.update(s => ({
      ...s,
      expandedStyleNo: s.expandedStyleNo === styleNo ? null : styleNo
    }));
  }

  /** Returns true if the given styleNo is checked (at least one color confirmed) */
  isStyleNoChecked(styleNo: string): boolean {
    return this.manualDesignSelectionState().selectedStyleNos.includes(styleNo);
  }

  /**
   * Toggles a style number on/off.
   * Checking it auto-selects ALL colors; unchecking removes all its colors.
   */
  toggleManualStyleNo(styleNo: string) {
    const allColors = this.designs().filter(d => d.styleNo === styleNo);
    this.manualDesignSelectionState.update(state => {
      const isChecked = state.selectedStyleNos.includes(styleNo);
      if (isChecked) {
        // Uncheck: remove this style and all its colors
        return {
          ...state,
          selectedStyleNos: state.selectedStyleNos.filter(s => s !== styleNo),
          confirmedDesigns: state.confirmedDesigns.filter(d => d.styleNo !== styleNo),
          expandedStyleNo: state.expandedStyleNo === styleNo ? null : state.expandedStyleNo,
        };
      } else {
        // Check: add this style and auto-select all its colors
        const newDesigns = [...state.confirmedDesigns];
        for (const color of allColors) {
          if (!newDesigns.find(d => d.id === color.id)) newDesigns.push(color);
        }
        return {
          ...state,
          selectedStyleNos: [...state.selectedStyleNos, styleNo],
          confirmedDesigns: newDesigns,
          expandedStyleNo: styleNo,  // auto-expand to show colors
        };
      }
    });
  }

  /** Toggles an individual color (Design) on/off */
  toggleManualDesignColor(design: Design) {
    this.manualDesignSelectionState.update(state => {
      const exists = state.confirmedDesigns.find(d => d.id === design.id);
      let newConfirmed: Design[];
      let newStyleNos: string[];

      if (exists) {
        newConfirmed = state.confirmedDesigns.filter(d => d.id !== design.id);
        // If no colors remain for this style, uncheck the style too
        const remaining = newConfirmed.filter(d => d.styleNo === design.styleNo);
        newStyleNos = remaining.length > 0
          ? state.selectedStyleNos
          : state.selectedStyleNos.filter(s => s !== design.styleNo);
      } else {
        newConfirmed = [...state.confirmedDesigns, design];
        // Ensure style is marked as checked
        newStyleNos = state.selectedStyleNos.includes(design.styleNo!)
          ? state.selectedStyleNos
          : [...state.selectedStyleNos, design.styleNo!];
      }

      return { ...state, confirmedDesigns: newConfirmed, selectedStyleNos: newStyleNos };
    });
  }

  /** Selects or deselects ALL colors for the currently expanded style */
  toggleAllColorsForCurrentStyle(selectAll: boolean) {
    const styleNo = this.manualDesignSelectionState().expandedStyleNo;
    if (!styleNo) return;
    const allColors = this.designs().filter(d => d.styleNo === styleNo);

    this.manualDesignSelectionState.update(state => {
      const withoutThisStyle = state.confirmedDesigns.filter(d => d.styleNo !== styleNo);
      const newConfirmed = selectAll ? [...withoutThisStyle, ...allColors] : withoutThisStyle;
      const newStyleNos = selectAll
        ? (state.selectedStyleNos.includes(styleNo) ? state.selectedStyleNos : [...state.selectedStyleNos, styleNo])
        : state.selectedStyleNos.filter(s => s !== styleNo);
      return { ...state, confirmedDesigns: newConfirmed, selectedStyleNos: newStyleNos };
    });
  }

  removeManualConfirmedDesign(design: Design) {
    this.manualDesignSelectionState.update(s => {
      const newConfirmed = s.confirmedDesigns.filter(d => d.id !== design.id);
      const remaining = newConfirmed.filter(d => d.styleNo === design.styleNo);
      const newStyleNos = remaining.length > 0
        ? s.selectedStyleNos
        : s.selectedStyleNos.filter(n => n !== design.styleNo);
      return { ...s, confirmedDesigns: newConfirmed, selectedStyleNos: newStyleNos };
    });
  }

  proceedFromManualToSizeEntry() {
    const { confirmedDesigns } = this.manualDesignSelectionState();
    if (confirmedDesigns.length === 0) return;

    const pseudoBarcodes: string[] = confirmedDesigns
      .map(d => d.sizes[0]?.BARCODE)
      .filter((b): b is string => !!b);

    this.consolidatedEntryState.set({
      isActive: true,
      scannedBarcodes: pseudoBarcodes,
      groups: this.buildGroupsFromDesigns(confirmedDesigns),
    });
    this.expandedCardKey.set(null);

    this.cancelManualEntry();
  }

  // ============================================================
  // --- Batch Scanning and Consolidated Entry ---
  // ============================================================

  async startBatchScan() {
    this.isBatchScanning.set(true);
    this.scannedBarcodes.set([]);
    this.collapsedScanGroups.set(new Set());
    this.lastScannedTime = 0;
    this.lastTickTime = 0;
    this.isTorchAvailable.set(false);
    this.isTorchOn.set(false);
    this.torchTrack = null;
    this.enhanceCanvas = document.createElement('canvas');

    setTimeout(async () => {
      if (!this.videoElement || !navigator.mediaDevices?.getUserMedia) {
        Swal.fire({ icon: 'error', title: 'Error', text: 'Camera not supported by your browser or element not ready.' });
        this.isBatchScanning.set(false);
        return;
      }
      try {
        // Request the highest available resolution for better distance detection
        const constraints: MediaStreamConstraints = {
          video: {
            facingMode: 'environment',
            width:  { ideal: 1920, min: 640 },
            height: { ideal: 1080, min: 480 },
          } as any
        };

        this.stream = await navigator.mediaDevices.getUserMedia(constraints);

        // Enable continuous autofocus and check torch availability
        const videoTrack = this.stream.getVideoTracks()[0];
        if (videoTrack) {
          const caps = videoTrack.getCapabilities() as any;

          // Apply focus + exposure settings where supported
          const applyConstraints: any = {};
          if (caps.focusMode?.includes('continuous'))  applyConstraints.focusMode  = 'continuous';
          if (caps.exposureMode?.includes('continuous')) applyConstraints.exposureMode = 'continuous';
          if (caps.whiteBalanceMode?.includes('continuous')) applyConstraints.whiteBalanceMode = 'continuous';
          if (Object.keys(applyConstraints).length > 0) {
            await videoTrack.applyConstraints({ advanced: [applyConstraints] } as any).catch(() => {});
          }

          // Torch
          if (caps.torch) {
            this.isTorchAvailable.set(true);
            this.torchTrack = videoTrack;
          }
        }

        this.videoElement.nativeElement.srcObject = this.stream;
        this.videoElement.nativeElement.play();
        this.animationFrameId = requestAnimationFrame(() => this.tick());
      } catch (err) {
        Swal.fire({ icon: 'error', title: 'Camera Error', text: 'Could not access camera. Please ensure permissions are granted.' });
        this.isBatchScanning.set(false);
      }
    });
  }

  async toggleTorch() {
    if (!this.torchTrack || !this.isTorchAvailable()) return;
    this.torchEnabled = !this.torchEnabled;
    await this.torchTrack.applyConstraints({ advanced: [{ torch: this.torchEnabled } as any] }).catch(() => {});
    this.isTorchOn.set(this.torchEnabled);
  }

  tick() {
    if (!this.isBatchScanning()) return;
    this.animationFrameId = requestAnimationFrame(() => this.tick());

    const now = Date.now();
    if (now - this.lastTickTime < this.SCAN_INTERVAL) return;
    this.lastTickTime = now;

    const video = this.videoElement?.nativeElement;
    if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) return;

    const canvas = this.canvasElement?.nativeElement;
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!ctx || !canvas) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    // ── PASS 1: Full frame at native resolution ──────────────────────────────
    // Use the full video frame (no 640 cap) for maximum QR code pixel coverage.
    // Downscale only if the resolution is extremely large to keep jsQR fast.
    const scale = Math.min(1, 900 / Math.max(vw, vh));
    const fw = Math.round(vw * scale);
    const fh = Math.round(vh * scale);

    if (canvas.width !== fw || canvas.height !== fh) {
      canvas.width  = fw;
      canvas.height = fh;
    }

    ctx.drawImage(video, 0, 0, vw, vh, 0, 0, fw, fh);
    let imageData = ctx.getImageData(0, 0, fw, fh);
    let result = jsQR(imageData.data, fw, fh, { inversionAttempts: 'attemptBoth' });

    if (result?.data) {
      this.addBarcodeToBatch(result.data);
      return;
    }

    // ── PASS 2: Enhanced center-crop ─────────────────────────────────────────
    // Crop the central 60 % of the frame, scale up to 640 px, and apply a
    // contrast boost.  This handles codes that are small / far away.
    const ec = this.enhanceCanvas!;
    const cropFraction = 0.6;
    const cx = vw * (1 - cropFraction) / 2;
    const cy = vh * (1 - cropFraction) / 2;
    const cw = vw * cropFraction;
    const ch = vh * cropFraction;

    const eSize = 640;
    if (ec.width !== eSize || ec.height !== eSize) {
      ec.width  = eSize;
      ec.height = eSize;
    }

    const ec2 = ec.getContext('2d', { willReadFrequently: true })!;
    ec2.drawImage(video, cx, cy, cw, ch, 0, 0, eSize, eSize);
    const raw = ec2.getImageData(0, 0, eSize, eSize);

    // Fast contrast stretch + grayscale binarization
    const enhanced = this.enhanceImageData(raw);
    ec2.putImageData(enhanced, 0, 0);

    const enhanced2 = ec2.getImageData(0, 0, eSize, eSize);
    result = jsQR(enhanced2.data, eSize, eSize, { inversionAttempts: 'attemptBoth' });

    if (result?.data) {
      this.addBarcodeToBatch(result.data);
    }
  }

  /**
   * Boosts contrast using a per-channel min-max stretch then converts to
   * grayscale-like luminance so that low-contrast / faded codes are readable.
   */
  private enhanceImageData(imageData: ImageData): ImageData {
    const d = new Uint8ClampedArray(imageData.data);
    const len = d.length;

    // Find luminance range for the center region (ignore edges to avoid vignette bias)
    let minL = 255, maxL = 0;
    for (let i = 0; i < len; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum < minL) minL = lum;
      if (lum > maxL) maxL = lum;
    }

    const range = maxL - minL || 1;
    const scale = 255 / range;

    for (let i = 0; i < len; i += 4) {
      const lum = Math.round((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - minL) * scale);
      // Write stretched luminance to all channels (greyscale keeps QR readable)
      d[i] = d[i + 1] = d[i + 2] = lum;
      // d[i + 3] stays 255
    }

    return new ImageData(d, imageData.width, imageData.height);
  }

  private playSuccessBeep() {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = this.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1046, ctx.currentTime);       // C6 — clear, scanner-like tone
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + 0.008);  // fast attack
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12); // quick decay
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.12);
    } catch {
      // Audio not available — silently skip
    }
  }

  addBarcodeToBatch(barcode: string) {
    const now = Date.now();
    if (now - this.lastScannedTime < this.SCAN_DEBOUNCE) return;
    if (this.scannedBarcodes().includes(barcode)) {
      this.lastScannedTime = now;
      this.scanFeedback.set('duplicate');
      setTimeout(() => this.scanFeedback.set('idle'), 500);
      return;
    }
    this.lastScannedTime = now;
    this.scannedBarcodes.update(codes => [...codes, barcode]);
    this.lastAddedBarcode.set(barcode);
    setTimeout(() => this.lastAddedBarcode.set(null), 600);
    this.scanFeedback.set('success');
    this.playSuccessBeep();
    setTimeout(() => this.scanFeedback.set('idle'), 400);
  }

  toggleScanGroup(group: string) {
    this.collapsedScanGroups.update(s => {
      const next = new Set(s);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  removeScannedBarcode(index: number) {
    this.scannedBarcodes.update(codes => codes.filter((_, i) => i !== index));
  }

  stopBatchScan() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    // Turn off torch before stopping
    if (this.torchEnabled && this.torchTrack) {
      this.torchTrack.applyConstraints({ advanced: [{ torch: false } as any] }).catch(() => {});
    }
    this.stream?.getTracks().forEach(track => track.stop());
    this.isBatchScanning.set(false);
    this.isTorchOn.set(false);
    this.isTorchAvailable.set(false);
    this.torchEnabled = false;
    this.torchTrack = null;
    this.enhanceCanvas = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  processScannedBarcodes() {
    this.stopBatchScan();
    const barcodes = this.scannedBarcodes();
    if (barcodes.length === 0) return;

    const barcodeToDesign = new Map<string, Design>();
    this.designs().forEach(d => d.sizes.forEach(s => barcodeToDesign.set(s.BARCODE, d)));

    const uniqueDesigns = new Map<string, Design>();
    for (const barcode of barcodes) {
      const design = barcodeToDesign.get(barcode.trim());
      if (design) uniqueDesigns.set(design.id!, design);
    }

    if (uniqueDesigns.size === 0) {
      Swal.fire({ icon: 'error', title: 'No Designs Found', text: 'No valid designs found for the scanned barcodes.' });
      return;
    }

    this.consolidatedEntryState.set({
      isActive: true,
      scannedBarcodes: barcodes,
      groups: this.buildGroupsFromDesigns(Array.from(uniqueDesigns.values()), barcodes),
    });
    this.expandedCardKey.set(null);
  }

  // ============================================================
  // --- Consolidated Entry: group-based quantity editing ---
  // ============================================================

  /**
   * Determines which sleeve types (Full/Half) are actually available for a design, and
   * the catalog Fabric Description that belongs to each sleeve (a design's Full and Half
   * sizeVars can carry different Fabric Description strings, e.g. "...FS" vs "...HS").
   * When `scannedBarcodes` is provided, availability/labels reflect only the sizeVars
   * whose barcode was actually scanned. When omitted (manual selection / save-as, i.e.
   * no real scan happened), this falls back to whatever sleeve types exist for the
   * design in the catalog — unrestricted, matching prior behavior.
   */
  private getScannedSleeveInfoForDesign(
    design: Design,
    barcodeSet: Set<string> | null
  ): { scanned: SleeveAvailability; fabricDescriptions: SleeveFabricDescriptions } {
    let full = false;
    let half = false;
    let fullFabricDescription: string | null = null;
    let halfFabricDescription: string | null = null;

    for (const s of design.sizes) {
      const wasScanned = barcodeSet ? barcodeSet.has(String(s.BARCODE ?? '').trim()) : true;
      if (!wasScanned) continue;
      if (s.sleeveType === 'Full') {
        full = true;
        if (!fullFabricDescription) fullFabricDescription = s.fabricType?.trim() || null;
      } else if (s.sleeveType === 'Half') {
        half = true;
        if (!halfFabricDescription) halfFabricDescription = s.fabricType?.trim() || null;
      }
    }
    return {
      scanned: { full, half },
      fabricDescriptions: { full: fullFabricDescription, half: halfFabricDescription },
    };
  }

  /** Zeroes out the full/half value for any sleeve type that wasn't actually scanned. */
  private applySleeveAvailabilityMask(
    shirtQty: Record<string, { full: string; half: string }>,
    availability: SleeveAvailability
  ): Record<string, { full: string; half: string }> {
    return Object.fromEntries(
      Object.entries(shirtQty).map(([size, v]) => [
        size,
        { full: availability.full ? v.full : '', half: availability.half ? v.half : '' },
      ])
    );
  }

  private buildGroupsFromDesigns(designs: Design[], scannedBarcodes?: string[]): FabricGroupEntry[] {
    const barcodeSet = scannedBarcodes ? new Set(scannedBarcodes.map(b => b.trim())) : null;

    const groupMap = new Map<string, Design[]>();
    for (const design of designs) {
      const g = design.sizes[0]?.fabricType?.trim() || 'Uncategorized';
      if (!groupMap.has(g)) groupMap.set(g, []);
      groupMap.get(g)!.push(design);
    }
    return Array.from(groupMap.entries()).map(([fabricDescription, groupDesigns]) => {
      const containsShirt = groupDesigns.some(d => d.group?.toUpperCase().includes('SHIRT'));
      const allPossibleSizes = [...new Set(groupDesigns.flatMap(d => d.sizes.map(s => s.size)))].sort(
        (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })
      );
      const designRatios = groupDesigns.map(d => {
        const { scanned, fabricDescriptions } = this.getScannedSleeveInfoForDesign(d, barcodeSet);
        return {
          design: d,
          sizeQuantities: {},
          shirtSizeQuantities: {},
          scannedSleeveTypes: scanned,
          sleeveFabricDescriptions: fabricDescriptions,
        };
      });
      return {
        fabricDescription,
        containsShirt,
        allPossibleSizes,
        designRatios,
        groupSizeQuantities: {},
        groupShirtSizeQuantities: {},
        groupScannedSleeveTypes: {
          full: designRatios.some(dr => dr.scannedSleeveTypes.full),
          half: designRatios.some(dr => dr.scannedSleeveTypes.half),
        },
        groupSleeveFabricDescriptions: {
          full: designRatios.find(dr => dr.sleeveFabricDescriptions.full)?.sleeveFabricDescriptions.full ?? null,
          half: designRatios.find(dr => dr.sleeveFabricDescriptions.half)?.sleeveFabricDescriptions.half ?? null,
        },
      };
    });
  }

  /** Accordion state for the Fabric Description cards — at most one expanded at a time. */
  toggleCardExpanded(cardKey: string) {
    this.expandedCardKey.update(current => (current === cardKey ? null : cardKey));
  }

  isCardExpanded(cardKey: string): boolean {
    return this.expandedCardKey() === cardKey;
  }

  updateGroupSizeQty(groupIndex: number, size: string, value: string) {
    this.consolidatedEntryState.update(state => ({
      ...state,
      groups: state.groups.map((g, i) =>
        i === groupIndex ? { ...g, groupSizeQuantities: { ...g.groupSizeQuantities, [size]: value } } : g
      ),
    }));
  }

  updateGroupShirtSizeQty(groupIndex: number, size: string, sleeveType: 'Full' | 'Half', value: string) {
    this.consolidatedEntryState.update(state => ({
      ...state,
      groups: state.groups.map((g, i) => {
        if (i !== groupIndex) return g;
        const existing = g.groupShirtSizeQuantities[size] ?? { full: '', half: '' };
        return {
          ...g,
          groupShirtSizeQuantities: {
            ...g.groupShirtSizeQuantities,
            [size]: sleeveType === 'Full' ? { ...existing, full: value } : { ...existing, half: value },
          },
        };
      }),
    }));
  }

  applyGroupRatioToAll(groupIndex: number) {
    this.consolidatedEntryState.update(state => ({
      ...state,
      groups: state.groups.map((g, i) => {
        if (i !== groupIndex) return g;
        return {
          ...g,
          designRatios: g.designRatios.map(dr => ({
            ...dr,
            sizeQuantities: { ...g.groupSizeQuantities },
            shirtSizeQuantities: this.applySleeveAvailabilityMask(g.groupShirtSizeQuantities, dr.scannedSleeveTypes),
          })),
        };
      }),
    }));
  }

  applyAllGroupRatios() {
    this.consolidatedEntryState.update(state => {
      // Find the first group where the user has entered any non-zero template value
      const sourceGroup = state.groups.find(g => {
        if (g.containsShirt) {
          return Object.values(g.groupShirtSizeQuantities).some(
            sq => this.parseFractionalQuantity(sq.full) > 0 || this.parseFractionalQuantity(sq.half) > 0
          );
        }
        return Object.values(g.groupSizeQuantities).some(v => this.parseFractionalQuantity(v) > 0);
      });

      if (!sourceGroup) return state; // nothing entered yet — no-op

      return {
        ...state,
        groups: state.groups.map(g => {
          // Build the ratio for THIS group's sizes using the source group's values
          const newShirtQty: Record<string, { full: string; half: string }> = {};
          const newSizeQty: Record<string, string> = {};

          for (const size of g.allPossibleSizes) {
            if (g.containsShirt) {
              newShirtQty[size] = sourceGroup.groupShirtSizeQuantities[size]
                ? { ...sourceGroup.groupShirtSizeQuantities[size] }
                : { full: '', half: '' };
            } else {
              newSizeQty[size] = (sourceGroup.groupSizeQuantities as Record<string, string>)[size] ?? '';
            }
          }

          return {
            ...g,
            // Update this group's own template so it also shows the applied ratio,
            // masked to the sleeve types actually scanned somewhere in this group.
            groupShirtSizeQuantities: g.containsShirt
              ? this.applySleeveAvailabilityMask(newShirtQty, g.groupScannedSleeveTypes)
              : g.groupShirtSizeQuantities,
            groupSizeQuantities: !g.containsShirt ? newSizeQty : g.groupSizeQuantities,
            // Apply the ratio to every design in this group, masked per design's own scanned sleeve types
            designRatios: g.designRatios.map(dr => ({
              ...dr,
              shirtSizeQuantities: g.containsShirt
                ? this.applySleeveAvailabilityMask(newShirtQty, dr.scannedSleeveTypes)
                : dr.shirtSizeQuantities,
              sizeQuantities: !g.containsShirt ? { ...newSizeQty } : dr.sizeQuantities,
            })),
          };
        }),
      };
    });
  }

  updateDesignSizeQty(groupIndex: number, designIndex: number, size: string, value: string) {
    this.consolidatedEntryState.update(state => ({
      ...state,
      groups: state.groups.map((g, gi) => {
        if (gi !== groupIndex) return g;
        return {
          ...g,
          designRatios: g.designRatios.map((dr, di) =>
            di === designIndex
              ? { ...dr, sizeQuantities: { ...dr.sizeQuantities, [size]: value } }
              : dr
          ),
        };
      }),
    }));
  }

  updateDesignShirtSizeQty(groupIndex: number, designIndex: number, size: string, sleeveType: 'Full' | 'Half', value: string) {
    this.consolidatedEntryState.update(state => ({
      ...state,
      groups: state.groups.map((g, gi) => {
        if (gi !== groupIndex) return g;
        return {
          ...g,
          designRatios: g.designRatios.map((dr, di) => {
            if (di !== designIndex) return dr;
            const existing = dr.shirtSizeQuantities[size] ?? { full: '', half: '' };
            return {
              ...dr,
              shirtSizeQuantities: {
                ...dr.shirtSizeQuantities,
                [size]: sleeveType === 'Full' ? { ...existing, full: value } : { ...existing, half: value },
              },
            };
          }),
        };
      }),
    }));
  }

  addConsolidatedItemsToOrder() {
    const state = this.consolidatedEntryState();
    let itemsAddedCount = 0;

    for (const group of state.groups) {
      for (const dr of group.designRatios) {
        if (group.containsShirt) {
          for (const [size, { full: fullStr, half: halfStr }] of Object.entries(dr.shirtSizeQuantities)) {
            for (const [sleeveType, qtyStr] of [['Full', fullStr], ['Half', halfStr]] as [string, string][]) {
              const qty = Math.round(this.parseFractionalQuantity(qtyStr || '0'));
              if (qty <= 0) continue;
              const sizeVar = dr.design.sizes.find(s => s.size === size && s.sleeveType === sleeveType);
              if (sizeVar) { this.addOrUpdateOrderItem(dr.design, sizeVar, qty); itemsAddedCount++; }
            }
          }
        } else {
          for (const [size, qtyStr] of Object.entries(dr.sizeQuantities)) {
            const qty = Math.round(this.parseFractionalQuantity(qtyStr || '0'));
            if (qty <= 0) continue;
            const sizeVar = dr.design.sizes.find(s => s.size === size);
            if (sizeVar) { this.addOrUpdateOrderItem(dr.design, sizeVar, qty); itemsAddedCount++; }
          }
        }
      }
    }

    if (itemsAddedCount === 0) {
      Swal.fire({ icon: 'info', title: 'No Quantities Entered', text: 'Please enter at least one size quantity before adding to the order.' });
      return;
    }
    this.cancelConsolidatedEntry();
  }

  cancelConsolidatedEntry() {
    this.consolidatedEntryState.set(EMPTY_CONSOLIDATED_ENTRY_STATE);
    this.scannedBarcodes.set([]);
    this.expandedCardKey.set(null);
  }

  /** Whether the given design row belongs under the given sleeve type. */
  isDesignInSleeve(dr: DesignRatio, sleeveType: 'Full' | 'Half'): boolean {
    return sleeveType === 'Full' ? dr.scannedSleeveTypes.full : dr.scannedSleeveTypes.half;
  }

  /** Number of scanned designs in this group that belong to the given sleeve type. */
  getGroupDesignCountForSleeve(group: FabricGroupEntry, sleeveType: 'Full' | 'Half'): number {
    return group.designRatios.filter(dr => this.isDesignInSleeve(dr, sleeveType)).length;
  }

  /** The catalog Fabric Description (e.g. "...FS" or "...HS") that matches this card's sleeve type. */
  getCardFabricDescription(group: FabricGroupEntry, sleeveType: 'Full' | 'Half'): string {
    const label = sleeveType === 'Full'
      ? group.groupSleeveFabricDescriptions.full
      : group.groupSleeveFabricDescriptions.half;
    return label || group.fabricDescription;
  }

  getGroupSleeveTotals(group: FabricGroupEntry): { full: number; half: number } {
    let full = 0;
    let half = 0;
    for (const dr of group.designRatios) {
      for (const { full: f, half: h } of Object.values(dr.shirtSizeQuantities)) {
        full += this.parseFractionalQuantity(f);
        half += this.parseFractionalQuantity(h);
      }
    }
    return { full, half };
  }

  private parseFractionalQuantity(value: unknown): number {
    if (typeof value === 'number') return value >= 0 ? value : 0;
    if (typeof value !== 'string') {
      const num = Number(value);
      return !isNaN(num) && num >= 0 ? num : 0;
    }
    const trimmed = value.trim();
    if (trimmed === '') return 0;
    if (trimmed.includes('/')) {
      const parts = trimmed.split('/');
      if (parts.length === 2) {
        const numerator = parseFloat(parts[0]);
        const denominator = parseFloat(parts[1]);
        if (!isNaN(numerator) && !isNaN(denominator) && denominator !== 0) {
          const result = numerator / denominator;
          return !isNaN(result) && result >= 0 ? result : 0;
        }
      }
    }
    const num = parseFloat(trimmed);
    return !isNaN(num) && num >= 0 ? num : 0;
  }

  // --- Order Save/Delete ---
  saveOrder() {
    if (!this.selectedClientId()) {
      Swal.fire({ icon: 'error', title: 'Error', text: 'Please select a client.' });
      return;
    }
    if (this.orderItems().length === 0) {
      Swal.fire({ icon: 'error', title: 'Error', text: 'Please add at least one design to the order.' });
      return;
    }

    const editableOrder = this.editableOrder();
    Swal.fire({
      title: editableOrder ? 'Updating Sales Order...' : 'Creating Sales Order...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    if (editableOrder) {
      const updatedOrder: SalesOrder = {
        ...editableOrder,
        clientId: this.selectedClientId()!,
        deliveryDate: this.deliveryDate(),
        items: this.orderItems()
      };
      this.salesOrderService.updateSalesOrder(updatedOrder).subscribe({
        next: () => {
          Swal.fire({ icon: 'success', title: 'Updated!', text: `Sales Order ${updatedOrder.id} updated successfully!`, timer: 2000, showConfirmButton: false });
          this.loadSalesOrders();
          this.switchToListView();
        },
        error: (err) => {
          console.error('Failed to update sales order:', err);
          Swal.fire({ icon: 'error', title: 'Error', text: err?.message || 'Failed to update sales order.' });
        }
      });
    } else {
      const orderData = {
        clientId: this.selectedClientId()!,
        deliveryDate: this.deliveryDate(),
        items: this.orderItems()
      };
      this.salesOrderService.createSalesOrder(orderData as any).subscribe({
        next: (savedOrder) => {
          this.clearDraft();
          Swal.fire({ icon: 'success', title: 'Created!', text: `Sales Order ${savedOrder.id} created successfully!`, timer: 2000, showConfirmButton: false });
          this.loadSalesOrders();
          this.switchToListView();
        },
        error: (err) => {
          console.error('Failed to create sales order:', err);
          Swal.fire({ icon: 'error', title: 'Error', text: err?.message || 'Failed to create sales order.' });
        }
      });
    }
  }

  showSaveAsForm(order: SalesOrder) {
    const designMap = new Map<string, Design>();
    for (const item of order.items) {
      if (item.design?.id && !designMap.has(item.design.id)) {
        designMap.set(item.design.id, item.design);
      }
    }
    const designs = Array.from(designMap.values());

    if (designs.length === 0) {
      Swal.fire({ icon: 'warning', title: 'No Designs', text: 'This order has no designs to copy.' });
      return;
    }

    this.editableOrder.set(null);
    this.orderItems.set([]);
    this.selectedClientId.set(order.clientId);
    this.deliveryDate.set('');
    this.mode.set('form');

    this.consolidatedEntryState.set({
      isActive: true,
      scannedBarcodes: designs.map(d => d.sizes[0]?.BARCODE).filter((b): b is string => !!b),
      groups: this.buildGroupsFromDesigns(designs),
    });
    this.expandedCardKey.set(null);
  }

  requestDeleteOrder(order: SalesOrder) {
    this.orderToDelete.set(order);
  }

  async confirmDelete() {
    try {
      if (!this.orderToDelete()) return;
      Swal.fire({ title: 'Deleting...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      await this.salesOrderService.deleteSalesOrder(this.orderToDelete()!.id);
      Swal.fire({ icon: 'success', title: 'Deleted!', text: 'Order deleted successfully.', timer: 2000, showConfirmButton: false });
      this.orderToDelete.set(null);
      this.loadSalesOrders();
    } catch {
      Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to delete order.' });
    }
  }

  cancelDelete() {
    this.orderToDelete.set(null);
  }
}