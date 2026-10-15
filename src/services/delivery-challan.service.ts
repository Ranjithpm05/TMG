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
  writeBatch,
} from '@angular/fire/firestore';
import { getDocs, runTransaction } from './firestore-reads';
import { Observable, firstValueFrom } from 'rxjs';
import { DCBalanceClosure, DCDelivery, DCDeliveryItem, DCItem, DeliveryChallan } from '../models/delivery-challan.model';
import { PackingListService } from './packing-list.service';
import { ClientService } from './client.service';
import { InventoryService } from './inventory.service';
import { PickListService } from './pick-list.service';
import { balanceItemSizeQty, buildDeliveryItems, deliveryPatch } from './dc-delivery.util';
import { invalidateRangeCaches, removeFromRangeCaches, syncedRangeQuery } from './range-cache.util';
import { SyncedCollectionCache, byCreatedAtDesc } from './synced-collection-cache.util';

export interface DeleteDCResult {
  dcNo: string;
  returnedQty: number;
  packedQty: number;
  pickedQty: number;
  packingListNo?: string;
  pickListNos: string[];
  // Shared Pick Lists kept for their other Packing Lists, with only this
  // DC's qty taken off.
  reducedPickListNos: string[];
  unreturned: string[];
}

// Why deleteDC() refused — message is shown to the user as-is.
export class DeleteDCError extends Error {}

@Injectable({ providedIn: 'root' })
export class DeliveryChallanService {
  private firestore = inject(Firestore);
  private packingListService = inject(PackingListService);
  private pickListService = inject(PickListService);
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

