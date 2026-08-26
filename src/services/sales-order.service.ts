import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  orderBy,
  where,
  Timestamp,
  serverTimestamp
} from '@angular/fire/firestore';

import type { SalesOrder } from '../models/sales-order.model';
import { from, Observable, shareReplay } from 'rxjs';
import { fetchAllDocs } from './firestore-pagination.util';

@Injectable({ providedIn: 'root' })
export class SalesOrderService {

    private firestore = inject(Firestore);
    private salesOrderRef = collection(this.firestore, 'salesOrders');

    // The full unbounded list is read repeatedly (Pick List screen, Sales Order's
    // own "All" view, every write-triggered refresh) — cached one-time read,
    // invalidated by this service's own create/update/delete below, same pattern
    // as ClientService/DesignService/InventoryService.
    private salesOrdersCache$: Observable<SalesOrder[]> | null = null;

    // getSalesOrdersInRange() is keyed by exact (start, end) pair rather than
    // a single cached value, since different callers legitimately want
    // different ranges — but the common case (Sales Order/Dashboard/Reports
    // all default to "current month", and users frequently navigate back to
    // the same screen without changing the filter) previously re-paid a full
    // paginated Firestore read on every single visit. Capped to avoid
    // unbounded growth in a long-lived SPA session — cleared wholesale if it
    // ever grows past a generous bound rather than tracking per-entry LRU.
    private salesOrdersRangeCache = new Map<string, Observable<SalesOrder[]>>();
    private static readonly MAX_RANGE_CACHE_ENTRIES = 30;

    // Public: PickListService.syncSalesOrderShipment() writes salesOrders/{id}.status
    // directly (auto-marking an order Shipped once fully picked) without going through
    // this service, and must invalidate this cache too or the Pick List screen would
    // keep showing the pre-shipment status until an unrelated cache refresh.
    invalidateCache(): void {
        this.salesOrdersCache$ = null;
        this.salesOrdersRangeCache.clear();
    }

    private buildSalesOrder(
        order: Omit<SalesOrder, 'id' | 'status' | 'orderDate'>
    ): Omit<SalesOrder, 'id'> {
        return {
            ...order,
            salesNo: `SO-${Date.now()}`,
            status: 'Pending',
            orderDate: new Date().toISOString().split('T')[0]
        } as Omit<SalesOrder, 'id'>;
    }

    // One-time read, paged through in full via fetchAllDocs() — a prior fixed
    // limit(100) here silently truncated the list once sales orders passed
    // that count. Every screen that lists sales orders just snapshots into a
    // signal/array and manually reloads after its own writes, so a standing
    // realtime listener buys nothing but extra reads on every remote change.
    //
    // No orderBy() here (deliberately): Firestore excludes any document that
    // lacks the ordered-by field from the ENTIRE result set, not just from the
    // ordering — so any legacy/edited-outside-the-app sales order missing
    // `createdAt` would silently vanish from every screen and report that
    // reads this method (same bug class as the Design Master export issue).
    // Sorted client-side instead, which has no such requirement.
    getSalesOrders(): Observable<SalesOrder[]> {
        if (!this.salesOrdersCache$) {
            this.salesOrdersCache$ = from(
                fetchAllDocs(this.salesOrderRef, [], (d) =>
                    // Spread doc data first, then override with the real Firestore doc id last —
                    // some legacy documents have a stale/blank "id" field stored in their body
                    // (see createSalesOrder), which must never win over the actual doc reference id.
                    ({ ...d.data(), id: d.id } as SalesOrder)
                ).then(async orders => {
                    await this.healMissingCreatedAt(orders);
                    return orders.sort((a, b) => this.toMillis(b.createdAt) - this.toMillis(a.createdAt));
                })
            ).pipe(shareReplay(1));
        }
        return this.salesOrdersCache$;
    }

