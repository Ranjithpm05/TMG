import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from '@angular/fire/firestore';
import { from, Observable, shareReplay } from 'rxjs';
import { DCItem, DeliveryChallan } from '../models/delivery-challan.model';
import { fetchAllDocs } from './firestore-pagination.util';
import { PackingListService } from './packing-list.service';

@Injectable({ providedIn: 'root' })
export class DeliveryChallanService {
  private firestore = inject(Firestore);
  private packingListService = inject(PackingListService);
  private dcRef = collection(this.firestore, 'deliveryChallans');

  // Read repeatedly (Packing List and e-Invoice screens, every DC-generation
  // refresh) — cached one-time read, invalidated by createDC/updateDCItems below,
  // same pattern as ClientService/DesignService/InventoryService.
  private dcsCache$: Observable<DeliveryChallan[]> | null = null;

  // Public: InvoiceService.createInvoice() stamps invoiceId/invoiceNo directly
  // onto a deliveryChallans/{id} doc in the same transaction as creating the
  // invoice, without going through this service — it must invalidate this
  // cache too or the DC would keep showing as not-yet-invoiced.
  invalidateCache(): void {
    this.dcsCache$ = null;
  }

  // One-time read, paged through in full via fetchAllDocs() — a prior fixed
  // limit(100) here silently truncated the list once delivery challans passed
  // that count. The Packing List screen snapshots this into a local list.
  getDeliveryChallans(): Observable<DeliveryChallan[]> {
    if (!this.dcsCache$) {
      this.dcsCache$ = from(
        fetchAllDocs(this.dcRef, [orderBy('createdAt', 'desc')], (d) => this.normalize({ id: d.id, ...d.data() }))
      ).pipe(shareReplay(1));
    }
    return this.dcsCache$;
  }

  async getDCsByPackingListIdOnce(packingListId: string): Promise<DeliveryChallan[]> {
    const snap = await getDocs(query(this.dcRef, where('packingListId', '==', packingListId)));
    return snap.docs.map((d) => this.normalize({ id: d.id, ...d.data() }));
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
      items: Array.isArray(raw?.items)
        ? raw.items.map((item: any): DCItem => ({
            partName: String(item?.partName ?? ''),
            styleNo: String(item?.styleNo ?? ''),
            color: String(item?.color ?? ''),
            sleeveType: item?.sleeveType ? String(item.sleeveType) : undefined,
            sizeQty: item?.sizeQty && typeof item.sizeQty === 'object' ? item.sizeQty : {},
            total: Number(item?.total) || 0,
            mrp: Number(item?.mrp) || 0,
          }))
        : [],
      sizes: Array.isArray(raw?.sizes) ? raw.sizes.map((s: any) => String(s)) : [],
      invoiceId: raw?.invoiceId ? String(raw.invoiceId) : undefined,
      invoiceNo: raw?.invoiceNo ? String(raw.invoiceNo) : undefined,
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }
}
