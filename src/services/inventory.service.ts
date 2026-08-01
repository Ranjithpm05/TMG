import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, doc,
  updateDoc, query, orderBy, where, getDocs, serverTimestamp, writeBatch, WriteBatch
} from '@angular/fire/firestore';
import { from, map, Observable, shareReplay } from 'rxjs';
import type { InventoryItem } from '../models/inventory.model';
import type { GoodsInwardItem } from '../models/goods-inward.model';
import { fetchAllDocs } from './firestore-pagination.util';

@Injectable({ providedIn: 'root' })
export class InventoryService {
  private firestore = inject(Firestore);
  private invRef = collection(this.firestore, 'inventory');

  // Inventory is read as a bulk list from several screens (Dashboard, Reports,
  // Pick List, Packing List, Inventory). Cache the one-time read and let any
  // stock-mutating write path (here or in Pick/Packing List services) call
  // invalidateCache() instead of every screen holding its own live listener.
  private inventoryCache$: Observable<InventoryItem[]> | null = null;

  // Paged through in full via fetchAllDocs() — a prior fixed limit(5000) here
  // silently truncated the list once inventory passed that many rows (same
  // bug class as Design Master's export; see project memory).
  getInventory(): Observable<InventoryItem[]> {
    if (!this.inventoryCache$) {
      this.inventoryCache$ = from(
        fetchAllDocs(this.invRef, [orderBy('styleNo', 'asc')], (d) => ({ id: d.id, ...d.data() } as InventoryItem))
      ).pipe(shareReplay(1));
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

    // Phase 2: Commit all creates and updates, chunked to stay under
    // Firestore's 500-operation-per-batch limit for large GRNs.
    const operations: Array<(batch: WriteBatch) => void> = snapshots.map((snap, idx) => {
      const { item, totalQty } = dedupedItems[idx];
      if (snap.empty) {
        return (batch) => batch.set(doc(this.invRef), {
          barcode: item.barcode, designId: item.designId,
          styleNo: item.styleNo, color: item.color, group: item.group,
          size: item.size, ...(item.sleeveType ? { sleeveType: item.sleeveType } : {}),
          fabricType: item.fabricType, currentStock: totalQty,
          totalReceived: totalQty,
          WSP: item.WSP, price: item.price, lastGrnNo: grnNo,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
      }
      const existing = snap.docs[0];
      const data = existing.data() as InventoryItem;
      return (batch) => batch.update(doc(this.firestore, `inventory/${existing.id}`), {
        currentStock: (Number(data.currentStock) || 0) + totalQty,
        totalReceived: (Number(data.totalReceived) || 0) + totalQty,
        WSP: item.WSP, price: item.price, lastGrnNo: grnNo,
        updatedAt: serverTimestamp()
      });
    });
    await this.commitInChunks(operations);
    this.invalidateCache();
  }

  private async commitInChunks(operations: Array<(batch: WriteBatch) => void>, chunkSize = 450): Promise<void> {
    for (let i = 0; i < operations.length; i += chunkSize) {
      const batch = writeBatch(this.firestore);
      operations.slice(i, i + chunkSize).forEach((op) => op(batch));
      await batch.commit();
    }
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