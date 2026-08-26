import { Injectable, inject, computed, signal } from '@angular/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { from, of, switchMap, catchError, finalize } from 'rxjs';

import { ReportsDataService } from './reports-data.service';
import { PickListService } from '../../services/pick-list.service';
import { PackingListService } from '../../services/packing-list.service';
import { DeliveryChallanService } from '../../services/delivery-challan.service';
import { InvoiceService } from '../../services/invoice.service';
import type { PickList, PickListLine, PickListType } from '../../models/pick-list.model';
import type { PackingList } from '../../models/packing-list.model';

/** One ordered (SalesOrder, style/color/size) line, flattened for joining against dispatch data. */
export interface OrderLine {
  salesOrderId: string;
  salesNo: string;
  clientId: string;
  clientName: string;
  agentName: string;
  designId: string;
  styleNo: string;
  color: string;
  group: string;
  size: string;
  sleeveType: string;
  orderQty: number;
}

/**
 * Per-Pick-List-line dispatch attribution — how much of a Pick List line has
 * actually been packed/dispatched/invoiced, traced through Packing List ->
 * DC -> Invoice. One record per (pickListId, pickListLineId), always present
 * even when dcQty is still 0 (so Pick List Wise can show still-pending
 * lines). A record with an empty pickListId/pickListLineId represents
 * dispatched quantity that could not be traced back to any Pick List line
 * (manually-added Packing List lines) — see `unassignedRecords`.
 */
export interface DispatchLineRecord {
  pickListId: string;
  pickListNo: string;
  pickListType: PickListType;
  pickListLineId: string;
  pickListLineIsAdditional: boolean;
  packingListId: string;
  packingListNo: string;
  dcId: string;
  dcNo: string;
  dcDate: Date | null;
  invoiceId: string;
  invoiceNo: string;
  salesOrderId: string;
  salesNo: string;
  clientId: string;
  clientName: string;
  styleNo: string;
  color: string;
  group: string;
  size: string;
  sleeveType: string;
  requiredQty: number;
  pickedQty: number;
  packedQty: number;
  dcQty: number;
  invoiceQty: number;
}

interface DispatchFanOutResult {
  lineRecords: DispatchLineRecord[];
  unassignedRecords: DispatchLineRecord[];
}

interface DispatchAttributionResult extends DispatchFanOutResult {
  pickLists: PickList[];
}

const EMPTY_DISPATCH_RESULT: DispatchAttributionResult = { pickLists: [], lineRecords: [], unassignedRecords: [] };

/** Order vs. dispatch fulfillment for one (salesOrder, style/color/size) SKU — the atom every report aggregates from. */
export interface SkuFulfillment {
  joinKey: string;
  salesOrderId: string;
  salesNo: string;
  clientId: string;
  clientName: string;
  agentName: string;
  designId: string;
  styleNo: string;
  color: string;
  group: string;
  size: string;
  sleeveType: string;
  orderQty: number;
  dispatchedQty: number;
  extraQty: number;
  pendingQty: number;
  /** Most recent DC touching this SKU — used by Exceed Order Report's "Dispatch / DC No." + "Dispatch Date" columns. */
  lastDcNo: string;
  lastDcDate: Date | null;
}

export interface QtyTotals {
  orderQty: number;
  dispatchedQty: number;
  extraQty: number;
  pendingQty: number;
}

export interface AggregatedRow extends QtyTotals {
  key: string;
  label: string;
  /** A representative fulfillment for this bucket — lets callers pull context fields (clientId, agentName, etc.) without a second lookup. */
  sample: SkuFulfillment;
  children?: AggregatedRow[];
}

/** Recursive so aggregate()/aggregateFrom() can compose an arbitrary-depth drill-down (e.g. Agent -> Customer -> Style) in one call. */
export interface DrillSpec {
  keyFn: (f: SkuFulfillment) => string;
  labelFn: (key: string, sample: SkuFulfillment) => string;
  drill?: DrillSpec;
}

