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

// --- State for Manual Entry ---
type ManualEntryStep = 'select-designs' | 'select-colors' | 'select-sizes';

type ManualDesignSelection = {
  styleNo: string;
  allDesigns: Design[];
  selectedColorDesigns: Design[];
};

/**
 * SIZE-BASED QUANTITY CALCULATION
 *
 * totalColors = total selected design-color combinations (auto-computed, not entered by user).
 *
 * Per size the user picks a fraction: '1', '1/2', '3/4', '2'
 *
 * Final qty = Math.floor(totalColors × fraction)
 *
 *   totalColors=10, fraction='1'   → floor(10 × 1.0)  = 10
 *   totalColors=10, fraction='1/2' → floor(10 × 0.5)  =  5
 *   totalColors=10, fraction='3/4' → floor(10 × 0.75) =  7
 *   totalColors=10, fraction='2'   → floor(10 × 2.0)  = 20
 */
type ManualEntryState = {
  isActive: boolean;
  step: ManualEntryStep;
  designGroups: { styleNo: string; group: string; designs: Design[] }[];
  selectedStyleNos: string[];
  designSelections: ManualDesignSelection[];
  allPossibleSizes: string[];
  /** fraction per size: '1' | '1/2' | '3/4' | '2'. key present = size selected. */
  sizeFractions: Record<string, string>;
  containsShirt: boolean;
  selectedSleeveType: 'Full' | 'Half' | null;
};

