import { Injectable, signal, inject, computed } from '@angular/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { switchMap, tap } from 'rxjs';

import { SalesOrderService } from '../../services/sales-order.service';
import { ClientService } from '../../services/client.service';
import { DesignService } from '../../services/design.service';
import { InventoryService } from '../../services/inventory.service';
import { LoadingService } from '../../services/loading.service';
import type { SalesOrder, OrderItem } from '../../models/sales-order.model';
import type { Client } from '../../models/client.model';
import type { Design } from '../../models/design.model';
import type { InventoryItem } from '../../models/inventory.model';

export interface MatrixRow {
  key: string;
  label: string;
  qtyByGroup: Record<string, number>;
  totalQty: number;
  totalValue: number;
}

export interface MatrixReport {
  groups: string[];
  rows: MatrixRow[];
  grandTotal: { qtyByGroup: Record<string, number>; totalQty: number; totalValue: number };
}

export const STATUS_OPTIONS = ['Pending', 'Confirmed', 'Shipped'] as const;

/**
 * Holds the filter state and shared data pipelines used by every report tab
 * on the Reports screen. NOT providedIn: 'root' — it must be provided at the
 * ReportsComponent level (see its `providers` array) so a fresh instance
 * (fresh filters) is created each time the Reports screen is opened, matching
 * the previous behavior where a new ReportsComponent instance reset all this
 * state on every visit. If it were root-provided it would wrongly persist
 * filters across navigations away and back.
 */
@Injectable()
export class ReportsDataService {
  private readonly salesOrderService = inject(SalesOrderService);
  private readonly clientService = inject(ClientService);
  private readonly designService = inject(DesignService);
  private readonly inventoryService = inject(InventoryService);
  private readonly loadingService = inject(LoadingService);

  // ── Filter state ──────────────────────────────────────────────────────
  readonly startDate = signal(this.currentMonthStart());
  readonly endDate = signal(this.currentMonthEnd());
  readonly selectedCustomerId = signal('');
  readonly selectedAgent = signal('');
  readonly selectedGroup = signal('');
  readonly designSearch = signal('');
  readonly selectedStatus = signal('');

  readonly statusOptions = STATUS_OPTIONS;

  readonly dateRange = computed(() => {
    const rawStart = this.parseInputDate(this.startDate()) ?? this.parseInputDate(this.currentMonthStart())!;
    const rawEnd = this.parseInputDate(this.endDate()) ?? new Date();
    const start = rawStart <= rawEnd ? rawStart : rawEnd;
    const end = rawEnd >= rawStart ? rawEnd : rawStart;
    return { start: this.startOfDay(start), end: this.endOfDay(end) };
  });

  // ── Data sources ──────────────────────────────────────────────────────
  // Loader ties to each Observable's own subscribe/finalize lifecycle (not a
  // .then()/.catch() around the whole signal) so it starts exactly when a
  // request begins and stops on success, error, or cancellation (e.g.
  // switchMap dropping a stale in-flight request when the date range changes
  // again before it resolves).
  private readonly ordersInRange = toSignal(
    toObservable(this.dateRange).pipe(
      switchMap(({ start, end }) =>
        this.salesOrderService.getSalesOrdersInRange(start, end).pipe(
          tap({ subscribe: () => this.loadingService.start(), finalize: () => this.loadingService.stop() })
        )
      )
    ),
    { initialValue: [] as SalesOrder[] }
  );

  readonly clients = toSignal(
    this.clientService.getClients().pipe(
      tap({ subscribe: () => this.loadingService.start(), finalize: () => this.loadingService.stop() })
    ),
    { initialValue: [] as Client[] }
  );
  readonly designs = toSignal(
    this.designService.getDesigns().pipe(
      tap({ subscribe: () => this.loadingService.start(), finalize: () => this.loadingService.stop() })
    ),
    { initialValue: [] as Design[] }
  );
  readonly inventory = toSignal(
    this.inventoryService.getInventory().pipe(
      tap({ subscribe: () => this.loadingService.start(), finalize: () => this.loadingService.stop() })
    ),
    { initialValue: [] as InventoryItem[] }
  );

  readonly clientById = computed(() => {
    const map = new Map<string, Client>();
    for (const c of this.clients()) {
      if (c.id) map.set(c.id, c);
    }
    return map;
  });

  readonly sortedClients = computed(() =>
    [...this.clients()].sort((a, b) => this.toText(a.clientName).localeCompare(this.toText(b.clientName)))
  );

  readonly agentOptions = computed(() => {
    const set = new Set<string>();
    for (const c of this.clients()) {
      set.add(this.resolveAgentName(c));
    }
    return [...set].sort();
  });

  readonly groupOptions = computed(() => {
    const set = new Set<string>();
    for (const d of this.designs()) {
      const group = this.toText(d.group);
      if (group) set.add(group);
    }
    return [...set].sort();
  });

  // ── Filtering pipeline ────────────────────────────────────────────────
  readonly filteredOrders = computed(() => {
    const customerId = this.selectedCustomerId();
    const agent = this.selectedAgent();
    const status = this.selectedStatus();
    const clientById = this.clientById();

    return this.ordersInRange().filter((order) => {
      if (customerId && order.clientId !== customerId) return false;
      if (status && order.status !== status) return false;
      if (agent) {
        const client = clientById.get(order.clientId);
        if (!client || this.resolveAgentName(client) !== agent) return false;
      }
      return true;
    });
  });

