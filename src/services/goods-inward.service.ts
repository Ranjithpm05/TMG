import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  orderBy,
  serverTimestamp,
  Timestamp,
  where,
} from '@angular/fire/firestore';
import { getDocs, runTransaction } from './firestore-reads';
import { Observable } from 'rxjs';
import type { GoodsInward, GoodsInwardItem } from '../models/goods-inward.model';
import { InventoryService } from './inventory.service';
import { invalidateRangeCaches, removeFromRangeCaches, syncedRangeQuery } from './range-cache.util';
import { SyncedCollectionCache, byCreatedAtDesc } from './synced-collection-cache.util';

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
  // Synced via updatedAt delta queries (SyncedCollectionCache) — see there.
  private readonly grnsCache = new SyncedCollectionCache<GoodsInward>({
    storageKey: 'goodsInwards',
    collectionRef: this.grnRef,
    constraints: [orderBy('createdAt', 'desc')],
    requiredField: 'createdAt',
    mapDoc: (d) => ({ id: d.id, ...d.data() } as GoodsInward),
    compare: byCreatedAtDesc,
    afterFetch: (grns) => this.healCorruptedCreatedAt(grns),
  });

  // getGoodsInwardsInRange() is keyed by exact (start, end) pair — same
  // reasoning as SalesOrderService.salesOrdersRangeCache. Dashboard previously
  // called getGoodsInwards() (the full, ever-growing history) just to filter
  // it down to one date range client-side.
  private grnsRangeCache = new Map<string, SyncedCollectionCache<GoodsInward>>();
  private static readonly MAX_RANGE_CACHE_ENTRIES = 30;

  private invalidateGrnsCache(): void {
    this.grnsCache.invalidate();
    invalidateRangeCaches(this.grnsRangeCache);
  }

  /** True only for a real Firestore Timestamp or JS Date — false for a missing value or a corrupted plain map/string/number, which Firestore can't range-query the same way. */
  private isValidTimestampType(value: unknown): boolean {
    const raw: any = value;
    return !!raw && (typeof raw.toDate === 'function' || raw instanceof Date);
  }

  /**
   * Treats a missing/unparseable createdAt as 0 (oldest) instead of throwing or
   * excluding the doc. Also recovers the exact original instant from a corrupted
   * {seconds, nanoseconds, ...} map (see updateGoodsInward) rather than treating
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

  /** Falls back to the GRN's own receivedDate/invoiceDate before resorting to "now". */
  private bestEffortCreatedAt(grn: GoodsInward): Date {
    const parsedReceivedDate = grn.receivedDate ? new Date(grn.receivedDate) : null;
    if (parsedReceivedDate && !Number.isNaN(parsedReceivedDate.getTime())) return parsedReceivedDate;

    const parsedInvoiceDate = grn.invoiceDate ? new Date(grn.invoiceDate) : null;
    if (parsedInvoiceDate && !Number.isNaN(parsedInvoiceDate.getTime())) return parsedInvoiceDate;

    return new Date();
  }

  // Self-heal: any GRN whose createdAt has been corrupted into a plain
  // {seconds, nanoseconds} map (see updateGoodsInward doc comment) is invisible
  // to getGoodsInwardsInRange() — the where('createdAt', ...) queries used by
  // Dashboard/Reports require a real Timestamp to match against, and silently
  // exclude any doc where the field is the wrong type. This only ever runs from
  // this unbounded "All" read, which already fetches every doc regardless — so
  // it costs no extra reads, only repairs the (hopefully rare) broken ones, and
  // patches the in-memory result too so this same read reflects the fix immediately.
  private async healCorruptedCreatedAt(grns: GoodsInward[]): Promise<void> {
    const broken = grns.filter(g => !this.isValidTimestampType(g.createdAt));
    if (broken.length === 0) return;

    await Promise.all(broken.map(async grn => {
      // A corrupted map still carries the true original value — recover it
      // exactly rather than falling back to an approximation.
      const recoveredMillis = this.toMillis(grn.createdAt);
      const repairedDate = recoveredMillis > 0 ? new Date(recoveredMillis) : this.bestEffortCreatedAt(grn);
      const timestamp = Timestamp.fromDate(repairedDate);
      try {
        await updateDoc(doc(this.firestore, `goodsInward/${grn.id}`), { createdAt: timestamp });
        (grn as unknown as { createdAt: unknown }).createdAt = timestamp;
      } catch {
        // Best-effort only — if the write fails (e.g. permissions), leave the
        // doc as-is; it'll simply be retried the next time this method runs.
      }
    }));
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
    return this.grnsCache.get$();
  }

  // 🔹 Date-bounded one-time query — see getGoodsInwards() above for why this
  // exists (Dashboard only needs GRNs within its selected date range, not the
  // entire history). Cached per exact (start, end) pair; see grnsRangeCache above.
  getGoodsInwardsInRange(start: Date, end: Date, options?: { cachedFirst?: boolean }): Observable<GoodsInward[]> {
    return syncedRangeQuery({
      cache: this.grnsRangeCache,
      collectionName: 'goodsInward',
      collectionRef: this.grnRef,
      start,
      end,
      mapDoc: (d) => ({ id: d.id, ...d.data() } as GoodsInward),
      maxEntries: GoodsInwardService.MAX_RANGE_CACHE_ENTRIES,
      cachedFirst: options?.cachedFirst,
    });
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
  //
  // createdAt must never be part of an update payload. The caller's `grn` is
  // typically a JSON.parse(JSON.stringify(...)) deep copy of a previously-fetched
  // doc (see GoodsInwardComponent.showEditForm), and Firestore's Timestamp defines
  // toJSON() (for SSR/serialization support) — so that round-trip silently turns a
  // real createdAt Timestamp into a plain {seconds, nanoseconds, ...} map. Writing
  // that back stores createdAt as an ordinary Firestore map instead of a Timestamp,
  // which then fails to match every where('createdAt', ...) range query used by
  // getGoodsInwardsInRange() (Dashboard/Reports) — silently vanishing this GRN from
  // every date-filtered screen even though it still shows in the unbounded list.
  // createdAt is immutable after creation, so it's simply never touched here — see
  // SalesOrderService.updateSalesOrder for the identical fix.
  async updateGoodsInward(grn: GoodsInward): Promise<void> {
    if (!grn.id) return;
    const { id, createdAt, ...rest } = grn;
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
    // A delta query can't see deletions — without this the next sync's
    // count() check fails and re-downloads the entire GRN collection.
    this.grnsCache.removeOne(id);
    removeFromRangeCaches(this.grnsRangeCache, id);
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
        // updatedAt: other devices' delta sync must see the lock too.
        updatedAt: serverTimestamp(),
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