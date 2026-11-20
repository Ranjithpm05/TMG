import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  Transaction,
  collection,
  doc,
  increment,
  orderBy,
  query,
  serverTimestamp,
} from '@angular/fire/firestore';
import { getDoc, getDocs, runTransaction } from './firestore-reads';
import { Observable, firstValueFrom } from 'rxjs';
import type { Invoice } from '../models/invoice.model';
import type { DamageStockItem, SalesReturn, SalesReturnLedger } from '../models/sales-return.model';
import { resolveHsnCode } from '../models/hsn-code.model';
import { DeliveryChallanService } from './delivery-challan.service';
import { DesignService } from './design.service';
import { InventoryService } from './inventory.service';
import { PackingListService } from './packing-list.service';
import { SyncedCollectionCache, byCreatedAtDesc } from './synced-collection-cache.util';
import {
  BillRow, ReturnDraftInput, ReturnStore, ScannedItem, TxLike, buildBillRows, cancelReturn, dcIdsNeeded, inventoryKey, paths,
  postReturn, saveDraft,
} from './sales-return.engine';

/** Same fallback HSN the Generate Invoice dialog defaults to for a product not in the standard list. */
const DEFAULT_HSN = '62059090';

/** Barcode (upper-cased) → scanned item, for the Customer-Based Scanned Return. */
export type ScanCatalog = Map<string, ScannedItem>;

export interface InvoiceBill {
  invoice: Invoice;
  rows: BillRow[];
  /** DCs this invoice was billed from that no longer exist — its lines can't be rebuilt. */
  missingDcIds: string[];
}

/**
 * Firestore side of Sales Return. All rules (validation against the original
 * invoice, over-return guard, one-time stock posting, reversal) live in
 * sales-return.engine.ts — this class maps the engine's store onto Firestore
 * and gathers the read-only data the screen shows (bill lines, damage stock).
 */
@Injectable({ providedIn: 'root' })
export class SalesReturnService {
  private firestore = inject(Firestore);
  private inventoryService = inject(InventoryService);
  private deliveryChallanService = inject(DeliveryChallanService);
  private packingListService = inject(PackingListService);
  private designService = inject(DesignService);
  private returnsRef = collection(this.firestore, 'salesReturns');

  private readonly returnsCache = new SyncedCollectionCache<SalesReturn>({
    storageKey: 'salesReturns',
    collectionRef: this.returnsRef,
    constraints: [orderBy('createdAt', 'desc')],
    requiredField: 'createdAt',
    mapDoc: (d) => ({ id: d.id, ...d.data() } as SalesReturn),
    compare: byCreatedAtDesc,
  });

  private readonly store: ReturnStore = {
    runTransaction: (fn) => runTransaction(this.firestore, (tx) => fn(this.wrapTx(tx))),
    serverTime: () => serverTimestamp(),
    increment: (n) => increment(n),
  };

  getReturns(): Observable<SalesReturn[]> {
    return this.returnsCache.get$();
  }

  refreshReturns(): void {
    this.returnsCache.invalidate();
  }

  /** Doc id for a new entry — chosen once per entry so a repeated save updates the same draft. */
  newReturnId(): string {
    return doc(this.returnsRef).id;
  }

  async getReturnOnce(id: string): Promise<SalesReturn | null> {
    const snap = await getDoc(doc(this.firestore, paths.salesReturn(id)));
    return snap.exists() ? ({ id: snap.id, ...snap.data() } as SalesReturn) : null;
  }

  /**
   * Billed lines of each invoice with sold / previously returned / eligible qty
   * and the inventory record each piece goes back to — resolved the same way
   * DeliveryChallanService.closeBalance() does: the Packing List line's
   * inventoryId first, else a styleNo/color/sleeve/size match in inventory.
   */
  async loadBills(invoices: Invoice[]): Promise<InvoiceBill[]> {
    if (!invoices.length) return [];
    const dcIds = [...new Set(invoices.flatMap((inv) => dcIdsNeeded(inv)))];
    const packingListIds = [...new Set(invoices.flatMap((inv) => inv.packingListIds?.length ? inv.packingListIds : [inv.packingListId]).filter(Boolean))];

    const [dcs, ledgers, packingLines, inventory] = await Promise.all([
      dcIds.length ? this.deliveryChallanService.getDCsByIdsOnce(dcIds) : Promise.resolve([]),
      Promise.all(invoices.map((inv) => this.getLedger(inv.id!))),
      Promise.all(packingListIds.map((id) => this.packingListService.getPackingListLinesOnce(id).catch(() => []))),
      firstValueFrom(this.inventoryService.getInventory()),
    ]);

    const invById = new Map(inventory.filter((i) => i.id).map((i) => [i.id!, i] as const));
    const invByKey = new Map<string, { id: string; barcode: string }>();
    for (const inv of inventory) {
      const key = inventoryKey(inv.styleNo, inv.color, inv.sleeveType, inv.size);
      if (inv.id && !invByKey.has(key)) invByKey.set(key, { id: inv.id, barcode: inv.barcode });
    }
    const fromPacking = new Map<string, { id: string; barcode: string }>();
    for (const line of packingLines.flat()) {
      const key = inventoryKey(line.styleNo, line.color, line.sleeveType, line.size);
      const inv = line.inventoryId ? invById.get(line.inventoryId) : undefined;
      if (inv && !fromPacking.has(key)) fromPacking.set(key, { id: inv.id!, barcode: inv.barcode });
    }
    const resolve = (styleNo: string, color: string, sleeveType: string | undefined, size: string) => {
      const key = inventoryKey(styleNo, color, sleeveType, size);
      return fromPacking.get(key) ?? invByKey.get(key) ?? null;
    };

    const dcsById = new Map(dcs.filter((dc) => dc.id).map((dc) => [dc.id!, dc] as const));
    return invoices.map((invoice, i) => {
      const { rows, missingDcIds } = buildBillRows(invoice, dcsById, ledgers[i]?.returned, resolve);
      return { invoice, rows, missingDcIds };
    });
  }