export type PickListDisplayStatus = 'Pending' | 'Partially Picked' | 'Picked' | 'Partially Dispatched' | 'Dispatched' | 'Completed';

export interface PickListWiseRow {
  pickListId: string;
  pickListNo: string;
  pickListStatus: PickList['status'];
  createdAt: Date | null;
  clientId: string;
  clientName: string;
  agentName: string;
  salesNo: string;
  styleNo: string;
  color: string;
  group: string;
  size: string;
  sleeveType: string;
  itemType: 'Requested' | 'Additional';
  orderQty: number;
  pickedQty: number;
  dispatchedQty: number;
  extraQty: number;
  pendingQty: number;
  displayStatus: PickListDisplayStatus;
}

/** Bounded-concurrency map — avoids opening one Firestore round-trip chain per item when the in-scope set is large. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const bucketKey = (partName: string, styleNo: string, color: string, sleeveType: string, size: string) =>
  `${partName}||${styleNo}||${color}||${sleeveType}||${size}`;

const lineRecordKey = (pickListId: string, pickListLineId: string) => `${pickListId}||${pickListLineId}`;

/**
 * Shared calculation layer for every Reports tab. Computes Order Qty /
 * Dispatched Qty / Extra Dispatched Qty / Pending Qty exactly once per
 * filter change and lets each of the 7 report components aggregate the same
 * underlying `skuFulfillments()` differently (by customer, agent, style,
 * etc.) instead of re-deriving these numbers themselves.
 *
 * Scoped like ReportsDataService (provided per ReportsComponent instance,
 * not root) so every @defer'd tab shares one instance via DI and its signals
 * memoize across tab switches.
 */
@Injectable()
export class ReportCalcService {
  private readonly reportsData = inject(ReportsDataService);
  private readonly pickListService = inject(PickListService);
  private readonly packingListService = inject(PackingListService);
  private readonly dcService = inject(DeliveryChallanService);
  private readonly invoiceService = inject(InvoiceService);

  /** Scoped to the dispatch fan-out only — does NOT drive the app-wide blocking modal. Report components render their own local loading state from this. */
  readonly isLoadingDispatch = signal(false);
  readonly dispatchError = signal<string | null>(null);
  private readonly retryTrigger = signal(0);

  /** Clears the error and re-runs the last dispatch fetch (bypassing the cache, since the prior attempt for this signature failed). */
  retryDispatch(): void {
    this.dispatchError.set(null);
    this.dispatchCache.delete(this.filterSignature());
    this.retryTrigger.update((n) => n + 1);
  }

  // Cache of dispatch-attribution results keyed by the filter tuple that
  // determines order membership (date range + customer/agent/status) — lets
  // switching report tabs back and forth, or re-selecting a previously-seen
  // filter combination, reuse the fan-out result instead of re-fetching.
  // Capped like SalesOrderService's own range cache; ReportCalcService itself
  // is recreated fresh per Reports visit, so this never outlives one visit.
  private readonly dispatchCache = new Map<string, DispatchAttributionResult>();
  private static readonly MAX_DISPATCH_CACHE_ENTRIES = 20;

  private readonly filterSignature = computed(() => {
    const { start, end } = this.reportsData.dateRange();
    return `${start.getTime()}|${end.getTime()}|${this.reportsData.selectedCustomerId()}|${this.reportsData.selectedAgent()}|${this.reportsData.selectedStatus()}`;
  });