    let redeductStock = false;
    const data = await runTransaction(this.firestore, async (transaction) => {
      const packingSnap = await transaction.get(packingListRef);
      if (!packingSnap.exists()) throw new Error('packinglist_not_found');
      redeductStock = packingSnap.data()?.['restockedByDcDelete'] === true;

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
        ...(redeductStock ? { restockedByDcDelete: false } : {}),
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
    // A previous DC on this Packing List was removed with "Delete DC only",
    // which returned the packed stock — take it out again for the new DC.
    if (redeductStock) await this.packingListService.deductInventoryOnCompletion(input.packingListId);
    return { id: dcDocRef.id, ...data };
  }

  // Deletes a DC and puts its stock back into inventory. Two modes:
  //  - 'dc_only': the DC alone. The Packing List's packed qty is returned
  //    (stock left inventory at packing completion, see
  //    PackingListService.deductInventoryOnCompletion) and the Packing List is
  //    unlocked (dcGeneratedKeys cleared, stockDeducted reset) so a new DC can
  //    be generated from it — createDC() then deducts the stock again
  //    (restockedByDcDelete flag).
  //  - 'full': the DC, its Packing List and source Pick List(s), all with
  //    their lines. Returns the packed qty plus each Pick List's picked qty
  //    (a Pick List scan deducts stock itself unless inventoryReserved — same
  //    as PickListService.deletePickList), then re-syncs Sales Order status.
  // Same rules as scripts/delete-dcs-return-stock.mjs: refused (nothing
  // written) when the DC has an Invoice, a delivery, a closed balance or an
  // LR Entry, when its Packing List has an Invoice or holds other DCs, or
  // ('full') when a Pick List also fed another Packing List. DC + stock +
  // parent docs commit in one transaction; the lines subcollections (a Pick
  // List can exceed the 500-write limit) are deleted in batches after.
  async deleteDC(dcId: string, mode: 'dc_only' | 'full'): Promise<DeleteDCResult> {
    const dc = (await this.getDCsByIdsOnce([dcId]))[0];
    if (!dc) throw new Error('dc_not_found');

    const fail = (reason: string): never => { throw new DeleteDCError(reason); };
    if (dc.invoiceId || dc.invoiceNo) fail(`has Invoice ${dc.invoiceNo || dc.invoiceId} — delete the Invoice first`);
    if ((dc.deliveries ?? []).length) fail(`has ${dc.deliveries!.length} delivery record(s)`);
    if (dc.balanceClosure) fail('its balance is already closed (stock partly returned)');

    const invoicesRef = collection(this.firestore, 'invoices');
    const [invByDcId, invByDcIds, lrSnap] = await Promise.all([
      getDocs(query(invoicesRef, where('dcId', '==', dcId))),
      getDocs(query(invoicesRef, where('dcIds', 'array-contains', dcId))),
      getDocs(query(collection(this.firestore, 'lrEntries'), where('dcId', '==', dcId))),
    ]);
    const invoiceNos = [...invByDcId.docs, ...invByDcIds.docs].map((d) => d.data()?.['invoiceNo'] || d.id);
    if (invoiceNos.length) fail(`has Invoice ${[...new Set(invoiceNos)].join(', ')} — delete the Invoice first`);
    if (!lrSnap.empty) fail(`has LR Entry ${lrSnap.docs.map((d) => d.data()?.['lrNo'] || d.id).join(', ')}`);

    const returns = new Map<string, number>();
    const addReturn = (inventoryId: string, qty: number) => returns.set(inventoryId, (returns.get(inventoryId) ?? 0) + qty);
    const unreturned: string[] = [];
    const describe = (line: any, qty: number) =>
      `${line?.styleNo ?? ''} ${line?.color ?? ''} ${line?.sleeveType ?? ''} size ${line?.size ?? ''} × ${qty}`.replace(/\s+/g, ' ');

    // Packing List: packed qty goes back only if it was ever deducted.
    const plId = dc.packingListId;
    const plRef = plId ? doc(this.firestore, `packingLists/${plId}`) : null;
    const pl = plId ? await this.packingListService.getPackingListByIdOnce(plId) : null;
    if (plId && !pl && mode === 'full') fail(`Packing List ${dc.packingListNo || plId} not found`);
    const plLineRefs = plId ? (await getDocs(collection(this.firestore, `packingLists/${plId}/lines`))).docs : [];
    let packedQty = 0;
    if (pl) {
      if (pl.invoiceId) fail(`Packing List ${pl.packingListNo} has an Invoice`);
      const others = (await this.getDCsByPackingListIdOnce(plId)).filter((o) => o.id !== dcId);
      if (others.length) fail(`Packing List ${pl.packingListNo} also holds DC ${others.map((o) => o.dcNo).join(', ')}`);
      if (pl.stockDeducted) {
        const lines = plLineRefs.map((d) => d.data());
        const barcodes = lines.filter((l) => Number(l['packedQty']) > 0 && !l['inventoryId'] && l['barcode']).map((l) => String(l['barcode']));
        const found = barcodes.length ? await this.inventoryService.getInventoryByBarcodes([...new Set(barcodes)]) : [];
        for (const line of lines) {
          const qty = Number(line['packedQty']) || 0;
          if (qty <= 0) continue;
          const inventoryId = line['inventoryId'] || found.find((i) => i.barcode === line['barcode'] && i.id)?.id;
          if (inventoryId) { addReturn(inventoryId, qty); packedQty += qty; }
          else unreturned.push(describe(line, qty));
        }
      }
    }

    // Pick List(s) — 'full' only. A Pick List that fed only this Packing List
    // is deleted whole. One that also fed other Packing Lists (Party-wise
    // lists are packed in many batches) keeps the other Packing Lists' part:
    // only the qty this Packing List claimed — PackingListLine.sources — is
    // taken off its lines (requiredQty, pickedQty, packedIntoPackingListsQty),
    // a line left with nothing required is deleted, and that picked qty goes
    // back to stock. That frees the Sales Order qty for a new Pick List,
    // exactly as deleting a whole Pick List does.
    const pickLists: { id: string; pickListNo: string; salesOrderIds: string[]; lineRefs: typeof plLineRefs }[] = [];
    const sharedPickLists: { id: string; pickListNo: string }[] = [];
    const sharedLineCuts = new Map<string, { ref: ReturnType<typeof doc>; qty: number; salesOrderId: string }>();
    let pickedQty = 0;
    if (mode === 'full' && pl) {
      const pickListIds = [...new Set([...(pl.pickListIds ?? []), pl.pickListId].filter(Boolean))];
      const plLines = plLineRefs.map((d) => d.data());
      for (const pickListId of pickListIds) {
        const pick = await this.pickListService.getPickListByIdOnce(pickListId);
        if (!pick) continue;
        const lineRefs = (await getDocs(collection(this.firestore, `pickLists/${pickListId}/lines`))).docs;
        const feeding = (await this.packingListService.getPackingListsReferencingPickListOnce(pickListId)).filter((p) => p.id !== plId);
        if (!feeding.length) {
          if (!pick.inventoryReserved) {
            for (const d of lineRefs) {
              const line = d.data();
              const qty = Number(line['pickedQty']) || 0;
              if (qty <= 0) continue;
              if (line['inventoryId']) { addReturn(line['inventoryId'], qty); pickedQty += qty; }
              else unreturned.push(describe(line, qty));
            }
          }
          pickLists.push({ id: pickListId, pickListNo: pick.pickListNo, salesOrderIds: pick.salesOrderIds ?? [], lineRefs });
          continue;
        }

        // Shared — work out this Packing List's claim per Pick List line.
        const claimByLineId = new Map<string, number>();
        for (const line of plLines) {
          const sources: any[] = Array.isArray(line['sources']) ? line['sources'] : [];
          if (sources.length) {
            for (const s of sources) {
              if (s?.pickListId !== pickListId || !s?.pickListLineId) continue;
              claimByLineId.set(s.pickListLineId, (claimByLineId.get(s.pickListLineId) ?? 0) + (Number(s.qty) || 0));
            }
          } else if (pickListIds.length === 1 && line['pickListLineId']) {
            // Legacy line written before `sources` existed — single source Pick List.
            const qty = Number(line['requiredQty']) || Number(line['packedQty']) || 0;
            claimByLineId.set(line['pickListLineId'], (claimByLineId.get(line['pickListLineId']) ?? 0) + qty);
          }
        }
        if (!claimByLineId.size) fail(`cannot tell which part of shared Pick List ${pick.pickListNo} belongs to this Packing List`);
        for (const [lineId, qty] of claimByLineId) {
          if (qty <= 0) continue;
          const lineSnap = lineRefs.find((d) => d.id === lineId);
          if (!lineSnap) continue;
          const line = lineSnap.data();
          sharedLineCuts.set(`${pickListId}/${lineId}`, { ref: lineSnap.ref, qty, salesOrderId: String(line['salesOrderId'] ?? '') });
          const returnQty = Math.min(qty, Number(line['pickedQty']) || 0);
          if (pick.inventoryReserved || returnQty <= 0) continue;
          if (line['inventoryId']) { addReturn(line['inventoryId'], returnQty); pickedQty += returnQty; }
          else unreturned.push(describe(line, returnQty));
        }
        sharedPickLists.push({ id: pickListId, pickListNo: pick.pickListNo });
      }
    }

    const invEntries = [...returns.entries()];
    const sharedCuts = [...sharedLineCuts.values()];
    if (invEntries.length + pickLists.length + sharedCuts.length + 2 > 490) fail('too many items to update in one step — contact support');

    const dcDocRef = doc(this.dcRef, dcId);
    let returnedQty = 0;
    let missingInventory: string[] = [];
    await runTransaction(this.firestore, async (transaction) => {
      const [dcSnap, plSnap, ...restSnaps] = await Promise.all([
        transaction.get(dcDocRef),
        plRef ? transaction.get(plRef) : Promise.resolve(null),
        ...invEntries.map(([id]) => transaction.get(doc(this.firestore, `inventory/${id}`))),
        ...sharedCuts.map((cut) => transaction.get(cut.ref)),
      ]);
      const invSnaps = restSnaps.slice(0, invEntries.length);
      const cutSnaps = restSnaps.slice(invEntries.length);
      if (!dcSnap.exists()) throw new Error('dc_not_found');
      const live = this.normalize({ id: dcSnap.id, ...dcSnap.data() });
      if (live.invoiceId || (live.deliveries ?? []).length || live.balanceClosure) fail('was invoiced or delivered just now — refresh and check');
      if (plSnap?.exists() && (plSnap.data()?.['stockDeducted'] === true) !== !!pl?.stockDeducted) fail('Packing List changed just now — try again');

      returnedQty = 0;
      missingInventory = [];
      invEntries.forEach(([id, qty], i) => {
        if (!invSnaps[i].exists()) { missingInventory.push(`inventory record ${id} × ${qty}`); return; }
        transaction.update(invSnaps[i].ref, { currentStock: increment(qty), updatedAt: serverTimestamp() });
        returnedQty += qty;
      });
      transaction.delete(dcDocRef);
      if (plSnap?.exists()) {
        if (mode === 'full') transaction.delete(plSnap.ref);
        else transaction.update(plSnap.ref, {
          dcGeneratedKeys: [],
          stockDeducted: false,
          restockedByDcDelete: !!pl?.stockDeducted,
          updatedAt: serverTimestamp(),
        });
      }
      for (const pick of pickLists) transaction.delete(doc(this.firestore, `pickLists/${pick.id}`));
      sharedCuts.forEach((cut, i) => {
        if (!cutSnaps[i].exists()) return;
        const line = cutSnaps[i].data()!;
        const requiredQty = Math.max(0, (Number(line['requiredQty']) || 0) - cut.qty);
        // requiredQty 0 would read back as orderedQty - pendingQty (see
        // PickListService.normalizeLine) — drop the line instead.
        if (requiredQty <= 0) { transaction.delete(cut.ref); return; }
        const pickedQty = Math.max(0, (Number(line['pickedQty']) || 0) - cut.qty);
        const remainingQty = Math.max(0, requiredQty - pickedQty);
        const keepStatus = line['status'] === 'blocked' || line['status'] === 'pending_stock';
        transaction.update(cut.ref, {
          requiredQty,
          pickedQty,
          remainingQty,
          balanceQty: remainingQty + Math.max(0, Number(line['pendingQty']) || 0),
          packedIntoPackingListsQty: Math.max(0, (Number(line['packedIntoPackingListsQty']) || 0) - cut.qty),
          ...(keepStatus ? {} : { status: remainingQty <= 0 ? 'completed' : pickedQty > 0 ? 'in_progress' : 'ready' }),
          updatedAt: serverTimestamp(),
        });
      });
    });

    if (mode === 'full') {
      const lineRefs = [...plLineRefs, ...pickLists.flatMap((p) => p.lineRefs)].map((d) => d.ref);
      for (let i = 0; i < lineRefs.length; i += 450) {
        const batch = writeBatch(this.firestore);
        for (const ref of lineRefs.slice(i, i + 450)) batch.delete(ref);
        await batch.commit();
      }
      for (const pick of sharedPickLists) await this.pickListService.recalculatePickListStatus(pick.id);
      const salesOrderIds = [...pickLists.flatMap((p) => p.salesOrderIds), ...sharedCuts.map((c) => c.salesOrderId)].filter(Boolean);
      for (const salesOrderId of new Set(salesOrderIds)) {
        await this.pickListService.syncSalesOrderShipment('', salesOrderId).catch(() => undefined);
      }
    }

    this.dcsCache.removeOne(dcId);
    removeFromRangeCaches(this.dcsRangeCache, dcId);
    if (mode === 'full' && plId) this.packingListService.removeFromCache(plId);
    else this.packingListService.invalidateCache();
    for (const pick of pickLists) this.pickListService.removeFromCache(pick.id);
    if (returnedQty > 0) this.inventoryService.invalidateCache();

    return {
      dcNo: dc.dcNo,
      returnedQty,
      packedQty,
      pickedQty,
      packingListNo: mode === 'full' && pl ? pl.packingListNo : undefined,
      pickListNos: pickLists.map((p) => p.pickListNo),
      reducedPickListNos: sharedPickLists.map((p) => p.pickListNo),
      unreturned: [...unreturned, ...missingInventory],
    };
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