  // ── Filter actions ────────────────────────────────────────────────────
  updateStartDate(value: string): void {
    this.startDate.set(value);
  }

  updateEndDate(value: string): void {
    this.endDate.set(value);
  }

  resetToCurrentMonth(): void {
    this.startDate.set(this.currentMonthStart());
    this.endDate.set(this.currentMonthEnd());
  }

  setPreset(days: number): void {
    const end = new Date();
    const start = this.shiftDays(end, -(days - 1));
    this.startDate.set(this.formatDateInput(start));
    this.endDate.set(this.formatDateInput(end));
  }

  resetFilters(): void {
    this.selectedCustomerId.set('');
    this.selectedAgent.set('');
    this.selectedGroup.set('');
    this.designSearch.set('');
    this.selectedStatus.set('');
  }

  filterSummary(): string {
    const { start, end } = this.dateRange();
    const parts = [`${this.formatLongDate(start)} - ${this.formatLongDate(end)}`];
    const customer = this.clients().find((c) => c.id === this.selectedCustomerId())?.clientName;
    parts.push(`Customer: ${customer ?? 'All'}`);
    parts.push(`Agent: ${this.selectedAgent() || 'All'}`);
    parts.push(`Product: ${this.selectedGroup() || 'All'}`);
    if (this.designSearch().trim()) parts.push(`Design: ${this.designSearch().trim()}`);
    parts.push(`Status: ${this.selectedStatus() || 'All'}`);
    return parts.join('  ·  ');
  }

  // ── Aggregation helpers shared by Customer Wise + Agent Wise ──────────
  // Every order that reaches this point must contribute to some row and to
  // the grand total — falling back to an "Unassigned" bucket instead of
  // skipping the order outright (as this used to do via `if (!key) continue`)
  // is what previously caused Agent Wise (and, in principle, Customer Wise)
  // totals to under-count whenever an order's client couldn't be resolved
  // (e.g. a deleted client), silently excluding that order's quantities from
  // every row AND the grand total instead of just mis-labeling it.
  buildMatrix(keyFn: (order: SalesOrder) => string, labelFn: (key: string) => string): MatrixReport {
    const rows = new Map<string, MatrixRow>();
    const groupSet = new Set<string>();

    for (const order of this.filteredOrders()) {
      const resolvedKey = keyFn(order);
      const key = resolvedKey || '__unassigned__';

      for (const item of order.items ?? []) {
        if (!this.matchesItemFilters(item)) continue;
        const group = this.toText(item.design?.group) || 'Other';
        groupSet.add(group);

        let row = rows.get(key);
        if (!row) {
          const label = resolvedKey ? labelFn(resolvedKey) : 'Unassigned';
          row = { key, label, qtyByGroup: {}, totalQty: 0, totalValue: 0 };
          rows.set(key, row);
        }

        for (const size of item.itemSizes ?? []) {
          const qty = Number(size.quantity) || 0;
          const value = qty * (Number(size.WSP) || 0);
          row.qtyByGroup[group] = (row.qtyByGroup[group] ?? 0) + qty;
          row.totalQty += qty;
          row.totalValue += value;
        }
      }
    }

    const groups = [...groupSet].sort();
    const rowList = [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
    const grandTotal = {
      qtyByGroup: Object.fromEntries(groups.map((g) => [g, rowList.reduce((s, r) => s + (r.qtyByGroup[g] ?? 0), 0)])),
      totalQty: rowList.reduce((s, r) => s + r.totalQty, 0),
      totalValue: rowList.reduce((s, r) => s + r.totalValue, 0),
    };

    return { groups, rows: rowList, grandTotal };
  }

  /** Shared by all report aggregations that iterate order items (product/exceed/style pivots + buildMatrix). */
  matchesItemFilters(item: OrderItem): boolean {
    const group = this.selectedGroup();
    const search = this.toText(this.designSearch()).toLowerCase();
    if (group && this.toText(item.design?.group) !== group) return false;
    if (search && !this.toText(item.design?.styleNo).toLowerCase().includes(search)) return false;
    return true;
  }

  resolveAgentName(client: Client): string {
    const agent = this.toText(client.agentName);
    if (agent) return agent;
    if (client.clientType === 'Agent') return this.toText(client.clientName) || 'Unassigned';
    return 'Unassigned';
  }

  /** Firestore documents aren't type-checked — coerce possibly-non-string values before string ops. */
  toText(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (value == null) return '';
    return String(value).trim();
  }

  // ── Date / formatting helpers ─────────────────────────────────────────
  private parseInputDate(value: string): Date | null {
    if (!value) return null;
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  }

  endOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  }

  shiftDays(date: Date, days: number): Date {
    const shifted = new Date(date);
    shifted.setDate(shifted.getDate() + days);
    return shifted;
  }

  currentMonthStart(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  currentMonthEnd(): string {
    const d = new Date();
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  }

  formatDateInput(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  formatLongDate(date: Date): string {
    return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  }

  formatTimestamp(): string {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  }
}