const EMPTY_MANUAL_ENTRY_STATE: ManualEntryState = {
  isActive: false,
  step: 'select-designs',
  designGroups: [],
  selectedStyleNos: [],
  designSelections: [],
  allPossibleSizes: [],
  sizeFractions: {},
  containsShirt: false,
  selectedSleeveType: null,
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
    designs = signal<Design[]>([]);

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

    // --- State for Manual Entry ---
    manualEntryState = signal<ManualEntryState>(EMPTY_MANUAL_ENTRY_STATE);
    manualDesignSearchTerm = signal<string>('');

    manualFilteredDesignGroups = computed(() => {
      const term = this.manualDesignSearchTerm().toLowerCase().trim();
      const groups = this.manualEntryState().designGroups;
      if (!term) return groups;
      return groups.filter(dg =>
        dg.styleNo.toLowerCase().includes(term) ||
        dg.group.toLowerCase().includes(term)
      );
    });

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

  // --- State for searchable client dropdown ---
  clientSearchTerm = signal('');
  isClientDropdownOpen = signal(false);

  isConsolidatedAddDisabled = computed(() => {
    const state = this.consolidatedEntryState();
    if (!state.isActive) return true;
    const hasValidSelection = Object.values(state.sizeQuantities).some(qty => this.parseFractionalQuantity(qty) > 0);
    if (!hasValidSelection) {
      return true;
    }
    if (state.containsShirt && !state.selectedSleeveType) {
      return true;
    }
    return false;
  });

  // --- Manual Entry Computed ---
  manualEntryIsAddDisabled = computed(() => {
    const state = this.manualEntryState();
    if (state.step !== 'select-sizes') return true;
    if (Object.keys(state.sizeFractions).length === 0) return true;
    if (state.containsShirt && !state.selectedSleeveType) return true;
    return false;
  });

  manualIsAllSizesSelected = computed(() => {
    const state = this.manualEntryState();
    if (state.allPossibleSizes.length === 0) return false;
    return state.allPossibleSizes.every(s => state.sizeFractions.hasOwnProperty(s));
  });

  manualIsSomeSizesSelected = computed(() => {
    const state = this.manualEntryState();
    const n = Object.keys(state.sizeFractions).length;
    return n > 0 && n < state.allPossibleSizes.length;
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

    orderItemsGroupedByDesign = computed(() => {
        const items = this.orderItems();
        if (!items) return [];

        const grouped = new Map<string, OrderItem[]>();

        for (const item of items) {
            const designId = item.design.id;
            if (!grouped.has(designId)) {
                grouped.set(designId, []);
            }
            grouped.get(designId)!.push(item);
        }

        grouped.forEach(groupItems => {
            groupItems.sort((a, b) => (a.sleeveType || '').localeCompare(b.sleeveType || ''));
        });

        return Array.from(grouped.values());
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


  private stream: MediaStream | null = null;
  private animationFrameId: number | null = null;

  private lastTickTime = 0;
  private readonly SCAN_INTERVAL = 33;
  private lastScannedTime: number = 0;


  ngOnInit() {
    this.clientService.getClients().subscribe(clients => this.clients.set(clients));
    this.designService.getDesigns().subscribe(designs => this.designs.set(designs));
    this.loadSalesOrders();
    this.resetFormFields();
  }

  ngOnDestroy() {
    this.stopBatchScan();
  }

  loadSalesOrders() {
    Swal.fire({
      title: 'Loading Sales Orders...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });
    this.salesOrderService.getSalesOrders().subscribe({
      next: (orders) => {
        this.salesOrders.set(orders)
        Swal.close()
      },
      error: (err) => {
        Swal.close()
        Swal.fire('Error', 'Failed to load Sales Orders', 'error');
      }
    });
  }

  // --- Client Dropdown Logic ---
  toggleClientDropdown() {
    this.isClientDropdownOpen.update(v => !v);
    if (!this.isClientDropdownOpen()) {
      this.clientSearchTerm.set('');
    }
  }

  closeDropdownOnEscape() {
    this.isClientDropdownOpen.set(false);
  }

  selectClient(client: Client) {
    this.selectedClientId.set(client.id);
    this.isClientDropdownOpen.set(false);
    this.clientSearchTerm.set('');
  }

  // --- View Switching ---
  showAddForm() {
    this.resetFormFields();
    this.mode.set('form');
  }

  showEditForm(order: SalesOrder) {
    const orderCopy = JSON.parse(JSON.stringify(order));
    this.editableOrder.set(orderCopy);
    this.selectedClientId.set(orderCopy.clientId);
    this.deliveryDate.set(orderCopy.deliveryDate);
    this.orderItems.set(orderCopy.items);
    this.mode.set('form');
  }

  cancel() {
    this.switchToListView();
  }

  private switchToListView() {
    this.resetFormFields();
    this.mode.set('list');
  }

  private resetFormFields() {
    this.editableOrder.set(null);
    this.selectedClientId.set(null);
    this.orderItems.set([]);
    this.deliveryDate.set(new Date().toISOString().split('T')[0]);
    this.cancelConsolidatedEntry();
    this.cancelManualEntry();
  }

  // --- Helpers for List View Template ---
  getClientName(clientId: string): string {
    return this.clients().find(c => c.id === clientId)?.clientName ?? 'Unknown Client';
  }

  getOrderTotalQuantity(order: SalesOrder): number {
    return order.items.reduce((total, item) => total + item.itemSizes.reduce((itemTotal, size) => itemTotal + (Number(size.quantity) || 0), 0), 0);
  }

  getOrderTotalPrice(order: SalesOrder): number {
    return order.items.reduce((total, item) => total + item.itemSizes.reduce((itemTotal, size) => itemTotal + ((Number(size.quantity) || 0) * (Number(size.price) || 0)), 0), 0);
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
          existingSize.price = sizeVar.WSP;
        } else {
          existingItem.itemSizes.push({
            size: sizeVar.size,
            quantity: quantity,
            price: sizeVar.WSP
          });
          existingItem.itemSizes.sort((a: OrderItemSize, b: OrderItemSize) =>
            String(a.size).localeCompare(String(b.size), undefined, { numeric: true })
          );
        }
      } else {
        const newOrderItem: OrderItem = {
          design: design,
          itemSizes: [{
            size: sizeVar.size,
            quantity: quantity,
            price: sizeVar.WSP
          }]
        };
        if (isShirt) {
          newOrderItem.sleeveType = sizeVar.sleeveType;
        }
        itemsCopy.push(newOrderItem);
      }
      return itemsCopy;
    });
  }

  // --- Batch Scanning and Consolidated Entry ---
  async startBatchScan() {
    this.isBatchScanning.set(true);
    this.scannedBarcodes.set([]);
    this.lastScannedTime = 0;
    this.lastTickTime = 0;

    setTimeout(async () => {
      if (!this.videoElement || !navigator.mediaDevices?.getUserMedia) {
        Swal.fire({ icon: 'error', title: 'Error', text: 'Camera not supported by your browser or element not ready.' });
        this.isBatchScanning.set(false);
        return;
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        this.videoElement.nativeElement.srcObject = this.stream;
        await this.videoElement.nativeElement.play();
        this.scanLoop();
      } catch (err) {
        Swal.fire({ icon: 'error', title: 'Camera Error', text: 'Could not access camera. Please check permissions.' });
        this.isBatchScanning.set(false);
      }
    }, 100);
  }

  private scanLoop() {
    if (!this.isBatchScanning()) return;

    this.animationFrameId = requestAnimationFrame((timestamp) => {
      if (timestamp - this.lastTickTime < this.SCAN_INTERVAL) {
        this.scanLoop();
        return;
      }
      this.lastTickTime = timestamp;

      const video = this.videoElement?.nativeElement;
      const canvas = this.canvasElement?.nativeElement;

      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.height = video.videoHeight;
        canvas.width = video.videoWidth;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
          if (code) {
            const now = Date.now();
            if (now - this.lastScannedTime > 1500) {
              this.lastScannedTime = now;
              this.handleScannedBarcode(code.data);
            }
          }
        }
      }
      this.scanLoop();
    });
  }

  private handleScannedBarcode(barcode: string) {
    const currentBarcodes = this.scannedBarcodes();
    if (currentBarcodes.includes(barcode)) {
      this.scanFeedback.set('duplicate');
    } else {
      this.scannedBarcodes.update(codes => [...codes, barcode]);
      this.lastAddedBarcode.set(barcode);
      this.scanFeedback.set('success');
      setTimeout(() => this.lastAddedBarcode.set(null), 1500);
    }
    setTimeout(() => this.scanFeedback.set('idle'), 800);
  }

  removeScannedBarcode(index: number) {
    this.scannedBarcodes.update(codes => codes.filter((_, i) => i !== index));
  }

  stopBatchScan() {
    this.isBatchScanning.set(false);
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.videoElement?.nativeElement) {
      this.videoElement.nativeElement.srcObject = null;
    }
  }

  async processScannedBarcodes() {
    const barcodes = this.scannedBarcodes();
    if (barcodes.length === 0) return;

    this.stopBatchScan();

    const barcodeDetails = new Map<string, { design: Design; sizeVar: SizePrice }>();
    this.designs().forEach(d => d.sizes.forEach(s => barcodeDetails.set(s.BARCODE, { design: d, sizeVar: s })));

    const uniqueDesigns = new Map<string, Design>();
    for (const barcode of barcodes) {
      const details = barcodeDetails.get(barcode.trim());
      if (details && !uniqueDesigns.has(details.design.id)) {
        uniqueDesigns.set(details.design.id, details.design);
      }
    }

    if (uniqueDesigns.size === 0) {
      Swal.fire({ icon: 'warning', title: 'No Matching Designs', text: 'None of the scanned barcodes matched any known designs in the system.' });
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
    const { sizeQuantities, selectedSleeveType, scannedBarcodes } = state;

    if (Object.keys(sizeQuantities).length === 0 || (state.containsShirt && !selectedSleeveType)) {
      Swal.fire({ icon: 'warning', title: 'Incomplete Selection', text: 'Please select at least one size and specify a sleeve type for shirts.' });
      return;
    }

    const totalScannedItems = scannedBarcodes.length;
    if (totalScannedItems === 0) {
      this.cancelConsolidatedEntry();
      return;
    }

    const barcodeDetails = new Map<string, { design: Design; sizeVar: SizePrice }>();
    this.designs().forEach(d => d.sizes.forEach(s => barcodeDetails.set(s.BARCODE, { design: d, sizeVar: s })));

    const designScannedCounts = new Map<string, number>();
    for (const barcode of scannedBarcodes) {
        const details = barcodeDetails.get(barcode.trim());
        if (details) {
            const isShirt = details.design.group.toUpperCase().includes('SHIRT');
            const key = `${details.design.id}` + (isShirt ? `-${selectedSleeveType}` : '');
            designScannedCounts.set(key, (designScannedCounts.get(key) || 0) + 1);
        }
    }

    const uniqueDesigns = new Map<string, Design>();
    for(const barcode of scannedBarcodes) {
        const details = barcodeDetails.get(barcode.trim());
        if(details && !uniqueDesigns.has(details.design.id)) {
            uniqueDesigns.set(details.design.id, details.design);
        }
    }

    let itemsAddedCount = 0;
    const designsArray = Array.from(uniqueDesigns.values());

    for (const [size, quantityRuleString] of Object.entries(sizeQuantities)) {
        const trimmedRule = (quantityRuleString || '0').trim();

        let totalTargetForSize = 0;
        if (trimmedRule.includes('/')) {
            const parts = trimmedRule.split('/');
            const denominator = parseInt(parts[1], 10);
            if (!isNaN(denominator) && denominator !== 0) {
                totalTargetForSize = Math.ceil(totalScannedItems / denominator);
            }
        } else {
            const literalValue = parseFloat(trimmedRule);
            if (!isNaN(literalValue)) {
                totalTargetForSize = literalValue * designsArray.length;
            }
        }

        if (totalTargetForSize <= 0) continue;

        let remainingForSize = totalTargetForSize;

        for (let i = 0; i < designsArray.length; i++) {
            const design = designsArray[i];
            const isShirt = design.group.toUpperCase().includes('SHIRT');
            const designKey = `${design.id}` + (isShirt ? `-${selectedSleeveType}` : '');
            const countOfDesignScanned = designScannedCounts.get(designKey) || 0;

            if (countOfDesignScanned === 0) continue;

            let finalQuantity = 0;
            if (i === designsArray.length - 1) {
                finalQuantity = remainingForSize;
            } else {
                finalQuantity = Math.round(totalTargetForSize * (countOfDesignScanned / totalScannedItems));
                if (finalQuantity > remainingForSize) finalQuantity = remainingForSize;
            }

            if (finalQuantity > 0) {
                const sizeVar = design.sizes.find(s =>
                    isShirt
                    ? s.size === size && s.sleeveType === selectedSleeveType
                    : s.size === size
                );

                if (sizeVar) {
                    this.addOrUpdateOrderItem(design, sizeVar, finalQuantity);
                    itemsAddedCount++;
                    remainingForSize -= finalQuantity;
                }
            }
        }
    }

    if (itemsAddedCount === 0 && totalScannedItems > 0) {
        Swal.fire({ icon: 'info', title: 'No Matching Items', text: `The selected sizes/sleeve type did not match any of the designs in the specified barcodes.` });
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
            if (!newQuantities.hasOwnProperty(size)) {
            newQuantities[size] = '1'
            }
        } else {
            delete newQuantities[size];
        }
        return { ...state, sizeQuantities: newQuantities };
        });
    }

  private parseFractionalQuantity(value: unknown): number {
    if (typeof value === 'number') {
      return value >= 0 ? value : 0;
    }
    if (typeof value !== 'string') {
      const num = Number(value);
      return !isNaN(num) && num >= 0 ? num : 0;
    }

    const trimmed = value.trim();
    if (trimmed === '') {
      return 0;
    }

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

  toggleAllSizesSelectionForConsolidatedEntry(isSelected: boolean) {
    this.consolidatedEntryState.update(state => {
      if (isSelected) {
        const newQuantities = { ...state.sizeQuantities };
        for (const size of state.allPossibleSizes) {
          if (this.parseFractionalQuantity(newQuantities[size] ?? '0') <= 0) {
            newQuantities[size] = '1';
          }
        }
        return { ...state, sizeQuantities: newQuantities };
      } else {
        return { ...state, sizeQuantities: {} };
      }
    });
  }

  updateConsolidatedState(patch: Partial<ConsolidatedEntryState>) {
    this.consolidatedEntryState.update(state => ({ ...state, ...patch }));
  }

  // --- Form Logic ---
  removeOrderItemGroup(itemGroup: OrderItem[]) {
    if (!itemGroup || itemGroup.length === 0) return;
    const designIdToRemove = itemGroup[0].design.id;
    this.orderItems.update(items => items.filter(item => item.design.id !== designIdToRemove));
  }

  removeItemSize(itemToRemoveFrom: OrderItem, sizeToRemove: string) {
    const uniqueKey = itemToRemoveFrom.design.id + (itemToRemoveFrom.sleeveType || '');
    this.orderItems.update(items => {
      const newItems = items.map(item => {
        const currentItemKey = item.design.id + (item.sleeveType || '');
        if (currentItemKey === uniqueKey) {
          const updatedItem = JSON.parse(JSON.stringify(item));
          updatedItem.itemSizes = updatedItem.itemSizes.filter((s: OrderItemSize) => s.size !== sizeToRemove);
          return updatedItem;
        }
        return item;
      });
      return newItems.filter(orderItem => orderItem.itemSizes.length > 0);
    });
  }

  updateItemQuantity(itemToUpdate: OrderItem, sizeToUpdate: string, newQuantity: unknown) {
    const finalQuantity = this.parseFractionalQuantity(newQuantity);

    const uniqueKey = itemToUpdate.design.id + (itemToUpdate.sleeveType || '');
    this.orderItems.update(items => {
      return items.map(item => {
        const currentItemKey = item.design.id + (item.sleeveType || '');
        if (currentItemKey === uniqueKey) {
          const updatedItemSizes = item.itemSizes.map(sizeItem =>
            sizeItem.size === sizeToUpdate ? { ...sizeItem, quantity: finalQuantity } : sizeItem
          );
          return { ...item, itemSizes: updatedItemSizes };
        }
        return item;
      });
    });
  }

  // --- Template Helpers for Item Display ---
  getTotalQuantity(): number {
    return this.orderItems().reduce((total, item) =>
      total + item.itemSizes.reduce((itemTotal, size) => itemTotal + (Number(size.quantity) || 0), 0), 0);
  }

  getTotalPrice(): number {
    return this.orderItems().reduce((total, item) =>
      total + item.itemSizes.reduce((itemTotal, size) => itemTotal + ((Number(size.quantity) || 0) * (Number(size.price) || 0)), 0), 0);
  }

  saveOrder() {
    if (!this.selectedClientId()) {
      Swal.fire({
        icon: 'error',
        title: 'Error',
        text: 'Please select a client.'
      });
      return;
    }
    if (this.orderItems().length === 0) {
      Swal.fire({
        icon: 'error',
        title: 'Error',
        text: 'Please add at least one design to the order.'
      });
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
          Swal.fire({
            icon: 'success',
            title: 'Updated!',
            text: `Sales Order ${updatedOrder.id} updated successfully!`,
            timer: 2000,
            showConfirmButton: false
          });
          this.loadSalesOrders();
          this.switchToListView();
        },
        error: (err) => {
          Swal.fire({
            icon: 'error',
            title: 'Error',
            text: 'Failed to update sales order.'
          })
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
          Swal.fire({
            icon: 'success',
            title: 'Created!',
            text: `Sales Order ${savedOrder.id} created successfully!`,
            timer: 2000,
            showConfirmButton: false
          });
          this.loadSalesOrders();
          this.switchToListView();
        },
        error: (err) => {
          Swal.fire({
            icon: 'error',
            title: 'Error',
            text: err.message
          });
        }
      });
    }
  }

  requestDeleteOrder(order: SalesOrder) {
    this.orderToDelete.set(order);
  }

  async confirmDelete() {
    try {
      if (!this.orderToDelete()) return;
      await this.salesOrderService.deleteSalesOrder(this.orderToDelete()!.id)
      Swal.fire({
        icon: 'success',
        title: 'Deleted!',
        text: 'Client deleted successfully',
        timer: 2000,
        showConfirmButton: false
      });
      this.loadSalesOrders();
      this.cancelDelete();
    }
    catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Error',
        text: error.message
      });
    }
  }

  cancelDelete() {
    this.orderToDelete.set(null);
  }

  // --- Integrated Print Logic ---
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
    return item.itemSizes?.[0]?.price ?? 0;
  }

  printGetItemTotalPrice(item: OrderItem): number {
    return (item.itemSizes || []).reduce((sum, s) => sum + (Number(s.quantity || 0) * Number(s.price || 0)), 0);
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

  // ─── Manual Entry ────────────────────────────────────────────────────────────

  startManualEntry() {
    this.manualDesignSearchTerm.set('');
    const allDesigns = this.designs();
    const groupMap = new Map<string, { styleNo: string; group: string; designs: Design[] }>();
    for (const d of allDesigns) {
      if (!groupMap.has(d.styleNo)) {
        groupMap.set(d.styleNo, { styleNo: d.styleNo, group: d.group || '', designs: [] });
      }
      groupMap.get(d.styleNo)!.designs.push(d);
    }
    const designGroups = Array.from(groupMap.values()).sort((a, b) =>
      a.styleNo.localeCompare(b.styleNo)
    );
    this.manualEntryState.set({
      ...EMPTY_MANUAL_ENTRY_STATE,
      isActive: true,
      designGroups,
    });
  }

  manualToggleDesignStyle(styleNo: string, isSelected: boolean) {
    this.manualEntryState.update(state => {
      const selectedStyleNos = isSelected
        ? [...state.selectedStyleNos, styleNo]
        : state.selectedStyleNos.filter(s => s !== styleNo);
      return { ...state, selectedStyleNos };
    });
  }

  manualIsStyleSelected(styleNo: string): boolean {
    return this.manualEntryState().selectedStyleNos.includes(styleNo);
  }

  manualGoToColorStep() {
    this.manualEntryState.update(state => {
      if (state.selectedStyleNos.length === 0) return state;
      const designSelections: ManualDesignSelection[] = state.selectedStyleNos.map(styleNo => {
        const group = state.designGroups.find(g => g.styleNo === styleNo)!;
        return { styleNo, allDesigns: group.designs, selectedColorDesigns: [] };
      });
      return { ...state, step: 'select-colors', designSelections };
    });
  }

  manualToggleColor(styleNo: string, design: Design, isSelected: boolean) {
    this.manualEntryState.update(state => {
      const selections = state.designSelections.map(sel => {
        if (sel.styleNo !== styleNo) return sel;
        const selectedColorDesigns = isSelected
          ? [...sel.selectedColorDesigns, design]
          : sel.selectedColorDesigns.filter(d => d.id !== design.id);
        return { ...sel, selectedColorDesigns };
      });
      return { ...state, designSelections: selections };
    });
  }

  manualIsColorSelected(styleNo: string, designId: string | undefined): boolean {
    const sel = this.manualEntryState().designSelections.find(s => s.styleNo === styleNo);
    if (!sel) return false;
    return sel.selectedColorDesigns.some(d => d.id === designId);
  }

  manualGoToSizeStep() {
    this.manualEntryState.update(state => {
      const allSelectedDesigns = state.designSelections.flatMap(s => s.selectedColorDesigns);
      if (allSelectedDesigns.length === 0) return state;
      const containsShirt = allSelectedDesigns.some(d => d.group?.toUpperCase().includes('SHIRT'));
      const allSizes = allSelectedDesigns.flatMap(d => d.sizes.map(s => s.size));
      const uniqueSizes = [...new Set(allSizes)].sort((a, b) =>
        String(a).localeCompare(String(b), undefined, { numeric: true })
      );
      return {
        ...state,
        step: 'select-sizes',
        allPossibleSizes: uniqueSizes,
        sizeFractions: {},
        containsShirt,
        selectedSleeveType: null,
      };
    });
  }

  manualIsSizeSelected(size: string): boolean {
    return this.manualEntryState().sizeFractions.hasOwnProperty(size);
  }

  manualGetSizeFraction(size: string): string {
    return this.manualEntryState().sizeFractions[size] ?? '1';
  }

  manualSetSizeFraction(size: string, fraction: string) {
    this.manualEntryState.update(state => ({
      ...state,
      sizeFractions: { ...state.sizeFractions, [size]: fraction },
    }));
  }

  manualToggleSize(size: string, isSelected: boolean) {
    this.manualEntryState.update(state => {
      const sizeFractions = { ...state.sizeFractions };
      if (isSelected) {
        if (!sizeFractions[size]) sizeFractions[size] = '1';
      } else {
        delete sizeFractions[size];
      }
      return { ...state, sizeFractions };
    });
  }

  manualToggleAllSizes(isSelected: boolean) {
    this.manualEntryState.update(state => {
      if (isSelected) {
        const sizeFractions = { ...state.sizeFractions };
        for (const size of state.allPossibleSizes) {
          if (!sizeFractions[size]) sizeFractions[size] = '1';
        }
        return { ...state, sizeFractions };
      } else {
        return { ...state, sizeFractions: {} };
      }
    });
  }

  manualGoBack() {
    this.manualEntryState.update(state => {
      if (state.step === 'select-colors') return { ...state, step: 'select-designs' };
      if (state.step === 'select-sizes') return { ...state, step: 'select-colors' };
      return state;
    });
  }

  /**
   * totalColors = total selected design-color combinations (Step 2).
   * Final qty per size = Math.floor(totalColors × fraction)
   *
   *   totalColors=10, '1'   → floor(10 × 1.00) = 10
   *   totalColors=10, '1/2' → floor(10 × 0.50) =  5
   *   totalColors=10, '3/4' → floor(10 × 0.75) =  7
   *   totalColors=10, '2'   → floor(10 × 2.00) = 20
   */
  manualComputedQtyForSize(size: string): number {
    const state = this.manualEntryState();
    const fraction = state.sizeFractions[size];
    if (!fraction) return 0;
    const totalColors = state.designSelections.reduce(
      (sum, sel) => sum + sel.selectedColorDesigns.length, 0
    );
    if (totalColors <= 0) return 0;
    const fracVal = this.parseFractionalQuantity(fraction);
    if (fracVal <= 0) return 0;
    return Math.floor(totalColors * fracVal);
  }

//   addManualItemsToOrder() {
//     const state = this.manualEntryState();
//     const { sizeFractions, selectedSleeveType, containsShirt } = state;

//     if (containsShirt && !selectedSleeveType) {
//       Swal.fire({ icon: 'warning', title: 'Select Sleeve Type', text: 'Please select Full or Half Sleeve for shirt designs.' });
//       return;
//     }
//     if (Object.keys(sizeFractions).length === 0) {
//       Swal.fire({ icon: 'warning', title: 'No Sizes Selected', text: 'Please select at least one size.' });
//       return;
//     }

//     const allSelectedDesigns = state.designSelections.flatMap(s => s.selectedColorDesigns);
//     const totalColors = allSelectedDesigns.length;

//     if (totalColors === 0) {
//       Swal.fire({ icon: 'warning', title: 'No Colors Selected', text: 'No design-color combinations selected.' });
//       return;
//     }

//     // qty per size = Math.floor(totalColors × fraction)
//     const sizeQtyMap: Record<string, number> = {};
//     for (const [size, fraction] of Object.entries(sizeFractions)) {
//       const fracVal = this.parseFractionalQuantity(fraction);
//       if (fracVal <= 0) continue;
//       const qty = Math.floor(totalColors * fracVal);
//       if (qty > 0) sizeQtyMap[size] = qty;
//     }

//     if (Object.keys(sizeQtyMap).length === 0) {
//       Swal.fire({ icon: 'warning', title: 'Zero Quantities', text: 'All quantities are zero. Select more colors or use a larger fraction.' });
//       return;
//     }

//     let itemsAdded = 0;
//     for (const design of allSelectedDesigns) {
//       for (const [size, quantity] of Object.entries(sizeQtyMap)) {
//         const isShirt = design.group?.toUpperCase().includes('SHIRT');
//         const sizeVar = design.sizes.find(s =>
//           isShirt ? s.size === size && s.sleeveType === selectedSleeveType
//                   : s.size === size
//         );
//         if (sizeVar) {
//           this.addOrUpdateOrderItem(design, sizeVar, quantity);
//           itemsAdded++;
//         }
//       }
//     }

//     if (itemsAdded === 0) {
//       Swal.fire({ icon: 'info', title: 'No Matches', text: 'Selected sizes did not match any design size variations. Check sleeve type for shirts.' });
//     } else {
//       this.cancelManualEntry();
//     }
//   }
addManualItemsToOrder() {
  const state = this.manualEntryState();
  const { sizeFractions, selectedSleeveType, containsShirt } = state;

  if (containsShirt && !selectedSleeveType) {
    Swal.fire({ icon: 'warning', title: 'Select Sleeve Type', text: 'Please select Full or Half Sleeve for shirt designs.' });
    return;
  }

  const allSelectedDesigns = state.designSelections.flatMap(s => s.selectedColorDesigns);
  const totalColors = allSelectedDesigns.length;

  if (totalColors === 0) {
    Swal.fire({ icon: 'warning', title: 'No Colors Selected', text: 'No design-color combinations selected.' });
    return;
  }

  let itemsAdded = 0;

  for (const [size, fractionString] of Object.entries(sizeFractions)) {

    if (!fractionString) continue;

    let applyColorCount = 0;
    let perColorQty = 1;

    // Fraction logic
    if (fractionString.includes('/')) {
      const [num, den] = fractionString.split('/').map(Number);
      if (!den || den === 0) continue;

      const fractionValue = num / den;

      // Apply to remaining portion
      applyColorCount = Math.floor(totalColors * (1 - fractionValue));
      perColorQty = 1;
    }
    else {
      const numericValue = parseFloat(fractionString);
      if (isNaN(numericValue) || numericValue <= 0) continue;

      // Apply to all colors
      applyColorCount = totalColors;
      perColorQty = numericValue;
    }

    if (applyColorCount <= 0) continue;

    // Apply only first N colors
    const applicableDesigns = allSelectedDesigns.slice(0, applyColorCount);

    for (const design of applicableDesigns) {

      const isShirt = design.group?.toUpperCase().includes('SHIRT');

      const sizeVar = design.sizes.find(s =>
        isShirt
          ? s.size === size && s.sleeveType === selectedSleeveType
          : s.size === size
      );

      if (sizeVar) {
        this.addOrUpdateOrderItem(design, sizeVar, perColorQty);
        itemsAdded++;
      }
    }
  }

  if (itemsAdded === 0) {
    Swal.fire({
      icon: 'info',
      title: 'No Matches',
      text: 'Selected sizes did not match any design size variations.'
    });
  } else {
    this.cancelManualEntry();
  }
}

  cancelManualEntry() {
    this.manualEntryState.set(EMPTY_MANUAL_ENTRY_STATE);
    this.manualDesignSearchTerm.set('');
  }

  updateManualEntryState(patch: Partial<ManualEntryState>) {
    this.manualEntryState.update(state => ({ ...state, ...patch }));
  }

    getManualTotalSelectedColors(): number {
        return this.manualEntryState().designSelections.reduce(
        (sum, sel) => sum + sel.selectedColorDesigns.length, 0
        );
    }

    getManualSizeDisplayText(size: string): string {
        const state = this.manualEntryState();
        const fraction = state.sizeFractions[size];
        if (!fraction) return '';

        const totalColors = this.getManualTotalSelectedColors();
        if (totalColors === 0) return '';

        if (fraction.includes('/')) {
            const [num, den] = fraction.split('/').map(Number);
            if (!den || den === 0) return '';

            const fractionValue = num / den;
            const applyCount = Math.floor(totalColors * (1 - fractionValue));

            return `Applies to ${applyCount} colors (1 each)`;
        } else {
            const numericValue = parseFloat(fraction);
            if (isNaN(numericValue) || numericValue <= 0) return '';

            return `All ${totalColors} colors (${numericValue} each)`;
        }
    }

    isAllColorsSelected(sel: ManualDesignSelection): boolean {
        return sel.selectedColorDesigns.length === sel.allDesigns.length
                && sel.allDesigns.length > 0;
    }

    isSomeColorsSelected(sel: ManualDesignSelection): boolean {
        return sel.selectedColorDesigns.length > 0 &&
            sel.selectedColorDesigns.length < sel.allDesigns.length;
    }

    manualToggleAllColors(styleNo: string, isSelected: boolean) {
        this.manualEntryState.update(state => {
            const designSelections = state.designSelections.map(sel => {
            if (sel.styleNo !== styleNo) return sel;

            return {
                ...sel,
                selectedColorDesigns: isSelected ? [...sel.allDesigns] : []
            };
            });

            return { ...state, designSelections };
        });
    }
}