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
    scanFeedback = signal<'idle' | 'success' | 'duplicate'>('idle'); // For visual feedback in viewfinder
    lastAddedBarcode = signal<string | null>(null); // For list item highlight

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

    // Check if any size has been selected with a quantity > 0
    const hasValidSelection = Object.values(state.sizeQuantities).some(qty => this.parseFractionalQuantity(qty) > 0);
    if (!hasValidSelection) {
      return true;
    }

    // If there's a shirt, a sleeve type must be selected
    if (state.containsShirt && !state.selectedSleeveType) {
      return true;
    }

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

        // Sort items within each group by sleeveType for consistent ordering
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

  // --- OPTIMIZATION: Throttling properties for the scanner loop ---
  private lastTickTime = 0;
  private readonly SCAN_INTERVAL = 33; // Scan at ~30 FPS

  // --- Scanning Accuracy Tuning ---
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
        // --- OPTIMIZATION: Request a 720p resolution for broader compatibility and performance ---
        const constraints = {
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
            advanced: [{ focusMode: 'continuous' }]
          } as any
        };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.videoElement.nativeElement.srcObject = this.stream;
        this.videoElement.nativeElement.play();
        this.animationFrameId = requestAnimationFrame(() => this.tick());
      } catch (err) {
        Swal.fire({ icon: 'error', title: 'Camera Error', text: 'Could not access camera. Please ensure permissions are granted.' });
        this.isBatchScanning.set(false);
      }
    });
  }

  tick() {
    if (!this.isBatchScanning()) return;
    this.animationFrameId = requestAnimationFrame(() => this.tick());

    const now = Date.now();
    if (now - this.lastTickTime < this.SCAN_INTERVAL) return;
    this.lastTickTime = now;

    if (this.videoElement?.nativeElement.readyState === this.videoElement.nativeElement.HAVE_ENOUGH_DATA) {
      const canvas = this.canvasElement?.nativeElement;
      const video = this.videoElement.nativeElement;
      const ctx = canvas?.getContext('2d', { willReadFrequently: true });

      if (ctx && canvas) {
        const videoWidth = video.videoWidth;
        const videoHeight = video.videoHeight;
        const cropSize = Math.min(videoWidth, videoHeight, 640);
        
        if (canvas.width !== cropSize) canvas.width = cropSize;
        if (canvas.height !== cropSize) canvas.height = cropSize;
        
        const sx = (videoWidth - cropSize) / 2;
        const sy = (videoHeight - cropSize) / 2;

        ctx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, cropSize, cropSize);
        const imageData = ctx.getImageData(0, 0, cropSize, cropSize);
        
        // Use 'attemptBoth' for better reliability with different QR code types (e.g., inverted)
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });

        if (code?.data) {
          this.addBarcodeToBatch(code.data);
        }
      }
    }
  }

  addBarcodeToBatch(barcode: string) {
    const now = Date.now();
    // Prevent hyper-fast double scans. If any scan was successful in the last 400ms, ignore this one.
    if (now - this.lastScannedTime < 400) {
        return;
    }

    // Check if the barcode has already been scanned in this session.
    if (this.scannedBarcodes().includes(barcode)) {
        this.lastScannedTime = now;
        this.scanFeedback.set('duplicate');
        setTimeout(() => this.scanFeedback.set('idle'), 400); // Give feedback for duplicate
        return;
    }

    this.lastScannedTime = now;

    this.scannedBarcodes.update(codes => [...codes, barcode]);
    this.lastAddedBarcode.set(barcode);
    setTimeout(() => this.lastAddedBarcode.set(null), 500);

    this.scanFeedback.set('success');
    setTimeout(() => this.scanFeedback.set('idle'), 300);
  }

  removeScannedBarcode(index: number) {
    this.scannedBarcodes.update(codes => codes.filter((_, i) => i !== index));
  }

  stopBatchScan() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    this.stream?.getTracks().forEach(track => track.stop());
    this.isBatchScanning.set(false);
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
        const details:any = barcodeDetails.get(barcode.trim());
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

    // Map barcode values to their design details for quick lookup
    const barcodeDetails = new Map<string, { design: Design; sizeVar: SizePrice }>();
    this.designs().forEach(d => d.sizes.forEach(s => barcodeDetails.set(s.BARCODE, { design: d, sizeVar: s })));

    // Pre-calculate counts of each design scanned (ignoring the size of the scanned barcode)
    const designScannedCounts = new Map<string, number>();
    for (const barcode of scannedBarcodes) {
        const details = barcodeDetails.get(barcode.trim());
        if (details) {
            const isShirt = details.design.group.toUpperCase().includes('SHIRT');
            // Group by design and the sleeve type selected in the modal
            const key = `${details.design.id}` + (isShirt ? `-${selectedSleeveType}` : '');
            designScannedCounts.set(key, (designScannedCounts.get(key) || 0) + 1);
        }
    }

    // Get the unique set of designs present in the scanned items
    const uniqueDesigns = new Map<string, Design>();
    for(const barcode of scannedBarcodes) {
        const details = barcodeDetails.get(barcode.trim());
        if(details && !uniqueDesigns.has(details.design.id)) {
            uniqueDesigns.set(details.design.id, details.design);
        }
    }
    
    let itemsAddedCount = 0;
    const designsArray = Array.from(uniqueDesigns.values());

    // Iterate over each size the user has selected in the modal
    for (const [size, quantityRuleString] of Object.entries(sizeQuantities)) {
        const trimmedRule = (quantityRuleString || '0').trim();
        
        let totalTargetForSize = 0;
        if (trimmedRule.includes('/')) {
            const parts = trimmedRule.split('/');
            const denominator = parseInt(parts[1], 10);
            if (!isNaN(denominator) && denominator !== 0) {
                // As per requirement: 3/4 of 10 is 3, 3/4 of 4 is 1, 1/2 of 4 is 2
                // This matches ceil(totalScanned / denominator)
                totalTargetForSize = Math.ceil(totalScannedItems / denominator);
            }
        } else {
            const literalValue = parseFloat(trimmedRule);
            if (!isNaN(literalValue)) {
                // For literal numbers, we multiply by number of designs to ensure "X per design"
                totalTargetForSize = literalValue * designsArray.length;
            }
        }
        
        if (totalTargetForSize <= 0) continue;

        let remainingForSize = totalTargetForSize;

        // Distribute the total target among the designs proportionally
        for (let i = 0; i < designsArray.length; i++) {
            const design = designsArray[i];
            const isShirt = design.group.toUpperCase().includes('SHIRT');
            const designKey = `${design.id}` + (isShirt ? `-${selectedSleeveType}` : '');
            const countOfDesignScanned = designScannedCounts.get(designKey) || 0;

            if (countOfDesignScanned === 0) continue;

            let finalQuantity = 0;
            if (i === designsArray.length - 1) {
                // Last design gets the remaining quantity to ensure the total matches the target
                finalQuantity = remainingForSize;
            } else {
                // Proportional distribution: (Total Target * (Design Scans / Total Scans))
                finalQuantity = Math.round(totalTargetForSize * (countOfDesignScanned / totalScannedItems));
                if (finalQuantity > remainingForSize) finalQuantity = remainingForSize;
            }

            if (finalQuantity > 0) {
                // Find the specific size variation for the current design, size, and sleeve type
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

      // Firestore Timestamp
      if (order.createdAt instanceof Timestamp) {
        date = order.createdAt.toDate();
      }
      // Already a Date
      else if (order.createdAt instanceof Date) {
        date = order.createdAt;
      }
      // Fallback (string / number)
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
}