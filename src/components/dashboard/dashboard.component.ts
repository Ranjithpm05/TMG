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
import type { PickList } from '../../models/pick-list.model';
import type { PackingList } from '../../models/packing-list.model';

interface SummaryCard {
  label: string;
  value: string;
  detail: string;
  accent: string;
}

interface TrendPoint {
  dateKey: string;
  label: string;
  orders: number;
  received: number;
  packed: number;
}

interface ProgressRow {
  label: string;
  valueLabel: string;
  percent: number;
  detail: string;
  barClass: string;
}

interface RankedRow {
  label: string;
  value: number;
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

  readonly startDate = signal(this.formatDateInput(this.shiftDays(new Date(), -29)));
  readonly endDate = signal(this.formatDateInput(new Date()));

  readonly dateRange = computed(() => {
    const rawStart = this.parseInputDate(this.startDate()) ?? this.shiftDays(new Date(), -29);
    const rawEnd = this.parseInputDate(this.endDate()) ?? new Date();
    const start = rawStart <= rawEnd ? rawStart : rawEnd;
    const end = rawEnd >= rawStart ? rawEnd : rawStart;
    return {
      start: this.startOfDay(start),
      end: this.endOfDay(end),
    };
  });

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

  readonly totalOrderQty = computed(() =>
    this.filteredSalesOrders().reduce(
      (sum, order) =>
        sum + (order.items ?? []).reduce(
          (itemTotal, item) =>
            itemTotal + (item.itemSizes ?? []).reduce((sizeTotal, size) => sizeTotal + (Number(size.quantity) || 0), 0),
          0
        ),
      0
    )
  );

  readonly totalReceivedQty = computed(() =>
    this.filteredGoodsInwards().reduce(
      (sum, goodsInward) =>
        sum + (goodsInward.items ?? []).reduce((itemTotal, item) => itemTotal + (Number(item.receivedQty) || 0), 0),
      0
    )
  );

  readonly totalPickedQty = computed(() =>
    this.filteredPickLists().reduce((sum, pickList) => sum + (Number(pickList.totalPickedQty) || 0), 0)
  );

  readonly totalPackedQty = computed(() =>
    this.filteredPackingLists().reduce((sum, packingList) => sum + (Number(packingList.totalPackedQty) || 0), 0)
  );

  readonly activeClientsInRange = computed(() =>
    new Set(this.filteredSalesOrders().map((order) => order.clientId).filter(Boolean)).size
  );

  readonly currentInventoryUnits = computed(() =>
    this.inventory().reduce((sum, item) => sum + (Number(item.currentStock) || 0), 0)
  );

  readonly lowStockCount = computed(() =>
    this.inventory().filter((item) => (Number(item.currentStock) || 0) > 0 && (Number(item.currentStock) || 0) <= 10).length
  );

  readonly outOfStockCount = computed(() =>
    this.inventory().filter((item) => (Number(item.currentStock) || 0) <= 0).length
  );

  readonly shippedOrders = computed(() =>
    this.filteredSalesOrders().filter((order) => order.status === 'Shipped').length
  );

  readonly summaryCards = computed<SummaryCard[]>(() => [
    {
      label: 'Orders',
      value: this.formatNumber(this.filteredSalesOrders().length),
      detail: `${this.totalOrderQty()} pcs in selected range`,
      accent: 'from-sky-500 via-cyan-400 to-teal-300',
    },
    {
      label: 'Received Qty',
      value: this.formatNumber(this.totalReceivedQty()),
      detail: `${this.filteredGoodsInwards().length} GRNs loaded`,
      accent: 'from-emerald-500 via-green-400 to-lime-300',
    },
    {
      label: 'Picked Qty',
      value: this.formatNumber(this.totalPickedQty()),
      detail: `${this.filteredPickLists().length} pick lists in range`,
      accent: 'from-amber-500 via-orange-400 to-yellow-300',
    },
    {
      label: 'Packed Qty',
      value: this.formatNumber(this.totalPackedQty()),
      detail: `${this.filteredPackingLists().length} packing lists in range`,
      accent: 'from-rose-500 via-orange-400 to-pink-300',
    },
    {
      label: 'Active Clients',
      value: this.formatNumber(this.activeClientsInRange()),
      detail: `Default view loads last 30 days`,
      accent: 'from-violet-500 via-fuchsia-400 to-pink-300',
    },
    {
      label: 'Live Inventory',
      value: this.formatNumber(this.currentInventoryUnits()),
      detail: `${this.lowStockCount()} low stock, ${this.outOfStockCount()} out of stock`,
      accent: 'from-slate-700 via-slate-500 to-slate-300',
    },
  ]);

