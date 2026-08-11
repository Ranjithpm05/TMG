import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, Subscription } from 'rxjs';
import Swal from 'sweetalert2';
import { SalesOrder } from '../../models/sales-order.model';
import { InventoryItem } from '../../models/inventory.model';
import {
  PickList,
  PickListClaimUser,
  PickListLine,
  PickListLineItem,
  PickListType,
} from '../../models/pick-list.model';
import { Client } from '../../models/client.model';
import { SalesOrderService } from '../../services/sales-order.service';
import { InventoryService } from '../../services/inventory.service';
import { PickListService } from '../../services/pick-list.service';
import { ClientService } from '../../services/client.service';
import { AuthService } from '../../services/auth.service';
import { LoadingService } from '../../services/loading.service';

declare const jsQR: any;

type ViewMode = 'list' | 'select-type' | 'select-party' | 'select-orders' | 'select-items' | 'preview' | 'live-pick' | 'view' | 'edit';

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL', '6XL', 'Free Size'];

@Component({
  selector: 'app-pick-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './pick-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PickListComponent implements OnInit, OnDestroy {
  @ViewChild('scanInput') scanInputElement?: ElementRef<HTMLInputElement>;
  @ViewChild('cameraVideo') cameraVideoElement?: ElementRef<HTMLVideoElement>;

  private salesOrderService = inject(SalesOrderService);
  private inventoryService = inject(InventoryService);
  private pickListService = inject(PickListService);
  private clientService = inject(ClientService);
  private authService = inject(AuthService);
  private loadingService = inject(LoadingService);

  private liveSubscriptions: Subscription[] = [];
  private claimHeartbeat: ReturnType<typeof setInterval> | null = null;
  private cameraStream: MediaStream | null = null;
  private cameraAnimationFrame: number | null = null;
  private cameraCanvas: HTMLCanvasElement | null = null;
  private barcodeDetector: any = null;
  private cameraLoopBusy = false;
  private lastCameraBarcode = '';
  private lastCameraBarcodeAt = 0;
  private completionHandled = false;

  mode = signal<ViewMode>('list');
  salesOrders = signal<SalesOrder[]>([]);
  inventory = signal<InventoryItem[]>([]);
  clients = signal<Client[]>([]);
  pickLists = signal<PickList[]>([]);
  draftLines = signal<PickListLineItem[]>([]);
  viewPickList = signal<PickList | null>(null);
  viewLines = signal<PickListLine[]>([]);
  editPickList = signal<PickList | null>(null);
  editableLines = signal<PickListLine[]>([]);
  addOrderSearchTerm = signal('');
  livePickList = signal<PickList | null>(null);
  liveLines = signal<PickListLine[]>([]);
  currentLineId = signal<string | null>(null);

  isLoading = signal(true);
  isSaving = signal(false);
  isSubmittingScan = signal(false);
  isClaimingItem = signal(false);
  isCameraOpen = signal(false);
  scanFeedback = signal<'idle' | 'success' | 'error'>('idle');
  scannerMessage = signal('Scan the assigned item');
  manualScanValue = signal('');
  showLinesPanel = signal(false);

  listTab = signal<'orders' | 'picklists'>('orders');
  searchTerm = signal('');
  statusFilter = signal<'all' | 'Pending' | 'Confirmed' | 'Shipped'>('all');
  plTypeFilter = signal<'all' | 'direct' | 'combined' | 'itemwise' | 'party'>('all');
  pickType = signal<PickListType>('direct');
  selectedOrderIds = signal<Set<string>>(new Set());
  orderSearchTerm = signal('');
  selectedPartyId = signal<string | null>(null);
  partySearchTerm = signal('');

  currentUser = computed(() => this.authService.currentUser());

  // Indexes inventory by styleNo|color|size so findInventoryMatch() below is an
  // O(1) map lookup instead of scanning the full inventory list (11k+ rows in
  // production) twice per size-entry — with 270 sales orders, one of them
  // carrying 688 items, that linear scan was O(orders * items * sizes *
  // inventory), which froze the Sales Orders tab's render for minutes.
  private inventoryIndex = computed(() => {
    const map = new Map<string, InventoryItem[]>();
    for (const item of this.inventory()) {
      const key = `${item.styleNo}||${item.color}||${String(item.size)}`;
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return map;
  });

  filteredOrders = computed(() => {
    const term = this.searchTerm().toLowerCase();
    const status = this.statusFilter();
    return this.salesOrders().filter((order) => {
      const matchesStatus = status === 'all' || order.status === status;
      const matchesTerm = !term
        || order.salesNo.toLowerCase().includes(term)
        || this.getClientName(order.clientId).toLowerCase().includes(term);
      return matchesStatus && matchesTerm;
    });
  });

  filteredOrdersForSelection = computed(() => {
    const term = this.orderSearchTerm().toLowerCase();
    const partyId = this.pickType() === 'party' ? this.selectedPartyId() : null;
    return this.salesOrders().filter((order) => {
      if (this.getOrderRemainingQty(order.id) <= 0) return false;
      if (partyId && order.clientId !== partyId) return false;
      return !term
        || order.salesNo.toLowerCase().includes(term)
        || this.getClientName(order.clientId).toLowerCase().includes(term);
    });
  });

  partiesWithOpenOrders = computed(() => {
    const term = this.partySearchTerm().toLowerCase();
    const clientIdsWithOrders = new Set(
      this.salesOrders().filter((order) => this.getOrderRemainingQty(order.id) > 0).map((order) => order.clientId)
    );
    return this.clients()
      .filter((client) => !!client.id && clientIdsWithOrders.has(client.id))
      .filter((client) => !term || client.clientName.toLowerCase().includes(term))
      .sort((a, b) => a.clientName.localeCompare(b.clientName));
  });

  visiblePickLists = computed(() => this.pickLists().filter((pickList) => this.isDisplayablePickList(pickList)));
  effectivePickedLists = computed(() => this.visiblePickLists().filter((pickList) => !pickList.legacyPickingPending));

  filteredPickLists = computed(() => {
    const type = this.plTypeFilter();
    const term = this.searchTerm().toLowerCase();
    return this.visiblePickLists().filter((pickList) => {
      const matchesType = type === 'all' || pickList.type === type;
      const matchesTerm = !term
        || pickList.pickListNo.toLowerCase().includes(term)
        || (pickList.salesNos ?? []).some((salesNo) => salesNo.toLowerCase().includes(term))
        || pickList.clientName.toLowerCase().includes(term);
      return matchesType && matchesTerm;
    });
  });

  selectedOrders = computed(() => this.salesOrders().filter((order) => this.selectedOrderIds().has(order.id)));
  selectedItemCount = computed(() => this.draftLines().filter((line) => line.selected).length);

  draftTotals = computed(() => {
    const lines = this.draftLines().filter((line) => this.pickType() !== 'itemwise' || line.selected);
    return {
      ordered: lines.reduce((sum, line) => sum + line.orderedQty, 0),
      required: lines.reduce((sum, line) => sum + line.requiredQty, 0),
      pending: lines.reduce((sum, line) => sum + line.pendingQty, 0),
      balance: lines.reduce((sum, line) => sum + line.balanceQty, 0),
      readyLines: lines.filter((line) => line.requiredQty > 0).length,
    };
  });

  combinedPreviewGroups = computed(() => {
    if (this.pickType() !== 'combined') return null;
    const groups = new Map<string, {
      styleNo: string; color: string; size: string; sleeveType?: string; barcode?: string;
      orderedQty: number; alreadyPickedQty: number; requiredQty: number; pendingQty: number;
      orders: { salesNo: string; requiredQty: number; pendingQty: number }[];
    }>();
    for (const line of this.draftLines()) {
      const key = `${line.styleNo}||${line.color}||${line.size}||${line.sleeveType ?? ''}`;
      const existing = groups.get(key);
      if (existing) {
        existing.orderedQty += line.orderedQty;
        existing.alreadyPickedQty += line.alreadyPickedQty;
        existing.requiredQty += line.requiredQty;
        existing.pendingQty += line.pendingQty;
        existing.orders.push({ salesNo: line.salesNo, requiredQty: line.requiredQty, pendingQty: line.pendingQty });
      } else {
        groups.set(key, {
          styleNo: line.styleNo, color: line.color, size: line.size, sleeveType: line.sleeveType,
          barcode: line.barcode, orderedQty: line.orderedQty, alreadyPickedQty: line.alreadyPickedQty,
          requiredQty: line.requiredQty, pendingQty: line.pendingQty,
          orders: [{ salesNo: line.salesNo, requiredQty: line.requiredQty, pendingQty: line.pendingQty }],
        });
      }
    }
    return [...groups.values()];
  });

  candidateGroups = computed(() => {
    const map = new Map<string, PickListLineItem[]>();
    for (const line of this.draftLines()) {
      const key = `${line.styleNo}||${line.color}||${line.size}||${line.sleeveType ?? ''}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(line);
    }
    return [...map.entries()].map(([key, lines]) => ({
      key,
      styleNo: lines[0].styleNo,
      color: lines[0].color,
      size: lines[0].size,
      sleeveType: lines[0].sleeveType ?? '',
      requiredQty: lines.reduce((sum, line) => sum + line.requiredQty, 0),
      pendingQty: lines.reduce((sum, line) => sum + line.pendingQty, 0),
      salesNos: [...new Set(lines.map((line) => line.salesNo))],
      selected: lines.every((line) => line.selected),
    }));
  });

  liveProgress = computed(() => ({
    totalRequiredQty: this.livePickList()?.totalRequiredQty ?? 0,
    totalPickedQty: this.livePickList()?.totalPickedQty ?? 0,
    totalPendingQty: this.livePickList()?.totalPendingQty ?? 0,
    pickableLineCount: this.livePickList()?.pickableLineCount ?? 0,
    completedLineCount: this.livePickList()?.completedLineCount ?? 0,
  }));

  currentAssignedLine = computed(() => {
    const preferredLineId = this.currentLineId();
    const userId = this.currentUser()?.id;
    const lines = this.liveLines();
    if (!userId) return null;
    const preferred = preferredLineId
      ? lines.find((line) => line.lineId === preferredLineId && line.claimedByUserId === userId && line.remainingQty > 0)
      : undefined;
    return preferred ?? lines.find((line) => line.claimedByUserId === userId && line.remainingQty > 0) ?? null;
  });

  viewDisplayLines = computed(() => this.viewLines().length ? this.viewLines() : this.viewPickList()?.items ?? []);

  overallProgress = computed(() => {
    const required = this.livePickList()?.totalRequiredQty ?? 0;
    const picked = this.livePickList()?.totalPickedQty ?? 0;
    return required > 0 ? Math.round((picked / required) * 100) : 0;
  });

  currentDesignLines = computed(() => {
    const currentLine = this.currentAssignedLine();
    if (!currentLine) return [];
    return this.liveLines().filter((line) =>
      (line.clientId ?? '') === (currentLine.clientId ?? '') &&
      line.styleNo === currentLine.styleNo &&
      line.color === currentLine.color &&
      (line.sleeveType ?? '') === (currentLine.sleeveType ?? '') &&
      line.status !== 'pending_stock' &&
      line.status !== 'blocked'
    );
  });

  currentDesignTotals = computed(() => {
    const lines = this.currentDesignLines();
    return {
      requiredQty: lines.reduce((sum, l) => sum + l.requiredQty, 0),
      pickedQty: lines.reduce((sum, l) => sum + l.pickedQty, 0),
      remainingQty: lines.reduce((sum, l) => sum + l.remainingQty, 0),
    };
  });

  currentCustomerDesigns = computed(() => {
    const currentLine = this.currentAssignedLine();
    if (!currentLine) return [];
    const clientId = currentLine.clientId ?? '';
    const designMap = new Map<string, {
      key: string; styleNo: string; color: string; sleeveType?: string;
      requiredQty: number; pickedQty: number; isCurrentDesign: boolean;
    }>();
    for (const line of this.liveLines()) {
      if ((line.clientId ?? '') !== clientId) continue;
      if (line.status === 'pending_stock' || line.status === 'blocked') continue;
      const key = `${line.styleNo}||${line.color}||${line.sleeveType ?? ''}`;
      const isCurrent = line.styleNo === currentLine.styleNo &&
        line.color === currentLine.color &&
        (line.sleeveType ?? '') === (currentLine.sleeveType ?? '');
      const existing = designMap.get(key);
      if (existing) {
        existing.requiredQty += line.requiredQty;
        existing.pickedQty += line.pickedQty;
        if (isCurrent) existing.isCurrentDesign = true;
      } else {
        designMap.set(key, {
          key, styleNo: line.styleNo, color: line.color, sleeveType: line.sleeveType,
          requiredQty: line.requiredQty, pickedQty: line.pickedQty, isCurrentDesign: isCurrent,
        });
      }
    }
    return [...designMap.values()];
  });

  partyLiveLines = computed(() => {
    return [...this.liveLines()].sort((a, b) => {
      if (!!a.isAdditional !== !!b.isAdditional) return a.isAdditional ? 1 : -1;
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    });
  });

  partyLiveTotals = computed(() => {
    const pickList = this.livePickList();
    return {
      requiredQty: pickList?.totalRequiredQty ?? 0,
      pickedQty: pickList?.totalPickedQty ?? 0,
      additionalPickedQty: pickList?.totalAdditionalPickedQty ?? 0,
    };
  });

  partyWiseTotals = computed(() =>
    this.customerWiseViewLines().map((customer) => ({
      clientId: customer.clientId,
      clientName: customer.clientName,
      isCurrentCustomer: customer.isCurrentCustomer,
      totalRequired: customer.designs.reduce((s, d) => s + d.requiredQty, 0),
      totalPicked: customer.designs.reduce((s, d) => s + d.pickedQty, 0),
    }))
  );

  customerWiseViewLines = computed(() => {
    const currentLine = this.currentAssignedLine();
    const customerMap = new Map<string, {
      clientId: string; clientName: string; isCurrentCustomer: boolean;
      designs: Map<string, {
        key: string; styleNo: string; color: string; sleeveType?: string;
        isCurrentDesign: boolean; allCompleted: boolean; anyActive: boolean;
        requiredQty: number; pickedQty: number; remainingQty: number;
        lines: PickListLine[];
      }>;
    }>();
    for (const line of this.liveLines()) {
      const clientKey = line.clientId || line.clientName || '';
      const isCurrentCustomer = currentLine ? (line.clientId ?? '') === (currentLine.clientId ?? '') : false;
      const designKey = `${line.styleNo}||${line.color}||${line.sleeveType ?? ''}`;
      const isCurrentDesign = currentLine && isCurrentCustomer
        ? line.styleNo === currentLine.styleNo && line.color === currentLine.color &&
          (line.sleeveType ?? '') === (currentLine.sleeveType ?? '')
        : false;
      if (!customerMap.has(clientKey)) {
        customerMap.set(clientKey, {
          clientId: line.clientId ?? '', clientName: line.clientName ?? '',
          isCurrentCustomer, designs: new Map(),
        });
      }
      const customer = customerMap.get(clientKey)!;
      if (isCurrentCustomer) customer.isCurrentCustomer = true;
      if (!customer.designs.has(designKey)) {
        customer.designs.set(designKey, {
          key: designKey, styleNo: line.styleNo, color: line.color, sleeveType: line.sleeveType,
          isCurrentDesign, allCompleted: true, anyActive: false,
          requiredQty: 0, pickedQty: 0, remainingQty: 0, lines: [],
        });
      }
      const design = customer.designs.get(designKey)!;
      if (isCurrentDesign) design.isCurrentDesign = true;
      design.lines.push(line);
      design.requiredQty += line.requiredQty;
      design.pickedQty += line.pickedQty;
      design.remainingQty += line.remainingQty;
      if (line.status !== 'completed') design.allCompleted = false;
      if (line.status === 'in_progress') design.anyActive = true;
    }
    return [...customerMap.values()].map((c) => ({ ...c, designs: [...c.designs.values()] }));
  });

  ngOnInit() {
    this.isLoading.set(true);
    // Same global "Processing…" overlay Reports uses for exports — this screen's
    // initial fetch (salesOrders/inventory/clients/pickLists, 11k+ inventory rows
    // in production) plus rendering the Sales Orders table can take a visible
    // moment, and this makes that unmistakable rather than looking stuck.
    this.loadingService.start();
    let doneCount = 0;
    const done = () => {
      doneCount += 1;
      if (doneCount === 4) {
        this.isLoading.set(false);
        // Hold the overlay through the paint that follows this data arriving —
        // signals flipping doesn't mean the (potentially large) table has
        // actually rendered/painted yet.
        requestAnimationFrame(() => requestAnimationFrame(() => this.loadingService.stop()));
      }
    };

    this.salesOrderService.getSalesOrders().subscribe({ next: (orders) => { this.salesOrders.set(orders); done(); }, error: done });
    this.inventoryService.getInventory().subscribe({ next: (inventory) => { this.inventory.set(inventory); done(); }, error: done });
    this.clientService.getClients().subscribe({ next: (clients) => { this.clients.set(clients); done(); }, error: done });
    this.pickListService.getPickLists().subscribe({
      next: (pickLists) => {
        this.pickLists.set(pickLists);
        const currentView = this.viewPickList();
        if (currentView?.id) {
          const fresh = pickLists.find((pickList) => pickList.id === currentView.id);
          if (fresh) this.viewPickList.set(fresh);
        }
        const currentLive = this.livePickList();
        if (currentLive?.id) {
          const fresh = pickLists.find((pickList) => pickList.id === currentLive.id);
          if (fresh) this.livePickList.set(fresh);
        }
        done();
      },
      error: done,
    });
  }

  ngOnDestroy() {
    void this.stopLivePicking({ keepMode: true });
  }

  getClientName(id: string): string {
    return this.clients().find((client) => client.id === id)?.clientName ?? '-';
  }

  getOrderTotalQty(order: SalesOrder): number {
    return order.items.reduce((sum, item) => sum + item.itemSizes.reduce((itemSum, size) => itemSum + (Number(size.quantity) || 0), 0), 0);
  }

  getPickedQtyForOrder(orderId: string): number {
    return this.effectivePickedLists().reduce((sum, pickList) => {
      const summary = pickList.orderSummaries?.find((entry) => entry.salesOrderId === orderId);
      if (summary) return sum + summary.pickedQty;
      return sum + (pickList.items ?? []).filter((item) => item.salesOrderId === orderId).reduce((itemSum, item) => itemSum + (item.pickedQty || 0), 0);
    }, 0);
  }

  getOrderPendingQty(orderId: string): number {
    return this.effectivePickedLists().reduce((sum, pickList) => {
      const summary = pickList.orderSummaries?.find((entry) => entry.salesOrderId === orderId);
      if (summary) return sum + summary.pendingQty;
      return sum + (pickList.items ?? []).filter((item) => item.salesOrderId === orderId).reduce((itemSum, item) => itemSum + (item.pendingQty || 0), 0);
    }, 0);
  }

  getPickStatusForOrder(orderId: string): 'not_started' | 'partial' | 'completed' {
    const order = this.salesOrders().find((entry) => entry.id === orderId);
    if (!order) return 'not_started';
    const total = this.getOrderTotalQty(order);
    const picked = this.getPickedQtyForOrder(orderId);
    const pending = this.getOrderPendingQty(orderId);
    const hasPickList = this.visiblePickLists().some((pickList) => pickList.salesOrderIds.includes(orderId));
    if (total > 0 && picked >= total) return 'completed';
    if (hasPickList || picked > 0 || pending > 0) return 'partial';
    return 'not_started';
  }

  getPickListForOrder(orderId: string): PickList | null {
    return this.visiblePickLists().find((pickList) => pickList.salesOrderIds.includes(orderId)) ?? null;
  }

  getOpenPickListForOrder(orderId: string): PickList | null {
    return this.visiblePickLists().find((pickList) =>
      pickList.salesOrderIds.includes(orderId)
      && (pickList.status !== 'Completed' || !!pickList.legacyPickingPending)
    ) ?? null;
  }

  getAvailableQtyForOrder(order: SalesOrder): number {
    let total = 0;
    for (const item of order.items) {
      for (const sizeEntry of item.itemSizes) {
        const orderedQty = Number(sizeEntry.quantity) || 0;
        const size = String(sizeEntry.size);
        const alreadyPickedQty = this.getAlreadyPickedQty(order.id, item.design.styleNo, item.design.color ?? '', size, item.sleeveType);
        const balanceQty = Math.max(0, orderedQty - alreadyPickedQty);
        const inventoryMatch = this.findInventoryMatch(item.design.styleNo, item.design.color ?? '', size, item.sleeveType);
        const stockAvailable = Number(inventoryMatch?.currentStock) || 0;
        total += Math.min(balanceQty, stockAvailable);
      }
    }
    return total;
  }

  getOrderRemainingQty(orderId: string): number {
    const order = this.salesOrders().find((entry) => entry.id === orderId);
    if (!order) return 0;
    return Math.max(0, this.getOrderTotalQty(order) - this.getPickedQtyForOrder(orderId));
  }

  canGenerateOrder(orderId: string): boolean {
    return !this.getOpenPickListForOrder(orderId) && this.getOrderRemainingQty(orderId) > 0;
  }

  hasPickableQty(pickList: PickList | null | undefined): boolean {
    // 'Partial' stays resumable — including after the explicit Party-wise
    // "Complete Pick List" action, and even after Packing Lists have already
    // been generated from it (a Pick List may be packed in several batches
    // over time) — so the user can keep scanning pending Sales Order items
    // and additional items across sessions.
    return !!pickList && (pickList.totalRequiredQty ?? 0) > 0
      && pickList.status !== 'Pending' && pickList.status !== 'Completed';
  }

  canStartPicking(pickList: PickList | null | undefined): boolean {
    if (!pickList) return false;
    if (pickList.legacyPickingPending) return true;
    return this.hasPickableQty(pickList);
  }

  getGenerateActionLabel(orderId: string): string {
    return this.visiblePickLists().some((pickList) => pickList.salesOrderIds.includes(orderId)) ? 'Generate Balance' : 'Generate';
  }

  getPickActionLabel(pickList: PickList | null | undefined): string {
    if (!pickList) return 'Start Picking';
    if (pickList.legacyPickingPending) return 'Start Picking';
    return (pickList.totalPickedQty ?? 0) > 0 ? 'Continue Picking' : 'Start Picking';
  }

  isDisplayablePickList(pickList: PickList | null | undefined): boolean {
    if (!pickList) return false;
    return !!pickList.legacyPickingPending || (pickList.totalRequiredQty ?? 0) > 0 || (pickList.totalPickedQty ?? 0) > 0;
  }

  // Rebuilding a flatMap of every pick list's items on every single call (once
  // per size-entry — tens of thousands across all orders) was the same O(n)
  // hot-path problem as findInventoryMatch(). Indexed once per
  // effectivePickedLists() change instead.
  private alreadyPickedIndex = computed(() => {
    const map = new Map<string, number>();
    for (const pickList of this.effectivePickedLists()) {
      for (const line of pickList.items ?? []) {
        const key = `${line.salesOrderId}||${line.styleNo}||${line.color}||${String(line.size)}||${line.sleeveType ?? ''}`;
        map.set(key, (map.get(key) ?? 0) + (line.pickedQty || 0));
      }
    }
    return map;
  });

  getAlreadyPickedQty(orderId: string, styleNo: string, color: string, size: string, sleeveType?: string): number {
    const key = `${orderId}||${styleNo}||${color}||${String(size)}||${sleeveType ?? ''}`;
    return this.alreadyPickedIndex().get(key) ?? 0;
  }

  formatDate(raw: any): string {
    if (!raw) return '-';
    try {
      const date = raw?.toDate ? raw.toDate() : new Date(raw);
      return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
      return '-';
    }
  }

  plTypeBadge(type: PickListType): string {
    return ({ direct: 'bg-indigo-100 text-indigo-800', combined: 'bg-purple-100 text-purple-800', itemwise: 'bg-teal-100 text-teal-800', party: 'bg-pink-100 text-pink-800' } as Record<PickListType, string>)[type];
  }

  plTypeLabel(type: PickListType): string {
    return ({ direct: 'Direct', combined: 'Combined', itemwise: 'Item-wise', party: 'Party-wise' } as Record<PickListType, string>)[type];
  }

  orderPickBadge(orderId: string): string {
    const status = this.getPickStatusForOrder(orderId);
    return status === 'completed' ? 'bg-green-100 text-green-800' : status === 'partial' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-600';
  }

  orderPickLabel(orderId: string): string {
    const status = this.getPickStatusForOrder(orderId);
    return status === 'completed' ? 'Picked' : status === 'partial' ? 'Partial' : 'Not Started';
  }

  liveLineStatusBadge(line: PickListLine): string {
    return ({ ready: 'bg-green-100 text-green-800', in_progress: 'bg-blue-100 text-blue-800', completed: 'bg-emerald-100 text-emerald-800', pending_stock: 'bg-orange-100 text-orange-700', blocked: 'bg-red-100 text-red-700' } as Record<PickListLine['status'], string>)[line.status];
  }

  liveLineStatusLabel(line: PickListLine): string {
    return ({ ready: 'Ready', in_progress: 'In Progress', completed: 'Completed', pending_stock: 'Pending Stock', blocked: 'Blocked' } as Record<PickListLine['status'], string>)[line.status];
  }

  startNewPickList() {
    this.resetBuilderState();
    this.mode.set('select-type');
  }

  selectType(type: PickListType) {
    this.pickType.set(type);
    this.mode.set(type === 'party' ? 'select-party' : 'select-orders');
  }

  selectParty(clientId: string) {
    this.selectedPartyId.set(clientId);
    this.selectedOrderIds.set(new Set());
    this.mode.set('select-orders');
  }

  isPartySelected(clientId: string): boolean {
    return this.selectedPartyId() === clientId;
  }

  async cancel() {
    if (this.mode() === 'live-pick') {
      await this.stopLivePicking();
    }
    this.mode.set('list');
    this.resetBuilderState();
    this.viewPickList.set(null);
    this.viewLines.set([]);
    this.editPickList.set(null);
    this.editableLines.set([]);
    this.addOrderSearchTerm.set('');
  }

  toggleOrderSelection(orderId: string) {
    if (!this.canGenerateOrder(orderId)) return;
    this.selectedOrderIds.update((selected) => {
      const next = new Set(selected);
      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        if (this.pickType() === 'direct') next.clear();
        next.add(orderId);
      }
      return next;
    });
  }

  isOrderSelected(orderId: string): boolean {
    return this.selectedOrderIds().has(orderId);
  }

  async openDirectGenerate(order: SalesOrder) {
    this.pickType.set('direct');
    this.selectedOrderIds.set(new Set([order.id]));
    await this.proceedFromOrderSelection();
  }

  async proceedFromOrderSelection() {
    const orders = this.selectedOrders();
    if (!orders.length) return;

    const blockedOrders = orders.filter((order) => this.getOpenPickListForOrder(order.id));
    if (blockedOrders.length > 0) {
      await Swal.fire({
        icon: 'warning',
        title: 'Open Pick List Exists',
        html: `<p>The selected order(s) already have an active Pick List.</p><p class="mt-2 text-sm text-gray-500">${blockedOrders.map((order) => order.salesNo).join(', ')}</p>`,
      });
      return;
    }

    this.buildDraftLines(orders);
    this.mode.set(this.pickType() === 'itemwise' ? 'select-items' : 'preview');
  }

  toggleItemSelection(groupKey: string) {
    this.draftLines.update((lines) => lines.map((line) => {
      const lineKey = `${line.styleNo}||${line.color}||${line.size}||${line.sleeveType ?? ''}`;
      return lineKey === groupKey ? { ...line, selected: !line.selected } : line;
    }));
  }

  selectAllItems() {
    this.draftLines.update((lines) => lines.map((line) => ({ ...line, selected: true })));
  }

  clearItemSelection() {
    this.draftLines.update((lines) => lines.map((line) => ({ ...line, selected: false })));
  }

  proceedFromItemSelection() {
    if (!this.draftLines().some((line) => line.selected)) {
      Swal.fire({ icon: 'warning', title: 'No Items Selected', text: 'Select at least one item to continue.' });
      return;
    }
    this.mode.set('preview');
  }

  async generatePickList() {
    const orders = this.selectedOrders();
    const selectedLines = this.draftLines().filter((line) => this.pickType() !== 'itemwise' || line.selected);
    if (!orders.length || !selectedLines.length) {
      await Swal.fire({ icon: 'warning', title: 'Nothing To Generate', text: 'There are no lines to generate.' });
      return;
    }

    const scannableLines = selectedLines.filter((line) => line.requiredQty > 0 && !!line.inventoryId && !!line.barcode);
    const skippedLines = selectedLines.filter((line) => !scannableLines.includes(line));
    if (!scannableLines.length) {
      await Swal.fire({
        icon: 'warning',
        title: 'No Scannable Items',
        text: 'Pick List was not created because all selected items are out of stock or missing a barcode.',
      });
      return;
    }

    const type = this.pickType();
    const includedOrderIds = [...new Set(scannableLines.map((line) => line.salesOrderId))];
    const includedOrders = orders.filter((order) => includedOrderIds.includes(order.id));
    const includedSalesNos = [...new Set(scannableLines.map((line) => line.salesNo))];
    const primaryOrder = includedOrders[0];
    const clientIds = [...new Set(includedOrders.map((order) => order.clientId))];
    const clientId = type === 'direct' ? primaryOrder.clientId : clientIds.length === 1 ? clientIds[0] : 'multi';
    const clientName = type === 'direct'
      ? this.getClientName(primaryOrder.clientId)
      : clientIds.length === 1
        ? this.getClientName(clientIds[0])
        : 'Multiple Clients';

    const liveLines: PickListLine[] = scannableLines.map((line, index) => ({
      lineId: line.lineId,
      salesOrderId: line.salesOrderId,
      salesNo: line.salesNo,
      clientId: line.clientId,
      clientName: line.clientName,
      designId: line.designId,
      styleNo: line.styleNo,
      color: line.color,
      group: line.group,
      size: String(line.size),
      sleeveType: line.sleeveType,
      barcode: line.barcode,
      inventoryId: line.inventoryId,
      orderedQty: line.orderedQty,
      requiredQty: line.requiredQty,
      pickedQty: 0,
      remainingQty: line.requiredQty,
      balanceQty: line.requiredQty + line.pendingQty,
      pendingQty: line.pendingQty,
      status: line.requiredQty > 0 ? 'ready' : line.inventoryId ? 'pending_stock' : 'blocked',
      sortOrder: index,
    }));

    // Sort all types: customer → styleNo → color → sleeveType → size
    const rankSize = (s: string) => { const i = SIZE_ORDER.indexOf(s); return i === -1 ? 999 : i; };
    liveLines.sort((a, b) => {
      const clientCmp = (a.clientName ?? '').localeCompare(b.clientName ?? '');
      if (clientCmp !== 0) return clientCmp;
      const styleCmp = a.styleNo.localeCompare(b.styleNo);
      if (styleCmp !== 0) return styleCmp;
      const colorCmp = a.color.localeCompare(b.color);
      if (colorCmp !== 0) return colorCmp;
      const sleeveCmp = (a.sleeveType ?? '').localeCompare(b.sleeveType ?? '');
      if (sleeveCmp !== 0) return sleeveCmp;
      return rankSize(a.size) - rankSize(b.size);
    });
    liveLines.forEach((line, idx) => { line.sortOrder = idx; });

    const requiredQty = scannableLines.reduce((sum, line) => sum + line.requiredQty, 0);
    const result = await Swal.fire({
      title: 'Generate Pick List?',
      html: `<div style="text-align:left;font-size:13px"><p><strong>Type:</strong> ${this.plTypeLabel(type)}</p><p><strong>Orders:</strong> ${includedSalesNos.join(', ')}</p><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px"><div style="background:#eef2ff;border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:#4338ca;font-weight:700;text-transform:uppercase">Ready To Pick</div><div style="font-size:24px;font-weight:700;color:#4338ca">${requiredQty}</div></div><div style="background:#ffedd5;border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:#c2410c;font-weight:700;text-transform:uppercase">Skipped Lines</div><div style="font-size:24px;font-weight:700;color:#ea580c">${skippedLines.length}</div></div><div style="background:#ecfdf5;border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:#047857;font-weight:700;text-transform:uppercase">Scannable Lines</div><div style="font-size:24px;font-weight:700;color:#047857">${scannableLines.length}</div></div></div><p style="margin-top:10px;color:#64748b">${skippedLines.length > 0 ? 'Out-of-stock or barcode-missing items will not be generated.' : 'All selected items are ready for scanning.'}</p></div>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Generate',
      confirmButtonColor: '#4f46e5',
    });

    if (!result.isConfirmed) return;

    this.isSaving.set(true);
    try {
      const pickListId = await this.pickListService.createGeneratedPickList({
        pickListNo: `PL-${Date.now()}`,
        type,
        salesOrderIds: includedOrders.map((order) => order.id),
        salesNos: includedSalesNos,
        clientId,
        clientName,
        lines: liveLines,
      });

      this.listTab.set('picklists');
      this.resetBuilderState();

      const createdPickList = await this.pickListService.getPickListByIdOnce(pickListId);
      if (!createdPickList) {
        this.mode.set('list');
        await Swal.fire({
          icon: 'success',
          title: 'Pick List Generated',
          text: 'The new Pick List was saved successfully.',
          timer: 2200,
          showConfirmButton: false,
        });
        return;
      }

      if (!this.hasPickableQty(createdPickList)) {
        await Swal.fire({
          icon: 'success',
          title: 'Pick List Generated',
          text: 'This Pick List has only pending or blocked lines right now.',
          timer: 2400,
          showConfirmButton: false,
        });
        await this.openView(createdPickList);
        return;
      }

      const nextStep = await Swal.fire({
        icon: 'success',
        title: 'Pick List Generated',
        text: skippedLines.length > 0
          ? `You can start scanning now. ${skippedLines.length} unavailable line(s) were skipped.`
          : 'You can start scanning now or review the Pick List first.',
        showCancelButton: true,
        confirmButtonText: 'Start Picking Now',
        cancelButtonText: 'Review Pick List',
        confirmButtonColor: '#16a34a',
        cancelButtonColor: '#64748b',
      });

      if (nextStep.isConfirmed) {
        await this.startPicking(createdPickList);
        return;
      }

      await this.openView(createdPickList);
    } catch (error: any) {
      const message = error?.message === 'no_scannable_lines'
        ? 'Pick List was not created because no stock-backed barcode items were available.'
        : error?.message ?? 'Unable to generate Pick List.';
      await Swal.fire({ icon: 'error', title: 'Generation Failed', text: message });
    } finally {
      this.isSaving.set(false);
    }
  }

  async openView(pickList: PickList) {
    if (pickList.id) {
      await this.pickListService.ensureLegacyPickListLines(pickList);
      const [freshPickList, lines] = await Promise.all([
        this.pickListService.getPickListByIdOnce(pickList.id),
        this.pickListService.getPickListLinesOnce(pickList.id),
      ]);
      this.viewPickList.set(freshPickList ?? pickList);
      this.viewLines.set(lines);
    } else {
      this.viewPickList.set(pickList);
      this.viewLines.set([]);
    }
    this.mode.set('view');
  }

  // Backend-enforced too (PickListService.assertPickListEditable) — this is
  // only the button-visibility hint, not the real guard. Reads a field
  // already present on the loaded PickList (no extra query needed):
  // totalPackedIntoPackingListsQty means exactly "how much of this list has
  // actually been carried into a Packing List".
  canEditOrDeletePickList(pickList: PickList | null | undefined): boolean {
    return !!pickList?.id && (pickList.totalPackedIntoPackingListsQty ?? 0) <= 0;
  }

  editLinesByOrder = computed(() => {
    const groups = new Map<string, { salesOrderId: string; salesNo: string; lines: PickListLine[] }>();
    for (const line of this.editableLines()) {
      if (line.isAdditional) continue;
      const existing = groups.get(line.salesOrderId);
      if (existing) existing.lines.push(line);
      else groups.set(line.salesOrderId, { salesOrderId: line.salesOrderId, salesNo: line.salesNo, lines: [line] });
    }
    return [...groups.values()];
  });

  editAdditionalLines = computed(() => this.editableLines().filter((line) => line.isAdditional));

  editEligibleOrders = computed(() => {
    const pl = this.editPickList();
    if (!pl || (pl.type !== 'party' && pl.type !== 'combined')) return [];
    const includedIds = new Set(this.editableLines().map((line) => line.salesOrderId));
    const term = this.addOrderSearchTerm().toLowerCase();
    return this.salesOrders().filter((order) =>
      order.clientId === pl.clientId
      && !includedIds.has(order.id)
      && !this.getOpenPickListForOrder(order.id)
      && (!term || order.salesNo.toLowerCase().includes(term))
    );
  });

  async openEdit(pickList: PickList) {
    if (!pickList.id) return;
    const [fresh, lines] = await Promise.all([
      this.pickListService.getPickListByIdOnce(pickList.id),
      this.pickListService.getPickListLinesOnce(pickList.id),
    ]);
    if (!fresh || !this.canEditOrDeletePickList(fresh)) {
      await Swal.fire({ icon: 'warning', title: 'Cannot Edit', text: 'Packing has already started for this Pick List — it can no longer be edited.' });
      await this.refreshPickLists();
      return;
    }
    this.editPickList.set(fresh);
    this.editableLines.set(lines);
    this.addOrderSearchTerm.set('');
    this.mode.set('edit');
  }

  updateEditRequiredQty(lineId: string, value: string | number) {
    const qty = Math.max(0, Math.floor(Number(value) || 0));
    this.editableLines.update((lines) => lines.map((line) => line.lineId === lineId ? { ...line, requiredQty: qty } : line));
  }

  updateEditAdditionalQty(lineId: string, value: string | number) {
    const qty = Math.max(0, Math.floor(Number(value) || 0));
    this.editableLines.update((lines) => lines.map((line) => line.lineId === lineId ? { ...line, pickedQty: qty } : line));
  }

  removeEditLine(lineId: string) {
    this.editableLines.update((lines) => lines.filter((line) => line.lineId !== lineId));
  }

  removeEditOrder(salesOrderId: string) {
    this.editableLines.update((lines) => lines.filter((line) => line.salesOrderId !== salesOrderId));
  }

  addOrderToEdit(order: SalesOrder) {
    const existing = this.editableLines();
    const startSort = existing.length ? Math.max(...existing.map((line) => line.sortOrder ?? 0)) + 1 : 0;
    const computedLines = this.computeOrderLines(order, startSort)
      .filter((line) => line.requiredQty > 0 && !!line.inventoryId && !!line.barcode);

    if (!computedLines.length) {
      Swal.fire({ icon: 'info', title: 'Nothing To Add', text: 'This order has no in-stock, barcoded items to add.' });
      return;
    }

    const newLines: PickListLine[] = computedLines.map((line, index) => ({
      lineId: line.lineId,
      salesOrderId: line.salesOrderId,
      salesNo: line.salesNo,
      clientId: line.clientId,
      clientName: line.clientName,
      designId: line.designId,
      styleNo: line.styleNo,
      color: line.color,
      group: line.group,
      size: String(line.size),
      sleeveType: line.sleeveType,
      barcode: line.barcode,
      inventoryId: line.inventoryId,
      orderedQty: line.orderedQty,
      requiredQty: line.requiredQty,
      pickedQty: 0,
      remainingQty: line.requiredQty,
      balanceQty: line.requiredQty + line.pendingQty,
      pendingQty: line.pendingQty,
      status: 'ready',
      sortOrder: startSort + index,
    }));

    this.editableLines.update((lines) => [...lines, ...newLines]);
    this.addOrderSearchTerm.set('');
  }

  async saveEdit() {
    const pickList = this.editPickList();
    if (!pickList?.id || this.isSaving()) return;

    const result = await Swal.fire({
      title: 'Save Changes?',
      text: 'This updates the Pick List and restores inventory for any reduced or removed quantity.',
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Save',
      confirmButtonColor: '#4f46e5',
    });
    if (!result.isConfirmed) return;

    this.isSaving.set(true);
    try {
      await this.pickListService.updatePickList(pickList.id, { lines: this.editableLines() });
      await this.refreshPickLists();
      await Swal.fire({ icon: 'success', title: 'Pick List Updated', timer: 1800, showConfirmButton: false });
      const updated = await this.pickListService.getPickListByIdOnce(pickList.id);
      if (updated) await this.openView(updated); else await this.cancel();
    } catch (error: any) {
      const message = error?.message === 'picklist_packing_started'
        ? 'Packing has already started for this Pick List — it can no longer be edited.'
        : error?.message ?? 'Unable to update Pick List.';
      await Swal.fire({ icon: 'error', title: 'Update Failed', text: message });
      await this.refreshPickLists();
    } finally {
      this.isSaving.set(false);
    }
  }

  async deletePickList(pickList: PickList) {
    if (!pickList.id) return;
    const result = await Swal.fire({
      title: 'Are you sure?',
      text: 'Are you sure you want to delete this Pick List?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      cancelButtonColor: '#6b7280',
      confirmButtonText: 'Yes, delete it',
      cancelButtonText: 'Cancel',
    });
    if (!result.isConfirmed) return;

    try {
      Swal.fire({ title: 'Deleting...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      await this.pickListService.deletePickList(pickList.id);
      await this.refreshPickLists();
      if (this.viewPickList()?.id === pickList.id || this.editPickList()?.id === pickList.id) {
        await this.cancel();
      }
      await Swal.fire({ icon: 'success', title: 'Deleted!', text: 'Pick List deleted successfully.', timer: 2000, showConfirmButton: false });
    } catch (error: any) {
      const message = error?.message === 'picklist_packing_started'
        ? 'Packing has already started for this Pick List — it can no longer be deleted.'
        : 'Failed to delete Pick List.';
      await Swal.fire({ icon: 'error', title: 'Error', text: message });
      await this.refreshPickLists();
    }
  }

  private async refreshPickLists(): Promise<void> {
    const lists = await firstValueFrom(this.pickListService.getPickLists());
    this.pickLists.set(lists);
  }

  private buildDraftLines(orders: SalesOrder[]) {
    const lines: PickListLineItem[] = [];
    let sortOrder = 0;
    for (const order of orders) {
      const orderLines = this.computeOrderLines(order, sortOrder);
      lines.push(...orderLines);
      sortOrder += orderLines.length;
    }
    this.draftLines.set(lines);
  }

  // Pure per-order line computation, shared by the "New Pick List" wizard
  // (buildDraftLines) and the Edit screen's "Add Sales Order" action — so
  // balance/inventory-matching logic never diverges between create and edit.
  private computeOrderLines(order: SalesOrder, sortOrderStart: number): PickListLineItem[] {
    const lines: PickListLineItem[] = [];
    let sortOrder = sortOrderStart;

    for (const item of order.items) {
      for (const sizeEntry of item.itemSizes) {
        const orderedQty = Number(sizeEntry.quantity) || 0;
        const size = String(sizeEntry.size);
        const alreadyPickedQty = this.getAlreadyPickedQty(order.id, item.design.styleNo, item.design.color ?? '', size, item.sleeveType);
        const balanceQty = Math.max(0, orderedQty - alreadyPickedQty);
        if (balanceQty <= 0) continue;

        const inventoryMatch = this.findInventoryMatch(item.design.styleNo, item.design.color ?? '', size, item.sleeveType);
        const stockAvailable = Number(inventoryMatch?.currentStock) || 0;
        const requiredQty = Math.min(balanceQty, stockAvailable);
        const pendingQty = Math.max(0, balanceQty - requiredQty);

        lines.push({
          lineId: this.buildLineId(order.id, item.design.styleNo, size, sortOrder),
          salesOrderId: order.id,
          salesNo: order.salesNo,
          clientId: order.clientId,
          clientName: this.getClientName(order.clientId),
          designId: item.design.id ?? '',
          styleNo: item.design.styleNo,
          color: item.design.color ?? '',
          group: item.design.group ?? '',
          size,
          sleeveType: item.sleeveType,
          orderedQty,
          alreadyPickedQty,
          balanceQty,
          stockAvailable,
          requiredQty,
          pendingQty,
          barcode: inventoryMatch?.barcode,
          inventoryId: inventoryMatch?.id,
          selected: requiredQty > 0,
          status: requiredQty > 0 ? 'ready' : inventoryMatch?.id ? 'pending_stock' : 'blocked',
        });

        sortOrder += 1;
      }
    }

    return lines;
  }

  private findInventoryMatch(styleNo: string, color: string, size: string, sleeveType?: string): InventoryItem | undefined {
    const candidates = this.inventoryIndex().get(`${styleNo}||${color}||${String(size)}`);
    if (!candidates?.length) return undefined;
    return candidates.find((item) => (item.sleeveType ?? '') === (sleeveType ?? ''))
      ?? candidates.find((item) => !item.sleeveType || !sleeveType);
  }

  private buildLineId(orderId: string, styleNo: string, size: string, index: number): string {
    return `${orderId}-${styleNo}-${size}-${index + 1}`.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  }

  async startPicking(pickList: PickList) {
    const user = this.asClaimUser();
    if (!user) {
      await Swal.fire({ icon: 'error', title: 'Login Required', text: 'Please log in again before picking.' });
      return;
    }
    if (!pickList.id) return;

    await this.stopLivePicking({ keepMode: true });
    if (pickList.legacyPickingPending) {
      const confirmResume = await Swal.fire({
        icon: 'question',
        title: 'Enable Scan Picking?',
        text: 'This Pick List looks like an older completed record. The scan flow will be reopened without deducting stock again.',
        showCancelButton: true,
        confirmButtonText: 'Enable Scan Picking',
        confirmButtonColor: '#16a34a',
      });
      if (!confirmResume.isConfirmed) return;
      await this.pickListService.prepareLegacyPickListForPicking(pickList.id);
    } else {
      await this.pickListService.ensureLegacyPickListLines(pickList);
    }

    const freshPickList = await this.pickListService.getPickListByIdOnce(pickList.id);
    if (!freshPickList) {
      await Swal.fire({ icon: 'error', title: 'Not Found', text: 'The selected Pick List could not be loaded.' });
      return;
    }
    if ((freshPickList.totalRequiredQty ?? 0) <= 0) {
      await Swal.fire({ icon: 'info', title: 'No Pickable Items', text: 'This Pick List has only pending or blocked lines right now.' });
      await this.openView(freshPickList);
      return;
    }

    this.mode.set('live-pick');
    this.livePickList.set(freshPickList);
    this.liveLines.set([]);
    this.currentLineId.set(null);
    this.manualScanValue.set('');
    this.scanFeedback.set('idle');
    this.scannerMessage.set('Scan the assigned item');
    this.completionHandled = false;

    this.liveSubscriptions.push(
      this.pickListService.getPickListById(pickList.id).subscribe((nextPickList) => {
        if (!nextPickList) return;
        const previousStatus = this.livePickList()?.status;
        this.livePickList.set(nextPickList);
        if (!this.completionHandled && previousStatus !== 'Completed' && nextPickList.status === 'Completed') {
          this.completionHandled = true;
          void this.handleRemoteCompletion();
        }
      })
    );

    this.liveSubscriptions.push(
      this.pickListService.getPickListLines(pickList.id).subscribe((lines) => {
        this.liveLines.set(lines);
        const currentLine = this.currentAssignedLine();
        if (currentLine) this.currentLineId.set(currentLine.lineId);
      })
    );

    if (freshPickList.type === 'party') {
      // Party-wise picking has no claim/next-line assignment — any barcode
      // may be scanned in any order, so there's nothing to claim on start.
      this.scannerMessage.set('Scan any item');
      this.focusScanInput();
      return;
    }

    this.claimHeartbeat = setInterval(() => {
      const assignedLine = this.currentAssignedLine();
      const livePickList = this.livePickList();
      const currentUser = this.asClaimUser();
      if (!assignedLine || !livePickList?.id || !currentUser) return;
      void this.pickListService.refreshClaim(livePickList.id, assignedLine.lineId, currentUser).catch(() => undefined);
    }, 45000);

    let claimedLine = await this.claimNextAvailableLine();
    if (!claimedLine) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      claimedLine = await this.claimNextAvailableLine();
    }
    if (!claimedLine) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      claimedLine = await this.claimNextAvailableLine();
    }
    if (!claimedLine) this.scannerMessage.set('Waiting for an available item');
    this.focusScanInput();
  }

  async retryClaimNextItem() {
    if (this.isClaimingItem() || this.isSubmittingScan()) return;
    this.isClaimingItem.set(true);
    try {
      const claimedLine = await this.claimNextAvailableLine();
      if (!claimedLine) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const retry = await this.claimNextAvailableLine();
        if (!retry) {
          this.scannerMessage.set('Waiting for an available item');
          await this.showToast('info', 'No items available', 'All lines may be claimed by other users or completed.');
        }
      }
    } finally {
      this.isClaimingItem.set(false);
    }
  }

  async submitCurrentInput() {
    await this.submitBarcode(this.manualScanValue().trim());
  }

  onManualScanChange(value: string) {
    this.manualScanValue.set(value);
  }

  async toggleCamera() {
    if (this.isCameraOpen()) {
      this.stopCameraScanner();
      return;
    }
    await this.startCameraScanner();
  }

  private async claimNextAvailableLine(preferredLineId?: string) {
    const pickListId = this.livePickList()?.id;
    const user = this.asClaimUser();
    if (!pickListId || !user) return null;

    try {
      const claimedLine = await this.pickListService.claimNextLine(pickListId, user, preferredLineId);
      if (claimedLine) {
        this.currentLineId.set(claimedLine.lineId);
        this.scannerMessage.set('Scan the assigned item');
      } else {
        this.currentLineId.set(null);
      }
      this.focusScanInput();
      return claimedLine;
    } catch (err: any) {
      this.currentLineId.set(null);
      return null;
    }
  }

  private async submitBarcode(rawBarcode: string) {
    if (this.livePickList()?.type === 'party') {
      await this.submitPartyScan(rawBarcode);
      return;
    }
    await this.submitScan(rawBarcode);
  }

  private async submitPartyScan(rawBarcode: string) {
    const barcode = rawBarcode.trim();
    if (!barcode || this.isSubmittingScan()) return;

    const pickList = this.livePickList();
    const user = this.asClaimUser();
    if (!pickList?.id || !user) return;

    this.isSubmittingScan.set(true);

    try {
      const result = await this.pickListService.processPartyScan(pickList.id, barcode, user);
      this.manualScanValue.set('');
      this.lastCameraBarcodeAt = Date.now();
      const label = result.line.isAdditional
        ? `Extra item · ${result.line.styleNo} ${result.line.size} · ${result.line.pickedQty} scanned`
        : `${result.line.styleNo} ${result.line.size} · ${result.line.pickedQty}/${result.line.requiredQty}`;
      this.flashScanFeedback('success', label);
    } catch (error: any) {
      const code = error?.message ?? '';
      const { title, text } = code === 'barcode_not_found'
        ? { title: 'Barcode not found', text: 'This barcode has no matching inventory item, so it cannot be added.' }
        : this.mapScanError(code);
      this.flashScanFeedback('error', text ?? title);
      await this.showToast('error', title, text);
    } finally {
      this.isSubmittingScan.set(false);
      this.focusScanInput();
    }
  }

  async completePartyPickList() {
    const pickList = this.livePickList();
    const user = this.asClaimUser();
    if (!pickList?.id || !user) return;

    const totalPicked = (pickList.totalPickedQty || 0) + (pickList.totalAdditionalPickedQty || 0);
    if (totalPicked <= 0) {
      await Swal.fire({ icon: 'warning', title: 'Nothing Picked Yet', text: 'Scan at least one item before completing this Pick List.' });
      return;
    }

    const pending = Math.max(0, (pickList.totalRequiredQty || 0) - (pickList.totalPickedQty || 0));
    const confirmResult = await Swal.fire({
      icon: pending > 0 ? 'warning' : 'question',
      title: 'Complete Pick List?',
      html: pending > 0
        ? `<p>${pending} requested unit(s) are still not picked.</p><p class="mt-2 text-sm text-gray-500">This sends the currently picked quantity to Packing as Partial. You can still come back later to pick the remaining items.</p>`
        : '<p>All requested items are picked. This sends the Pick List to Packing.</p>',
      showCancelButton: true,
      confirmButtonText: 'Complete Pick List',
      confirmButtonColor: '#16a34a',
    });
    if (!confirmResult.isConfirmed) return;

    this.isSaving.set(true);
    try {
      await this.pickListService.finalizePickList(pickList.id, user);
      this.completionHandled = true;
      await this.stopLivePicking({ keepMode: true, releaseClaim: false });
      const freshPickList = await this.pickListService.getPickListByIdOnce(pickList.id);
      await this.showToast('success', freshPickList?.status === 'Partial' ? 'Pick List Completed as Partial' : 'Pick List Completed');
      if (freshPickList) {
        await this.openView(freshPickList);
      } else {
        this.mode.set('list');
      }
    } catch (error: any) {
      await Swal.fire({ icon: 'error', title: 'Could Not Complete', text: error?.message ?? 'Unable to complete this Pick List.' });
    } finally {
      this.isSaving.set(false);
    }
  }

  private async submitScan(rawBarcode: string) {
    const barcode = rawBarcode.trim();
    if (!barcode || this.isSubmittingScan()) return;

    const pickList = this.livePickList();
    const currentLine = this.currentAssignedLine();
    const user = this.asClaimUser();
    if (!pickList?.id || !user) return;
    if (!currentLine) {
      await this.showToast('info', 'No item assigned', 'Wait for an available line or claim the next item.');
      return;
    }

    this.isSubmittingScan.set(true);

    try {
      const result = await this.pickListService.processScan(pickList.id, barcode, user, currentLine.lineId);
      this.manualScanValue.set('');
      this.lastCameraBarcodeAt = Date.now();
      this.flashScanFeedback('success', `${result.line.styleNo} ${result.line.size} · ${result.line.pickedQty}/${result.line.requiredQty}`);

      if (result.orderCompleted) {
        void this.pickListService.syncSalesOrderShipment(pickList.id, result.salesOrderId);
      }

      if (result.pickListCompleted) {
        this.completionHandled = true;
        await this.showToast('success', 'Pick List Completed');
        await this.stopLivePicking({ keepMode: true, releaseClaim: false });
        const freshPickList = await this.pickListService.getPickListByIdOnce(pickList.id);
        if (freshPickList) {
          await this.openView(freshPickList);
        } else {
          this.mode.set('list');
        }
        return;
      }

      if (result.lineCompleted) {
        await this.showToast('success', 'Quantity Completed');
        const nextLine = await this.claimNextAvailableLine();
        this.currentLineId.set(nextLine?.lineId ?? null);
        this.scannerMessage.set(nextLine ? 'Scan the assigned item' : 'Waiting for an available item');
      } else {
        this.currentLineId.set(result.line.lineId);
        this.scannerMessage.set('Scan the assigned item');
      }
    } catch (error: any) {
      const { title, text } = this.mapScanError(error?.message ?? '');
      this.flashScanFeedback('error', text ?? title);
      await this.showToast('error', title, text);
    } finally {
      this.isSubmittingScan.set(false);
      this.focusScanInput();
    }
  }

  private async handleRemoteCompletion() {
    await this.showToast('success', 'Pick List Completed');
    await this.stopLivePicking({ keepMode: true, releaseClaim: false });
    const pickList = this.livePickList();
    if (pickList) {
      await this.openView(pickList);
    } else {
      this.mode.set('list');
    }
  }

  private async stopLivePicking(options?: { keepMode?: boolean; releaseClaim?: boolean }) {
    const keepMode = options?.keepMode ?? false;
    const shouldReleaseClaim = options?.releaseClaim ?? true;

    if (this.claimHeartbeat) {
      clearInterval(this.claimHeartbeat);
      this.claimHeartbeat = null;
    }

    if (shouldReleaseClaim) {
      const pickListId = this.livePickList()?.id;
      const currentLine = this.currentAssignedLine();
      const user = this.asClaimUser();
      if (pickListId && currentLine && user) {
        await this.pickListService.releaseClaim(pickListId, currentLine.lineId, user).catch(() => undefined);
      }
    }

    this.liveSubscriptions.forEach((subscription) => subscription.unsubscribe());
    this.liveSubscriptions = [];
    this.stopCameraScanner();

    this.currentLineId.set(null);
    this.liveLines.set([]);
    this.livePickList.set(null);
    this.manualScanValue.set('');
    this.scanFeedback.set('idle');
    this.scannerMessage.set('Scan the assigned item');
    this.isSubmittingScan.set(false);
    this.completionHandled = false;

    if (!keepMode) this.mode.set('list');
  }

  private focusScanInput() {
    setTimeout(() => this.scanInputElement?.nativeElement.focus(), 60);
  }

  private async startCameraScanner() {
    if (this.isCameraOpen()) return;
    this.isCameraOpen.set(true);
    this.scannerMessage.set('Point camera at the assigned item');

    setTimeout(async () => {
      if (!this.cameraVideoElement || !navigator.mediaDevices?.getUserMedia) {
        this.isCameraOpen.set(false);
        await this.showToast('error', 'Camera Error', 'Camera is not supported on this device.');
        return;
      }

      try {
        this.barcodeDetector = this.barcodeDetector || await this.createBarcodeDetector();
        this.cameraCanvas = document.createElement('canvas');
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        const video = this.cameraVideoElement!.nativeElement;
        video.srcObject = this.cameraStream;
        await video.play();
        this.cameraLoop();
      } catch {
        this.stopCameraScanner();
        await this.showToast('error', 'Camera Error', 'Could not access the camera.');
      }
    }, 50);
  }

  private stopCameraScanner() {
    if (this.cameraAnimationFrame) {
      cancelAnimationFrame(this.cameraAnimationFrame);
      this.cameraAnimationFrame = null;
    }
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    this.cameraStream = null;
    this.cameraCanvas = null;
    this.cameraLoopBusy = false;
    this.isCameraOpen.set(false);
  }

  private cameraLoop() {
    if (!this.isCameraOpen()) return;
    this.cameraAnimationFrame = requestAnimationFrame(() => this.cameraLoop());
    if (this.cameraLoopBusy || this.isSubmittingScan()) return;

    const video = this.cameraVideoElement?.nativeElement;
    if (!video || video.readyState < video.HAVE_ENOUGH_DATA || !video.videoWidth || !video.videoHeight) return;

    this.cameraLoopBusy = true;
    void this.detectCameraBarcode(video)
      .then((barcode) => {
        if (!barcode) return;
        const now = Date.now();
        if (barcode === this.lastCameraBarcode && now - this.lastCameraBarcodeAt < 3000) return;
        this.lastCameraBarcode = barcode;
        this.lastCameraBarcodeAt = now;
        void this.submitBarcode(barcode);
      })
      .finally(() => {
        this.cameraLoopBusy = false;
      });
  }

  private async detectCameraBarcode(video: HTMLVideoElement): Promise<string | null> {
    if (this.barcodeDetector) {
      try {
        const codes = await this.barcodeDetector.detect(video);
        if (codes?.length) return codes[0].rawValue ?? null;
      } catch {
        // fallback to jsQR below
      }
    }

    if (!this.cameraCanvas) return null;
    const size = 640;
    this.cameraCanvas.width = size;
    this.cameraCanvas.height = size;
    const context = this.cameraCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    // Try full frame first — better for distant/wide barcodes
    context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, size, size);
    let imageData = context.getImageData(0, 0, size, size);
    let result = jsQR(imageData.data, size, size, { inversionAttempts: 'attemptBoth' });
    if (result?.data) return result.data;

    // Fallback: tight center crop — better for close-up scans
    const sourceWidth = video.videoWidth * 0.55;
    const sourceHeight = video.videoHeight * 0.55;
    const sourceX = (video.videoWidth - sourceWidth) / 2;
    const sourceY = (video.videoHeight - sourceHeight) / 2;
    context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, size, size);
    imageData = context.getImageData(0, 0, size, size);
    result = jsQR(imageData.data, size, size, { inversionAttempts: 'attemptBoth' });
    return result?.data ?? null;
  }

  private async createBarcodeDetector() {
    if (!('BarcodeDetector' in window)) return null;
    try {
      const supported: string[] = await (window as any).BarcodeDetector.getSupportedFormats?.() ?? [];
      const preferred = ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'data_matrix'];
      const formats = preferred.filter((format) => supported.includes(format));
      return new (window as any).BarcodeDetector({ formats: formats.length ? formats : preferred });
    } catch {
      return null;
    }
  }

  async printActivePickList() {
    const selectedLines = this.draftLines().filter((line) => this.pickType() !== 'itemwise' || line.selected);
    const html = this.buildPrintHtml(
      `Pick List Preview - ${this.plTypeLabel(this.pickType())}`,
      this.selectedOrders().map((order) => `${order.salesNo} (${this.getClientName(order.clientId)})`).join(', '),
      'Preview',
      this.plTypeLabel(this.pickType()),
      selectedLines.map((line) => ({ ...line, pickedQty: 0, remainingQty: line.requiredQty }))
    );
    const win = window.open('', '_blank', 'width=1050,height=750');
    if (win) {
      win.document.write(html);
      win.document.close();
      setTimeout(() => win.print(), 600);
    }
  }

  async printSavedPickList(pickList: PickList) {
    const savedLines = pickList.id ? await this.pickListService.getPickListLinesOnce(pickList.id) : pickList.items;
    const savedHtml = this.buildPrintHtml(
      pickList.pickListNo,
      `${(pickList.salesNos ?? []).join(', ')} - ${pickList.clientName}`,
      pickList.status,
      this.plTypeLabel(pickList.type),
      savedLines
    );
    const savedWindow = window.open('', '_blank', 'width=1050,height=750');
    if (savedWindow) {
      savedWindow.document.write(savedHtml);
      savedWindow.document.close();
      setTimeout(() => savedWindow.print(), 600);
    }
    return;

    const lines = pickList.id ? await this.pickListService.getPickListLinesOnce(pickList.id) : pickList.items;
    const html = this.buildPrintHtml(
      pickList.pickListNo,
      `${(pickList.salesNos ?? []).join(', ')} · ${pickList.clientName}`,
      pickList.status,
      this.plTypeLabel(pickList.type),
      lines
    );
    const win = window.open('', '_blank', 'width=1050,height=750');
    if (win) {
      win.document.write(html);
      win.document.close();
      setTimeout(() => win.print(), 600);
    }
  }

  private resetBuilderState() {
    this.pickType.set('direct');
    this.selectedOrderIds.set(new Set());
    this.orderSearchTerm.set('');
    this.draftLines.set([]);
    this.selectedPartyId.set(null);
    this.partySearchTerm.set('');
  }

  private asClaimUser(): PickListClaimUser | null {
    const user = this.currentUser();
    return user ? { id: user.id, username: user.username } : null;
  }

  private flashScanFeedback(type: 'success' | 'error', message: string) {
    this.scanFeedback.set(type);
    this.scannerMessage.set(message);
    if (type === 'success') this.playSuccessBeep();
    setTimeout(() => {
      this.scanFeedback.set('idle');
      this.scannerMessage.set(
        this.livePickList()?.type === 'party'
          ? 'Scan any item'
          : this.currentAssignedLine() ? 'Scan the assigned item' : 'Waiting for an available item'
      );
    }, 800);
  }

  private playSuccessBeep(): void {
    try {
      const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(1047, ctx.currentTime);
      oscillator.frequency.setValueAtTime(1319, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.35, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.35);
    } catch {
      // Audio API not supported
    }
  }

  private mapScanError(code: string): { title: string; text?: string } {
    switch (code) {
      case 'barcode_mismatch':
        return { title: 'Wrong item scanned', text: 'Finish picking the current item before scanning another.' };
      case 'line_claimed':
      case 'claim_conflict':
        return { title: 'Item is being picked by another user' };
      case 'stock_exhausted':
        return { title: 'Stock already exhausted' };
      case 'barcode_not_found':
        return { title: 'Barcode not found in selected Pick List' };
      case 'pending_stock':
      case 'blocked':
        return { title: 'This line cannot be picked right now' };
      case 'line_completed':
        return { title: 'Quantity already completed' };
      default:
        return { title: 'Scan failed', text: 'Please try again.' };
    }
  }

  private async showToast(icon: 'success' | 'error' | 'info' | 'warning', title: string, text?: string) {
    if (icon === 'error') {
      await Swal.fire({
        icon: 'error',
        title,
        html: text ? `<p style="font-size:15px;color:#374151;margin-top:4px">${text}</p>` : undefined,
        confirmButtonText: 'Try Again',
        confirmButtonColor: '#dc2626',
        timer: 5000,
        timerProgressBar: true,
        showConfirmButton: true,
        customClass: { title: 'text-xl font-bold' },
      });
    } else {
      await Swal.fire({
        toast: true,
        position: 'top-end',
        icon,
        title,
        text,
        timer: 1800,
        showConfirmButton: false,
        timerProgressBar: true,
      });
    }
  }

  private buildPrintHtml(
    title: string,
    subTitle: string,
    status: string,
    type: string,
    lines: Array<PickListLine | (PickListLineItem & { pickedQty?: number; remainingQty?: number })>
  ): string {
    const rankSize = (size: string) => {
      const index = SIZE_ORDER.indexOf(size);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };

    const printLines = [...lines]
      .map((line) => {
        const orderedQtyValue = Number(line.orderedQty) || 0;
        const requiredQtyValue = Math.max(
          0,
          Number((line as PickListLine).requiredQty ?? Math.max(0, orderedQtyValue - (Number(line.pendingQty) || 0))) || 0
        );
        const pickedQtyValue = Math.max(0, Number(line.pickedQty ?? 0) || 0);
        const remainingQtyValue = Math.max(
          0,
          Number(line.remainingQty ?? Math.max(0, requiredQtyValue - pickedQtyValue)) || 0
        );
        const pendingQtyValue = Math.max(0, Number(line.pendingQty ?? 0) || 0);
        const lineStatusValue = (line as PickListLine).status
          ?? (requiredQtyValue > 0 ? (pickedQtyValue > 0 ? 'in_progress' : 'ready') : pendingQtyValue > 0 ? 'pending_stock' : 'blocked');

        return {
          salesNo: line.salesNo,
          styleNo: line.styleNo,
          color: line.color,
          size: String(line.size),
          sleeveType: line.sleeveType ?? '',
          barcode: line.barcode ?? '-',
          orderedQty: orderedQtyValue,
          requiredQty: requiredQtyValue,
          pickedQty: pickedQtyValue,
          remainingQty: remainingQtyValue,
          pendingQty: pendingQtyValue,
          status: lineStatusValue,
        };
      })
      .sort((left, right) => {
        const salesNoCompare = left.salesNo.localeCompare(right.salesNo, undefined, { numeric: true });
        if (salesNoCompare !== 0) return salesNoCompare;
        const styleCompare = left.styleNo.localeCompare(right.styleNo, undefined, { numeric: true });
        if (styleCompare !== 0) return styleCompare;
        const colorCompare = left.color.localeCompare(right.color, undefined, { numeric: true });
        if (colorCompare !== 0) return colorCompare;
        const sizeCompare = rankSize(left.size) - rankSize(right.size);
        if (sizeCompare !== 0) return sizeCompare;
        return left.sleeveType.localeCompare(right.sleeveType, undefined, { numeric: true });
      });

    const summaryCards = printLines.reduce((totals, line) => ({
      ordered: totals.ordered + line.orderedQty,
      required: totals.required + line.requiredQty,
      picked: totals.picked + line.pickedQty,
      remaining: totals.remaining + line.remainingQty,
      pending: totals.pending + line.pendingQty,
    }), { ordered: 0, required: 0, picked: 0, remaining: 0, pending: 0 });

    const lineStatusStyles: Record<string, { bg: string; fg: string }> = {
      Completed: { bg: '#d1fae5', fg: '#047857' },
      Pending: { bg: '#ffedd5', fg: '#c2410c' },
      Partial: { bg: '#fef3c7', fg: '#b45309' },
      Draft: { bg: '#e5e7eb', fg: '#4b5563' },
      Preview: { bg: '#dbeafe', fg: '#1d4ed8' },
      ready: { bg: '#dcfce7', fg: '#166534' },
      in_progress: { bg: '#dbeafe', fg: '#1d4ed8' },
      completed: { bg: '#d1fae5', fg: '#047857' },
      pending_stock: { bg: '#ffedd5', fg: '#c2410c' },
      blocked: { bg: '#fee2e2', fg: '#b91c1c' },
    };

    const labelForStatus = (value: string) => value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
    const styleForStatus = (value: string) => lineStatusStyles[value] ?? { bg: '#e5e7eb', fg: '#374151' };
    const buildHeaderCell = (label: string, align: 'left' | 'center' | 'right' = 'left') =>
      `<th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700;text-transform:uppercase;text-align:${align};letter-spacing:0.04em">${label}</th>`;

    const htmlRows = printLines.map((line, index) => {
      const lineBadge = styleForStatus(line.status);
      return `
        <tr style="background:${index % 2 === 0 ? '#ffffff' : '#f8fafc'}">
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;color:#64748b">${index + 1}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;font-weight:600;color:#334155">${line.salesNo}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;font-weight:700;color:#111827">${line.styleNo}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;color:#475569">${line.color || '-'}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;color:#334155">${line.size}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;color:#475569">${line.sleeveType || '-'}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;font-family:'Courier New',monospace;font-size:10px;color:#334155">${line.barcode}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center">${line.orderedQty}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:#4338ca">${line.requiredQty}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:#15803d">${line.pickedQty}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:${line.remainingQty > 0 ? '#d97706' : '#94a3b8'}">${line.remainingQty}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:${line.pendingQty > 0 ? '#ea580c' : '#94a3b8'}">${line.pendingQty}</td>
          <td style="padding:8px 10px;border:1px solid #d7deea">
            <span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:10px;font-weight:700;background:${lineBadge.bg};color:${lineBadge.fg}">${labelForStatus(line.status)}</span>
          </td>
        </tr>`;
    }).join('');

    const overallStatusStyle = styleForStatus(status);
    const printedAtLabel = new Date().toLocaleString('en-IN');

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${title}</title>
          <style>
            body { font-family: Arial, sans-serif; font-size: 12px; margin: 18px; color: #0f172a; }
            h1, p { margin: 0; }
            .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 12px; }
            .meta { margin-top: 4px; color: #64748b; font-size: 11px; line-height: 1.5; }
            .badge { display: inline-block; margin-top: 8px; margin-right: 6px; padding: 4px 10px; border-radius: 999px; font-size: 10px; font-weight: 700; }
            .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 14px 0 10px; }
            .box { border: 1px solid #d7deea; background: #f8fafc; border-radius: 10px; padding: 10px 12px; }
            .label { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.04em; }
            .value { margin-top: 5px; font-size: 20px; font-weight: 700; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            tfoot td { background: #eff6ff; font-weight: 700; }
            .signatures { display: flex; justify-content: space-between; gap: 24px; margin-top: 28px; }
            .signatures div { flex: 1; border-top: 1px solid #334155; padding-top: 6px; text-align: center; color: #475569; font-size: 11px; }
            @media print {
              body { margin: 10px; }
              .summary { gap: 8px; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <h1 style="font-size:24px">${title}</h1>
              <p class="meta">${subTitle}</p>
              <span class="badge" style="background:${overallStatusStyle.bg};color:${overallStatusStyle.fg}">${status}</span>
              <span class="badge" style="background:#e0e7ff;color:#3730a3">${type}</span>
            </div>
            <div style="text-align:right">
              <div style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase">Printed At</div>
              <div style="margin-top:4px;font-size:12px;color:#0f172a">${printedAtLabel}</div>
            </div>
          </div>

          <div class="summary">
            <div class="box"><div class="label">Total Lines</div><div class="value">${printLines.length}</div></div>
            <div class="box"><div class="label">Ordered Qty</div><div class="value">${summaryCards.ordered}</div></div>
            <div class="box"><div class="label">Ready Qty</div><div class="value" style="color:#4338ca">${summaryCards.required}</div></div>
            <div class="box"><div class="label">Picked Qty</div><div class="value" style="color:#15803d">${summaryCards.picked}</div></div>
            <div class="box"><div class="label">Pending Stock</div><div class="value" style="color:${summaryCards.pending > 0 ? '#ea580c' : '#94a3b8'}">${summaryCards.pending}</div></div>
          </div>

          <table>
            <thead>
              <tr>
                ${buildHeaderCell('#', 'center')}
                ${buildHeaderCell('Order')}
                ${buildHeaderCell('Style No')}
                ${buildHeaderCell('Color')}
                ${buildHeaderCell('Size', 'center')}
                ${buildHeaderCell('Sleeve')}
                ${buildHeaderCell('Barcode')}
                ${buildHeaderCell('Ordered', 'center')}
                ${buildHeaderCell('Ready Qty', 'center')}
                ${buildHeaderCell('Picked', 'center')}
                ${buildHeaderCell('Remaining', 'center')}
                ${buildHeaderCell('Pending', 'center')}
                ${buildHeaderCell('Status')}
              </tr>
            </thead>
            <tbody>${htmlRows}</tbody>
            <tfoot>
              <tr>
                <td colspan="7" style="padding:9px 10px;border:1px solid #d7deea;text-align:right">Totals</td>
                <td style="padding:9px 10px;border:1px solid #d7deea;text-align:center">${summaryCards.ordered}</td>
                <td style="padding:9px 10px;border:1px solid #d7deea;text-align:center;color:#4338ca">${summaryCards.required}</td>
                <td style="padding:9px 10px;border:1px solid #d7deea;text-align:center;color:#15803d">${summaryCards.picked}</td>
                <td style="padding:9px 10px;border:1px solid #d7deea;text-align:center;color:${summaryCards.remaining > 0 ? '#d97706' : '#94a3b8'}">${summaryCards.remaining}</td>
                <td style="padding:9px 10px;border:1px solid #d7deea;text-align:center;color:${summaryCards.pending > 0 ? '#ea580c' : '#94a3b8'}">${summaryCards.pending}</td>
                <td style="padding:9px 10px;border:1px solid #d7deea"></td>
              </tr>
            </tfoot>
          </table>

          <div class="signatures">
            <div>Prepared By</div>
            <div>Picked By</div>
            <div>Checked By</div>
          </div>
        </body>
      </html>`;

    const sizeSet = new Set(lines.map((line) => String(line.size)));
    const sizes = [...sizeSet].sort((a, b) => {
      const aIndex = SIZE_ORDER.indexOf(a);
      const bIndex = SIZE_ORDER.indexOf(b);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      return a.localeCompare(b, undefined, { numeric: true });
    });

    const groupsMap = new Map<string, typeof lines>();
    for (const line of lines) {
      const key = `${line.styleNo}||${line.color}||${line.sleeveType ?? ''}`;
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key)!.push(line);
    }

    const groups = [...groupsMap.entries()].map(([key, groupedLines]) => {
      const [styleNo, color, sleeve] = key.split('||');
      return {
        styleNo,
        color,
        sleeve: sleeve || '',
        lines: groupedLines.map((line: any) => ({
          size: String(line.size),
          orderedQty: Number(line.orderedQty) || 0,
          pickedQty: Number(line.pickedQty ?? line.requiredQty) || 0,
          balanceQty: Number(line.balanceQty ?? line.remainingQty ?? line.pendingQty ?? 0) || 0,
        })),
      };
    });

    const totalOrdered = groups.flatMap((group) => group.lines).reduce((sum, line) => sum + line.orderedQty, 0);
    const totalPicked = groups.flatMap((group) => group.lines).reduce((sum, line) => sum + line.pickedQty, 0);
    const totalBalance = groups.flatMap((group) => group.lines).reduce((sum, line) => sum + line.balanceQty, 0);

    const statusBg = status === 'Completed' ? '#d1fae5' : status === 'Pending' ? '#ffedd5' : '#fef3c7';
    const statusFg = status === 'Completed' ? '#047857' : status === 'Pending' ? '#c2410c' : '#b45309';
    const th = (text: string, centered = false) => `<th style="padding:6px 9px;border:1px solid #ccc;text-align:${centered ? 'center' : 'left'};background:#1e293b;color:#fff;font-size:11px">${text}</th>`;

    const rows = groups.map((group, index) => {
      const sizeCells = sizes.map((size) => {
        const line = group.lines.find((entry) => entry.size === size);
        if (!line) return `<td style="padding:5px 7px;border:1px solid #ddd;text-align:center;color:#cbd5e1">-</td>`;
        return `<td style="padding:5px 7px;border:1px solid #ddd;text-align:center"><div style="font-size:9px;color:#64748b">Ord:${line.orderedQty}</div><div style="font-size:13px;font-weight:700;color:#16a34a">${line.pickedQty || '-'}</div><div style="font-size:9px;color:${line.balanceQty > 0 ? '#dc2626' : '#6b7280'}">Bal:${line.balanceQty}</div></td>`;
      }).join('');

      const rowPicked = group.lines.reduce((sum, line) => sum + line.pickedQty, 0);
      return `<tr style="background:${index % 2 === 0 ? '#fff' : '#f8fafc'}"><td style="padding:5px 7px;border:1px solid #ddd;text-align:center;color:#64748b">${index + 1}</td><td style="padding:5px 7px;border:1px solid #ddd"><strong>${group.styleNo}</strong><br><small style="color:#64748b">${group.color}${group.sleeve ? ` · ${group.sleeve}` : ''}</small></td>${sizeCells}<td style="padding:5px 7px;border:1px solid #ddd;text-align:center;font-weight:700;color:#4f46e5">${rowPicked}</td></tr>`;
    }).join('');

    return `<!DOCTYPE html><html><head><title>${title}</title><style>body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#1e293b}h2{margin:0}table{border-collapse:collapse;width:100%;margin-top:12px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}.box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:6px 10px}.lbl{font-size:9px;color:#64748b;text-transform:uppercase}.val{font-size:13px;font-weight:600;margin-top:2px}tfoot td{background:#f1f5f9;font-weight:700}@media print{body{margin:8px}}</style></head><body><div style="display:flex;justify-content:space-between;border-bottom:2px solid #1e293b;padding-bottom:8px"><div><h2>${title}</h2><p style="margin:2px 0;color:#64748b;font-size:11px">${subTitle}</p><span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;background:${statusBg};color:${statusFg}">${status}</span><span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;background:#e0e7ff;color:#3730a3;margin-left:6px">${type}</span></div><div style="text-align:right;font-size:10px;color:#94a3b8">Printed: ${new Date().toLocaleDateString('en-IN')}</div></div><div class="grid"><div class="box"><div class="lbl">Total Ordered</div><div class="val">${totalOrdered} pcs</div></div><div class="box"><div class="lbl">Total Picked</div><div class="val" style="color:#16a34a">${totalPicked} pcs</div></div><div class="box"><div class="lbl">Balance</div><div class="val" style="color:${totalBalance > 0 ? '#dc2626' : '#6b7280'}">${totalBalance} pcs</div></div></div><table><thead><tr>${th('#', true)}${th('Product')}${sizes.map((size) => th(size, true)).join('')}${th('Picked', true)}</tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="2" style="padding:7px 9px;border:1px solid #ddd;text-align:right">Total</td>${sizes.map((size) => { const sizeTotal = groups.flatMap((group) => group.lines).filter((line) => line.size === size).reduce((sum, line) => sum + line.pickedQty, 0); return `<td style="padding:7px 9px;border:1px solid #ddd;text-align:center">${sizeTotal}</td>`; }).join('')}<td style="padding:7px 9px;border:1px solid #ddd;text-align:center;color:#4f46e5">${totalPicked}</td></tr></tfoot></table><div style="margin-top:24px;display:flex;justify-content:space-between;padding:0 10px"><div style="border-top:1px solid #333;width:150px;padding-top:5px;text-align:center;font-size:11px;color:#555">Picker</div><div style="border-top:1px solid #333;width:150px;padding-top:5px;text-align:center;font-size:11px;color:#555">Verified By</div><div style="border-top:1px solid #333;width:150px;padding-top:5px;text-align:center;font-size:11px;color:#555">Dispatcher</div></div><p style="margin-top:14px;font-size:9px;color:#94a3b8;text-align:center">Generated ${new Date().toLocaleString('en-IN')} · TMG Clothings</p></body></html>`;
  }
}