  /**
   * Every scannable item code: Design Master is the item master (style, colour,
   * size, sleeve, product group, current MRP — see DesignService.getMrpByBarcodeMap
   * for why MRP never comes from inventory); the inventory record is where a
   * Fresh piece goes back to — by barcode, else the same styleNo/color/sleeve/size
   * match loadBills() uses. A barcode only in inventory still resolves from it.
   */
  async loadScanCatalog(): Promise<ScanCatalog> {
    const [designs, inventory] = await Promise.all([
      firstValueFrom(this.designService.getDesigns()),
      firstValueFrom(this.inventoryService.getInventory()),
    ]);
    const invByBarcode = new Map<string, string>();
    const invByKey = new Map<string, string>();
    for (const inv of inventory) {
      if (!inv.id) continue;
      const code = String(inv.barcode ?? '').trim().toUpperCase();
      if (code && !invByBarcode.has(code)) invByBarcode.set(code, inv.id);
      const key = inventoryKey(inv.styleNo, inv.color, inv.sleeveType, inv.size);
      if (!invByKey.has(key)) invByKey.set(key, inv.id);
    }

    const catalog: ScanCatalog = new Map();
    for (const design of designs) {
      for (const size of design.sizes ?? []) {
        const barcode = String(size.BARCODE ?? '').trim();
        const code = barcode.toUpperCase();
        if (!code || catalog.has(code)) continue;
        const group = design.group ?? '';
        catalog.set(code, {
          barcode,
          inventoryId: invByBarcode.get(code) ?? invByKey.get(inventoryKey(design.styleNo, design.color, size.sleeveType, size.size)) ?? '',
          styleNo: design.styleNo ?? '',
          color: design.color ?? '',
          size: size.size ?? '',
          ...(size.sleeveType ? { sleeveType: size.sleeveType } : {}),
          description: group,
          mrp: Number(size.price) || 0,
          hsnSac: resolveHsnCode(group, DEFAULT_HSN),
        });
      }
    }
    for (const inv of inventory) {
      const code = String(inv.barcode ?? '').trim().toUpperCase();
      if (!inv.id || !code || catalog.has(code)) continue;
      catalog.set(code, {
        barcode: inv.barcode,
        inventoryId: inv.id,
        styleNo: inv.styleNo ?? '',
        color: inv.color ?? '',
        size: inv.size ?? '',
        ...(inv.sleeveType ? { sleeveType: inv.sleeveType } : {}),
        description: inv.group ?? '',
        mrp: Number(inv.price) || 0,
        hsnSac: resolveHsnCode(inv.group, DEFAULT_HSN),
      });
    }
    return catalog;
  }

  async getLedger(invoiceId: string): Promise<SalesReturnLedger | null> {
    const snap = await getDoc(doc(this.firestore, paths.ledger(invoiceId)));
    return snap.exists() ? (snap.data() as SalesReturnLedger) : null;
  }

  async getDamageStock(): Promise<DamageStockItem[]> {
    const snap = await getDocs(query(collection(this.firestore, 'damageStock')));
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() } as DamageStockItem))
      .filter((d) => (Number(d.qty) || 0) > 0)
      .sort((a, b) => a.styleNo.localeCompare(b.styleNo) || a.color.localeCompare(b.color) || a.size.localeCompare(b.size));
  }

  async saveDraft(id: string, input: ReturnDraftInput, user: string): Promise<{ id: string; returnNo: string; created: boolean }> {
    try {
      return await saveDraft(this.store, { id, input, user, fyCode: this.getFyCode() });
    } finally {
      this.returnsCache.invalidate();
    }
  }

  async postReturn(id: string, user: string): Promise<'posted' | 'already-posted'> {
    try {
      return await postReturn(this.store, id, user);
    } finally {
      this.inventoryService.invalidateCache();
      this.returnsCache.invalidate();
    }
  }

  async cancelReturn(id: string, user: string, reason: string): Promise<'cancelled' | 'already-cancelled'> {
    try {
      return await cancelReturn(this.store, id, user, reason);
    } finally {
      this.inventoryService.invalidateCache();
      this.returnsCache.invalidate();
    }
  }

  // Same April–March financial-year code InvoiceService uses for TMGC numbers.
  private getFyCode(): string {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const fyStart = month >= 4 ? year : year - 1;
    return `${String(fyStart).slice(2)}${String(fyStart + 1).slice(2)}`;
  }

  private wrapTx(tx: Transaction): TxLike {
    return {
      get: async (path) => {
        const snap = await tx.get(doc(this.firestore, path));
        return snap.exists() ? snap.data() : null;
      },
      set: (path, data) => { tx.set(doc(this.firestore, path), stripUndefined(data)); },
      update: (path, patch) => { tx.update(doc(this.firestore, path), stripUndefined(patch)); },
    };
  }
}

// Firestore rejects `undefined` nested inside arrays/maps (e.g. an optional
// field on a return line) — same deep strip as InvoiceService.stripUndefined.
// Non-plain values (Timestamp, serverTimestamp()/increment() sentinels) are
// left untouched.
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined).map((entry) => stripUndefined(entry)) as T;
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, stripUndefined(entry)])
    ) as T;
  }
  return value;
}