  // ── Order side ──────────────────────────────────────────────────────────
  readonly orderLines = computed<OrderLine[]>(() => {
    const clientById = this.reportsData.clientById();
    const lines: OrderLine[] = [];
    for (const order of this.reportsData.filteredOrders()) {
      const client = clientById.get(order.clientId);
      const clientName = client?.clientName ?? '';
      const agentName = client ? this.reportsData.resolveAgentName(client) : 'Unassigned';
      for (const item of order.items ?? []) {
        if (!this.reportsData.matchesItemFilters(item)) continue;
        const styleNo = this.reportsData.toText(item.design?.styleNo);
        const color = this.reportsData.toText(item.design?.color);
        const group = this.reportsData.toText(item.design?.group) || 'Other';
        const designId = this.reportsData.toText((item.design as { id?: string })?.id);
        const sleeveType = this.reportsData.toText(item.sleeveType);
        for (const size of item.itemSizes ?? []) {
          const qty = Number(size.quantity) || 0;
          if (qty <= 0) continue;
          lines.push({
            salesOrderId: order.id, salesNo: order.salesNo,
            clientId: order.clientId, clientName, agentName,
            designId, styleNo, color, group, size: size.size, sleeveType,
            orderQty: qty,
          });
        }
      }
    }
    return lines;
  });

  // ── Dispatch side ───────────────────────────────────────────────────────
  // Scope is bounded by the in-range Sales Orders' IDs, not by a Pick List's
  // own createdAt — a Pick List generated after the filtered window must
  // still contribute its full current dispatch status to that order's row
  // (dispatch reflects an order's lifetime fulfillment, not a period-bound
  // slice). Every PickListType is included (not just 'party') — the old
  // Pick List Report's type==='party' filter was incidental to that one
  // report, not a technical restriction.
  //
  // Fetched via a query-level scoped read (getPickListsByOrderIdsOnce) keyed
  // to exactly these order IDs — NOT the full pickLists collection. Reading
  // the entire collection here (as an earlier version of this service did)
  // was the root cause of the Reports page hanging behind a full-page
  // "Processing…" modal: it pulled every Pick List ever created on every
  // Reports visit before any date/filter scoping was applied.
  private readonly orderIdsInRange = computed<string[]>(() => {
    const ids = new Set<string>();
    for (const order of this.reportsData.filteredOrders()) if (order.id) ids.add(order.id);
    return [...ids];
  });

  private readonly dispatchTrigger = computed(() => ({
    orderIds: this.orderIdsInRange(),
    signature: this.filterSignature(),
    retry: this.retryTrigger(),
  }));

  private readonly dispatchRecords = toSignal(
    toObservable(this.dispatchTrigger).pipe(
      switchMap(({ orderIds, signature }) => {
        this.dispatchError.set(null);
        if (!orderIds.length) return of(EMPTY_DISPATCH_RESULT);
        const cached = this.dispatchCache.get(signature);
        if (cached) return of(cached);
        this.isLoadingDispatch.set(true);
        return from(this.loadDispatchAttribution(orderIds, signature)).pipe(
          catchError((err) => {
            console.error('Reports: failed to load dispatch data', err);
            this.dispatchError.set('Unable to load report data. Please try again.');
            return of(EMPTY_DISPATCH_RESULT);
          }),
          finalize(() => this.isLoadingDispatch.set(false))
        );
      })
    ),
    { initialValue: EMPTY_DISPATCH_RESULT }
  );

  private async loadDispatchAttribution(orderIds: string[], signature: string): Promise<DispatchAttributionResult> {
    const t0 = performance.now();
    const pickLists = await this.pickListService.getPickListsByOrderIdsOnce(orderIds);
    console.debug(`[Reports] pick lists: ${pickLists.length} for ${orderIds.length} orders in ${Math.round(performance.now() - t0)}ms`);
    const t1 = performance.now();
    const attribution = pickLists.length
      ? await this.buildDispatchAttribution(pickLists)
      : { lineRecords: [] as DispatchLineRecord[], unassignedRecords: [] as DispatchLineRecord[] };
    console.debug(`[Reports] dispatch attribution: ${attribution.lineRecords.length} lines in ${Math.round(performance.now() - t1)}ms`);
    const result: DispatchAttributionResult = { pickLists, ...attribution };

    this.dispatchCache.set(signature, result);
    if (this.dispatchCache.size > ReportCalcService.MAX_DISPATCH_CACHE_ENTRIES) {
      const oldestKey = this.dispatchCache.keys().next().value;
      if (oldestKey !== undefined) this.dispatchCache.delete(oldestKey);
    }
    return result;
  }