  readonly trendSeries = computed<TrendPoint[]>(() => {
    const { start, end } = this.dateRange();
    const buckets = new Map<string, TrendPoint>();

    for (let cursor = new Date(start); cursor <= end; cursor = this.shiftDays(cursor, 1)) {
      const dateKey = this.formatDateInput(cursor);
      buckets.set(dateKey, {
        dateKey,
        label: this.formatShortDay(cursor),
        orders: 0,
        received: 0,
        packed: 0,
      });
    }

    for (const order of this.filteredSalesOrders()) {
      const date = this.getSalesOrderDate(order);
      if (!date) continue;
      const bucket = buckets.get(this.formatDateInput(date));
      if (bucket) {
        bucket.orders += (order.items ?? []).reduce(
          (itemTotal, item) =>
            itemTotal + (item.itemSizes ?? []).reduce((sizeTotal, size) => sizeTotal + (Number(size.quantity) || 0), 0),
          0
        );
      }
    }

    for (const goodsInward of this.filteredGoodsInwards()) {
      const date = this.getGoodsInwardDate(goodsInward);
      if (!date) continue;
      const bucket = buckets.get(this.formatDateInput(date));
      if (bucket) {
        bucket.received += (goodsInward.items ?? []).reduce(
          (itemTotal, item) => itemTotal + (Number(item.receivedQty) || 0),
          0
        );
      }
    }

    for (const packingList of this.filteredPackingLists()) {
      const date = this.parseUnknownDate(packingList.createdAt);
      if (!date) continue;
      const bucket = buckets.get(this.formatDateInput(date));
      if (bucket) {
        bucket.packed += Number(packingList.totalPackedQty) || 0;
      }
    }

    return [...buckets.values()];
  });

  readonly trendMax = computed(() => {
    const values = this.trendSeries().flatMap((point) => [point.orders, point.received, point.packed]);
    return Math.max(1, ...values);
  });

  readonly progressRows = computed<ProgressRow[]>(() => {
    const shipped = this.shippedOrders();
    const orders = this.filteredSalesOrders().length;
    const picked = this.totalPickedQty();
    const pickRequired = this.filteredPickLists().reduce((sum, item) => sum + (Number(item.totalRequiredQty) || 0), 0);
    const packed = this.totalPackedQty();
    const packRequired = this.filteredPackingLists().reduce((sum, item) => sum + (Number(item.totalRequiredQty) || 0), 0);

    return [
      {
        label: 'Order Shipment',
        valueLabel: `${shipped}/${orders || 0}`,
        percent: this.toPercent(shipped, orders),
        detail: `${orders - shipped > 0 ? orders - shipped : 0} orders still open`,
        barClass: 'from-sky-500 to-cyan-300',
      },
      {
        label: 'Picking Completion',
        valueLabel: `${this.formatNumber(picked)}/${this.formatNumber(pickRequired)}`,
        percent: this.toPercent(picked, pickRequired),
        detail: `${this.filteredPickLists().length} filtered pick lists`,
        barClass: 'from-amber-500 to-yellow-300',
      },
      {
        label: 'Packing Completion',
        valueLabel: `${this.formatNumber(packed)}/${this.formatNumber(packRequired)}`,
        percent: this.toPercent(packed, packRequired),
        detail: `${this.filteredPackingLists().length} filtered packing lists`,
        barClass: 'from-rose-500 to-orange-300',
      },
    ];
  });

