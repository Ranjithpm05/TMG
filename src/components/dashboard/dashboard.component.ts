import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { ClientService } from '../../services/client.service';
import { SalesOrderService } from '../../services/sales-order.service';
import { GoodsInwardService } from '../../services/goods-inward.service';
import { InventoryService } from '../../services/inventory.service';
import { PickListService } from '../../services/pick-list.service';
import { PackingListService } from '../../services/packing-list.service';
import { AuthService } from '../../services/auth.service';
import type { SalesOrder } from '../../models/sales-order.model';
import type { GoodsInward } from '../../models/goods-inward.model';

interface SummaryCard {
  id: 'inventory' | 'lowStock' | 'pendingSales' | 'pickPack';
  label: string;
  value: string;
  detail: string;
  accent: string;
  iconBg: string;
}

interface InventorySummaryTile {
  label: string;
  value: string;
  tone: string;
}

interface InventoryCategoryRow {
  label: string;
  value: number;
  barClass: string;
}

interface LowStockRow {
  name: string;
  detail: string;
  stock: number;
}

interface SalesOrderRow {
  id: string;
  customer: string;
  status: string;
  badgeClass: string;
}

interface PickPackPanel {
  title: string;
  value: string;
  subtitle: string;
  detail: string;
  accent: string;
}

