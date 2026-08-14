import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, doc,
  updateDoc, query, orderBy, where, getDocs, serverTimestamp, writeBatch, WriteBatch, increment
} from '@angular/fire/firestore';
import { from, map, Observable, shareReplay } from 'rxjs';
import type { InventoryItem } from '../models/inventory.model';
import type { GoodsInwardItem } from '../models/goods-inward.model';
import { fetchAllDocs } from './firestore-pagination.util';

export type InventoryBatchOp = (batch: WriteBatch) => void;

export interface CommitChunksOptions {
  /** Adds extra writes (e.g. a GRN progress bump) into the SAME batch as a chunk's inventory writes. */
  augmentBatch?: (batch: WriteBatch, chunkIndex: number) => void;
  /** Fires right after a chunk's batch.commit() succeeds, so callers know how far a partial failure got. */
  onChunkCommitted?: (chunkIndex: number) => void;
}

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

  /**
   * Builds the per-item inventory write operations for a GRN, using atomic Firestore
   * increment() so concurrent writers touching the same barcode can't lose an update
   * to a stale read. Pass direction: -1 to build the exact reverse (compensation) of a
   * previously-applied +1 call for the same items/grnNo.
   */
  async buildInventoryOps(items: GoodsInwardItem[], grnNo: string, direction: 1 | -1 = 1): Promise<InventoryBatchOp[]> {
    const validItems = items.filter(item => (Number(item.receivedQty) || 0) > 0);
    if (!validItems.length) return [];

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

    // Batched lookup (chunks of 30 via a single `where(barcode, 'in', ...)` query each)
    // instead of one query per distinct barcode — a GRN with hundreds of distinct SKUs
    // previously cost one billed read-query per SKU here.
    const existingByBarcode = new Map(
      (await this.getInventoryByBarcodes(dedupedItems.map(({ item }) => item.barcode)))
        .map((inv) => [inv.barcode, inv] as const)
    );

    return dedupedItems.map(({ item, totalQty }) => {
      const signedQty = direction * totalQty;
      const existing = existingByBarcode.get(item.barcode);
      if (!existing) {
        if (direction === -1) {
          // Compensating a chunk whose target doc no longer exists — nothing to revert.
          console.warn(`Inventory compensation skipped: no inventory doc for barcode ${item.barcode}`);
          return (_batch: WriteBatch) => {};
        }
        return (batch: WriteBatch) => batch.set(doc(this.invRef), {
          barcode: item.barcode, designId: item.designId,
          styleNo: item.styleNo, color: item.color, group: item.group,
          size: item.size, ...(item.sleeveType ? { sleeveType: item.sleeveType } : {}),
          fabricType: item.fabricType, currentStock: totalQty,
          totalReceived: totalQty,
          WSP: item.WSP, price: item.price, lastGrnNo: grnNo,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
      }
      return (batch: WriteBatch) => batch.update(doc(this.firestore, `inventory/${existing.id}`), {
        currentStock: increment(signedQty),
        totalReceived: increment(signedQty),
        ...(direction === 1 ? { WSP: item.WSP, price: item.price, lastGrnNo: grnNo } : {}),
        updatedAt: serverTimestamp()
      });
    });
  }

  async upsertFromGrn(items: GoodsInwardItem[], grnNo: string): Promise<void> {
    const operations = await this.buildInventoryOps(items, grnNo, 1);
    await this.commitInChunks(operations);
    this.invalidateCache();
  }

  /**
   * Commits operations in chunks to stay under Firestore's 500-operation-per-batch
   * limit for large GRNs. Each chunk's batch.commit() is atomic on its own; this
   * function does NOT guarantee the whole call is atomic — a caller that needs
   * whole-operation safety must track onChunkCommitted progress and compensate
   * on failure itself (see GoodsInwardService.approveGrn).
   */
  async commitInChunks(operations: InventoryBatchOp[], chunkSize = 450, opts?: CommitChunksOptions): Promise<void> {
    for (let i = 0; i < operations.length; i += chunkSize) {
      const chunkIndex = i / chunkSize;
      const batch = writeBatch(this.firestore);
      operations.slice(i, i + chunkSize).forEach((op) => op(batch));
      opts?.augmentBatch?.(batch, chunkIndex);
      await batch.commit();
      opts?.onChunkCommitted?.(chunkIndex);
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