  // ── SKU-level fulfillment (the join) ──────────────────────────────────
  readonly skuFulfillments = computed<SkuFulfillment[]>(() => {
    const joinKey = (salesOrderId: string, styleNo: string, color: string, size: string, sleeveType: string) =>
      `${salesOrderId || '__unassigned__'}||${styleNo}||${color}||${size}||${sleeveType || ''}`;

    interface Bucket {
      orderQty: number; dispatchedQty: number; lastDcNo: string; lastDcDate: Date | null;
      sample: Omit<SkuFulfillment, 'joinKey' | 'orderQty' | 'dispatchedQty' | 'extraQty' | 'pendingQty' | 'lastDcNo' | 'lastDcDate'>;
    }
    const buckets = new Map<string, Bucket>();

    for (const line of this.orderLines()) {
      const key = joinKey(line.salesOrderId, line.styleNo, line.color, line.size, line.sleeveType);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          orderQty: 0, dispatchedQty: 0, lastDcNo: '', lastDcDate: null,
          sample: {
            salesOrderId: line.salesOrderId, salesNo: line.salesNo,
            clientId: line.clientId, clientName: line.clientName, agentName: line.agentName,
            designId: line.designId, styleNo: line.styleNo, color: line.color, group: line.group,
            size: line.size, sleeveType: line.sleeveType,
          },
        };
        buckets.set(key, bucket);
      }
      bucket.orderQty += line.orderQty;
    }

    const clientById = this.reportsData.clientById();
    const { lineRecords, unassignedRecords } = this.dispatchRecords();
    for (const rec of [...lineRecords, ...unassignedRecords]) {
      if (rec.dcQty <= 0) continue;
      if (!this.reportsData.matchesGroupAndDesign(rec.group, rec.styleNo)) continue;
      const key = joinKey(rec.salesOrderId, rec.styleNo, rec.color, rec.size, rec.sleeveType);
      let bucket = buckets.get(key);
      if (!bucket) {
        const client = clientById.get(rec.clientId);
        bucket = {
          orderQty: 0, dispatchedQty: 0, lastDcNo: '', lastDcDate: null,
          sample: {
            salesOrderId: rec.salesOrderId, salesNo: rec.salesNo,
            clientId: rec.clientId, clientName: rec.clientName || client?.clientName || '',
            agentName: client ? this.reportsData.resolveAgentName(client) : 'Unassigned',
            designId: '', styleNo: rec.styleNo, color: rec.color, group: rec.group,
            size: rec.size, sleeveType: rec.sleeveType,
          },
        };
        buckets.set(key, bucket);
      }
      bucket.dispatchedQty += rec.dcQty;
      if (rec.dcDate && (!bucket.lastDcDate || rec.dcDate > bucket.lastDcDate)) {
        bucket.lastDcDate = rec.dcDate;
        bucket.lastDcNo = rec.dcNo;
      }
    }

