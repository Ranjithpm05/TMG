import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  documentId,
  increment,
  limit,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from '@angular/fire/firestore';
import { getDocs, runTransaction } from './firestore-reads';
import { Observable, firstValueFrom } from 'rxjs';
import { DCBalanceClosure, DCDelivery, DCDeliveryItem, DCItem, DeliveryChallan } from '../models/delivery-challan.model';
import { PackingListService } from './packing-list.service';
import { ClientService } from './client.service';
import { InventoryService } from './inventory.service';
import { balanceItemSizeQty, buildDeliveryItems, deliveryPatch } from './dc-delivery.util';
import { invalidateRangeCaches, syncedRangeQuery } from './range-cache.util';
import { SyncedCollectionCache, byCreatedAtDesc } from './synced-collection-cache.util';

@Injectable({ providedIn: 'root' })
export class DeliveryChallanService {
  private firestore = inject(Firestore);
  private packingListService = inject(PackingListService);
  private clientService = inject(ClientService);
  private inventoryService = inject(InventoryService);
  private dcRef = collection(this.firestore, 'deliveryChallans');

  // Read repeatedly (Packing List and e-Invoice screens, every DC-generation
  // refresh) — cached one-time read, invalidated by createDC/updateDCItems below,
  // same pattern as ClientService/DesignService/InventoryService.
  // Synced via updatedAt delta queries (SyncedCollectionCache) — see there.
  private readonly dcsCache = new SyncedCollectionCache<DeliveryChallan>({
    storageKey: 'deliveryChallans',
    collectionRef: this.dcRef,
    constraints: [orderBy('createdAt', 'desc')],
    requiredField: 'createdAt',
    mapDoc: (d) => this.normalize({ id: d.id, ...d.data() }),
    compare: byCreatedAtDesc,
  });

  // getDeliveryChallansInRange() is keyed by exact (start, end) pair — same
  // reasoning as SalesOrderService.salesOrdersRangeCache. Dashboard previously
  // called getDeliveryChallans() (the full, ever-growing history) just to
  // filter it down to one date range client-side.
  private dcsRangeCache = new Map<string, SyncedCollectionCache<DeliveryChallan>>();
  private static readonly MAX_RANGE_CACHE_ENTRIES = 30;

  // Public: InvoiceService.createInvoice() stamps invoiceId/invoiceNo directly
  // onto a deliveryChallans/{id} doc in the same transaction as creating the
  // invoice, without going through this service — it must invalidate this
  // cache too or the DC would keep showing as not-yet-invoiced.
  invalidateCache(): void {
    this.dcsCache.invalidate();
    invalidateRangeCaches(this.dcsRangeCache);
  }

  // One-time read, paged through in full via fetchAllDocs() — a prior fixed
  // limit(100) here silently truncated the list once delivery challans passed
  // that count. The Packing List screen snapshots this into a local list.
  getDeliveryChallans(): Observable<DeliveryChallan[]> {
    return this.dcsCache.get$();
  }

  // Date-bounded one-time query — see getDeliveryChallans() above for why this
  // exists. Cached per exact (start, end) pair; see dcsRangeCache above.
  getDeliveryChallansInRange(start: Date, end: Date, options?: { cachedFirst?: boolean }): Observable<DeliveryChallan[]> {
    return syncedRangeQuery({
      cache: this.dcsRangeCache,
      collectionName: 'deliveryChallans',
      collectionRef: this.dcRef,
      start,
      end,
      mapDoc: (d) => this.normalize({ id: d.id, ...d.data() }),
      maxEntries: DeliveryChallanService.MAX_RANGE_CACHE_ENTRIES,
      cachedFirst: options?.cachedFirst,
    });
  }

  async getDCsByPackingListIdOnce(packingListId: string): Promise<DeliveryChallan[]> {
    const snap = await getDocs(query(this.dcRef, where('packingListId', '==', packingListId)));
    return snap.docs.map((d) => this.normalize({ id: d.id, ...d.data() }));
  }