interface MiniStatCard {
  label: string;
  value: string;
  detail: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent {
  private readonly authService = inject(AuthService);
  private readonly clientService = inject(ClientService);
  private readonly salesOrderService = inject(SalesOrderService);
  private readonly goodsInwardService = inject(GoodsInwardService);
  private readonly inventoryService = inject(InventoryService);
  private readonly pickListService = inject(PickListService);
  private readonly packingListService = inject(PackingListService);

  private readonly clients = toSignal(this.clientService.getClients(), { initialValue: [] });
  private readonly salesOrders = toSignal(this.salesOrderService.getSalesOrders(), { initialValue: [] });
  private readonly goodsInwards = toSignal(this.goodsInwardService.getGoodsInwards(), { initialValue: [] });
  private readonly inventory = toSignal(this.inventoryService.getInventory(), { initialValue: [] });
  private readonly pickLists = toSignal(this.pickListService.getPickLists(), { initialValue: [] });
  private readonly packingLists = toSignal(this.packingListService.getPackingLists(), { initialValue: [] });

  readonly currentUser = computed(() => this.authService.currentUser());
  readonly currentUserName = computed(() => this.currentUser()?.username || 'Warehouse User');
  readonly currentUserEmail = computed(() => this.currentUser()?.email || 'textile@workspace.local');
  readonly currentUserInitials = computed(() => {
    const username = this.currentUserName().trim();
    if (!username) return 'TU';
    return username
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('');
  });

  // Default to current month start → today
  readonly startDate = signal(this.currentMonthStart());
  readonly endDate = signal(this.formatDateInput(new Date()));

  readonly dateRange = computed(() => {
    const rawStart = this.parseInputDate(this.startDate()) ?? this.parseInputDate(this.currentMonthStart())!;
    const rawEnd = this.parseInputDate(this.endDate()) ?? new Date();
    const start = rawStart <= rawEnd ? rawStart : rawEnd;
    const end = rawEnd >= rawStart ? rawEnd : rawStart;
    return {
      start: this.startOfDay(start),
      end: this.endOfDay(end),
    };
  });

  readonly isCurrentMonthFilter = computed(() =>
    this.startDate() === this.currentMonthStart() &&
    this.endDate() === this.formatDateInput(new Date())
  );

  readonly clientNameMap = computed(() => {
    const map = new Map<string, string>();
    for (const client of this.clients()) {
      if (client.id) {
        map.set(client.id, client.clientName);
      }
    }
    return map;
  });

  readonly filteredSalesOrders = computed(() =>
    this.salesOrders().filter((order) => this.isWithinRange(this.getSalesOrderDate(order)))
  );

  readonly filteredGoodsInwards = computed(() =>
    this.goodsInwards().filter((goodsInward) => this.isWithinRange(this.getGoodsInwardDate(goodsInward)))
  );

  readonly filteredPickLists = computed(() =>
    this.pickLists().filter((pickList) => this.isWithinRange(this.parseUnknownDate(pickList.createdAt)))
  );

  readonly filteredPackingLists = computed(() =>
    this.packingLists().filter((packingList) => this.isWithinRange(this.parseUnknownDate(packingList.createdAt)))
  );

  readonly currentInventoryUnits = computed(() =>
    this.inventory().reduce((sum, item) => sum + (Number(item.currentStock) || 0), 0)
  );

  readonly lowStockCount = computed(() =>
    this.inventory().filter((item) => {
      const stock = Number(item.currentStock) || 0;
      return stock > 0 && stock <= 10;
    }).length
  );

  readonly outOfStockCount = computed(() =>
    this.inventory().filter((item) => (Number(item.currentStock) || 0) <= 0).length
  );

  readonly totalPickedQty = computed(() =>
    this.filteredPickLists().reduce((sum, pickList) => sum + (Number(pickList.totalPickedQty) || 0), 0)
  );

  readonly totalPackedQty = computed(() =>
    this.filteredPackingLists().reduce((sum, packingList) => sum + (Number(packingList.totalPackedQty) || 0), 0)
  );

  readonly summaryCards = computed<SummaryCard[]>(() => [
    {
      id: 'inventory',
      label: 'Total Inventory',
      value: this.formatNumber(this.currentInventoryUnits()),
      detail: 'Items available in the warehouse',
      accent: 'from-sky-500 to-blue-600',
      iconBg: 'bg-sky-100 text-sky-700',
    },
    {
      id: 'lowStock',
      label: 'Low Stock Alerts',
      value: this.formatNumber(this.lowStockCount()),
      detail: 'Items below the stock threshold',
      accent: 'from-rose-500 to-orange-500',
      iconBg: 'bg-rose-100 text-rose-700',
    },
    {
      id: 'pendingSales',
      label: 'Pending Sales Orders',
      value: this.formatNumber(this.pendingSalesOrders()),
      detail: 'Orders waiting for dispatch',
      accent: 'from-amber-500 to-orange-400',
      iconBg: 'bg-amber-100 text-amber-700',
    },
    {
      id: 'pickPack',
      label: 'Orders to Pick & Pack',
      value: this.formatNumber(this.openPickPackOrders()),
      detail: 'Open fulfilment work items',
      accent: 'from-emerald-500 to-green-500',
      iconBg: 'bg-emerald-100 text-emerald-700',
    },
  ]);

  readonly inventorySummaryTiles = computed<InventorySummaryTile[]>(() => [
    {
      label: 'In Stock',
      value: `${this.formatNumber(this.currentInventoryUnits())} items`,
      tone: 'text-sky-700',
    },
    {
      label: 'Reserved',
      value: `${this.formatNumber(this.reservedInventoryQty())} items`,
      tone: 'text-indigo-700',
    },
    {
      label: 'On Order',
      value: `${this.formatNumber(this.pendingInboundQty())} items`,
      tone: 'text-amber-700',
    },
    {
      label: 'Out of Stock',
      value: `${this.formatNumber(this.outOfStockCount())} items`,
      tone: 'text-rose-700',
    },
  ]);

  readonly inventoryCategoryRows = computed<InventoryCategoryRow[]>(() => {
    const palette = [
      'from-sky-500 to-blue-600',
      'from-emerald-500 to-green-600',
      'from-amber-500 to-orange-500',
      'from-rose-500 to-red-500',
      'from-violet-500 to-fuchsia-500',
    ];
    const groups = new Map<string, number>();

    for (const item of this.inventory()) {
      const label = String(item.group || 'Other').trim() || 'Other';
      groups.set(label, (groups.get(label) ?? 0) + (Number(item.currentStock) || 0));
    }

    return Array.from(groups.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, value], i) => ({
        label,
        value,
        barClass: palette[i % palette.length],
      }));
  });

  readonly inventoryCategoryMax = computed(() =>
    Math.max(1, ...this.inventoryCategoryRows().map((r) => r.value))
  );

  readonly lowStockRows = computed<LowStockRow[]>(() =>
    this.inventory()
      .filter((item) => {
        const stock = Number(item.currentStock) || 0;
        return stock > 0 && stock <= 10;
      })
      .sort((a, b) => (Number(a.currentStock) || 0) - (Number(b.currentStock) || 0))
      .slice(0, 6)
      .map((item) => ({
        name: item.styleNo || 'Unknown',
        detail: [item.color, item.size].filter(Boolean).join(' · '),
        stock: Number(item.currentStock) || 0,
      }))
  );

  readonly recentSalesOrders = computed<SalesOrderRow[]>(() =>
    this.filteredSalesOrders()
      .slice()
      .sort((a, b) => {
        const da = this.getSalesOrderDate(a)?.getTime() ?? 0;
        const db = this.getSalesOrderDate(b)?.getTime() ?? 0;
        return db - da;
      })
      .slice(0, 8)
      .map((order) => ({
        id: (order as SalesOrder & { salesNo?: string }).salesNo ?? order.id ?? '—',
        customer: this.clientNameMap().get(order.clientId) ?? order.clientId ?? '—',
        status: order.status ?? 'Pending',
        badgeClass: this.salesOrderBadgeClass(order.status ?? 'Pending'),
      }))
  );

  readonly pickPackPanels = computed<PickPackPanel[]>(() => [
    {
      title: 'Total Picked',
      value: this.formatNumber(this.totalPickedQty()),
      subtitle: 'Units picked in period',
      detail: `${this.filteredPickLists().filter((p) => p.status === 'Completed').length} pick lists completed`,
      accent: 'from-indigo-500 to-violet-600',
    },
    {
      title: 'Total Packed',
      value: this.formatNumber(this.totalPackedQty()),
      subtitle: 'Units packed in period',
      detail: `${this.filteredPackingLists().filter((p) => p.status === 'Completed').length} packing lists completed`,
      accent: 'from-emerald-500 to-teal-600',
    },
  ]);

  readonly miniStatCards = computed<MiniStatCard[]>(() => [
    {
      label: 'Open Pick Lists',
      value: this.formatNumber(
        this.filteredPickLists().filter((item) => item.status === 'Partial' || item.status === 'Draft').length
      ),
      detail: 'Active pick lists',
    },
    {
      label: 'Orders Packed Today',
      value: this.formatNumber(this.packedQtyToday()),
      detail: 'Packed quantity today',
    },
    {
      label: 'Shipments Out Today',
      value: this.formatNumber(this.shipmentsOutToday()),
      detail: 'Shipped orders today',
    },
  ]);

  readonly rangeLabel = computed(() => {
    const { start, end } = this.dateRange();
    return `${this.formatLongDate(start)} – ${this.formatLongDate(end)}`;
  });

  // ── Date filter methods ──────────────────────────────────────────────

  updateStartDate(value: string): void {
    this.startDate.set(value);
  }

  updateEndDate(value: string): void {
    this.endDate.set(value);
  }

  resetToCurrentMonth(): void {
    this.startDate.set(this.currentMonthStart());
    this.endDate.set(this.formatDateInput(new Date()));
  }

  setPreset(days: number): void {
    const end = new Date();
    const start = this.shiftDays(end, -(days - 1));
    this.startDate.set(this.formatDateInput(start));
    this.endDate.set(this.formatDateInput(end));
  }

  rowWidth(value: number, total: number): number {
    return Math.max(8, Math.round((value / Math.max(1, total)) * 100));
  }

  salesOrderBadgeClass(status: string): string {
    switch (status) {
      case 'Shipped':
        return 'bg-emerald-500 text-white';
      case 'Confirmed':
      case 'Processing':
        return 'bg-sky-500 text-white';
      case 'Pending':
      default:
        return 'bg-amber-500 text-white';
    }
  }

  trackByLabel(_index: number, item: { label: string }): string {
    return item.label;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private pendingSalesOrders(): number {
    return this.filteredSalesOrders().filter((order) => order.status !== 'Shipped').length;
  }

  private openPickPackOrders(): number {
    const openPick = this.filteredPickLists().filter((item) => item.status !== 'Completed').length;
    const openPack = this.filteredPackingLists().filter((item) => item.status !== 'Completed').length;
    return openPick + openPack;
  }

  private reservedInventoryQty(): number {
    return this.filteredPickLists().reduce(
      (sum, pickList) =>
        sum + (pickList.items ?? []).reduce((itemTotal, item) => itemTotal + (Number(item.remainingQty) || 0), 0),
      0
    );
  }

  private pendingInboundQty(): number {
    return this.filteredGoodsInwards()
      .filter((goodsInward) => goodsInward.status === 'Pending')
      .reduce(
        (sum, goodsInward) =>
          sum + (goodsInward.items ?? []).reduce((itemTotal, item) => itemTotal + (Number(item.receivedQty) || 0), 0),
        0
      );
  }

  private pickCreatedToday(): number {
    return this.filteredPickLists().filter((item) => this.isToday(this.parseUnknownDate(item.createdAt))).length;
  }

  private packCreatedToday(): number {
    return this.filteredPackingLists().filter((item) => this.isToday(this.parseUnknownDate(item.createdAt))).length;
  }

  private packedQtyToday(): number {
    return this.filteredPackingLists()
      .filter((item) => this.isToday(this.parseUnknownDate(item.createdAt)))
      .reduce((sum, item) => sum + (Number(item.totalPackedQty) || 0), 0);
  }

  private shipmentsOutToday(): number {
    return this.filteredSalesOrders().filter((order) => {
      return order.status === 'Shipped' && this.isToday(this.getSalesOrderDate(order));
    }).length;
  }

  private getSalesOrderDate(order: SalesOrder): Date | null {
    const rawOrder = order as SalesOrder & { orderDate?: string };
    return this.parseUnknownDate(rawOrder.orderDate) ?? this.parseUnknownDate(order.createdAt);
  }

  private getGoodsInwardDate(goodsInward: GoodsInward): Date | null {
    return (
      this.parseUnknownDate(goodsInward.receivedDate) ??
      this.parseUnknownDate(goodsInward.invoiceDate) ??
      this.parseUnknownDate(goodsInward.createdAt)
    );
  }

  private isWithinRange(value: Date | null): boolean {
    if (!value) return false;
    const { start, end } = this.dateRange();
    return value >= start && value <= end;
  }

  private isToday(date: Date | null): boolean {
    if (!date) return false;
    const today = new Date();
    return (
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate()
    );
  }

  private parseUnknownDate(value: unknown): Date | null {
    if (!value) return null;

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === 'string') {
      const parsed = new Date(value.includes('T') ? value : `${value}T00:00:00`);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    if (typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    if (typeof value === 'object') {
      const candidate = value as { toDate?: () => Date; seconds?: number };
      if (typeof candidate.toDate === 'function') {
        const parsed = candidate.toDate();
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }
      if (typeof candidate.seconds === 'number') {
        const parsed = new Date(candidate.seconds * 1000);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }
    }

    return null;
  }

  private parseInputDate(value: string): Date | null {
    if (!value) return null;
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  }

  private endOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  }

  private shiftDays(date: Date, days: number): Date {
    const shifted = new Date(date);
    shifted.setDate(shifted.getDate() + days);
    return shifted;
  }

  private currentMonthStart(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  private formatDateInput(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private formatLongDate(date: Date): string {
    return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  }

  private formatNumber(value: number): string {
    return new Intl.NumberFormat('en-IN').format(Math.round(value || 0));
  }
}