    /**
     * Treats a missing/unparseable createdAt as 0 (oldest) instead of throwing or
     * excluding the doc. Also recovers the exact original instant from a corrupted
     * {seconds, nanoseconds, ...} map (see updateSalesOrder) rather than treating
     * it as unparseable — that map still holds the true original value, it's just
     * no longer a real Timestamp type as far as Firestore is concerned.
     */
    private toMillis(value: unknown): number {
        const raw: any = value;
        if (raw && typeof raw.toDate === 'function') return raw.toDate().getTime();
        if (raw instanceof Date) return raw.getTime();
        if (raw && typeof raw.seconds === 'number') {
            return raw.seconds * 1000 + Math.round((raw.nanoseconds ?? 0) / 1e6);
        }
        if (raw) {
            const parsed = new Date(raw).getTime();
            if (!Number.isNaN(parsed)) return parsed;
        }
        return 0;
    }

    /** True only for a real Firestore Timestamp or JS Date — false for a missing value or a corrupted plain map/string/number, which Firestore can't range-query the same way. */
    private isValidTimestampType(value: unknown): boolean {
        const raw: any = value;
        return !!raw && (typeof raw.toDate === 'function' || raw instanceof Date);
    }

    // Self-heal: any order whose createdAt is missing, or has been corrupted into a
    // plain {seconds, nanoseconds} map (see updateSalesOrder), is invisible to
    // getSalesOrdersInRange() — the where('createdAt', ...) queries used by Reports,
    // Dashboard, and Sales Order's own date-filtered view require a real Timestamp
    // to match against, and silently exclude any doc where the field is absent or
    // the wrong type. This only ever runs from this unbounded "All" read, which
    // already fetches every doc regardless — so it costs no extra reads, only
    // repairs the (hopefully rare) broken ones, and patches the in-memory result
    // too so this same read reflects the fix immediately.
    private async healMissingCreatedAt(orders: SalesOrder[]): Promise<void> {
        const broken = orders.filter(o => !this.isValidTimestampType(o.createdAt));
        if (broken.length === 0) return;

        await Promise.all(broken.map(async order => {
            // A corrupted map still carries the true original value — recover it
            // exactly rather than falling back to an approximation.
            const recoveredMillis = this.toMillis(order.createdAt);
            const repairedDate = recoveredMillis > 0 ? new Date(recoveredMillis) : this.bestEffortCreatedAt(order);
            const timestamp = Timestamp.fromDate(repairedDate);
            try {
                await updateDoc(doc(this.firestore, `salesOrders/${order.id}`), { createdAt: timestamp });
                (order as unknown as { createdAt: unknown }).createdAt = timestamp;
            } catch {
                // Best-effort only — if the write fails (e.g. permissions), leave the
                // doc as-is; it'll simply be retried the next time this method runs.
            }
        }));
    }

    /** Falls back to the order's own orderDate/deliveryDate before resorting to "now". */
    private bestEffortCreatedAt(order: SalesOrder): Date {
        const orderDate = (order as unknown as { orderDate?: string }).orderDate;
        const parsedOrderDate = orderDate ? new Date(orderDate) : null;
        if (parsedOrderDate && !Number.isNaN(parsedOrderDate.getTime())) return parsedOrderDate;

        const parsedDeliveryDate = order.deliveryDate ? new Date(order.deliveryDate) : null;
        if (parsedDeliveryDate && !Number.isNaN(parsedDeliveryDate.getTime())) return parsedDeliveryDate;

        return new Date();
    }