  readonly topClients = computed<RankedRow[]>(() => {
    const totals = new Map<string, { qty: number; orders: number }>();

    for (const order of this.filteredSalesOrders()) {
      const clientId = order.clientId || 'unknown';
      const current = totals.get(clientId) ?? { qty: 0, orders: 0 };
      const qty = (order.items ?? []).reduce(
        (itemTotal, item) =>
          itemTotal + (item.itemSizes ?? []).reduce((sizeTotal, size) => sizeTotal + (Number(size.quantity) || 0), 0),
        0
      );
      current.qty += qty;
      current.orders += 1;
      totals.set(clientId, current);
    }

    return [...totals.entries()]
      .map(([clientId, total]) => ({
        label: this.clientNameMap().get(clientId) ?? (clientId === 'unknown' ? 'Unmapped Client' : clientId),
        value: total.qty,
        detail: `${total.orders} orders`,
      }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 5);
  });

  readonly topClientMax = computed(() => Math.max(1, ...this.topClients().map((item) => item.value)));

  readonly stockMix = computed(() => {
    const totalSkus = this.inventory().length || 1;
    const out = this.outOfStockCount();
    const low = this.lowStockCount();
    const healthy = Math.max(0, totalSkus - out - low);

    return [
      { label: 'Healthy', value: healthy, percent: Math.round((healthy / totalSkus) * 100), color: 'bg-emerald-400' },
      { label: 'Low', value: low, percent: Math.round((low / totalSkus) * 100), color: 'bg-amber-400' },
      { label: 'Out', value: out, percent: Math.round((out / totalSkus) * 100), color: 'bg-rose-400' },
    ];
  });

  readonly filteredStats = computed(() => [
    { label: 'Sales Orders', value: this.filteredSalesOrders().length },
    { label: 'GRNs', value: this.filteredGoodsInwards().length },
    { label: 'Pick Lists', value: this.filteredPickLists().length },
    { label: 'Packing Lists', value: this.filteredPackingLists().length },
  ]);

  readonly rangeLabel = computed(() => {
    const { start, end } = this.dateRange();
    return `${this.formatLongDate(start)} - ${this.formatLongDate(end)}`;
  });

  setPreset(days: number): void {
    const end = new Date();
    const start = this.shiftDays(end, -(days - 1));
    this.startDate.set(this.formatDateInput(start));
    this.endDate.set(this.formatDateInput(end));
  }

  updateStartDate(value: string): void {
    this.startDate.set(value);
  }

  updateEndDate(value: string): void {
    this.endDate.set(value);
  }

  resetRange(): void {
    this.setPreset(30);
  }

  barHeight(value: number): number {
    return Math.max(6, Math.round((value / this.trendMax()) * 100));
  }

  matrixCellHeight(value: number): number {
    return Math.max(6, Math.round((value / this.trendMax()) * 34));
  }

  rowWidth(value: number, total: number): number {
    return Math.max(6, Math.round((value / Math.max(1, total)) * 100));
  }

  trackByLabel(_index: number, item: { label: string }): string {
    return item.label;
  }

  private getSalesOrderDate(order: SalesOrder): Date | null {
    const rawOrder = order as SalesOrder & { orderDate?: string };
    return this.parseUnknownDate(rawOrder.orderDate) ?? this.parseUnknownDate(order.createdAt);
  }

  private getGoodsInwardDate(goodsInward: GoodsInward): Date | null {
    return this.parseUnknownDate(goodsInward.receivedDate)
      ?? this.parseUnknownDate(goodsInward.invoiceDate)
      ?? this.parseUnknownDate(goodsInward.createdAt);
  }

  private isWithinRange(value: Date | null): boolean {
    if (!value) {
      return false;
    }
    const { start, end } = this.dateRange();
    return value >= start && value <= end;
  }

  private parseUnknownDate(value: unknown): Date | null {
    if (!value) {
      return null;
    }

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
    if (!value) {
      return null;
    }
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

  private formatDateInput(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private formatShortDay(date: Date): string {
    return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(date);
  }

  private formatLongDate(date: Date): string {
    return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  }

  private toPercent(value: number, total: number): number {
    if (!total || total <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
  }

  private formatNumber(value: number): string {
    return new Intl.NumberFormat('en-IN').format(Math.round(value || 0));
  }
}