    return [...buckets.entries()].map(([joinKeyValue, b]) => ({
      joinKey: joinKeyValue,
      ...b.sample,
      orderQty: b.orderQty,
      dispatchedQty: b.dispatchedQty,
      extraQty: Math.max(0, b.dispatchedQty - b.orderQty),
      pendingQty: Math.max(0, b.orderQty - b.dispatchedQty),
      lastDcNo: b.lastDcNo,
      lastDcDate: b.lastDcDate,
    }));
  });

  // ── Generic aggregation ────────────────────────────────────────────────
  private summarize(fulfillments: SkuFulfillment[]): QtyTotals {
    return fulfillments.reduce(
      (acc, f) => {
        acc.orderQty += f.orderQty;
        acc.dispatchedQty += f.dispatchedQty;
        acc.extraQty += f.extraQty;
        acc.pendingQty += f.pendingQty;
        return acc;
      },
      { orderQty: 0, dispatchedQty: 0, extraQty: 0, pendingQty: 0 }
    );
  }

  /** Same as aggregate(), but operates on a caller-supplied subset — used to compose multi-level drill-downs (e.g. Agent -> Customer -> Style). */
  aggregateFrom(
    fulfillments: SkuFulfillment[],
    keyFn: (f: SkuFulfillment) => string,
    labelFn: (key: string, sample: SkuFulfillment) => string,
    drill?: DrillSpec
  ): { rows: AggregatedRow[]; grandTotal: QtyTotals } {
    const buckets = new Map<string, SkuFulfillment[]>();
    for (const f of fulfillments) {
      const key = keyFn(f) || '__unassigned__';
      const list = buckets.get(key);
      if (list) list.push(f); else buckets.set(key, [f]);
    }

    const rows: AggregatedRow[] = [...buckets.entries()]
      .map(([key, items]) => {
        const sample = items[0];
        const label = key === '__unassigned__' ? 'Unassigned' : labelFn(key, sample);
        const row: AggregatedRow = { key, label, sample, ...this.summarize(items) };
        // Recurses through drill.drill so a single aggregate() call composes
        // to any depth (e.g. Agent -> Customer -> Style) in one pass.
        if (drill) row.children = this.aggregateFrom(items, drill.keyFn, drill.labelFn, drill.drill).rows;
        return row;
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    return { rows, grandTotal: this.summarize(fulfillments) };
  }

  /** Groups the full filtered skuFulfillments() by keyFn — the entry point every report tab uses. */
  aggregate(
    keyFn: (f: SkuFulfillment) => string,
    labelFn: (key: string, sample: SkuFulfillment) => string,
    drill?: DrillSpec
  ): { rows: AggregatedRow[]; grandTotal: QtyTotals } {
    return this.aggregateFrom(this.skuFulfillments(), keyFn, labelFn, drill);
  }

  // ── Pick List Wise ─────────────────────────────────────────────────────
  readonly pickListWiseRows = computed<PickListWiseRow[]>(() => {
    const { pickLists, lineRecords } = this.dispatchRecords();
    const pickListsById = new Map(pickLists.map((pl) => [pl.id!, pl] as const));
    const clientById = this.reportsData.clientById();
    const rows: PickListWiseRow[] = [];

    for (const rec of lineRecords) {
      const pickList = pickListsById.get(rec.pickListId);
      if (!pickList) continue;
      if (!this.reportsData.matchesGroupAndDesign(rec.group, rec.styleNo)) continue;

      const client = clientById.get(rec.clientId || pickList.clientId);
      const orderQty = rec.requiredQty;
      const dispatchedQty = rec.dcQty;
      rows.push({
        pickListId: rec.pickListId, pickListNo: rec.pickListNo, pickListStatus: pickList.status,
        createdAt: this.toDate(pickList.createdAt),
        clientId: rec.clientId || pickList.clientId, clientName: rec.clientName || pickList.clientName,
        agentName: client ? this.reportsData.resolveAgentName(client) : 'Unassigned',
        salesNo: rec.salesNo, styleNo: rec.styleNo, color: rec.color, group: rec.group,
        size: rec.size, sleeveType: rec.sleeveType,
        itemType: rec.pickListLineIsAdditional ? 'Additional' : 'Requested',
        orderQty, pickedQty: rec.pickedQty, dispatchedQty,
        extraQty: Math.max(0, dispatchedQty - orderQty),
        pendingQty: Math.max(0, orderQty - dispatchedQty),
        displayStatus: this.deriveDisplayStatus(orderQty, rec.pickedQty, dispatchedQty, pickList.status),
      });
    }

    return rows.sort((a, b) => a.pickListNo.localeCompare(b.pickListNo) || a.styleNo.localeCompare(b.styleNo));
  });

  private deriveDisplayStatus(requiredQty: number, pickedQty: number, dispatchedQty: number, pickListStatus: PickList['status']): PickListDisplayStatus {
    if (requiredQty > 0 && dispatchedQty >= requiredQty) return pickListStatus === 'Completed' ? 'Completed' : 'Dispatched';
    if (dispatchedQty > 0) return 'Partially Dispatched';
    if (requiredQty > 0 && pickedQty >= requiredQty) return 'Picked';
    if (pickedQty > 0) return 'Partially Picked';
    return 'Pending';
  }

  // ── Fan-out: Pick List -> Packing List -> DC -> Invoice ────────────────
  private async buildDispatchAttribution(pickLists: PickList[]): Promise<DispatchFanOutResult> {
    const tStage1 = performance.now();
    const perPickList = await mapWithConcurrency(pickLists, 20, async (pickList) => {
      const [lines, packingLists] = await Promise.all([
        this.pickListService.getPickListLinesOnce(pickList.id!),
        this.packingListService.getPackingListsReferencingPickListOnce(pickList.id!),
      ]);
      return { pickList, lines, packingLists };
    });
    console.debug(`[Reports] fan-out stage 1 (lines+packing refs): ${pickLists.length} pick lists in ${Math.round(performance.now() - tStage1)}ms`);

    const linesByPickListId = new Map<string, PickListLine[]>();
    const lineRecords = new Map<string, DispatchLineRecord>();
    for (const { pickList, lines } of perPickList) {
      linesByPickListId.set(pickList.id!, lines);
      for (const line of lines) {
        lineRecords.set(lineRecordKey(pickList.id!, line.lineId), {
          pickListId: pickList.id!, pickListNo: pickList.pickListNo, pickListType: pickList.type,
          pickListLineId: line.lineId, pickListLineIsAdditional: !!line.isAdditional,
          packingListId: '', packingListNo: '',
          dcId: '', dcNo: '', dcDate: null,
          invoiceId: '', invoiceNo: '',
          salesOrderId: line.salesOrderId, salesNo: line.salesNo,
          clientId: line.clientId ?? pickList.clientId, clientName: line.clientName ?? pickList.clientName,
          styleNo: line.styleNo, color: line.color, group: line.group, size: line.size, sleeveType: line.sleeveType ?? '',
          requiredQty: line.isAdditional ? 0 : line.requiredQty,
          pickedQty: line.pickedQty,
          packedQty: 0, dcQty: 0, invoiceQty: 0,
        });
      }
    }

    const packingListById = new Map<string, PackingList>();
    for (const { packingLists } of perPickList) {
      for (const pl of packingLists) if (pl.id) packingListById.set(pl.id, pl);
    }
    if (!packingListById.size) return { lineRecords: [...lineRecords.values()], unassignedRecords: [] };

    const unassignedRecords: DispatchLineRecord[] = [];
    const tStage2 = performance.now();

    await mapWithConcurrency([...packingListById.values()], 20, async (packingList) => {
      const [packingLines, dcs] = await Promise.all([
        this.packingListService.getPackingListLinesOnce(packingList.id!),
        this.dcService.getDCsByPackingListIdOnce(packingList.id!),
      ]);
      const invoices = dcs.length ? await this.invoiceService.getInvoicesByDCIdsOnce(dcs.map((dc) => dc.id!)) : [];
      // A single Invoice can now consolidate several legacy per-Sales-Order
      // DCs (see InvoiceService.createInvoice) — map every one of its dcIds
      // back to it, not just the primary dcId, so each DC still attributes
      // correctly.
      const invoiceByDcId = new Map(invoices.flatMap((inv) => inv.dcIds.map((id) => [id, inv] as const)));

      // Union of PickListLines across every Pick List contributing to this
      // Packing List (not just one Pick List in isolation) — a Packing List
      // built via the "combine" flow (pickListIds.length > 1) must have its
      // DC buckets split across ALL contributing lines together, otherwise
      // each source Pick List's own pass would independently re-split the
      // same DC quantity and over-count it in aggregate.
      const contributingPickListIds = packingList.pickListIds?.length ? packingList.pickListIds : [packingList.pickListId];
      const bucketEntries: { pickListId: string; line: PickListLine }[] = [];
      for (const plId of contributingPickListIds) {
        for (const line of linesByPickListId.get(plId) ?? []) bucketEntries.push({ pickListId: plId, line });
      }

      const linesByBucket = new Map<string, { pickListId: string; line: PickListLine }[]>();
      for (const entry of bucketEntries) {
        const partName = String(entry.line.group ?? '').trim() || 'General';
        const key = bucketKey(partName, entry.line.styleNo, entry.line.color, entry.line.sleeveType ?? '', entry.line.size);
        const arr = linesByBucket.get(key);
        if (arr) arr.push(entry); else linesByBucket.set(key, [entry]);
      }

      // Packed Qty: exact, via PackingListLine.sources[].
      const packedByLineKey = new Map<string, number>();
      for (const packingLine of packingLines) {
        for (const source of packingLine.sources ?? []) {
          const key = lineRecordKey(source.pickListId, source.pickListLineId);
          packedByLineKey.set(key, (packedByLineKey.get(key) ?? 0) + source.qty);
        }
      }
      for (const entry of bucketEntries) {
        const key = lineRecordKey(entry.pickListId, entry.line.lineId);
        const rec = lineRecords.get(key);
        if (rec) rec.packedQty = packedByLineKey.get(key) ?? 0;
      }

      // Uncovered packed qty per bucket — PackingListLines added manually
      // (sources === []) or whose sources under-cover their own packedQty —
      // these get a synthetic "Unassigned" share of any DC quantity for that
      // bucket instead of silently inflating the traced lines' shares.
      const bucketTotals = new Map<string, { packed: number; sourced: number }>();
      for (const packingLine of packingLines) {
        const key = bucketKey(packingLine.partName, packingLine.styleNo, packingLine.color, packingLine.sleeveType ?? '', packingLine.size);
        const sourced = (packingLine.sources ?? []).reduce((sum, s) => sum + (Number(s.qty) || 0), 0);
        const totals = bucketTotals.get(key) ?? { packed: 0, sourced: 0 };
        totals.packed += Number(packingLine.packedQty) || 0;
        totals.sourced += sourced;
        bucketTotals.set(key, totals);
      }
      const uncoveredByBucket = new Map<string, number>();
      for (const [key, totals] of bucketTotals) {
        const uncovered = Math.max(0, totals.packed - totals.sourced);
        if (uncovered > 0) uncoveredByBucket.set(key, uncovered);
      }

      // DC/Invoice Qty: a DC groups items by (partName, styleNo, color,
      // sleeveType, size), not by Pick List line — split each bucket's
      // quantity across every matching Pick List line plus the bucket's
      // uncovered/manual share, proportional to each side's own Packed Qty.
      for (const dc of dcs) {
        const dcDate = this.toDate(dc.packedOn) ?? this.toDate(dc.createdAt);
        const invoice = dc.id ? invoiceByDcId.get(dc.id) : undefined;

        for (const item of dc.items) {
          for (const [size, rawQty] of Object.entries(item.sizeQty ?? {})) {
            const qty = Number(rawQty) || 0;
            if (qty <= 0) continue;

            const key = bucketKey(item.partName, item.styleNo, item.color, item.sleeveType ?? '', size);
            const matched = (linesByBucket.get(key) ?? []).filter(
              (entry) => !dc.salesOrderIds?.length || dc.salesOrderIds.includes(entry.line.salesOrderId)
            );
            const weights = matched.map((entry) => packedByLineKey.get(lineRecordKey(entry.pickListId, entry.line.lineId)) ?? 0);
            const uncoveredWeight = uncoveredByBucket.get(key) ?? 0;
            const totalWeight = weights.reduce((sum, w) => sum + w, 0) + uncoveredWeight;
            const equalSplitDenominator = matched.length + (uncoveredWeight > 0 ? 1 : 0);

            const applyToRecord = (rec: DispatchLineRecord, share: number) => {
              rec.dcQty += share;
              if (!rec.dcId || (dcDate && (!rec.dcDate || dcDate > rec.dcDate))) {
                rec.packingListId = packingList.id!; rec.packingListNo = packingList.packingListNo;
                rec.dcId = dc.id ?? rec.dcId; rec.dcNo = dc.dcNo; rec.dcDate = dcDate ?? rec.dcDate;
              }
              if (invoice) {
                rec.invoiceQty += share;
                rec.invoiceId = invoice.id ?? rec.invoiceId; rec.invoiceNo = invoice.invoiceNo ?? rec.invoiceNo;
              }
            };

            if (!matched.length && uncoveredWeight <= 0) {
              // No traceable line and no manual-packing evidence at all — still
              // never dropped, surfaces as a fully-unassigned dispatch record.
              unassignedRecords.push({
                pickListId: '', pickListNo: '', pickListType: 'direct', pickListLineId: '', pickListLineIsAdditional: false,
                packingListId: packingList.id ?? '', packingListNo: packingList.packingListNo,
                dcId: dc.id ?? '', dcNo: dc.dcNo, dcDate,
                invoiceId: invoice?.id ?? '', invoiceNo: invoice?.invoiceNo ?? '',
                salesOrderId: dc.salesOrderIds?.[0] ?? packingList.salesOrderIds?.[0] ?? '',
                salesNo: dc.salesNos?.[0] ?? packingList.salesNos?.[0] ?? '',
                clientId: packingList.clientId, clientName: packingList.clientName,
                styleNo: item.styleNo, color: item.color, group: item.partName, size, sleeveType: item.sleeveType ?? '',
                requiredQty: 0, pickedQty: 0, packedQty: qty, dcQty: qty, invoiceQty: invoice ? qty : 0,
              });
              continue;
            }

            matched.forEach((entry, i) => {
              const share = totalWeight > 0 ? (qty * weights[i]) / totalWeight : qty / equalSplitDenominator;
              const rec = lineRecords.get(lineRecordKey(entry.pickListId, entry.line.lineId));
              if (rec) applyToRecord(rec, share);
            });

            if (uncoveredWeight > 0) {
              const share = totalWeight > 0 ? (qty * uncoveredWeight) / totalWeight : qty / equalSplitDenominator;
              unassignedRecords.push({
                pickListId: '', pickListNo: '', pickListType: 'direct', pickListLineId: '', pickListLineIsAdditional: false,
                packingListId: packingList.id ?? '', packingListNo: packingList.packingListNo,
                dcId: dc.id ?? '', dcNo: dc.dcNo, dcDate,
                invoiceId: invoice?.id ?? '', invoiceNo: invoice?.invoiceNo ?? '',
                salesOrderId: dc.salesOrderIds?.[0] ?? packingList.salesOrderIds?.[0] ?? '',
                salesNo: dc.salesNos?.[0] ?? packingList.salesNos?.[0] ?? '',
                clientId: packingList.clientId, clientName: packingList.clientName,
                styleNo: item.styleNo, color: item.color, group: item.partName, size, sleeveType: item.sleeveType ?? '',
                requiredQty: 0, pickedQty: 0, packedQty: share, dcQty: share, invoiceQty: invoice ? share : 0,
              });
            }
          }
        }
      }
    });
    console.debug(`[Reports] fan-out stage 2 (packing lines+DCs+invoices): ${packingListById.size} packing lists in ${Math.round(performance.now() - tStage2)}ms`);

    return { lineRecords: [...lineRecords.values()], unassignedRecords };
  }

  private toDate(raw: any): Date | null {
    if (!raw) return null;
    try {
      const date = raw?.toDate ? raw.toDate() : new Date(raw);
      return Number.isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }
}