  // Batched form of getDCsByPackingListIdOnce() — scoped to a whole set of
  // Packing List ids in one chunked round trip instead of one query per
  // Packing List (Firestore bills a zero-match query as a read, so looping
  // this per Packing List — as Reports used to — burned a read for every
  // not-yet-dispatched Packing List with nothing to show for it). Same
  // chunking pattern as getDCsByPackingListIdOnce's callers /
  // InvoiceService.getInvoicesByDCIdsOnce.
  async getDCsByPackingListIdsOnce(packingListIds: string[]): Promise<DeliveryChallan[]> {
    const uniqueIds = [...new Set(packingListIds.filter(Boolean))];
    if (!uniqueIds.length) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += 30) chunks.push(uniqueIds.slice(i, i + 30));
    const results = await Promise.all(
      chunks.map((chunk) => getDocs(query(this.dcRef, where('packingListId', 'in', chunk))))
    );
    const byId = new Map<string, DeliveryChallan>();
    for (const snap of results) {
      for (const d of snap.docs) {
        byId.set(d.id, this.normalize({ id: d.id, ...d.data() }));
      }
    }
    return [...byId.values()];
  }

  // Every DC covering any of a set of Sales Orders — Reports' dispatched-qty
  // source (ReportCalcService.loadDcDispatch), which used to reach DCs only
  // via Pick List -> Packing List and read every line of both on the way.
  // Matches the `salesOrderIds` array and the legacy singular `salesOrderId`
  // (see normalize()), deduped by id.
  async getDCsBySalesOrderIdsOnce(salesOrderIds: string[]): Promise<DeliveryChallan[]> {
    const uniqueIds = [...new Set(salesOrderIds.filter(Boolean))];
    if (!uniqueIds.length) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += 30) chunks.push(uniqueIds.slice(i, i + 30));
    const results = await Promise.all(
      chunks.flatMap((chunk) => [
        getDocs(query(this.dcRef, where('salesOrderIds', 'array-contains-any', chunk))),
        getDocs(query(this.dcRef, where('salesOrderId', 'in', chunk))),
      ])
    );
    const byId = new Map<string, DeliveryChallan>();
    for (const snap of results) {
      for (const d of snap.docs) {
        byId.set(d.id, this.normalize({ id: d.id, ...d.data() }));
      }
    }
    return [...byId.values()];
  }

  // Batched lookup by document id — used to re-derive Invoice line data
  // (e.g. styleNo/sleeveType, see InvoiceService.backfillItemDesignInfoIfNeeded)
  // from the DC(s) an Invoice was originally built from.
  async getDCsByIdsOnce(dcIds: string[]): Promise<DeliveryChallan[]> {
    const uniqueIds = [...new Set(dcIds.filter(Boolean))];
    if (!uniqueIds.length) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += 30) chunks.push(uniqueIds.slice(i, i + 30));
    const results = await Promise.all(
      chunks.map((chunk) => getDocs(query(this.dcRef, where(documentId(), 'in', chunk))))
    );
    const byId = new Map<string, DeliveryChallan>();
    for (const snap of results) {
      for (const d of snap.docs) {
        byId.set(d.id, this.normalize({ id: d.id, ...d.data() }));
      }
    }
    return [...byId.values()];
  }

  // Atomically enforces "at most one DC per Packing List" — a plain
  // check-then-create (even with a fresh Firestore read right before) still
  // has a race window between two near-simultaneous calls (double click, two
  // tabs). A transaction closes it: the packing list doc's `dcGeneratedKeys`
  // array is read and verified inside the same transaction that creates the
  // DC and appends a marker, so Firestore aborts/retries one of two
  // concurrent attempts instead of letting both succeed. Throws
  // 'already_has_dc' if this packing list already has any DC — this also
  // correctly blocks a 3rd DC on packing lists that already accumulated
  // multiple DCs under the old per-Sales-Order scheme, since it only checks
  // array length, not the (legacy) key contents. Callers should surface a
  // clear message rather than silently creating a duplicate. Pass
  // `allowDuplicate: true` only for an explicit, user-confirmed "Generate
  // New DC" override (past a warning dialog) — the default stays guarded so
  // an accidental double-click can't silently create a second DC.
  async createDC(
    input: Omit<DeliveryChallan, 'id' | 'dcNo' | 'dcSeq' | 'packedOn' | 'createdAt' | 'updatedAt'>,
    options?: { allowDuplicate?: boolean },
  ): Promise<DeliveryChallan> {
    const dcKey = 'DC';
    const packingListRef = doc(this.firestore, `packingLists/${input.packingListId}`);
    const counterRef = doc(this.firestore, 'counters/dcCounter');
    const dcDocRef = doc(this.dcRef);
    const fyCode = this.getFyCode();

    const data = await runTransaction(this.firestore, async (transaction) => {
      const packingSnap = await transaction.get(packingListRef);
      if (!packingSnap.exists()) throw new Error('packinglist_not_found');

      const existingKeys: string[] = Array.isArray(packingSnap.data()?.['dcGeneratedKeys'])
        ? packingSnap.data()!['dcGeneratedKeys']
        : [];
      if (existingKeys.length > 0 && !options?.allowDuplicate) throw new Error('already_has_dc');

      const counterSnap = await transaction.get(counterRef);
      const currentSeq = counterSnap.exists() ? (Number(counterSnap.data()?.['seq']) || 0) : 0;
      const nextSeq = currentSeq + 1;

      const dcData = this.stripUndefined({
        ...input,
        dcNo: `DCC${fyCode}-${String(nextSeq).padStart(4, '0')}`,
        dcSeq: nextSeq,
        packedOn: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      transaction.set(dcDocRef, dcData);
      transaction.update(packingListRef, {
        dcGeneratedKeys: [...new Set([...existingKeys, dcKey])],
        updatedAt: serverTimestamp(),
      });
      if (counterSnap.exists()) {
        transaction.update(counterRef, { seq: nextSeq, updatedAt: serverTimestamp() });
      } else {
        transaction.set(counterRef, { seq: nextSeq, fy: fyCode, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }

      return dcData;
    });

    this.invalidateCache();
    // This transaction also stamped dcGeneratedKeys onto the source Packing
    // List doc — invalidate its cached list too so a subsequent Packing List
    // screen visit doesn't show stale dcGeneratedKeys/lock state.
    this.packingListService.invalidateCache();
    return { id: dcDocRef.id, ...data };
  }

  // Corrects data-quality gaps (e.g. sleeveType missing on DCs generated
  // before that field existed) without touching quantities/totals — callers
  // pass back the same items array with only the gap fields filled in.
  async updateDCItems(dcId: string, items: DCItem[]): Promise<void> {
    await updateDoc(doc(this.dcRef, dcId), this.stripUndefined({ items, updatedAt: serverTimestamp() }));
    this.invalidateCache();
  }

  // A DC stores a snapshot of the customer's name/address taken when it was
  // generated, so a later Client Master correction never reached the printed
  // DC (e.g. SARAVANA STORES renamed to "SARAVANA STORES (TEX) - SHOPn" and
  // its blank address filled in). Called before every DC print so the Client
  // Master is always the source of truth: persists only the fields that
  // differ. A DC is a shipping document, so it carries the Ship To address
  // (falling back to Bill To). A blank master field keeps the DC's value.
  async syncClientFromMaster(dc: DeliveryChallan): Promise<DeliveryChallan> {
    if (!dc.id || !dc.clientId) return dc;

    const client = await this.clientService.getClientForDC(dc.clientId, dc.clientName);
    if (!client) return dc;

    const master: Partial<DeliveryChallan> = {
      clientName: client.clientName || dc.clientName,
      billingAddress: client.shipToAddress || client.billingAddress || dc.billingAddress,
      place: client.shipToPlace || client.place || dc.place,
      state: client.shipToState || client.state || dc.state,
      zipCode: client.shipToZipCode || client.zipCode || dc.zipCode,
      clientPhone: client.mobile || dc.clientPhone,
      clientGstin: client.gstNo || dc.clientGstin,
    };
    const patch = Object.fromEntries(
      Object.entries(master).filter(([key, value]) => (dc as any)[key] !== value)
    ) as Partial<DeliveryChallan>;
    if (!Object.keys(patch).length) return dc;

    await updateDoc(doc(this.dcRef, dc.id), this.stripUndefined({ ...patch, updatedAt: serverTimestamp() }));
    this.invalidateCache();
    return { ...dc, ...patch };
  }

  // Explicitly closes a DC's undelivered balance (the "remaining qty is
  // cancelled" case — never automatic) and returns those pieces to inventory:
  // they were deducted from currentStock at packing completion
  // (PackingListService.deductInventoryOnCompletion), so leaving them deducted
  // would lose them from stock for good. Inventory records are resolved from
  // the DC's Packing List lines (inventoryId, else barcode), falling back to a
  // styleNo/color/sleeve/size match, before the transaction (queries can't run
  // inside one); the balance itself is re-read and recomputed inside it, so a
  // delivery saved from another tab in the meantime can't be returned twice.
  // Pieces that can't be matched to an inventory record are still closed but
  // reported back in `unreturned`, so the caller can tell the user.
  async closeBalance(dcId: string, reason: string): Promise<{ dc: DeliveryChallan; returnedQty: number; unreturned: string[] }> {
    const dcDocRef = doc(this.dcRef, dcId);
    const before = (await this.getDCsByIdsOnce([dcId]))[0];
    if (!before) throw new Error('dc_not_found');

    const keyOf = (styleNo: string, color: string, sleeveType: string | undefined, size: string) =>
      `${styleNo}|${color}|${sleeveType ?? ''}|${size}`.toUpperCase();
    const inventoryIdByKey = new Map<string, string>();
    const barcodeByKey = new Map<string, string>();
    const lines = before.packingListId ? await this.packingListService.getPackingListLinesOnce(before.packingListId) : [];
    for (const line of lines) {
      const key = keyOf(line.styleNo, line.color, line.sleeveType, line.size);
      if (line.inventoryId && !inventoryIdByKey.has(key)) inventoryIdByKey.set(key, line.inventoryId);
      else if (line.barcode && !barcodeByKey.has(key)) barcodeByKey.set(key, line.barcode);
    }
    const byBarcode = [...barcodeByKey.entries()].filter(([key]) => !inventoryIdByKey.has(key));
    if (byBarcode.length) {
      const found = await this.inventoryService.getInventoryByBarcodes(byBarcode.map(([, barcode]) => barcode));
      for (const [key, barcode] of byBarcode) {
        const inv = found.find((i) => i.barcode === barcode && i.id);
        if (inv) inventoryIdByKey.set(key, inv.id!);
      }
    }
    const pending = balanceItemSizeQty(before);
    const balanceKeys = before.items.flatMap((item, itemIndex) =>
      Object.keys(pending[itemIndex] ?? {}).map((size) => keyOf(item.styleNo, item.color, item.sleeveType, size)));
    if (balanceKeys.some((key) => !inventoryIdByKey.has(key))) {
      for (const inv of await firstValueFrom(this.inventoryService.getInventory())) {
        const key = keyOf(inv.styleNo, inv.color, inv.sleeveType, inv.size);
        if (inv.id && !inventoryIdByKey.has(key)) inventoryIdByKey.set(key, inv.id);
      }
    }

    const result = await runTransaction(this.firestore, async (transaction) => {
      const snap = await transaction.get(dcDocRef);
      if (!snap.exists()) throw new Error('dc_not_found');
      const dc = this.normalize({ id: snap.id, ...snap.data() });
      if (dc.balanceClosure) throw new Error('balance_already_closed');
      const items: DCDeliveryItem[] = buildDeliveryItems(dc, balanceItemSizeQty(dc));
      const totalQty = items.reduce((s, i) => s + i.total, 0);
      if (totalQty <= 0) throw new Error('no_balance');

      const returns = new Map<string, number>();
      const unreturned: string[] = [];
      for (const item of items) {
        for (const [size, qty] of Object.entries(item.sizeQty)) {
          const inventoryId = inventoryIdByKey.get(keyOf(item.styleNo, item.color, item.sleeveType, size));
          if (inventoryId) returns.set(inventoryId, (returns.get(inventoryId) ?? 0) + qty);
          else unreturned.push(`${item.styleNo} ${item.color} ${item.sleeveType ?? ''} size ${size} × ${qty}`.replace(/\s+/g, ' '));
        }
      }
      const invEntries = [...returns.entries()];
      const invSnaps = await Promise.all(invEntries.map(([id]) => transaction.get(doc(this.firestore, `inventory/${id}`))));
      let returnedQty = 0;
      invEntries.forEach(([id, qty], i) => {
        if (!invSnaps[i].exists()) {
          unreturned.push(`inventory record ${id} × ${qty}`);
          return;
        }
        transaction.update(invSnaps[i].ref, { currentStock: increment(qty), updatedAt: serverTimestamp() });
        returnedQty += qty;
      });

      const balanceClosure: DCBalanceClosure = {
        closedDate: Timestamp.now(),
        items,
        totalQty,
        reason: reason.trim(),
        returnedToStock: unreturned.length === 0,
      };
      const closed = { ...dc, balanceClosure };
      const patch = { balanceClosure, ...deliveryPatch(closed) };
      transaction.update(dcDocRef, this.stripUndefined({ ...patch, updatedAt: serverTimestamp() }));
      return { dc: { ...closed, ...patch }, returnedQty, unreturned };
    });

    this.invalidateCache();
    if (result.returnedQty > 0) this.inventoryService.invalidateCache();
    return result;
  }

  // Exposed for InvoiceService's delivery transactions, which read DC docs
  // directly via transaction.get() and need the same parsing.
  fromSnapshotData(id: string, data: any): DeliveryChallan {
    return this.normalize({ id, ...data });
  }

  private stripUndefined<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.filter((entry) => entry !== undefined).map((entry) => this.stripUndefined(entry)) as T;
    }
    if (value && typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return value;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .map(([key, entry]) => [key, this.stripUndefined(entry)])
      ) as T;
    }
    return value;
  }

  private getFyCode(): string {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const fyStart = month >= 4 ? year : year - 1;
    const fyEnd = fyStart + 1;
    return `${String(fyStart).slice(2)}${String(fyEnd).slice(2)}`;
  }

  private normalize(raw: any): DeliveryChallan {
    return {
      id: raw?.id,
      dcNo: String(raw?.dcNo ?? ''),
      dcSeq: Number(raw?.dcSeq) || 0,
      packingListId: String(raw?.packingListId ?? ''),
      packingListNo: String(raw?.packingListNo ?? ''),
      salesOrderIds: Array.isArray(raw?.salesOrderIds)
        ? raw.salesOrderIds.map((s: any) => String(s))
        : (raw?.salesOrderId ? [String(raw.salesOrderId)] : []),
      salesNos: Array.isArray(raw?.salesNos)
        ? raw.salesNos.map((s: any) => String(s))
        : (raw?.salesNo ? [String(raw.salesNo)] : []),
      orderNo: String(raw?.orderNo ?? ''),
      clientId: String(raw?.clientId ?? ''),
      clientName: String(raw?.clientName ?? ''),
      billingAddress: String(raw?.billingAddress ?? ''),
      place: String(raw?.place ?? ''),
      state: String(raw?.state ?? ''),
      zipCode: String(raw?.zipCode ?? ''),
      clientPhone: String(raw?.clientPhone ?? ''),
      clientGstin: String(raw?.clientGstin ?? ''),
      packedOn: raw?.packedOn,
      totalQty: Number(raw?.totalQty) || 0,
      boxCount: Number(raw?.boxCount) || 0,
      agentName: String(raw?.agentName ?? ''),
      transport: String(raw?.transport ?? ''),
      transportId: raw?.transportId ? String(raw.transportId) : undefined,
      transportAddress: raw?.transportAddress ? String(raw.transportAddress) : undefined,
      transportGstNo: raw?.transportGstNo ? String(raw.transportGstNo) : undefined,
      items: Array.isArray(raw?.items)
        ? raw.items.map((item: any): DCItem => ({
            partName: String(item?.partName ?? ''),
            styleNo: String(item?.styleNo ?? ''),
            color: String(item?.color ?? ''),
            sleeveType: item?.sleeveType ? String(item.sleeveType) : undefined,
            sizeQty: item?.sizeQty && typeof item.sizeQty === 'object' ? item.sizeQty : {},
            total: Number(item?.total) || 0,
            mrp: Number(item?.mrp) || 0,
            mrpBySize: item?.mrpBySize && typeof item.mrpBySize === 'object' ? item.mrpBySize : undefined,
            price: Number(item?.price) || 0,
            amount: Number(item?.amount) || 0,
          }))
        : [],
      sizes: Array.isArray(raw?.sizes) ? raw.sizes.map((s: any) => String(s)) : [],
      totalAmount: Number(raw?.totalAmount) || 0,
      invoiceId: raw?.invoiceId ? String(raw.invoiceId) : undefined,
      invoiceNo: raw?.invoiceNo ? String(raw.invoiceNo) : undefined,
      deliveries: Array.isArray(raw?.deliveries)
        ? raw.deliveries.map((d: any): DCDelivery => ({
            deliveryId: String(d?.deliveryId ?? ''),
            deliveryNo: Number(d?.deliveryNo) || 0,
            deliveryDate: d?.deliveryDate,
            items: this.normalizeDeliveryItems(d?.items),
            totalQty: Number(d?.totalQty) || 0,
            totalAmount: Number(d?.totalAmount) || 0,
            boxCount: d?.boxCount != null ? Number(d.boxCount) || 0 : undefined,
            invoiceId: d?.invoiceId ? String(d.invoiceId) : undefined,
            invoiceNo: d?.invoiceNo ? String(d.invoiceNo) : undefined,
            remarks: d?.remarks ? String(d.remarks) : undefined,
            createdAt: d?.createdAt,
          }))
        : undefined,
      balanceClosure: raw?.balanceClosure
        ? {
            closedDate: raw.balanceClosure.closedDate,
            items: this.normalizeDeliveryItems(raw.balanceClosure.items),
            totalQty: Number(raw.balanceClosure.totalQty) || 0,
            reason: String(raw.balanceClosure.reason ?? ''),
            returnedToStock: raw.balanceClosure.returnedToStock === true,
          }
        : undefined,
      deliveredQty: raw?.deliveredQty != null ? Number(raw.deliveredQty) || 0 : undefined,
      balanceQty: raw?.balanceQty != null ? Number(raw.balanceQty) || 0 : undefined,
      deliveryStatus: raw?.deliveryStatus || undefined,
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }

  private normalizeDeliveryItems(raw: any): DCDeliveryItem[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((item: any): DCDeliveryItem => ({
      itemIndex: Number(item?.itemIndex) || 0,
      partName: String(item?.partName ?? ''),
      styleNo: String(item?.styleNo ?? ''),
      color: String(item?.color ?? ''),
      sleeveType: item?.sleeveType ? String(item.sleeveType) : undefined,
      sizeQty: item?.sizeQty && typeof item.sizeQty === 'object' ? item.sizeQty : {},
      total: Number(item?.total) || 0,
      mrp: Number(item?.mrp) || 0,
      mrpBySize: item?.mrpBySize && typeof item.mrpBySize === 'object' ? item.mrpBySize : undefined,
      price: Number(item?.price) || 0,
      amount: Number(item?.amount) || 0,
    }));
  }
}
