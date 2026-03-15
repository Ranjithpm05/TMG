import { Component, ChangeDetectionStrategy, signal, inject, OnInit, OnDestroy, ViewChild, ElementRef, computed } from '@angular/core';
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

declare const jsQR: any;

type ViewMode = 'list' | 'form';

// --- State for Consolidated Entry ---
type ConsolidatedEntryState = {
  isActive: boolean;
  designs: Design[];
  scannedBarcodes: string[];
  containsShirt: boolean;
  determinedSleeveType: 'Full' | 'Half' | null;
  selectedSleeveType: 'Full' | 'Half' | null;
  allPossibleSizes: string[];
  sizeQuantities: Record<string, string>;
  portion: string;
};

const EMPTY_CONSOLIDATED_ENTRY_STATE: ConsolidatedEntryState = {
  isActive: false,
  designs: [],
  scannedBarcodes: [],
  containsShirt: false,
  determinedSleeveType: null,
  selectedSleeveType: null,
  allPossibleSizes: [],
  sizeQuantities: {},
  portion: 'All',
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

    // --- State for Manual Design Selection ---
    manualDesignSelectionState = signal<ManualDesignSelectionState>(EMPTY_MANUAL_SELECTION_STATE);

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
    if (!state.isActive) return true;
    const hasValidSelection = Object.values(state.sizeQuantities).some(qty => this.parseFractionalQuantity(qty) > 0);
    if (!hasValidSelection) return true;
    if (state.containsShirt && !state.selectedSleeveType) return true;
    return false;
  });

  filteredClientsForDropdown = computed(() => {
    const term = this.clientSearchTerm().toLowerCase();
    if (!term) return this.clients();
    return this.clients().filter(c =>
      c.clientName.toLowerCase().includes(term) ||
      c.clientCode.toLowerCase().includes(term)
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

  // --- Print state ---
  printOrder = signal<SalesOrder | null>(null);

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

  isAllSizesSelectedForConsolidatedEntry = computed(() => {
    const state = this.consolidatedEntryState();
    if (state.allPossibleSizes.length === 0) return false;
    return state.allPossibleSizes.every(size => this.parseFractionalQuantity(state.sizeQuantities[size] ?? '0') > 0);
  });

  isSomeSizesSelectedForConsolidatedEntry = computed(() => {
    const state = this.consolidatedEntryState();
    const selectedCount = Object.values(state.sizeQuantities).filter(qty => this.parseFractionalQuantity(qty) > 0).length;
    return selectedCount > 0 && selectedCount < state.allPossibleSizes.length;
  });

  /** Orders filtered by the selected date range (based on createdAt) */
  filteredSalesOrders = computed(() => {
    const orders = this.salesOrders();
    const from = this.filterFromDate();
    const to   = this.filterToDate();
    if (!from && !to) return orders;

    const fromMs = from ? new Date(from).setHours(0, 0, 0, 0)    : -Infinity;
    const toMs   = to   ? new Date(to).setHours(23, 59, 59, 999)  :  Infinity;

    return orders.filter(order => {
      const raw: any = order.createdAt;
      let d: Date;
      if (raw && typeof raw.toDate === 'function') {
        d = raw.toDate();
      } else if (raw instanceof Date) {
        d = raw;
      } else if (raw) {
        d = new Date(raw);
      } else {
        // fall back to deliveryDate if createdAt is missing
        d = new Date(order.deliveryDate);
      }
      const ms = d.getTime();
      return ms >= fromMs && ms <= toMs;
    });
  });

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
    this.clientService.getClients().subscribe(clients => this.clients.set(clients));
    this.designService.getDesigns().subscribe(designs => this.designs.set(designs));
    this.loadSalesOrders();
  }

  ngOnDestroy() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    this.stream?.getTracks().forEach(track => track.stop());
  }

  loadSalesOrders() {
    this.salesOrderService.getSalesOrders().subscribe(orders => this.salesOrders.set(orders));
  }

  switchToListView() {
    this.mode.set('list');
    this.editableOrder.set(null);
    this.orderItems.set([]);
    this.selectedClientId.set(null);
    this.deliveryDate.set('');
  }

  showAddForm() {
    this.editableOrder.set(null);
    this.orderItems.set([]);
    this.selectedClientId.set(null);
    this.deliveryDate.set('');
    this.mode.set('form');
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
    window.print();
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


  printGetSleeveTypeAbbreviation(sleeveType?: 'Half' | 'Full'): string {
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

  updateConsolidatedState(partial: Partial<ConsolidatedEntryState>) {
    this.consolidatedEntryState.update(s => ({ ...s, ...partial }));
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
        const newOrderItem: OrderItem = {
          design: design,
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

  /**
   * Takes all confirmed designs and opens the Consolidated Entry (size/qty) modal.
   * Each confirmed design is treated as one unit for proportional distribution.
   */
  proceedFromManualToSizeEntry() {
    const { confirmedDesigns } = this.manualDesignSelectionState();
    if (confirmedDesigns.length === 0) return;

    const containsShirt = confirmedDesigns.some(d => d.group?.toUpperCase().includes('SHIRT'));
    const allSizes = confirmedDesigns.flatMap(d => d.sizes.map(s => s.size));
    const uniqueSizes = [...new Set(allSizes)].sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { numeric: true })
    );

    // One pseudo-barcode per confirmed design (uses the first size barcode of each design)
    // This ensures uniform 1-each distribution in addConsolidatedItemsToOrder()
    const pseudoBarcodes: string[] = confirmedDesigns
      .map(d => d.sizes[0]?.BARCODE)
      .filter((b): b is string => !!b);

    this.consolidatedEntryState.set({
      isActive: true,
      designs: confirmedDesigns,
      scannedBarcodes: pseudoBarcodes,
      containsShirt,
      determinedSleeveType: null,
      selectedSleeveType: null,
      allPossibleSizes: uniqueSizes,
      sizeQuantities: {},
      portion: 'All',
    });

    this.cancelManualEntry();
  }

  // ============================================================
  // --- Batch Scanning and Consolidated Entry ---
  // ============================================================

  async startBatchScan() {
    this.isBatchScanning.set(true);
    this.scannedBarcodes.set([]);
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
    setTimeout(() => this.scanFeedback.set('idle'), 400);
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
  }

  processScannedBarcodes() {
    this.stopBatchScan();
    const barcodes = this.scannedBarcodes();
    if (barcodes.length === 0) return;

    const barcodeDetails = new Map<string, { design: Design; sizeVar: SizePrice }>();
    this.designs().forEach(d => d.sizes.forEach(s => barcodeDetails.set(s.BARCODE, { design: d, sizeVar: s })));

    const uniqueDesigns = new Map<string, Design>();
    for (const barcode of barcodes) {
      const details = barcodeDetails.get(barcode.trim());
      if (details) {
        uniqueDesigns.set(details.design.id, details.design);
      }
    }

    if (uniqueDesigns.size === 0) {
      Swal.fire({ icon: 'error', title: 'No Designs Found', text: 'No valid designs found for the scanned barcodes.' });
      return;
    }

    const designsArray = Array.from(uniqueDesigns.values());
    const containsShirt = designsArray.some(d => d.group.toUpperCase().includes('SHIRT'));
    const allSizes = designsArray.flatMap(d => d.sizes.map(s => s.size));
    const uniqueSizes = [...new Set(allSizes)].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));

    let determinedSleeveType: 'Full' | 'Half' | null = null;
    if (containsShirt) {
      const scannedSleeveTypes = new Set<'Full' | 'Half'>();
      for (const barcode of barcodes) {
        const details: any = barcodeDetails.get(barcode.trim());
        if (details && details.design.group.toUpperCase().includes('SHIRT')) {
          scannedSleeveTypes.add(details.sizeVar.sleeveType);
        }
      }
      if (scannedSleeveTypes.size === 1) {
        determinedSleeveType = scannedSleeveTypes.values().next().value;
      }
    }

    this.consolidatedEntryState.set({
      isActive: true,
      designs: designsArray,
      scannedBarcodes: barcodes,
      containsShirt,
      determinedSleeveType,
      selectedSleeveType: determinedSleeveType,
      allPossibleSizes: uniqueSizes,
      sizeQuantities: {},
      portion: 'All',
    });
  }

  addConsolidatedItemsToOrder() {
    const state = this.consolidatedEntryState();
    const { sizeQuantities, selectedSleeveType, scannedBarcodes, designs } = state;

    if (Object.keys(sizeQuantities).length === 0 || (state.containsShirt && !selectedSleeveType)) {
      Swal.fire({ icon: 'warning', title: 'Incomplete Selection', text: 'Please select at least one size and specify a sleeve type for shirts.' });
      return;
    }

    // Build the final list of designs to work with.
    // For scan flow: resolve barcodes → unique designs.
    // For manual flow: use designs directly (pseudo-barcodes may not resolve).
    const barcodeDetails = new Map<string, { design: Design; sizeVar: SizePrice }>();
    this.designs().forEach(d => d.sizes.forEach(s => barcodeDetails.set(s.BARCODE, { design: d, sizeVar: s })));

    const resolvedUnique = new Map<string, Design>();
    for (const barcode of scannedBarcodes) {
      const details = barcodeDetails.get(barcode.trim());
      if (details && !resolvedUnique.has(details.design.id)) {
        resolvedUnique.set(details.design.id, details.design);
      }
    }

    // Fall back to the designs list directly (manual entry case)
    if (resolvedUnique.size === 0 && designs.length > 0) {
      for (const d of designs) resolvedUnique.set(d.id!, d);
    }

    const finalDesigns = Array.from(resolvedUnique.values());
    if (finalDesigns.length === 0) {
      this.cancelConsolidatedEntry();
      return;
    }

    let itemsAddedCount = 0;

    for (const [size, quantityRuleString] of Object.entries(sizeQuantities)) {
      const trimmedRule = (quantityRuleString || '0').trim();

      if (trimmedRule.includes('/')) {
        // ── FRACTION MODE ──────────────────────────────────────────────────────
        // "N/D" means: apply qty 1 to round(totalDesigns × N/D) designs.
        // Example: 6 designs, "1/4" → round(6 × 0.25) = 2 designs get qty 1.
        // Example: 6 designs, "3/4" → round(6 × 0.75) = 5 designs get qty 1.
        const parts = trimmedRule.split('/');
        const numerator = parseInt(parts[0], 10);
        const denominator = parseInt(parts[1], 10);

        if (isNaN(numerator) || isNaN(denominator) || denominator === 0 || numerator <= 0) continue;

        const designsToApply = Math.round(finalDesigns.length * numerator / denominator);
        if (designsToApply <= 0) continue;

        // Apply qty 1 to the first N qualifying designs
        let applied = 0;
        for (const design of finalDesigns) {
          if (applied >= designsToApply) break;
          const isShirt = design.group?.toUpperCase().includes('SHIRT');
          const sizeVar = design.sizes.find(s =>
            isShirt ? s.size === size && s.sleeveType === selectedSleeveType : s.size === size
          );
          if (sizeVar) {
            this.addOrUpdateOrderItem(design, sizeVar, 1);
            itemsAddedCount++;
            applied++;
          }
        }

      } else {
        // ── LITERAL MODE ───────────────────────────────────────────────────────
        // A plain number means every design gets exactly that qty.
        // Example: 6 designs, "2" → each of the 6 designs gets qty 2.
        const literalValue = Math.round(parseFloat(trimmedRule));
        if (isNaN(literalValue) || literalValue <= 0) continue;

        for (const design of finalDesigns) {
          const isShirt = design.group?.toUpperCase().includes('SHIRT');
          const sizeVar = design.sizes.find(s =>
            isShirt ? s.size === size && s.sleeveType === selectedSleeveType : s.size === size
          );
          if (sizeVar) {
            this.addOrUpdateOrderItem(design, sizeVar, literalValue);
            itemsAddedCount++;
          }
        }
      }
    }

    if (itemsAddedCount === 0) {
      Swal.fire({ icon: 'info', title: 'No Matching Items', text: 'The selected sizes/sleeve type did not match any of the designs.' });
    }

    this.cancelConsolidatedEntry();
  }

  cancelConsolidatedEntry() {
    this.consolidatedEntryState.set(EMPTY_CONSOLIDATED_ENTRY_STATE);
    this.scannedBarcodes.set([]);
  }

  isSizeSelected(size: string): boolean {
    return this.consolidatedEntryState().sizeQuantities.hasOwnProperty(size);
  }

  getQuantityForSelectedSize(size: string): string {
    return this.consolidatedEntryState().sizeQuantities[size] || '1';
  }

  toggleSizeSelection(size: string, isSelected: boolean) {
    this.consolidatedEntryState.update(state => {
      const newQuantities = { ...state.sizeQuantities };
      if (isSelected) {
        if (!newQuantities.hasOwnProperty(size)) newQuantities[size] = '1';
      } else {
        delete newQuantities[size];
      }
      return { ...state, sizeQuantities: newQuantities };
    });
  }

  toggleAllSizesSelectionForConsolidatedEntry(isSelected: boolean) {
    this.consolidatedEntryState.update(state => {
      if (isSelected) {
        const newQuantities = { ...state.sizeQuantities };
        for (const size of state.allPossibleSizes) {
          if (this.parseFractionalQuantity(newQuantities[size] ?? '0') === 0) {
            newQuantities[size] = '1';
          }
        }
        return { ...state, sizeQuantities: newQuantities };
      } else {
        return { ...state, sizeQuantities: {} };
      }
    });
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

  updateQuantityForSelectedSize(size: string, quantity: unknown) {
    const newQuantity = (typeof quantity === 'string' ? quantity.trim() : String(quantity)) || '1';
    this.consolidatedEntryState.update(state => {
      const newQuantities = { ...state.sizeQuantities, [size]: newQuantity };
      return { ...state, sizeQuantities: newQuantities };
    });
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
        error: () => Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to update sales order.' })
      });
    } else {
      const orderData = {
        clientId: this.selectedClientId()!,
        deliveryDate: this.deliveryDate(),
        items: this.orderItems()
      };
      this.salesOrderService.createSalesOrder(orderData as any).subscribe({
        next: (savedOrder) => {
          Swal.fire({ icon: 'success', title: 'Created!', text: `Sales Order ${savedOrder.id} created successfully!`, timer: 2000, showConfirmButton: false });
          this.loadSalesOrders();
          this.switchToListView();
        },
        error: (err) => Swal.fire({ icon: 'error', title: 'Error', text: err.message })
      });
    }
  }

  requestDeleteOrder(order: SalesOrder) {
    this.orderToDelete.set(order);
  }

  async confirmDelete() {
    try {
      if (!this.orderToDelete()) return;
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