    // 🔹 Date-bounded one-time query for reports, paged through in full via
    // fetchAllDocs() — a prior fixed limit(5000) here would have silently
    // dropped orders from a report's totals once a date range held more rows
    // than that. Avoids leaving a listener open while a report is viewed.
    // Cached per exact (start, end) pair — see salesOrdersRangeCache above.
    // clientId narrows the query at the Firestore level (requires the
    // composite index on clientId+createdAt in firestore.indexes.json) when a
    // single customer is selected in Reports, instead of pulling the whole
    // date range and filtering client-side.
    getSalesOrdersInRange(start: Date, end: Date, clientId?: string): Observable<SalesOrder[]> {
        const key = `${start.getTime()}_${end.getTime()}_${clientId ?? ''}`;
        let cached = this.salesOrdersRangeCache.get(key);
        if (!cached) {
            if (this.salesOrdersRangeCache.size >= SalesOrderService.MAX_RANGE_CACHE_ENTRIES) {
                this.salesOrdersRangeCache.clear();
            }
            const constraints = [
                where('createdAt', '>=', Timestamp.fromDate(start)),
                where('createdAt', '<=', Timestamp.fromDate(end)),
                ...(clientId ? [where('clientId', '==', clientId)] : []),
                orderBy('createdAt', 'desc'),
            ];
            cached = from(
                fetchAllDocs(
                    this.salesOrderRef,
                    constraints,
                    (d) => ({ ...d.data(), id: d.id } as SalesOrder)
                )
            ).pipe(shareReplay(1));
            this.salesOrdersRangeCache.set(key, cached);
        }
        return cached;
    }

    // 🔹 Create sales order
    // async createSalesOrder(order: SalesOrder): Promise<void> {
    //     await addDoc(this.salesOrderRef, {
    //         ...order,
    //         createdAt: serverTimestamp(),
    //         updatedAt: serverTimestamp()
    //     });
    // }
    createSalesOrder(
        order: Omit<SalesOrder, 'id' | 'status' | 'orderDate'>
    ): Observable<SalesOrder> {
        const promise = (async () => {
            // Pre-allocate the doc ref so the real Firestore id can be stored in the
            // document body too, instead of the old placeholder id:"" that used to get
            // written and then clobber the real id on every subsequent read.
            const docRef = doc(this.salesOrderRef);
            const newOrder: SalesOrder = { ...this.buildSalesOrder(order), id: docRef.id };
            await setDoc(docRef, {
                ...newOrder,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            this.invalidateCache();
            return newOrder;
        })();

        return from(promise);
    }

    // 🔹 Update sales order
    updateSalesOrder(order: SalesOrder): Observable<void> {
        // Wrapped in an async IIFE so any synchronous error (e.g. an invalid/missing
        // doc id, or a Firestore rejection on undefined field values) becomes a
        // rejected promise routed through the caller's error handler, instead of
        // throwing before subscribe() ever attaches — which previously left the
        // "Updating..." loading dialog stuck forever with nothing saved.
        const promise = (async () => {
            if (!order.id) {
                throw new Error('Cannot update sales order: missing document ID.');
            }
            // createdAt must never be part of an update payload. The caller's `order`
            // came from a previously-fetched doc, so its createdAt is a real Firestore
            // Timestamp instance — but Timestamp defines toJSON() (for SSR/serialization
            // support), so round-tripping the WHOLE order through JSON.stringify/parse
            // below silently turns that Timestamp into a plain {seconds, nanoseconds,
            // type} object. Writing that back stores createdAt as an ordinary Firestore
            // map instead of a Timestamp, which then fails to match every subsequent
            // where('createdAt', ...) range query used by date filtering/sorting/Reports
            // — exactly the "createdAt sometimes wrong" bug reported against this app.
            // createdAt is immutable after creation, so it's simply never touched here.
            const { createdAt, ...updatable } = order;
            // Strip any stray undefined values (Firestore rejects them) before writing.
            const sanitized = JSON.parse(JSON.stringify(updatable));
            await updateDoc(doc(this.firestore, `salesOrders/${order.id}`), {
                ...sanitized,
                updatedAt: serverTimestamp()
            });
            this.invalidateCache();
        })();

        return from(promise);
    }

    // 🔹 Delete sales order
    async deleteSalesOrder(orderId: string): Promise<void> {
        const orderDoc = doc(this.firestore, `salesOrders/${orderId}`);
        await deleteDoc(orderDoc);
        this.invalidateCache();
    }
}