import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  addDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  deleteField,
  orderBy,
  runTransaction,
  serverTimestamp
} from '@angular/fire/firestore';
import { from, Observable, shareReplay } from 'rxjs';
import type { GoodsInward, GoodsInwardItem } from '../models/goods-inward.model';
import { fetchAllDocs } from './firestore-pagination.util';
import { InventoryService } from './inventory.service';

export type ApproveGrnOutcome = 'approved' | 'already-approved' | 'in-progress';

@Injectable({ providedIn: 'root' })
export class GoodsInwardService {

  private firestore = inject(Firestore);
  private inventoryService = inject(InventoryService);
  private grnRef = collection(this.firestore, 'goodsInward');
  private readonly APPROVE_CHUNK_ITEMS = 400;
  private readonly REVERT_RETRIES = 3;

  // Read repeatedly (Dashboard on every visit, this screen's own ngOnInit +
  // refresh-after-every-write) — cached one-time read, invalidated by every
  // write in this service below, same pattern as ClientService/DesignService.
  private grnsCache$: Observable<GoodsInward[]> | null = null;

  private invalidateGrnsCache(): void {
    this.grnsCache$ = null;
  }

  /**
   * Recursively removes every key whose value is `undefined`.
   * Firestore throws "Unsupported field value: undefined" if any
   * field — including nested ones inside array objects — is undefined.
   */
  private stripUndefined<T>(obj: T): T {
    if (Array.isArray(obj)) {
      return obj.map(item => this.stripUndefined(item)) as unknown as T;
    }
    if (obj !== null && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, this.stripUndefined(v)])
      ) as T;
    }
    return obj;
  }

  // 🔹 Get all GRNs (one-time read, paged through in full via fetchAllDocs() —
  // a prior fixed limit(100) here silently truncated the list once GRNs
  // passed that count; Dashboard/Reports need the complete set for correct
  // totals, not just the most recent page).
  getGoodsInwards(): Observable<GoodsInward[]> {
    if (!this.grnsCache$) {
      this.grnsCache$ = from(
        fetchAllDocs(this.grnRef, [orderBy('createdAt', 'desc')], (d) => ({ id: d.id, ...d.data() } as GoodsInward))
      ).pipe(shareReplay(1));
    }
    return this.grnsCache$;
  }

  // 🔹 Create GRN
  async createGoodsInward(grn: Omit<GoodsInward, 'id'>): Promise<void> {
    const clean = this.stripUndefined(grn);
    await addDoc(this.grnRef, {
      ...clean,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    this.invalidateGrnsCache();
  }

  // 🔹 Update GRN
  async updateGoodsInward(grn: GoodsInward): Promise<void> {
    if (!grn.id) return;
    const { id, ...rest } = grn;
    const clean = this.stripUndefined(rest);
    const grnDoc = doc(this.firestore, `goodsInward/${id}`);
    await updateDoc(grnDoc, {
      ...clean,
      updatedAt: serverTimestamp()
    });
    this.invalidateGrnsCache();
  }

  // 🔹 Delete GRN
  async deleteGoodsInward(id: string): Promise<void> {
    const grnDoc = doc(this.firestore, `goodsInward/${id}`);
    await deleteDoc(grnDoc);
    this.invalidateGrnsCache();
  }

  // 🔹 Approve GRN — locks the doc against concurrent/duplicate approval (re-reads
  // status live inside a transaction instead of trusting the caller's possibly-stale
  // object), applies inventory in item-count chunks, then finalizes to 'Approved'.
  // Any failure compensates whatever chunks committed and releases the lock back to
  // 'Pending' — inventory is never left partially applied against a non-Approved GRN.
  async approveGrn(grnId: string): Promise<ApproveGrnOutcome> {
    const grnDocRef = doc(this.firestore, `goodsInward/${grnId}`);

    const lock = await runTransaction(this.firestore, async (tx) => {
      const snap = await tx.get(grnDocRef);
      if (!snap.exists()) throw new Error('Goods Inward record not found.');
      const liveGrn = snap.data() as GoodsInward;
      if (liveGrn.status === 'Approved') return { outcome: 'already-approved' as const };
      if (liveGrn.status === 'Approving') return { outcome: 'in-progress' as const };

      const lockId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const itemChunks = this.chunkItems(liveGrn.items);
      tx.update(grnDocRef, {
        status: 'Approving',
        approvalLock: { lockId, chunksDone: 0, totalChunks: itemChunks.length, lastProgressAt: serverTimestamp() }
      });
      return { outcome: 'locked' as const, grnNo: liveGrn.grnNo, itemChunks };
    });

    if (lock.outcome !== 'locked') return lock.outcome;
    const { grnNo, itemChunks } = lock;

    let chunksCommitted = 0;
    try {
      for (let i = 0; i < itemChunks.length; i++) {
        const ops = await this.inventoryService.buildInventoryOps(itemChunks[i], grnNo, 1);
        await this.inventoryService.commitInChunks(ops, ops.length || 1, {
          augmentBatch: (batch) => batch.update(grnDocRef, {
            'approvalLock.chunksDone': i + 1,
            'approvalLock.lastProgressAt': serverTimestamp()
          })
        });
        chunksCommitted = i + 1;
      }

      await updateDoc(grnDocRef, {
        status: 'Approved',
        approvedAt: serverTimestamp(),
        approvalLock: deleteField(),
        updatedAt: serverTimestamp()
      });
      this.inventoryService.invalidateCache();
      this.invalidateGrnsCache();
      return 'approved';
    } catch (err) {
      await this.revertCommittedChunks(grnDocRef, grnNo, itemChunks, chunksCommitted);
      throw err;
    }
  }

  private async revertCommittedChunks(
    grnDocRef: ReturnType<typeof doc>,
    grnNo: string,
    itemChunks: GoodsInwardItem[][],
    chunksCommitted: number
  ): Promise<void> {
    for (let i = chunksCommitted - 1; i >= 0; i--) {
      let attempt = 0;
      // This network has documented intermittent connection drops; retry compensation
      // a few times before giving up, since failing to revert reproduces the exact bug.
      for (;;) {
        try {
          const revertOps = await this.inventoryService.buildInventoryOps(itemChunks[i], grnNo, -1);
          await this.inventoryService.commitInChunks(revertOps, revertOps.length || 1, {
            augmentBatch: (batch) => batch.update(grnDocRef, {
              'approvalLock.chunksDone': i,
              'approvalLock.lastProgressAt': serverTimestamp()
            })
          });
          break;
        } catch (revertErr) {
          attempt++;
          if (attempt >= this.REVERT_RETRIES) {
            this.inventoryService.invalidateCache();
            throw new Error(
              `Approval failed and automatic rollback could not complete for GRN ${grnNo} ` +
              `(chunk ${i + 1}/${itemChunks.length}). Inventory was NOT double-counted, but this ` +
              `record is stuck in 'Approving' and needs manual review. Original error: ${revertErr}`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
    }

    this.inventoryService.invalidateCache();
    await updateDoc(grnDocRef, { status: 'Pending', approvalLock: deleteField(), updatedAt: serverTimestamp() });
    this.invalidateGrnsCache();
  }

  private chunkItems(items: GoodsInwardItem[]): GoodsInwardItem[][] {
    if (!items.length) return [[]];
    const chunks: GoodsInwardItem[][] = [];
    for (let i = 0; i < items.length; i += this.APPROVE_CHUNK_ITEMS) {
      chunks.push(items.slice(i, i + this.APPROVE_CHUNK_ITEMS));
    }
    return chunks;
  }
}