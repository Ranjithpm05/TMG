import { Injectable, inject, computed, signal } from '@angular/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { from, of, switchMap, catchError, finalize, distinctUntilChanged, tap, map } from 'rxjs';

import { ReportsDataService } from '../reports-data.service';
import { ReportCalcService, mapWithConcurrency, normKey, type SkuFulfillment } from '../report-calc.service';
import { InventoryService } from '../../../services/inventory.service';
import { PickListService } from '../../../services/pick-list.service';
import type { InventoryItem } from '../../../models/inventory.model';
import type { PickList } from '../../../models/pick-list.model';
import type { SalesOrder } from '../../../models/sales-order.model';

export type StockStatus = 'Sufficient' | 'Insufficient' | 'Zero Stock';

/** One pending Sales Order line for one item, with its share of the item's stock (oldest order first). */
export interface PendingOrderAllocation {
  salesOrderId: string;
  salesNo: string;
  clientId: string;
  clientName: string;
  agentName: string;
  orderDate: Date | null;
  deliveryDate: string;
  styleNo: string;
  color: string;
  sleeveType: string;
  size: string;
  orderQty: number;
  dispatchedQty: number;
  pendingQty: number;
  /** Picked against this order but not yet on a DC — already deducted from Current Stock at scan time. */
  reservedQty: number;
  /** pendingQty - reservedQty: what still has to come off the shelf. */
  requiredFromStockQty: number;
  /** Shelf stock allocated to this order (FIFO by order date across the item's pending orders). */
  allocatedQty: number;
  shortQty: number;
}

export interface StockItemRow {
  key: string;
  barcode: string;
  styleNo: string;
  color: string;
  group: string;
  sleeveType: string;
  size: string;
  fabricType: string;
  /** False when the item exists only in inventory or on a Sales Order, not in Design Master. */
  inMaster: boolean;
  currentStock: number;
  reservedQty: number;
  availableQty: number;
  pendingQty: number;
  requiredFromStockQty: number;
  additionalRequiredQty: number;
  excessQty: number;
  status: StockStatus;
  orders: PendingOrderAllocation[];
}

export interface StockTotals {
  itemCount: number;
  itemsWithPending: number;
  currentStock: number;
  reservedQty: number;
  availableQty: number;
  pendingQty: number;
  requiredFromStockQty: number;
  additionalRequiredQty: number;
  excessQty: number;
  insufficientCount: number;
  zeroStockCount: number;
}

export type ItemLevel = 'sku' | 'style';

/** Keys an item by style/color/size, then sleeve — sleeve is matched separately because either side may have left it blank. */
const baseKey = (styleNo: unknown, color: unknown, size: unknown) => `${normKey(styleNo)}||${normKey(color)}||${normKey(size)}`;

/**
 * Exact (base, sleeve) match first; otherwise a blank sleeve on one side
 * joins the single sleeve variant on the other — the same rule
 * ReportCalcService.skuFulfillments() uses for order-vs-DC lines.
 */
class SleeveIndex {
  private readonly sleevesByBase = new Map<string, Set<string>>();

  add(base: string, sleeve: string): void {
    const set = this.sleevesByBase.get(base);
    if (set) set.add(sleeve); else this.sleevesByBase.set(base, new Set([sleeve]));
  }

  resolve(base: string, sleeve: string): string | null {
    const sleeves = this.sleevesByBase.get(base);
    if (!sleeves) return null;
    if (sleeves.has(sleeve)) return sleeve;
    if (sleeves.size !== 1) return null;
    const [only] = sleeves;
    return !sleeve || !only ? only : null;
  }
}

