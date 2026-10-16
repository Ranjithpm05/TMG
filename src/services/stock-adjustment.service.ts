import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  Transaction,
  collection,
  deleteField,
  doc,
  increment,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
} from '@angular/fire/firestore';
import { getDocs, runTransaction } from './firestore-reads';
import { Observable } from 'rxjs';
import type { InventoryItem } from '../models/inventory.model';
import type { StockAdjustmentLine, StockAdjustmentSession } from '../models/stock-adjustment.model';
import { InventoryService } from './inventory.service';
import { SyncedCollectionCache, byCreatedAtDesc } from './synced-collection-cache.util';
import {
  AdjustmentStore, CompleteOutcome, TxLike, cancelSession, completeSession, paths, startSession,
} from './stock-adjustment.engine';

const WRITE_BATCH_SIZE = 450;

/**
 * Firestore side of the group stock adjustment. All rules (validation, locking,
 * chunked atomic completion, rollback) live in stock-adjustment.engine.ts — this
 * class only maps the engine's store interface onto Firestore and adds the
 * scan-time writes, which only ever touch the session's own lines subcollection.
 * Inventory is written exclusively by completeSession().
 */
@Injectable({ providedIn: 'root' })
export class StockAdjustmentService {
  private firestore = inject(Firestore);
  private inventoryService = inject(InventoryService);
  private sessionsRef = collection(this.firestore, 'stockAdjustments');

  private readonly sessionsCache = new SyncedCollectionCache<StockAdjustmentSession>({
    storageKey: 'stockAdjustments',
    collectionRef: this.sessionsRef,
    constraints: [orderBy('createdAt', 'desc')],
    requiredField: 'createdAt',
    mapDoc: (d) => ({ id: d.id, ...d.data() } as StockAdjustmentSession),
    compare: byCreatedAtDesc,
  });

  private readonly store: AdjustmentStore = {
    runTransaction: (fn) => runTransaction(this.firestore, (tx) => fn(this.wrapTx(tx))),
    listLines: (sessionId) => this.getLines(sessionId),
    newSessionId: () => doc(this.sessionsRef).id,
    serverTime: () => serverTimestamp(),
    increment: (n) => increment(n),
    deleteField: () => deleteField(),
    nowMs: () => Date.now(),
  };

  getSessions(): Observable<StockAdjustmentSession[]> {
    return this.sessionsCache.get$();
  }

  /** Next getSessions() re-syncs (delta query) — e.g. to see a session another device just changed. */
  refreshSessions(): void {
    this.sessionsCache.invalidate();
  }

  async getLines(sessionId: string): Promise<StockAdjustmentLine[]> {
    const snap = await getDocs(query(collection(this.firestore, paths.linesCollection(sessionId))));
    return snap.docs.map((d) => {
      const data = d.data() as Partial<StockAdjustmentLine>;
      return { ...data, id: d.id, scannedQty: Number(data.scannedQty) || 0, startStock: Number(data.startStock) || 0 } as StockAdjustmentLine;
    });
  }

  async startSession(group: string, startedBy: string, groupItems: InventoryItem[]): Promise<{ id: string; adjustmentNo: string }> {
    try {
      return await startSession(this.store, {
        group,
        startedBy,
        totalProducts: groupItems.length,
        startStockTotal: groupItems.reduce((s, i) => s + (Number(i.currentStock) || 0), 0),
      });
    } finally {
      this.sessionsCache.invalidate();
    }
  }

  async cancelSession(sessionId: string, cancelledBy: string): Promise<void> {
    try {
      await cancelSession(this.store, sessionId, cancelledBy);
    } finally {
      this.sessionsCache.invalidate();
    }
  }

  /**
   * Persists buffered scan deltas as increment() writes on the session's line docs —
   * never on inventory. increment() keeps several scanners counting the same group
   * correct. `newItems` carries product details for lines that don't exist yet.
   */
  async saveScanDeltas(sessionId: string, deltas: Map<string, number>, newItems: Map<string, InventoryItem>, user: string): Promise<void> {
    const entries = [...deltas].filter(([, delta]) => delta !== 0);
    for (let i = 0; i < entries.length; i += WRITE_BATCH_SIZE) {
      const batch = writeBatch(this.firestore);
      for (const [inventoryId, delta] of entries.slice(i, i + WRITE_BATCH_SIZE)) {
        const item = newItems.get(inventoryId);
        batch.set(doc(this.firestore, paths.line(sessionId, inventoryId)), {
          ...(item ? this.lineDetails(item) : {}),
          scannedQty: increment(delta),
          lastScannedBy: user,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }
      await batch.commit();
    }
  }

  /** Explicit "none on hand" confirmation for products that have book stock but were not scanned (or undoing it). */
  async setZeroConfirmed(sessionId: string, items: InventoryItem[], confirmed: boolean, user: string): Promise<void> {
    for (let i = 0; i < items.length; i += WRITE_BATCH_SIZE) {
      const batch = writeBatch(this.firestore);
      for (const item of items.slice(i, i + WRITE_BATCH_SIZE)) {
        batch.set(doc(this.firestore, paths.line(sessionId, item.id!)), {
          ...this.lineDetails(item),
          zeroConfirmed: confirmed,
          scannedQty: increment(0),
          lastScannedBy: user,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }
      await batch.commit();
    }
  }

  async completeSession(
    sessionId: string, completedBy: string, groupItems: InventoryItem[], onProgress?: (done: number, total: number) => void,
  ): Promise<CompleteOutcome> {
    try {
      return await completeSession(this.store, { sessionId, completedBy, groupItems, onProgress });
    } finally {
      // Completion (or its rollback) wrote inventory — next reads pick it up via the delta sync.
      this.inventoryService.invalidateCache();
      this.sessionsCache.invalidate();
    }
  }

  private lineDetails(item: InventoryItem) {
    return {
      barcode: item.barcode,
      styleNo: item.styleNo,
      color: item.color,
      size: item.size,
      ...(item.sleeveType ? { sleeveType: item.sleeveType } : {}),
      startStock: Number(item.currentStock) || 0,
    };
  }

  private wrapTx(tx: Transaction): TxLike {
    return {
      get: async (path) => {
        const snap = await tx.get(doc(this.firestore, path));
        return snap.exists() ? snap.data() : null;
      },
      set: (path, data) => { tx.set(doc(this.firestore, path), data); },
      update: (path, patch) => { tx.update(doc(this.firestore, path), patch); },
      delete: (path) => { tx.delete(doc(this.firestore, path)); },
    };
  }
}
