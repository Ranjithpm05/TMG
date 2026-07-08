import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, doc,
  updateDoc, query, orderBy, where, getDocs, serverTimestamp, writeBatch
} from '@angular/fire/firestore';
import { from, map, Observable, shareReplay } from 'rxjs';
import type { InventoryItem } from '../models/inventory.model';
import type { GoodsInwardItem } from '../models/goods-inward.model';

@Injectable({ providedIn: 'root' })
export class InventoryService {
  private firestore = inject(Firestore);
  private invRef = collection(this.firestore, 'inventory');

  // Inventory is read as a bulk list from several screens (Dashboard, Reports,
  // Pick List, Packing List, Inventory). Cache the one-time read and let any
  // stock-mutating write path (here or in Pick/Packing List services) call
  // invalidateCache() instead of every screen holding its own live listener.
  private inventoryCache$: Observable<InventoryItem[]> | null = null;

  getInventory(): Observable<InventoryItem[]> {
    if (!this.inventoryCache$) {
      const q = query(this.invRef, orderBy('styleNo', 'asc'));
      this.inventoryCache$ = from(getDocs(q)).pipe(
        map((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() } as InventoryItem))),
        shareReplay(1)
      );
    }
    return this.inventoryCache$;
  }

  invalidateCache(): void {
    this.inventoryCache$ = null;
  }

  async upsertFromGrn(items: GoodsInwardItem[], grnNo: string): Promise<void> {
    const validItems = items.filter(item => (Number(item.receivedQty) || 0) > 0);
    if (!validItems.length) return;

    // Aggregate by barcode so duplicate entries in one GRN are combined before writing.
    const byBarcode = new Map<string, { item: GoodsInwardItem; totalQty: number }>();
    for (const item of validItems) {
      const entry = byBarcode.get(item.barcode);
      if (entry) {
        entry.totalQty += Number(item.receivedQty);
      } else {
        byBarcode.set(item.barcode, { item, totalQty: Number(item.receivedQty) });
      }
    }
    const dedupedItems = [...byBarcode.values()];

    // Phase 1: Run all inventory lookups in parallel instead of sequentially.
    const snapshots = await Promise.all(
      dedupedItems.map(({ item }) => getDocs(query(this.invRef, where('barcode', '==', item.barcode))))
    );

    // Phase 2: Commit all creates and updates in a single batch (max 500 ops).
    const batch = writeBatch(this.firestore);
    snapshots.forEach((snap, idx) => {
      const { item, totalQty } = dedupedItems[idx];
      if (snap.empty) {
        batch.set(doc(this.invRef), {
          barcode: item.barcode, designId: item.designId,
          styleNo: item.styleNo, color: item.color, group: item.group,
          size: item.size, ...(item.sleeveType ? { sleeveType: item.sleeveType } : {}),
          fabricType: item.fabricType, currentStock: totalQty,
          totalReceived: totalQty,
          WSP: item.WSP, price: item.price, lastGrnNo: grnNo,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
      } else {
        const existing = snap.docs[0];
        const data = existing.data() as InventoryItem;
        batch.update(doc(this.firestore, `inventory/${existing.id}`), {
          currentStock: (Number(data.currentStock) || 0) + totalQty,
          totalReceived: (Number(data.totalReceived) || 0) + totalQty,
          WSP: item.WSP, price: item.price, lastGrnNo: grnNo,
          updatedAt: serverTimestamp()
        });
      }
    });
    await batch.commit();
    this.invalidateCache();
  }

  async getInventoryByBarcodes(barcodes: string[]): Promise<InventoryItem[]> {
    if (!barcodes.length) return [];
    const results: InventoryItem[] = [];
    for (let i = 0; i < barcodes.length; i += 30) {
      const batch = barcodes.slice(i, i + 30);
      const snap = await getDocs(query(this.invRef, where('barcode', 'in', batch)));
      snap.docs.forEach(d => results.push({ id: d.id, ...d.data() } as InventoryItem));
    }
    return results;
  }
}