function toDate(raw: any): Date | null {
  if (!raw) return null;
  try {
    const date = raw?.toDate ? raw.toDate() : new Date(raw?.seconds ? raw.seconds * 1000 : raw);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function statusOf(availableQty: number, additionalRequiredQty: number): StockStatus {
  if (availableQty <= 0) return 'Zero Stock';
  return additionalRequiredQty > 0 ? 'Insufficient' : 'Sufficient';
}

/**
 * Item-wise stock vs. pending Sales Order demand. Builds on the shared
 * report pipeline instead of re-deriving quantities:
 *  - Pending Qty per (Sales Order, SKU) is ReportCalcService.skuFulfillments()
 *    (order qty - DC-dispatched qty, closed DC balances not dispatched),
 *    the same number every pending-order report shows.
 *  - Current Stock is inventory.currentStock as stored.
 *  - Reserved is qty picked for a pending order but not yet on a DC. Pick
 *    List scans already deduct currentStock (PickListService scan
 *    transaction), so these pieces are no longer in Current Stock; they
 *    reduce what the order still needs from the shelf instead of being
 *    subtracted from stock a second time.
 * Provided per report screen, alongside ReportsDataService/ReportCalcService.
 */
@Injectable()
export class StockRequirementService {
  private readonly data = inject(ReportsDataService);
  private readonly calc = inject(ReportCalcService);
  private readonly inventoryService = inject(InventoryService);
  private readonly pickListService = inject(PickListService);

  // ── Local (instant, no re-query) filters ───────────────────────────────
  readonly itemSearch = signal('');
  readonly salesOrderSearch = signal('');
  readonly itemLevel = signal<ItemLevel>('sku');

  // ── Inventory ─────────────────────────────────────────────────────────
  readonly isLoadingInventory = signal(true);
  readonly inventoryError = signal<string | null>(null);
  private readonly inventory = toSignal(
    this.inventoryService.getInventory().pipe(
      tap(() => this.isLoadingInventory.set(false)),
      catchError((err) => {
        console.error('Stock report: failed to load inventory', err);
        this.inventoryError.set('Unable to load inventory. Please try again.');
        this.isLoadingInventory.set(false);
        return of([] as InventoryItem[]);
      })
    ),
    { initialValue: [] as InventoryItem[] }
  );

  // ── Picked-not-dispatched (Reserved) ──────────────────────────────────
  readonly isLoadingPicked = signal(false);
  readonly pickedError = signal<string | null>(null);

  // Only orders still pending need it, and only once dispatch is known —
  // before that every order looks fully pending.
  private readonly pendingOrderIds = computed<string[] | null>(() => {
    if (!this.calc.isDispatchReady()) return null;
    const ids = new Set<string>();
    for (const f of this.calc.skuFulfillments()) if (f.pendingQty > 0 && f.salesOrderId) ids.add(f.salesOrderId);
    return [...ids].sort();
  });

  private readonly pickedCache = new Map<string, Map<string, number>>();

  private readonly pickedResult = toSignal(
    toObservable(this.pendingOrderIds).pipe(
      distinctUntilChanged((a, b) => a === b || (!!a && !!b && a.join(',') === b.join(','))),
      switchMap((ids) => {
        this.pickedError.set(null);
        if (!ids) return of(null);
        const key = ids.join(',');
        if (!ids.length) return of({ key, picked: new Map<string, number>() });
        const cached = this.pickedCache.get(key);
        if (cached) return of({ key, picked: cached });
        this.isLoadingPicked.set(true);
        return from(this.loadPicked(ids)).pipe(
          tap((picked) => this.pickedCache.set(key, picked)),
          catchError((err) => {
            console.error('Stock report: failed to load pick lists', err);
            this.pickedError.set('Unable to load pick list data. Please try again.');
            return of(new Map<string, number>());
          }),
          map((picked) => ({ key, picked })),
          finalize(() => this.isLoadingPicked.set(false))
        );
      })
    ),
    { initialValue: null }
  );

  /**
   * Picked qty per fulfillment-style key (`soId||STYLE||COLOR||SIZE||SLEEVE`).
   * Null until loaded for exactly the current pending orders — the async
   * result can lag a filter change by a render.
   */
  private readonly pickedByKey = computed(() => {
    const ids = this.pendingOrderIds();
    const result = this.pickedResult();
    return ids && result && result.key === ids.join(',') ? result.picked : null;
  });

  readonly isLoading = computed(() =>
    this.data.isLoadingOrders() || this.calc.isLoadingDispatch() || this.isLoadingInventory() ||
    this.isLoadingPicked() || this.pickedByKey() === null
  );
  readonly error = computed(() =>
    this.data.ordersError() || this.calc.dispatchError() || this.inventoryError() || this.pickedError()
  );

  retry(): void {
    this.pickedCache.clear();
    this.data.retryOrders();
    this.calc.retryDispatch();
  }

  /** True when an order-side filter narrows demand to some orders — then items with no matching demand are hidden. */
  readonly demandIsFiltered = computed(() =>
    !!(this.data.selectedCustomerId() || this.data.selectedAgent() || this.data.selectedStatus() || this.salesOrderSearch().trim())
  );

  // ── SKU rows ──────────────────────────────────────────────────────────
  readonly skuRows = computed<StockItemRow[]>(() => {
    const picked = this.pickedByKey() ?? new Map<string, number>();
    const rows = new Map<string, StockItemRow>();
    const sleeves = new SleeveIndex();

    const addRow = (styleNo: string, color: string, size: string, sleeveType: string, init: Partial<StockItemRow>): StockItemRow => {
      const base = baseKey(styleNo, color, size);
      const sleeve = normKey(sleeveType);
      const key = `${base}||${sleeve}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key, barcode: '', styleNo, color, group: '', sleeveType, size, fabricType: '', inMaster: false,
          currentStock: 0, reservedQty: 0, availableQty: 0, pendingQty: 0, requiredFromStockQty: 0,
          additionalRequiredQty: 0, excessQty: 0, status: 'Zero Stock', orders: [],
          ...init,
        };
        rows.set(key, row);
        sleeves.add(base, sleeve);
      }
      return row;
    };
    const findRow = (styleNo: unknown, color: unknown, size: unknown, sleeveType: unknown): StockItemRow | undefined => {
      const base = baseKey(styleNo, color, size);
      const sleeve = sleeves.resolve(base, normKey(sleeveType));
      return sleeve === null ? undefined : rows.get(`${base}||${sleeve}`);
    };

    // 1. Item master: every Design Master SKU, stock or not.
    for (const design of this.data.designs()) {
      const styleNo = this.data.toText(design.styleNo);
      if (!styleNo) continue;
      const group = this.data.toText(design.group);
      if (!this.data.matchesGroupAndDesign(group, styleNo)) continue;
      const color = this.data.toText(design.color);
      for (const entry of design.sizes ?? []) {
        const size = this.data.toText(entry.size);
        if (!size) continue;
        const row = addRow(styleNo, color, size, this.data.toText(entry.sleeveType), {
          group, inMaster: true, fabricType: this.data.toText(entry.fabricType),
        });
        if (!row.barcode) row.barcode = this.data.toText(entry.BARCODE);
      }
    }

    // 2. Inventory — summed, since a SKU can have more than one stock record.
    for (const inv of this.inventory()) {
      const styleNo = this.data.toText(inv.styleNo);
      if (!styleNo) continue;
      let row = findRow(styleNo, inv.color, inv.size, inv.sleeveType);
      if (!row) {
        if (!this.data.matchesGroupAndDesign(inv.group, styleNo)) continue;
        row = addRow(styleNo, this.data.toText(inv.color), this.data.toText(inv.size), this.data.toText(inv.sleeveType), {
          group: this.data.toText(inv.group), fabricType: this.data.toText(inv.fabricType),
        });
      }
      row.currentStock += Number(inv.currentStock) || 0;
      if (!row.barcode) row.barcode = this.data.toText(inv.barcode);
      if (!row.group) row.group = this.data.toText(inv.group);
    }

    // 3. Pending Sales Order demand.
    const orderById = new Map<string, SalesOrder>();
    for (const order of this.data.filteredOrders()) if (order.id) orderById.set(order.id, order);
    const soSearch = this.salesOrderSearch().trim().toLowerCase();
    const reservedByJoinKey = this.reservedByFulfillment(this.calc.skuFulfillments(), picked);

    for (const f of this.calc.skuFulfillments()) {
      if (f.pendingQty <= 0) continue;
      if (soSearch && !f.salesNo.toLowerCase().includes(soSearch)) continue;
      const row = findRow(f.styleNo, f.color, f.size, f.sleeveType)
        ?? addRow(f.styleNo, f.color, f.size, f.sleeveType, { group: f.group });
      const reservedQty = reservedByJoinKey.get(f.joinKey) ?? 0;
      const order = orderById.get(f.salesOrderId);
      const existing = row.orders.find((o) => o.salesOrderId === f.salesOrderId);
      if (existing) {
        // Two order lines resolved to one item (blank vs. set sleeve) — one entry per order.
        existing.orderQty += f.orderQty;
        existing.dispatchedQty += f.dispatchedQty;
        existing.pendingQty += f.pendingQty;
        existing.reservedQty += reservedQty;
        existing.requiredFromStockQty += f.pendingQty - reservedQty;
        continue;
      }
      row.orders.push({
        salesOrderId: f.salesOrderId, salesNo: f.salesNo,
        clientId: f.clientId, clientName: f.clientName, agentName: f.agentName,
        orderDate: toDate(order?.createdAt), deliveryDate: order?.deliveryDate ?? '',
        styleNo: row.styleNo, color: row.color, sleeveType: row.sleeveType, size: row.size,
        orderQty: f.orderQty, dispatchedQty: f.dispatchedQty, pendingQty: f.pendingQty,
        reservedQty, requiredFromStockQty: f.pendingQty - reservedQty,
        allocatedQty: 0, shortQty: 0,
      });
    }

    // 4. Allocate shelf stock to pending orders, oldest order first.
    const hideNoDemand = this.demandIsFiltered();
    const result: StockItemRow[] = [];
    for (const row of rows.values()) {
      if (hideNoDemand && !row.orders.length) continue;
      row.orders.sort((a, b) => (a.orderDate?.getTime() ?? 0) - (b.orderDate?.getTime() ?? 0) || a.salesNo.localeCompare(b.salesNo));
      row.availableQty = Math.max(0, row.currentStock);
      let remaining = row.availableQty;
      for (const o of row.orders) {
        o.allocatedQty = Math.min(remaining, o.requiredFromStockQty);
        o.shortQty = o.requiredFromStockQty - o.allocatedQty;
        remaining -= o.allocatedQty;
        row.pendingQty += o.pendingQty;
        row.reservedQty += o.reservedQty;
        row.requiredFromStockQty += o.requiredFromStockQty;
      }
      row.additionalRequiredQty = Math.max(0, row.requiredFromStockQty - row.availableQty);
      row.excessQty = Math.max(0, row.availableQty - row.requiredFromStockQty);
      row.status = statusOf(row.availableQty, row.additionalRequiredQty);
      result.push(row);
    }
    return result;
  });

  /**
   * Style & Color level: sums of the SKU rows. Shortage/excess are summed
   * per size, never netted — surplus Large can't cover a Medium order.
   */
  private readonly styleRows = computed<StockItemRow[]>(() => {
    const groups = new Map<string, StockItemRow>();
    for (const sku of this.skuRows()) {
      const key = `${normKey(sku.styleNo)}||${normKey(sku.color)}||${normKey(sku.sleeveType)}`;
      let row = groups.get(key);
      if (!row) {
        row = {
          ...sku, key, barcode: '', size: '', fabricType: sku.fabricType,
          currentStock: 0, reservedQty: 0, availableQty: 0, pendingQty: 0, requiredFromStockQty: 0,
          additionalRequiredQty: 0, excessQty: 0, orders: [],
        };
        groups.set(key, row);
      }
      row.inMaster = row.inMaster && sku.inMaster;
      row.currentStock += sku.currentStock;
      row.reservedQty += sku.reservedQty;
      row.availableQty += sku.availableQty;
      row.pendingQty += sku.pendingQty;
      row.requiredFromStockQty += sku.requiredFromStockQty;
      row.additionalRequiredQty += sku.additionalRequiredQty;
      row.excessQty += sku.excessQty;
      row.orders.push(...sku.orders);
    }
    for (const row of groups.values()) {
      row.status = statusOf(row.availableQty, row.additionalRequiredQty);
      row.orders.sort((a, b) => (a.orderDate?.getTime() ?? 0) - (b.orderDate?.getTime() ?? 0) || a.salesNo.localeCompare(b.salesNo) || a.size.localeCompare(b.size, undefined, { numeric: true }));
    }
    return [...groups.values()];
  });

  /** Rows at the selected level, narrowed by the item search (barcode / style / color / product). */
  readonly rows = computed<StockItemRow[]>(() => {
    const source = this.itemLevel() === 'style' ? this.styleRows() : this.skuRows();
    const search = this.itemSearch().trim().toLowerCase();
    if (!search) return source;
    return source.filter((row) =>
      row.barcode.toLowerCase().includes(search) ||
      row.styleNo.toLowerCase().includes(search) ||
      row.color.toLowerCase().includes(search) ||
      row.group.toLowerCase().includes(search)
    );
  });

  totalsOf(rows: StockItemRow[]): StockTotals {
    const totals: StockTotals = {
      itemCount: rows.length, itemsWithPending: 0, currentStock: 0, reservedQty: 0, availableQty: 0, pendingQty: 0,
      requiredFromStockQty: 0, additionalRequiredQty: 0, excessQty: 0, insufficientCount: 0, zeroStockCount: 0,
    };
    for (const row of rows) {
      if (row.pendingQty > 0) totals.itemsWithPending += 1;
      totals.currentStock += row.currentStock;
      totals.reservedQty += row.reservedQty;
      totals.availableQty += row.availableQty;
      totals.pendingQty += row.pendingQty;
      totals.requiredFromStockQty += row.requiredFromStockQty;
      totals.additionalRequiredQty += row.additionalRequiredQty;
      totals.excessQty += row.excessQty;
      if (row.additionalRequiredQty > 0) totals.insufficientCount += 1;
      if (row.status === 'Zero Stock') totals.zeroStockCount += 1;
    }
    return totals;
  }

  /**
   * Reserved per fulfillment: picked for that order line, minus what has
   * since gone out on a DC or was returned to stock by closing a DC
   * balance, capped at the line's pending qty.
   */
  private reservedByFulfillment(fulfillments: SkuFulfillment[], picked: Map<string, number>): Map<string, number> {
    const byJoinKey = new Map<string, SkuFulfillment>();
    const sleeves = new SleeveIndex();
    for (const f of fulfillments) {
      byJoinKey.set(f.joinKey, f);
      const sep = f.joinKey.lastIndexOf('||');
      sleeves.add(f.joinKey.slice(0, sep), f.joinKey.slice(sep + 2));
    }

    const pickedByJoinKey = new Map<string, number>();
    for (const [key, qty] of picked) {
      const sep = key.lastIndexOf('||');
      const base = key.slice(0, sep);
      const sleeve = sleeves.resolve(base, key.slice(sep + 2));
      if (sleeve === null) continue; // picked for something not (or no longer) on the order
      const joinKey = `${base}||${sleeve}`;
      pickedByJoinKey.set(joinKey, (pickedByJoinKey.get(joinKey) ?? 0) + qty);
    }

    const reserved = new Map<string, number>();
    for (const [joinKey, pickedQty] of pickedByJoinKey) {
      const f = byJoinKey.get(joinKey);
      if (!f || f.pendingQty <= 0) continue;
      const qty = Math.min(f.pendingQty, Math.max(0, pickedQty - f.dispatchedQty - f.closedQty));
      if (qty > 0) reserved.set(joinKey, qty);
    }
    return reserved;
  }

  /**
   * Picked qty per (order, SKU) across every Pick List of the given orders.
   * Uses each Pick List's pickedByLineKey aggregate when it agrees with the
   * live totals; scans update totalPickedQty/totalAdditionalPickedQty but
   * not pickedByLineKey (only recalculated on edits / Packing List
   * generation), so a mismatch means the aggregate is stale and that one
   * list's lines are read instead (per-device cached by updatedAt).
   */
  private async loadPicked(orderIds: string[]): Promise<Map<string, number>> {
    const t0 = performance.now();
    const inScope = new Set(orderIds);
    const pickLists = await this.pickListService.getPickListsByOrderIdsOnce(orderIds);
    const picked = new Map<string, number>();
    const add = (salesOrderId: string, styleNo: unknown, color: unknown, size: unknown, sleeveType: unknown, qty: number) => {
      if (qty <= 0 || !inScope.has(salesOrderId)) return;
      const key = `${salesOrderId}||${baseKey(styleNo, color, size)}||${normKey(sleeveType)}`;
      picked.set(key, (picked.get(key) ?? 0) + qty);
    };

    const stale: PickList[] = [];
    for (const pl of pickLists) {
      const liveTotal = (Number(pl.totalPickedQty) || 0) + (Number(pl.totalAdditionalPickedQty) || 0);
      const entries = Object.entries(pl.pickedByLineKey ?? {});
      const aggregateTotal = entries.reduce((sum, [, qty]) => sum + (Number(qty) || 0), 0);
      if (liveTotal <= 0 && aggregateTotal <= 0) continue;
      if (aggregateTotal !== liveTotal) {
        stale.push(pl);
        continue;
      }
      for (const [key, qty] of entries) {
        const [salesOrderId, styleNo, color, size, sleeveType = ''] = key.split('||');
        add(salesOrderId, styleNo, color, size, sleeveType, Number(qty) || 0);
      }
    }

    const staleLines = await mapWithConcurrency(stale, 10, (pl) => this.pickListService.getPickListLinesForReport(pl));
    for (const lines of staleLines) {
      for (const line of lines) add(line.salesOrderId, line.styleNo, line.color, line.size, line.sleeveType, Number(line.pickedQty) || 0);
    }
    console.debug(`[Reports] stock requirement: ${pickLists.length} pick lists (${stale.length} read line-level) for ${orderIds.length} pending orders in ${Math.round(performance.now() - t0)}ms`);
    return picked;
  }
}
