import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  addDoc,
  collection,
  collectionData,
  deleteField,
  doc,
  docData,
  getDoc,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
  WriteBatch,
} from '@angular/fire/firestore';
import { from, firstValueFrom, Observable, map, shareReplay } from 'rxjs';
import type { SalesOrder } from '../models/sales-order.model';
import type {
  PickList,
  PickListClaimUser,
  PickListLine,
  PickListLineItem,
  PickListOrderSummary,
  PickListScanResult,
  PickListType,
} from '../models/pick-list.model';
import type { InventoryItem } from '../models/inventory.model';
import { InventoryService } from './inventory.service';
import { DesignService } from './design.service';
import { SalesOrderService } from './sales-order.service';
import { fetchAllDocs } from './firestore-pagination.util';

type StoredPickList = PickList & {
  orderSummaries?: PickListOrderSummary[];
  totalRequiredQty?: number;
  totalPickedQty?: number;
  totalPendingQty?: number;
  pickableLineCount?: number;
  completedLineCount?: number;
};

@Injectable({ providedIn: 'root' })
export class PickListService {
  private readonly CLAIM_TTL_MS = 2 * 60 * 1000;

  private firestore = inject(Firestore);
  private inventoryService = inject(InventoryService);
  private designService = inject(DesignService);
  private salesOrderService = inject(SalesOrderService);
  private plRef = collection(this.firestore, 'pickLists');
  private inventoryRef = collection(this.firestore, 'inventory');

  // One-time read for the list screen, paged through in full via
  // fetchAllDocs() — a prior fixed limit(100) here silently truncated the
  // list once pick lists passed that count. The active picking session for a
  // single pick list uses getPickListById()/getPickListLines() below, which
  // stay live. Cached, invalidated by every write in this service below.
  private pickListsCache$: Observable<PickList[]> | null = null;

  private invalidatePickListsCache(): void {
    this.pickListsCache$ = null;
  }

  getPickLists(): Observable<PickList[]> {
    if (!this.pickListsCache$) {
      this.pickListsCache$ = from(
        fetchAllDocs(this.plRef, [orderBy('createdAt', 'desc')], (d) => this.normalizePickList({ id: d.id, ...d.data() }))
      ).pipe(shareReplay(1));
    }
    return this.pickListsCache$;
  }

  getPickListById(id: string): Observable<PickList | null> {
    return (docData(doc(this.firestore, `pickLists/${id}`), { idField: 'id' }) as Observable<any>).pipe(
      map((pickList) => (pickList ? this.normalizePickList(pickList) : null))
    );
  }

  async getPickListByIdOnce(id: string): Promise<PickList | null> {
    const snap = await getDoc(doc(this.firestore, `pickLists/${id}`));
    return snap.exists() ? this.normalizePickList({ id: snap.id, ...snap.data() }) : null;
  }

  getPickListLines(id: string): Observable<PickListLine[]> {
    const q = query(this.linesCollection(id), orderBy('sortOrder', 'asc'));
    return (collectionData(q, { idField: 'lineId' }) as Observable<any[]>).pipe(
      map((lines) => lines.map((line) => this.normalizeLine(line)))
    );
  }

  async getPickListLinesOnce(id: string): Promise<PickListLine[]> {
    if (!id) return [];
    const snap = await getDocs(query(this.linesCollection(id), orderBy('sortOrder', 'asc')));
    return snap.docs.map((docSnap) => this.normalizeLine({ lineId: docSnap.id, ...docSnap.data() }));
  }

  async getPickListsForOrder(salesOrderId: string): Promise<PickList[]> {
    const snap = await getDocs(
      query(this.plRef, where('salesOrderIds', 'array-contains', salesOrderId))
    );
    return snap.docs.map((docSnap) => this.normalizePickList({ id: docSnap.id, ...docSnap.data() }));
  }

  async createGeneratedPickList(input: {
    pickListNo: string;
    type: PickList['type'];
    salesOrderIds: string[];
    salesNos: string[];
    clientId: string;
    clientName: string;
    remarks?: string;
    lines: PickListLine[];
  }): Promise<string> {
    // Design Master (barcode present) is what makes a line scannable — stock/
    // inventoryId is no longer required: a barcode with no inventory doc yet
    // (never received via GRN) is still picked, going negative at scan time.
    const normalizedLines = input.lines
      .map((line, index) => this.normalizeLine({ ...line, sortOrder: line.sortOrder ?? index }))
      .filter((line) => line.requiredQty > 0 && !!line.barcode && line.status !== 'blocked' && line.status !== 'pending_stock')
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    if (!normalizedLines.length) {
      throw new Error('no_scannable_lines');
    }

    const summary = this.buildSummary(normalizedLines, input.type);
    const pickListDoc = doc(this.plRef);
    const salesOrderIds = [...new Set(normalizedLines.map((line) => line.salesOrderId))];
    const salesNos = [...new Set(normalizedLines.map((line) => line.salesNo))];

    const operations: Array<(batch: WriteBatch) => void> = [
      (batch) => batch.set(pickListDoc, this.stripUndefined({
        pickListNo: input.pickListNo,
        type: input.type,
        salesOrderIds,
        salesNos,
        clientId: input.clientId,
        clientName: input.clientName,
        inventoryReserved: false,
        legacyPickingPending: false,
        remarks: input.remarks,
        status: summary.status,
        totalRequiredQty: summary.totalRequiredQty,
        totalPickedQty: summary.totalPickedQty,
        totalPendingQty: summary.totalPendingQty,
        totalAdditionalPickedQty: summary.totalAdditionalPickedQty,
        pickableLineCount: summary.pickableLineCount,
        completedLineCount: summary.completedLineCount,
        orderSummaries: summary.orderSummaries,
        totalRemainingQty: summary.totalRemainingQty,
        pickedByLineKey: summary.pickedByLineKey,
        partGroups: summary.partGroups,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })),
      ...normalizedLines.map((line) => (batch: WriteBatch) => batch.set(this.lineDoc(pickListDoc.id, line.lineId), this.stripUndefined({
        ...line,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }))),
    ];

    await this.commitInChunks(operations);
    this.invalidatePickListsCache();
    return pickListDoc.id;
  }

  // A Pick List may be edited/deleted only before any Packing List has been
  // generated from it — totalPackedIntoPackingListsQty (and the per-line
  // packedIntoPackingListsQty it's rolled up from) already means exactly
  // "how much of this Pick List has actually been carried into a Packing
  // List" (see createGeneratedPackingList/recalculatePickListStatus), so it
  // doubles as the "packing started" lock with no new field needed. Always
  // called against a freshly-read pickList/lines, never a caller-supplied
  // (possibly stale) copy — this is the real backend guard, not just a
  // frontend button hide.
  private assertPickListEditable(pickList: PickList, lines: PickListLine[]): void {
    const packed = (pickList.totalPackedIntoPackingListsQty ?? 0) > 0
      || lines.some((line) => (line.packedIntoPackingListsQty ?? 0) > 0);
    if (packed) throw new Error('picklist_packing_started');
  }

  async deletePickList(pickListId: string): Promise<void> {
    const [pickList, lines] = await Promise.all([
      this.getPickListByIdOnce(pickListId),
      this.getPickListLinesOnce(pickListId),
    ]);
    if (!pickList) return;
    this.assertPickListEditable(pickList, lines);

    // Any already-scanned quantity was deducted from inventory at scan time
    // (unless this Pick List's stock was pre-reserved) — deleting the list
    // must give that stock back rather than silently losing it from the count.
    const restoreByInventoryId = new Map<string, number>();
    if (!pickList.inventoryReserved) {
      for (const line of lines) {
        if (line.pickedQty > 0 && line.inventoryId) {
          restoreByInventoryId.set(line.inventoryId, (restoreByInventoryId.get(line.inventoryId) ?? 0) + line.pickedQty);
        }
      }
    }

    const operations: Array<(batch: WriteBatch) => void> = [
      ...lines.map((line) => (batch: WriteBatch) => batch.delete(this.lineDoc(pickListId, line.lineId))),
      (batch) => batch.delete(doc(this.firestore, `pickLists/${pickListId}`)),
      ...[...restoreByInventoryId.entries()].map(([inventoryId, qty]) => (batch: WriteBatch) =>
        batch.update(doc(this.firestore, `inventory/${inventoryId}`), { currentStock: increment(qty), updatedAt: serverTimestamp() })),
    ];

    await this.commitInChunks(operations);
    this.invalidatePickListsCache();
    if (restoreByInventoryId.size > 0) this.inventoryService.invalidateCache();
  }

  // input.lines is the caller's complete desired end-state for the lines
  // subcollection (existing lines with an edited requiredQty, additional
  // lines with a possibly-lowered pickedQty, plus any newly-added order
  // lines with pickedQty 0). Diffed here against a fresh read of the current
  // subcollection — scan-derived truth (pickedQty on non-additional lines)
  // is never taken from the caller, only requiredQty/removal/addition are.
  async updatePickList(pickListId: string, input: { lines: PickListLine[] }): Promise<void> {
    const [pickList, currentLines] = await Promise.all([
      this.getPickListByIdOnce(pickListId),
      this.getPickListLinesOnce(pickListId),
    ]);
    if (!pickList) throw new Error('picklist_not_found');
    this.assertPickListEditable(pickList, currentLines);

    const currentById = new Map(currentLines.map((line) => [line.lineId, line]));
    const finalById = new Map(input.lines.map((line) => [line.lineId, line]));
    const canRestore = !pickList.inventoryReserved;
    const restoreByInventoryId = new Map<string, number>();
    const addRestore = (inventoryId: string | undefined, qty: number) => {
      if (!canRestore || !inventoryId || qty <= 0) return;
      restoreByInventoryId.set(inventoryId, (restoreByInventoryId.get(inventoryId) ?? 0) + qty);
    };

    const operations: Array<(batch: WriteBatch) => void> = [];
    const finalLines: PickListLine[] = [];

    // Removed entirely (whole line/order dropped) — restore its full picked qty.
    for (const line of currentLines) {
      if (finalById.has(line.lineId)) continue;
      addRestore(line.inventoryId, line.pickedQty);
      operations.push((batch) => batch.delete(this.lineDoc(pickListId, line.lineId)));
    }

    for (const requested of input.lines) {
      const current = currentById.get(requested.lineId);

      if (!current) {
        // New line — added via "Add Sales Order", never yet picked.
        const created = this.normalizeLine({ ...requested, pickedQty: 0, remainingQty: requested.requiredQty });
        finalLines.push(created);
        operations.push((batch) => batch.set(this.lineDoc(pickListId, created.lineId), this.stripUndefined({
          ...created,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })));
        continue;
      }

      if (current.isAdditional) {
        // Additional lines can only be reduced or removed here — never
        // increased (a genuine new extra item must be scanned, not typed).
        const newPickedQty = Math.max(0, Math.min(Number(requested.pickedQty) || 0, current.pickedQty));
        if (newPickedQty <= 0) {
          addRestore(current.inventoryId, current.pickedQty);
          operations.push((batch) => batch.delete(this.lineDoc(pickListId, current.lineId)));
          continue;
        }
        addRestore(current.inventoryId, current.pickedQty - newPickedQty);
        const updated = this.normalizeLine({
          ...current,
          pickedQty: newPickedQty,
          requiredQty: newPickedQty,
          remainingQty: 0,
          claimedByUserId: undefined,
          claimedByUsername: undefined,
          claimExpiresAt: undefined,
        });
        finalLines.push(updated);
        operations.push((batch) => batch.update(this.lineDoc(pickListId, current.lineId), this.stripUndefined({
          pickedQty: updated.pickedQty,
          requiredQty: updated.requiredQty,
          remainingQty: updated.remainingQty,
          status: updated.status,
          claimedByUserId: null,
          claimedByUsername: null,
          claimExpiresAt: null,
          updatedAt: serverTimestamp(),
        })));
        continue;
      }

      // Existing Sales-Order-derived line — client controls requiredQty
      // only; pickedQty is read live and only ever lowered here (never
      // raised — that only happens via scanning), restoring the difference.
      const newRequiredQty = Math.max(0, Number(requested.requiredQty) || 0);
      let pickedQty = current.pickedQty;
      if (newRequiredQty < current.pickedQty) {
        addRestore(current.inventoryId, current.pickedQty - newRequiredQty);
        pickedQty = newRequiredQty;
      }
      const remainingQty = Math.max(0, newRequiredQty - pickedQty);
      const updated = this.normalizeLine({
        ...current,
        requiredQty: newRequiredQty,
        pickedQty,
        remainingQty,
        balanceQty: remainingQty + (current.pendingQty || 0),
        // normalizeLineStatus() short-circuits and keeps 'blocked' /
        // 'pending_stock' / 'completed' as-is rather than re-deriving — pass
        // a non-terminal status so a qty change (e.g. re-raising a
        // previously-completed line's requiredQty) actually re-derives
        // ready/in_progress/completed instead of being stuck on the old one.
        status: 'ready',
        claimedByUserId: undefined,
        claimedByUsername: undefined,
        claimExpiresAt: undefined,
      });
      finalLines.push(updated);
      operations.push((batch) => batch.update(this.lineDoc(pickListId, current.lineId), this.stripUndefined({
        requiredQty: updated.requiredQty,
        pickedQty: updated.pickedQty,
        remainingQty: updated.remainingQty,
        balanceQty: updated.balanceQty,
        status: updated.status,
        claimedByUserId: null,
        claimedByUsername: null,
        claimExpiresAt: null,
        updatedAt: serverTimestamp(),
      })));
    }

    const salesOrderIds = [...new Set(finalLines.map((line) => line.salesOrderId).filter(Boolean))];
    const salesNos = [...new Set(finalLines.map((line) => line.salesNo).filter(Boolean))];

    operations.push((batch) => batch.update(doc(this.firestore, `pickLists/${pickListId}`), this.stripUndefined({
      salesOrderIds,
      salesNos,
      updatedAt: serverTimestamp(),
    })));
    operations.push(...[...restoreByInventoryId.entries()].map(([inventoryId, qty]) => (batch: WriteBatch) =>
      batch.update(doc(this.firestore, `inventory/${inventoryId}`), { currentStock: increment(qty), updatedAt: serverTimestamp() })));

    await this.commitInChunks(operations);
    await this.recalculatePickListStatus(pickListId);
    if (restoreByInventoryId.size > 0) this.inventoryService.invalidateCache();
  }

  private async commitInChunks(operations: Array<(batch: WriteBatch) => void>, chunkSize = 450): Promise<void> {
    for (let i = 0; i < operations.length; i += chunkSize) {
      const batch = writeBatch(this.firestore);
      operations.slice(i, i + chunkSize).forEach((op) => op(batch));
      await batch.commit();
    }
  }

  async ensureLegacyPickListLines(pickList: PickList): Promise<PickListLine[]> {
    if (!pickList.id) return [];

    const existingLines = await getDocs(query(this.linesCollection(pickList.id), limit(1)));
    if (!existingLines.empty) {
      return this.getPickListLinesOnce(pickList.id);
    }

    const sourceItems = Array.isArray(pickList.items) ? pickList.items : [];
    const legacyLines: PickListLine[] = [];
    const inventoryList = await firstValueFrom(this.inventoryService.getInventory());

    for (let index = 0; index < sourceItems.length; index += 1) {
      const source = this.normalizeLine({ ...sourceItems[index], lineId: sourceItems[index]?.lineId ?? `legacy-${index + 1}` });
      const inventory = this.findInventoryMatch(inventoryList, source.styleNo, source.color, source.size, source.sleeveType);
      const pickableQty = Math.max(0, source.requiredQty || (source.orderedQty - (source.pendingQty || 0)));
      const pickedQty = Math.min(source.pickedQty, pickableQty);
      const remainingQty = Math.max(0, pickableQty - pickedQty);
      const pendingQty = Math.max(0, Number(source.pendingQty) || 0);
      const status = !inventory?.id || !inventory?.barcode
        ? (pickableQty > 0 ? 'blocked' : 'pending_stock')
        : this.deriveOpenStatus({
            ...source,
            requiredQty: pickableQty,
            pickedQty,
            remainingQty,
            pendingQty,
            inventoryId: inventory.id,
            barcode: inventory.barcode,
          });

      legacyLines.push(this.normalizeLine({
        ...source,
        lineId: source.lineId || `legacy-${index + 1}`,
        inventoryId: inventory?.id,
        barcode: inventory?.barcode,
        requiredQty: pickableQty,
        pickedQty,
        remainingQty,
        balanceQty: remainingQty + pendingQty,
        pendingQty,
        status,
        sortOrder: source.sortOrder ?? index,
      }));
    }

    await this.commitInChunks(legacyLines.map((line) => (batch: WriteBatch) => batch.set(this.lineDoc(pickList.id!, line.lineId), this.stripUndefined({
      ...line,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }))));
    await this.recalculatePickListStatus(pickList.id);

    return this.getPickListLinesOnce(pickList.id);
  }

  async prepareLegacyPickListForPicking(pickListId: string): Promise<PickList | null> {
    const pickList = await this.getPickListByIdOnce(pickListId);
    if (!pickList?.id) return pickList;

    const sourceItems = Array.isArray(pickList.items) ? pickList.items : [];
    if (!sourceItems.length) return pickList;

    const resetLines: PickListLine[] = [];
    const inventoryList = await firstValueFrom(this.inventoryService.getInventory());
    for (let index = 0; index < sourceItems.length; index += 1) {
      const source = this.normalizeLine({ ...sourceItems[index], lineId: sourceItems[index]?.lineId ?? `legacy-${index + 1}` });
      const inventory = this.findInventoryMatch(inventoryList, source.styleNo, source.color, source.size, source.sleeveType);
      const requiredQty = Math.max(0, Number(source.requiredQty) || Number(source.pickedQty) || Math.max(0, source.orderedQty - (source.pendingQty || 0)));
      const pendingQty = Math.max(0, Number(source.pendingQty) || 0);
      const isReady = requiredQty > 0 && !!inventory?.id && !!inventory?.barcode;
      const status: PickListLine['status'] = isReady ? 'ready' : requiredQty > 0 ? 'blocked' : 'pending_stock';

      resetLines.push(this.normalizeLine({
        ...source,
        lineId: source.lineId || `legacy-${index + 1}`,
        inventoryId: inventory?.id,
        barcode: inventory?.barcode,
        requiredQty,
        pickedQty: 0,
        remainingQty: requiredQty,
        balanceQty: requiredQty + pendingQty,
        pendingQty,
        status,
        claimedByUserId: undefined,
        claimedByUsername: undefined,
        claimExpiresAt: undefined,
        completedAt: undefined,
        completedByUserId: undefined,
        completedByUsername: undefined,
        sortOrder: source.sortOrder ?? index,
      }));
    }

    const summary = this.buildSummary(resetLines, pickList.type);
    const operations: Array<(batch: WriteBatch) => void> = [
      ...resetLines.map((line) => (batch: WriteBatch) => batch.set(this.lineDoc(pickListId, line.lineId), this.stripUndefined({
        ...line,
        updatedAt: serverTimestamp(),
      }))),
      (batch) => batch.update(doc(this.firestore, `pickLists/${pickListId}`), this.stripUndefined({
        status: summary.status,
        totalRequiredQty: summary.totalRequiredQty,
        totalPickedQty: 0,
        totalPendingQty: summary.totalPendingQty,
        pickableLineCount: summary.pickableLineCount,
        completedLineCount: 0,
        orderSummaries: summary.orderSummaries.map((entry) => ({ ...entry, pickedQty: 0 })),
        // summary was built from resetLines, which already have pickedQty:0/
        // remainingQty:requiredQty per line — so these already reflect the
        // reset state directly, no extra zeroing needed.
        totalRemainingQty: summary.totalRemainingQty,
        pickedByLineKey: summary.pickedByLineKey,
        partGroups: summary.partGroups,
        // Shrinks any pre-fix doc that still carries the legacy `items` array
        // (see PickList.items doc comment) — this is the exact write path
        // that used to grow it, so it's the natural place to drop it too.
        items: deleteField(),
        inventoryReserved: true,
        legacyPickingPending: false,
        updatedAt: serverTimestamp(),
      })),
    ];

    await this.commitInChunks(operations);
    this.invalidatePickListsCache();
    return this.getPickListByIdOnce(pickListId);
  }

  async claimNextLine(
    pickListId: string,
    user: PickListClaimUser,
    preferredLineId?: string,
    retryCount = 0
  ): Promise<PickListLine | null> {
    const now = Date.now();

    // Fast path: if caller already knows which line they want, check it with a single doc read.
    if (preferredLineId) {
      const snap = await getDoc(this.lineDoc(pickListId, preferredLineId));
      if (snap.exists()) {
        const line = this.normalizeLine({ lineId: snap.id, ...snap.data() });
        if (this.isClaimUsable(line, user.id, now)) {
          return this.refreshClaim(pickListId, preferredLineId, user);
        }
      }
    }

    // Load only the lines that matter: claims by this user + the next batch of candidates.
    // Requires composite indexes: (claimedByUserId, status) and (status, sortOrder) on collection group "lines".
    const [claimedByUserSnap, candidatesSnap] = await Promise.all([
      getDocs(query(this.linesCollection(pickListId), where('claimedByUserId', '==', user.id))),
      getDocs(query(
        this.linesCollection(pickListId),
        where('status', 'in', ['ready', 'in_progress']),
        orderBy('sortOrder', 'asc'),
        limit(30),
      )),
    ]);

    const userClaimedLines = claimedByUserSnap.docs.map(d => this.normalizeLine({ lineId: d.id, ...d.data() }));
    const candidateLines = candidatesSnap.docs.map(d => this.normalizeLine({ lineId: d.id, ...d.data() }));

    // Re-use existing active claim if still valid.
    const activeOwnedLine = userClaimedLines.find(line => this.isClaimUsable(line, user.id, now) && line.claimedByUserId === user.id);
    if (activeOwnedLine) {
      return this.refreshClaim(pickListId, activeOwnedLine.lineId, user);
    }

    // Pick the first candidate that is actually free (expired/no claim, or owned by this user).
    const claimableLine = candidateLines.find(line => this.isLineAvailableForClaim(line, user.id, now));
    if (!claimableLine) return null;

    // Release any stale claims this user holds on other lines.
    const ownedClaims = userClaimedLines.filter(
      line => line.claimedByUserId === user.id && line.lineId !== claimableLine.lineId && this.isClaimActive(line, now)
    );
    if (ownedClaims.length > 0) {
      const batch = writeBatch(this.firestore);
      for (const line of ownedClaims) {
        batch.update(this.lineDoc(pickListId, line.lineId), {
          claimedByUserId: null,
          claimedByUsername: null,
          claimExpiresAt: null,
          status: this.deriveOpenStatus({ ...line, claimedByUserId: undefined }),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }

    try {
      return await runTransaction(this.firestore, async (transaction) => {
        const lineRef = this.lineDoc(pickListId, claimableLine.lineId);
        const snap = await transaction.get(lineRef);
        if (!snap.exists()) return null;

        const line = this.normalizeLine({ lineId: snap.id, ...snap.data() });
        const transactionNow = Date.now();
        if (!this.isLineAvailableForClaim(line, user.id, transactionNow)) {
          throw new Error('claim_conflict');
        }

        transaction.update(lineRef, this.stripUndefined({
          claimedByUserId: user.id,
          claimedByUsername: user.username,
          claimExpiresAt: transactionNow + this.CLAIM_TTL_MS,
          status: this.deriveOpenStatus({ ...line, claimedByUserId: user.id, claimedByUsername: user.username }),
          updatedAt: serverTimestamp(),
        }));

        return this.normalizeLine({
          ...line,
          claimedByUserId: user.id,
          claimedByUsername: user.username,
          claimExpiresAt: transactionNow + this.CLAIM_TTL_MS,
        });
      });
    } catch (error: any) {
      if (error?.message === 'claim_conflict' && retryCount < 3) {
        return this.claimNextLine(pickListId, user, undefined, retryCount + 1);
      }
      throw error;
    }
  }

  async refreshClaim(pickListId: string, lineId: string, user: PickListClaimUser): Promise<PickListLine | null> {
    return runTransaction(this.firestore, async (transaction) => {
      const lineRef = this.lineDoc(pickListId, lineId);
      const snap = await transaction.get(lineRef);
      if (!snap.exists()) return null;

      const line = this.normalizeLine({ lineId: snap.id, ...snap.data() });
      const now = Date.now();
      const claimActive = this.isClaimActive(line, now);
      if (claimActive && line.claimedByUserId && line.claimedByUserId !== user.id) {
        throw new Error('claim_conflict');
      }
      if (!this.isLivePickableLine(line)) {
        return null;
      }

      transaction.update(lineRef, this.stripUndefined({
        claimedByUserId: user.id,
        claimedByUsername: user.username,
        claimExpiresAt: now + this.CLAIM_TTL_MS,
        status: this.deriveOpenStatus({ ...line, claimedByUserId: user.id, claimedByUsername: user.username }),
        updatedAt: serverTimestamp(),
      }));

      return this.normalizeLine({
        ...line,
        claimedByUserId: user.id,
        claimedByUsername: user.username,
        claimExpiresAt: now + this.CLAIM_TTL_MS,
      });
    });
  }

  async releaseClaim(pickListId: string, lineId: string, user: PickListClaimUser): Promise<void> {
    await runTransaction(this.firestore, async (transaction) => {
      const lineRef = this.lineDoc(pickListId, lineId);
      const snap = await transaction.get(lineRef);
      if (!snap.exists()) return;

      const line = this.normalizeLine({ lineId: snap.id, ...snap.data() });
      if (line.claimedByUserId !== user.id || line.status === 'completed') return;

      transaction.update(lineRef, {
        claimedByUserId: null,
        claimedByUsername: null,
        claimExpiresAt: null,
        status: this.deriveOpenStatus({
          ...line,
          claimedByUserId: undefined,
          claimedByUsername: undefined,
          claimExpiresAt: undefined,
        }),
        updatedAt: serverTimestamp(),
      });
    });
  }

  async processScan(
    pickListId: string,
    barcode: string,
    user: PickListClaimUser,
    currentLineId?: string
  ): Promise<PickListScanResult> {
    const trimmedBarcode = barcode.trim();
    if (!trimmedBarcode) {
      throw new Error('barcode_not_found');
    }

    const line = await this.resolveScannableLine(pickListId, trimmedBarcode, user.id, currentLineId);
    if (!line) {
      throw new Error(currentLineId ? 'barcode_mismatch' : 'barcode_not_found');
    }

    // Design Master (via computeOrderLines at draft time) is what makes this
    // barcode valid to pick — a line missing inventoryId just means no
    // `inventory` doc exists yet for it (never received via GRN), not that
    // the barcode itself is invalid. Resolved outside the transaction since
    // it may need a query + a Design Master read; reuse the line's own
    // inventoryId when already known to avoid that extra cost on every scan.
    const inventoryLookup = line.inventoryId
      ? { ref: doc(this.firestore, `inventory/${line.inventoryId}`), seed: null }
      : await this.resolveInventoryRefForBarcode(trimmedBarcode);

    const result = await runTransaction(this.firestore, async (transaction) => {
      const lineRef = this.lineDoc(pickListId, line.lineId);
      const pickListRef = doc(this.firestore, `pickLists/${pickListId}`);
      const [lineSnap, pickListSnap] = await Promise.all([
        transaction.get(lineRef),
        transaction.get(pickListRef),
      ]);

      if (!lineSnap.exists()) throw new Error('barcode_not_found');
      if (!pickListSnap.exists()) throw new Error('picklist_not_found');

      const liveLine = this.normalizeLine({ lineId: lineSnap.id, ...lineSnap.data() });
      const pickList = this.normalizePickList({ id: pickListSnap.id, ...pickListSnap.data() });
      const now = Date.now();
      const claimActive = this.isClaimActive(liveLine, now);
      const inventoryReserved = !!pickList.inventoryReserved;

      if (currentLineId && liveLine.lineId !== currentLineId) throw new Error('barcode_mismatch');
      if (trimmedBarcode !== String(liveLine.barcode ?? '').trim()) throw new Error('barcode_mismatch');
      if (liveLine.status === 'completed' || liveLine.remainingQty <= 0) throw new Error('line_completed');
      if (liveLine.status === 'blocked') throw new Error('blocked');
      if (liveLine.status === 'pending_stock' || liveLine.requiredQty <= 0) throw new Error('pending_stock');
      if (claimActive && liveLine.claimedByUserId && liveLine.claimedByUserId !== user.id) {
        throw new Error('line_claimed');
      }

      // Stock is checked (and, below, decremented — possibly negative) but no
      // longer gates the scan: Design Master already validated the barcode,
      // and zero/no stock must not block picking.
      const inventorySnap = inventoryReserved ? null : await transaction.get(inventoryLookup.ref);
      const currentStock = inventorySnap?.exists() ? (Number(inventorySnap.data()?.['currentStock']) || 0) : 0;

      const nextPickedQty = liveLine.pickedQty + 1;
      if (nextPickedQty > liveLine.requiredQty) throw new Error('line_completed');

      const nextRemainingQty = Math.max(0, liveLine.requiredQty - nextPickedQty);
      const lineCompleted = nextRemainingQty === 0;
      const updatedLine = this.normalizeLine({
        ...liveLine,
        pickedQty: nextPickedQty,
        remainingQty: nextRemainingQty,
        balanceQty: nextRemainingQty + (liveLine.pendingQty || 0),
        status: lineCompleted ? 'completed' : 'in_progress',
        inventoryId: liveLine.inventoryId || inventoryLookup.ref.id,
        claimedByUserId: lineCompleted ? undefined : user.id,
        claimedByUsername: lineCompleted ? undefined : user.username,
        claimExpiresAt: lineCompleted ? undefined : now + this.CLAIM_TTL_MS,
        completedAt: lineCompleted ? now : undefined,
        completedByUserId: lineCompleted ? user.id : undefined,
        completedByUsername: lineCompleted ? user.username : undefined,
      });

      transaction.update(lineRef, this.stripUndefined({
        pickedQty: updatedLine.pickedQty,
        remainingQty: updatedLine.remainingQty,
        balanceQty: updatedLine.balanceQty,
        status: updatedLine.status,
        inventoryId: updatedLine.inventoryId,
        claimedByUserId: lineCompleted ? null : user.id,
        claimedByUsername: lineCompleted ? null : user.username,
        claimExpiresAt: lineCompleted ? null : now + this.CLAIM_TTL_MS,
        completedAt: lineCompleted ? now : deleteField(),
        completedByUserId: lineCompleted ? user.id : deleteField(),
        completedByUsername: lineCompleted ? user.username : deleteField(),
        updatedAt: serverTimestamp(),
      }));

      if (!inventoryReserved) {
        if (inventorySnap?.exists()) {
          transaction.update(inventoryLookup.ref, {
            currentStock: currentStock - 1,
            updatedAt: serverTimestamp(),
          });
        } else if (inventoryLookup.seed) {
          // No inventory doc exists at all for this barcode (never received
          // via GRN) — create one now, going straight to -1, rather than
          // blocking a Design-Master-valid barcode for lack of a stock record.
          transaction.set(inventoryLookup.ref, this.stripUndefined({
            barcode: trimmedBarcode,
            designId: liveLine.designId,
            styleNo: liveLine.styleNo,
            color: liveLine.color,
            group: liveLine.group,
            size: liveLine.size,
            sleeveType: liveLine.sleeveType,
            fabricType: inventoryLookup.seed.fabricType,
            currentStock: -1,
            totalReceived: 0,
            WSP: inventoryLookup.seed.wsp,
            price: inventoryLookup.seed.price,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }));
        }
      }

      const nextTotalPickedQty = Math.min((pickList.totalPickedQty || 0) + 1, pickList.totalRequiredQty || 0);
      const nextCompletedLineCount = (pickList.completedLineCount || 0) + (lineCompleted ? 1 : 0);
      const nextOrderSummaries = (pickList.orderSummaries ?? []).map((summary) => {
        if (summary.salesOrderId !== liveLine.salesOrderId) return summary;
        return {
          ...summary,
          pickedQty: Math.min(summary.requiredQty, (summary.pickedQty || 0) + 1),
        };
      });

      const nextStatus = this.computePickListStatus(
        pickList.totalRequiredQty || 0,
        nextTotalPickedQty,
        pickList.pickableLineCount || 0,
        nextCompletedLineCount
      );

      transaction.update(pickListRef, this.stripUndefined({
        totalPickedQty: nextTotalPickedQty,
        completedLineCount: nextCompletedLineCount,
        orderSummaries: nextOrderSummaries,
        status: nextStatus,
        updatedAt: serverTimestamp(),
      }));

      const updatedOrderSummary = nextOrderSummaries.find((summary) => summary.salesOrderId === liveLine.salesOrderId);
      return {
        line: updatedLine,
        lineCompleted,
        pickListCompleted: nextStatus === 'Completed',
        orderCompleted: !!updatedOrderSummary && updatedOrderSummary.requiredQty > 0 && updatedOrderSummary.pickedQty >= updatedOrderSummary.requiredQty,
        salesOrderId: liveLine.salesOrderId,
      } satisfies PickListScanResult;
    });

    // The transaction may have deducted inventory.currentStock — drop the cached
    // inventory list so the next read (Dashboard/Reports/Inventory screen) is fresh.
    this.inventoryService.invalidateCache();
    this.invalidatePickListsCache();
    return result;
  }

  async recalculatePickListStatus(pickListId: string): Promise<void> {
    const [pickList, lines] = await Promise.all([
      this.getPickListByIdOnce(pickListId),
      this.getPickListLinesOnce(pickListId),
    ]);
    if (!pickList) return;

    const summary = this.buildSummary(lines, pickList.type);
    await updateDoc(doc(this.firestore, `pickLists/${pickListId}`), this.stripUndefined({
      status: summary.status,
      totalRequiredQty: summary.totalRequiredQty,
      totalPickedQty: summary.totalPickedQty,
      totalPendingQty: summary.totalPendingQty,
      totalAdditionalPickedQty: summary.totalAdditionalPickedQty,
      totalPackedIntoPackingListsQty: summary.totalPackedIntoPackingListsQty,
      pickableLineCount: summary.pickableLineCount,
      completedLineCount: summary.completedLineCount,
      orderSummaries: summary.orderSummaries,
      totalRemainingQty: summary.totalRemainingQty,
      pickedByLineKey: summary.pickedByLineKey,
      partGroups: summary.partGroups,
      // Shrinks any pre-fix doc that still carries the legacy full-line
      // `items` array (see PickList.items doc comment — this was the write
      // path that grew real pick lists past Firestore's 1 MiB limit, since
      // this is called on every edit and every Packing List generation).
      items: deleteField(),
      updatedAt: serverTimestamp(),
    }));
    this.invalidatePickListsCache();
  }

  /**
   * Explicit "Complete Pick List" action for Party-wise lists — snapshots
   * whatever quantity has actually been scanned as the picked total and
   * marks the list ready for Packing, regardless of remaining pending
   * quantity. This does NOT force status to 'Completed': the real
   * completion state is preserved (via computeEffectiveStatus — for a
   * 'party' list, Completed only once every required unit has actually
   * flowed into a Packing List, Partial otherwise) so downstream screens
   * report and pack the true picked quantity, not the original Sales Order
   * quantity.
   *
   * `finalizedAt` is an eligibility marker only — it does NOT lock the list
   * from further scanning, and does NOT prevent generating more Packing
   * Lists from it later (a Pick List may be packed in several batches — see
   * PackingListService.createGeneratedPackingList). A 'Partial' list,
   * finalized or not, stays fully resumable — a user may come back later
   * and pick more of the pending Sales Order items or scan new additional
   * items; each scan updates totals/status live regardless of finalizedAt.
   */
  async finalizePickList(pickListId: string, user: PickListClaimUser): Promise<PickList | null> {
    const [pickList, lines] = await Promise.all([
      this.getPickListByIdOnce(pickListId),
      this.getPickListLinesOnce(pickListId),
    ]);
    if (!pickList) return null;

    const summary = this.buildSummary(lines, pickList.type);
    const now = Date.now();
    const finalStatus = summary.status === 'Completed' ? 'Completed' : 'Partial';

    await updateDoc(doc(this.firestore, `pickLists/${pickListId}`), this.stripUndefined({
      status: finalStatus,
      totalRequiredQty: summary.totalRequiredQty,
      totalPickedQty: summary.totalPickedQty,
      totalPendingQty: summary.totalPendingQty,
      totalAdditionalPickedQty: summary.totalAdditionalPickedQty,
      totalPackedIntoPackingListsQty: summary.totalPackedIntoPackingListsQty,
      pickableLineCount: summary.pickableLineCount,
      completedLineCount: summary.completedLineCount,
      orderSummaries: summary.orderSummaries,
      totalRemainingQty: summary.totalRemainingQty,
      pickedByLineKey: summary.pickedByLineKey,
      partGroups: summary.partGroups,
      // See recalculatePickListStatus for why this actively removes the
      // legacy `items` field rather than just no longer adding to it.
      items: deleteField(),
      finalizedAt: now,
      finalizedByUserId: user.id,
      finalizedByUsername: user.username,
      updatedAt: serverTimestamp(),
    }));
    this.invalidatePickListsCache();

    await Promise.all(
      summary.orderSummaries
        .filter((entry) => entry.requiredQty > 0 && entry.pickedQty >= entry.requiredQty)
        .map((entry) => this.syncSalesOrderShipment(pickListId, entry.salesOrderId))
    );

    return this.getPickListByIdOnce(pickListId);
  }

  /**
   * Scan handler for Party-wise pick lists. Unlike processScan(), this has no
   * claim/next-line assignment — any barcode may be scanned in any order. A
   * barcode matching a requested line with remaining capacity tops that line
   * up first; anything else (an unlisted barcode, or extra units of an
   * already-fulfilled requested line) lands in a separate "additional" line
   * keyed by barcode, so a Packing List built from this pick list never loses
   * over-picked quantity (buildPackableLines() caps a line's pickedQty at its
   * own requiredQty).
   */
  async processPartyScan(
    pickListId: string,
    barcode: string,
    user: PickListClaimUser
  ): Promise<PickListScanResult> {
    const trimmedBarcode = barcode.trim();
    if (!trimmedBarcode) {
      throw new Error('barcode_not_found');
    }

    const existingSnap = await getDocs(query(this.linesCollection(pickListId), where('barcode', '==', trimmedBarcode)));
    const existingLines = existingSnap.docs.map((docSnap) => this.normalizeLine({ lineId: docSnap.id, ...docSnap.data() }));

    const requestedLine = existingLines.find(
      (line) => !line.isAdditional && line.status !== 'blocked' && line.pickedQty < line.requiredQty
    );
    const additionalLine = existingLines.find((line) => line.isAdditional);

    let targetLineId: string;
    let newLineSeed: PickListLine | null = null;

    if (requestedLine) {
      targetLineId = requestedLine.lineId;
    } else if (additionalLine) {
      targetLineId = additionalLine.lineId;
    } else {
      targetLineId = `ADD-${this.sanitizeLineIdPart(trimmedBarcode)}`;

      // Design Master is the source of truth for whether this barcode is
      // valid to pick at all — Inventory is only consulted afterward, purely
      // for its current stock level/doc id (which may not exist yet).
      const [designMatch, pickList] = await Promise.all([
        this.designService.findDesignSizeByBarcode(trimmedBarcode),
        this.getPickListByIdOnce(pickListId),
      ]);
      if (!designMatch) throw new Error('barcode_not_found');
      if (!pickList) throw new Error('picklist_not_found');

      const inventoryMatches = await this.inventoryService.getInventoryByBarcodes([trimmedBarcode]);
      const inventory = inventoryMatches[0];

      newLineSeed = this.normalizeLine({
        lineId: targetLineId,
        salesOrderId: pickList.salesOrderIds[0] ?? '',
        salesNo: pickList.salesNos[0] ?? '',
        clientId: pickList.clientId,
        clientName: pickList.clientName,
        designId: designMatch.design.id ?? '',
        styleNo: designMatch.design.styleNo,
        color: designMatch.design.color ?? '',
        group: designMatch.design.group ?? '',
        size: designMatch.sizeEntry.size,
        sleeveType: designMatch.sizeEntry.sleeveType ?? undefined,
        barcode: trimmedBarcode,
        inventoryId: inventory?.id,
        orderedQty: 0,
        requiredQty: 0,
        pickedQty: 0,
        remainingQty: 0,
        balanceQty: 0,
        pendingQty: 0,
        status: 'ready',
        isAdditional: true,
        sortOrder: 1_000_000,
      });
    }

    // Resolved outside the transaction — see processScan for why (may need a
    // query + a Design Master read when no inventory doc exists yet).
    const knownInventoryId = requestedLine?.inventoryId ?? additionalLine?.inventoryId ?? newLineSeed?.inventoryId;
    const inventoryLookup = knownInventoryId
      ? { ref: doc(this.firestore, `inventory/${knownInventoryId}`), seed: null }
      : await this.resolveInventoryRefForBarcode(trimmedBarcode);

    const result = await runTransaction(this.firestore, async (transaction) => {
      const lineRef = this.lineDoc(pickListId, targetLineId);
      const pickListRef = doc(this.firestore, `pickLists/${pickListId}`);
      const [lineSnap, pickListSnap] = await Promise.all([
        transaction.get(lineRef),
        transaction.get(pickListRef),
      ]);

      if (!pickListSnap.exists()) throw new Error('picklist_not_found');
      const pickList = this.normalizePickList({ id: pickListSnap.id, ...pickListSnap.data() });

      const liveLine = lineSnap.exists()
        ? this.normalizeLine({ lineId: lineSnap.id, ...lineSnap.data() })
        : newLineSeed;
      if (!liveLine) throw new Error('barcode_not_found');
      if (String(liveLine.barcode ?? '').trim() !== trimmedBarcode) throw new Error('barcode_mismatch');
      if (liveLine.status === 'blocked') throw new Error('blocked');

      // Stock is checked (and, below, decremented — possibly negative) but no
      // longer gates the scan: Design Master already validated the barcode,
      // and zero/no stock must not block picking.
      const inventoryReserved = !!pickList.inventoryReserved;
      const inventorySnap = inventoryReserved ? null : await transaction.get(inventoryLookup.ref);
      const currentStock = inventorySnap?.exists() ? (Number(inventorySnap.data()?.['currentStock']) || 0) : 0;

      const nextPickedQty = liveLine.pickedQty + 1;
      if (!liveLine.isAdditional && nextPickedQty > liveLine.requiredQty) throw new Error('line_completed');

      const nextRequiredQty = liveLine.isAdditional ? nextPickedQty : liveLine.requiredQty;
      const nextRemainingQty = Math.max(0, nextRequiredQty - nextPickedQty);
      const lineCompleted = !liveLine.isAdditional && nextRemainingQty === 0;
      const now = Date.now();

      const updatedLine = this.normalizeLine({
        ...liveLine,
        requiredQty: nextRequiredQty,
        pickedQty: nextPickedQty,
        remainingQty: nextRemainingQty,
        balanceQty: nextRemainingQty + (liveLine.pendingQty || 0),
        status: liveLine.isAdditional ? 'in_progress' : (lineCompleted ? 'completed' : 'in_progress'),
        inventoryId: liveLine.inventoryId || inventoryLookup.ref.id,
        completedAt: lineCompleted ? now : undefined,
        completedByUserId: lineCompleted ? user.id : undefined,
        completedByUsername: lineCompleted ? user.username : undefined,
      });

      transaction.set(lineRef, this.stripUndefined({
        ...updatedLine,
        createdAt: lineSnap.exists() ? (lineSnap.data() as any)?.createdAt ?? serverTimestamp() : serverTimestamp(),
        updatedAt: serverTimestamp(),
      }));

      if (!inventoryReserved) {
        if (inventorySnap?.exists()) {
          transaction.update(inventoryLookup.ref, {
            currentStock: currentStock - 1,
            updatedAt: serverTimestamp(),
          });
        } else if (inventoryLookup.seed) {
          // No inventory doc exists at all for this barcode (never received
          // via GRN) — create one now, going straight to -1, rather than
          // blocking a Design-Master-valid barcode for lack of a stock record.
          transaction.set(inventoryLookup.ref, this.stripUndefined({
            barcode: trimmedBarcode,
            designId: liveLine.designId,
            styleNo: liveLine.styleNo,
            color: liveLine.color,
            group: liveLine.group,
            size: liveLine.size,
            sleeveType: liveLine.sleeveType,
            fabricType: inventoryLookup.seed.fabricType,
            currentStock: -1,
            totalReceived: 0,
            WSP: inventoryLookup.seed.wsp,
            price: inventoryLookup.seed.price,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }));
        }
      }

      const nextTotalPickedQty = liveLine.isAdditional
        ? (pickList.totalPickedQty || 0)
        : Math.min((pickList.totalPickedQty || 0) + 1, pickList.totalRequiredQty || 0);
      const nextTotalAdditionalPickedQty = (pickList.totalAdditionalPickedQty || 0) + (liveLine.isAdditional ? 1 : 0);
      const nextCompletedLineCount = (pickList.completedLineCount || 0) + (lineCompleted ? 1 : 0);
      const nextOrderSummaries = liveLine.isAdditional
        ? (pickList.orderSummaries ?? [])
        : (pickList.orderSummaries ?? []).map((summary) => {
            if (summary.salesOrderId !== liveLine.salesOrderId) return summary;
            return {
              ...summary,
              pickedQty: Math.min(summary.requiredQty, (summary.pickedQty || 0) + 1),
            };
          });

      const nextStatus = this.computeEffectiveStatus(
        pickList.type,
        pickList.totalRequiredQty || 0,
        nextTotalPickedQty,
        pickList.totalPackedIntoPackingListsQty || 0,
        pickList.pickableLineCount || 0,
        nextCompletedLineCount
      );

      transaction.update(pickListRef, this.stripUndefined({
        totalPickedQty: nextTotalPickedQty,
        totalAdditionalPickedQty: nextTotalAdditionalPickedQty,
        completedLineCount: nextCompletedLineCount,
        orderSummaries: nextOrderSummaries,
        status: nextStatus,
        updatedAt: serverTimestamp(),
      }));

      const updatedOrderSummary = nextOrderSummaries.find((summary) => summary.salesOrderId === liveLine.salesOrderId);
      return {
        line: updatedLine,
        lineCompleted,
        pickListCompleted: !liveLine.isAdditional && nextStatus === 'Completed',
        orderCompleted: !liveLine.isAdditional && !!updatedOrderSummary && updatedOrderSummary.requiredQty > 0 && updatedOrderSummary.pickedQty >= updatedOrderSummary.requiredQty,
        salesOrderId: liveLine.salesOrderId,
      } satisfies PickListScanResult;
    });

    this.inventoryService.invalidateCache();
    this.invalidatePickListsCache();
    return result;
  }

  async syncSalesOrderShipment(_pickListId: string, salesOrderId: string): Promise<void> {
    if (!salesOrderId) return;

    const [orderSnap, orderPickLists] = await Promise.all([
      getDoc(doc(this.firestore, `salesOrders/${salesOrderId}`)),
      this.getPickListsForOrder(salesOrderId),
    ]);

    if (!orderSnap.exists()) return;

    const order = orderSnap.data() as SalesOrder;
    const totalOrderedQty = (order.items ?? []).reduce(
      (orderTotal, item) => orderTotal + (item.itemSizes ?? []).reduce((itemTotal, size) => itemTotal + (Number(size.quantity) || 0), 0),
      0
    );

    const totalPickedQty = orderPickLists.reduce((pickedTotal, pickList) => {
      const orderSummary = pickList.orderSummaries?.find((summary) => summary.salesOrderId === salesOrderId);
      if (orderSummary) {
        return pickedTotal + Math.min(orderSummary.pickedQty || 0, orderSummary.requiredQty || 0);
      }

      return pickedTotal + (pickList.items ?? [])
        .filter((line) => line.salesOrderId === salesOrderId)
        .reduce((lineTotal, line) => lineTotal + Math.min(line.pickedQty || 0, line.requiredQty || 0), 0);
    }, 0);

    const nextStatus: SalesOrder['status'] = totalOrderedQty > 0 && totalPickedQty >= totalOrderedQty
      ? 'Shipped'
      : order.status === 'Shipped'
        ? 'Confirmed'
        : order.status;

    if (nextStatus === order.status) return;

    // Write only the changed field — spreading the entire order object writes every field unnecessarily.
    await updateDoc(doc(this.firestore, `salesOrders/${salesOrderId}`), {
      status: nextStatus,
      updatedAt: serverTimestamp(),
    });
    this.salesOrderService.invalidateCache();
  }

  // Resolves the `inventory` doc to decrement stock against for a barcode
  // during picking. Design Master is what makes a barcode valid to pick (see
  // findDesignSizeByBarcode) — Inventory only tracks its stock level, which
  // may legitimately not exist yet (never received via GRN). When no
  // inventory doc exists, this returns a deterministic barcode-derived doc id
  // (rather than an auto-generated one) so two concurrent first-time scans of
  // the same never-before-seen barcode converge on the same document instead
  // of each creating their own — the transaction re-checks existence with its
  // own transaction.get() regardless, so this is a concurrency safety net,
  // not the authoritative check.
  private async resolveInventoryRefForBarcode(barcode: string): Promise<{
    ref: ReturnType<typeof doc>;
    seed: { wsp: number; price: number; fabricType: string } | null;
  }> {
    const existing = await this.inventoryService.getInventoryByBarcodes([barcode]);
    if (existing[0]?.id) {
      return { ref: doc(this.firestore, `inventory/${existing[0].id}`), seed: null };
    }
    const designMatch = await this.designService.findDesignSizeByBarcode(barcode);
    const safeId = `bc-${barcode.trim().replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    return {
      ref: doc(this.firestore, `inventory/${safeId}`),
      seed: {
        wsp: Number(designMatch?.sizeEntry.WSP) || 0,
        price: Number(designMatch?.sizeEntry.price) || 0,
        fabricType: designMatch?.sizeEntry.fabricType ?? '',
      },
    };
  }

  private async resolveScannableLine(
    pickListId: string,
    barcode: string,
    userId: string,
    currentLineId?: string
  ): Promise<PickListLine | null> {
    if (currentLineId) {
      const snap = await getDoc(this.lineDoc(pickListId, currentLineId));
      if (!snap.exists()) return null;
      const line = this.normalizeLine({ lineId: snap.id, ...snap.data() });
      return String(line.barcode ?? '').trim() === barcode ? line : null;
    }

    const snap = await getDocs(query(this.linesCollection(pickListId), where('barcode', '==', barcode)));
    if (snap.empty) return null;

    const lines = snap.docs.map((docSnap) => this.normalizeLine({ lineId: docSnap.id, ...docSnap.data() }));
    const now = Date.now();
    return (
      lines.find((line) => line.claimedByUserId === userId && this.isLivePickableLine(line)) ??
      lines.find((line) => this.isLineAvailableForClaim(line, userId, now)) ??
      lines[0] ??
      null
    );
  }

  private findInventoryMatch(
    inventoryList: InventoryItem[],
    styleNo: string,
    color: string,
    size: string,
    sleeveType?: string
  ): { id: string; barcode?: string } | null {
    const candidates = inventoryList.filter(
      (inv) => inv.styleNo === styleNo && inv.color === color && inv.size === size
    );

    const exactSleeveMatch = candidates.find((inv) => (inv.sleeveType ?? '') === (sleeveType ?? ''));
    if (exactSleeveMatch) return { id: exactSleeveMatch.id!, barcode: exactSleeveMatch.barcode };

    const fallbackMatch = candidates.find((inv) => !sleeveType || !inv.sleeveType);
    if (fallbackMatch) return { id: fallbackMatch.id!, barcode: fallbackMatch.barcode };

    return null;
  }

  private linesCollection(pickListId: string) {
    return collection(this.firestore, `pickLists/${pickListId}/lines`);
  }

  private lineDoc(pickListId: string, lineId: string) {
    return doc(this.firestore, `pickLists/${pickListId}/lines/${lineId}`);
  }

  private normalizePickList(raw: any): PickList {
    const items = Array.isArray(raw?.items) ? raw.items.map((line: any) => this.normalizeLine(line)) : [];
    const orderSummaries = Array.isArray(raw?.orderSummaries)
      ? raw.orderSummaries.map((summary: any) => this.normalizeOrderSummary(summary))
      : [];
    const legacyPickingPending = raw?.inventoryReserved !== true
      && Array.isArray(raw?.items)
      && raw.items.some((line: any) => (Number(line?.pickedQty) || 0) > 0)
      && raw.items.every((line: any) => !line?.completedAt && !line?.completedByUserId)
      && raw?.status === 'Completed';

    const fallbackSummary = orderSummaries.length
      ? {
          totalRequiredQty: orderSummaries.reduce((sum, summary) => sum + summary.requiredQty, 0),
          totalPickedQty: orderSummaries.reduce((sum, summary) => sum + summary.pickedQty, 0),
          totalPendingQty: orderSummaries.reduce((sum, summary) => sum + summary.pendingQty, 0),
        }
      : this.buildSummary(items, raw?.type);

    return {
      id: raw?.id,
      pickListNo: raw?.pickListNo ?? '',
      type: raw?.type ?? 'direct',
      salesOrderIds: Array.isArray(raw?.salesOrderIds)
        ? raw.salesOrderIds
        : raw?.salesOrderId ? [raw.salesOrderId] : [],
      salesNos: Array.isArray(raw?.salesNos)
        ? raw.salesNos
        : raw?.salesNo ? [raw.salesNo] : [],
      clientId: raw?.clientId ?? '',
      clientName: raw?.clientName ?? '',
      status: raw?.status ?? 'Draft',
      totalRequiredQty: Number(raw?.totalRequiredQty) || fallbackSummary.totalRequiredQty || 0,
      totalPickedQty: Number(raw?.totalPickedQty) || fallbackSummary.totalPickedQty || 0,
      totalPendingQty: Number(raw?.totalPendingQty) || fallbackSummary.totalPendingQty || 0,
      totalAdditionalPickedQty: Number(raw?.totalAdditionalPickedQty) || 0,
      totalPackedIntoPackingListsQty: Number(raw?.totalPackedIntoPackingListsQty) || 0,
      pickableLineCount: Number(raw?.pickableLineCount) || this.countPickableLines(items),
      completedLineCount: Number(raw?.completedLineCount) || this.countCompletedPickableLines(items),
      orderSummaries: orderSummaries.length ? orderSummaries : this.buildOrderSummaries(items),
      inventoryReserved: raw?.inventoryReserved === true,
      legacyPickingPending,
      // Kept only as the migration source for ensureLegacyPickListLines()/
      // prepareLegacyPickListForPicking() on pre-fix docs that still carry a
      // stored `items` array — always `[]` for any doc written after the fix.
      items,
      // totalRemainingQty/pickedByLineKey/partGroups replace the legacy `items`
      // duplication (see PickList.items doc comment) — for docs written after
      // that fix, these come straight from the stored aggregate fields; for
      // any older doc that still carries a full `items` array but hasn't been
      // touched by a write since, they're derived here from that array so
      // every consumer stays correct without needing a migration write first.
      totalRemainingQty: raw?.totalRemainingQty != null
        ? Number(raw.totalRemainingQty) || 0
        : items.reduce((sum, line) => sum + (line.remainingQty || 0), 0),
      pickedByLineKey: raw?.pickedByLineKey && typeof raw.pickedByLineKey === 'object'
        ? raw.pickedByLineKey
        : this.buildPickedByLineKey(items),
      partGroups: Array.isArray(raw?.partGroups)
        ? raw.partGroups.map((g: any) => String(g))
        : this.buildPartGroups(items),
      remarks: raw?.remarks ?? '',
      finalizedAt: raw?.finalizedAt != null ? Number(raw.finalizedAt) || 0 : undefined,
      finalizedByUserId: raw?.finalizedByUserId,
      finalizedByUsername: raw?.finalizedByUsername,
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }

  private normalizeLine(raw: any): PickListLine {
    const orderedQty = Math.max(0, Number(raw?.orderedQty) || 0);
    const pendingQty = Math.max(0, Number(raw?.pendingQty) || 0);
    const requiredQty = Math.max(0, Number(raw?.requiredQty) || Math.max(0, orderedQty - pendingQty));
    const pickedQty = Math.max(0, Number(raw?.pickedQty) || 0);
    const remainingQty = Math.max(
      0,
      raw?.remainingQty != null ? Number(raw.remainingQty) || 0 : Math.max(0, requiredQty - pickedQty)
    );
    const balanceQty = Math.max(
      0,
      raw?.balanceQty != null ? Number(raw.balanceQty) || 0 : remainingQty + pendingQty
    );

    const line: PickListLine = {
      lineId: String(raw?.lineId ?? ''),
      salesOrderId: String(raw?.salesOrderId ?? ''),
      salesNo: String(raw?.salesNo ?? ''),
      clientId: raw?.clientId ?? '',
      clientName: raw?.clientName ?? '',
      designId: String(raw?.designId ?? ''),
      styleNo: String(raw?.styleNo ?? ''),
      color: String(raw?.color ?? ''),
      group: String(raw?.group ?? ''),
      size: String(raw?.size ?? ''),
      sleeveType: raw?.sleeveType ?? undefined,
      barcode: raw?.barcode ?? undefined,
      inventoryId: raw?.inventoryId ?? undefined,
      orderedQty,
      requiredQty,
      pickedQty,
      remainingQty,
      balanceQty,
      pendingQty,
      status: raw?.status ?? 'ready',
      claimedByUserId: raw?.claimedByUserId ?? undefined,
      claimedByUsername: raw?.claimedByUsername ?? undefined,
      claimExpiresAt: raw?.claimExpiresAt != null ? Number(raw.claimExpiresAt) || 0 : undefined,
      completedAt: raw?.completedAt != null ? Number(raw.completedAt) || 0 : undefined,
      completedByUserId: raw?.completedByUserId ?? undefined,
      completedByUsername: raw?.completedByUsername ?? undefined,
      sortOrder: raw?.sortOrder != null ? Number(raw.sortOrder) || 0 : 0,
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
      isAdditional: raw?.isAdditional === true,
      packedIntoPackingListsQty: Math.max(0, Number(raw?.packedIntoPackingListsQty) || 0),
    };

    return {
      ...line,
      status: this.normalizeLineStatus(line),
    };
  }

  private normalizeOrderSummary(raw: any): PickListOrderSummary {
    return {
      salesOrderId: String(raw?.salesOrderId ?? ''),
      salesNo: String(raw?.salesNo ?? ''),
      clientId: String(raw?.clientId ?? ''),
      clientName: String(raw?.clientName ?? ''),
      requiredQty: Math.max(0, Number(raw?.requiredQty) || 0),
      pickedQty: Math.max(0, Number(raw?.pickedQty) || 0),
      pendingQty: Math.max(0, Number(raw?.pendingQty) || 0),
    };
  }

  // Barcode (Design Master) is what makes a line valid to pick — inventoryId
  // is deliberately NOT part of this check: a line can have a barcode but no
  // inventory doc yet (never received via GRN) and must still be 'ready',
  // not 'blocked'. See processScan/processPartyScan for the negative-stock
  // decrement/auto-create logic that follows from this.
  private normalizeLineStatus(line: PickListLine): PickListLine['status'] {
    if (line.status === 'blocked' || line.status === 'pending_stock' || line.status === 'completed') {
      return line.status;
    }
    if (line.remainingQty <= 0) return 'completed';
    if (!line.barcode) return line.requiredQty > 0 ? 'blocked' : 'pending_stock';
    if (line.requiredQty <= 0) return 'pending_stock';
    return this.deriveOpenStatus(line);
  }

  private deriveOpenStatus(line: PickListLine): PickListLine['status'] {
    if (line.remainingQty <= 0) return 'completed';
    if (!line.barcode) return line.requiredQty > 0 ? 'blocked' : 'pending_stock';
    if (line.requiredQty <= 0) return 'pending_stock';
    return line.pickedQty > 0 ? 'in_progress' : 'ready';
  }

  private isLivePickableLine(line: PickListLine): boolean {
    return line.requiredQty > 0 && line.remainingQty > 0 && line.status !== 'blocked' && line.status !== 'pending_stock';
  }

  private isClaimActive(line: PickListLine, now: number): boolean {
    return !!line.claimedByUserId && !!line.claimExpiresAt && line.claimExpiresAt > now;
  }

  private isClaimUsable(line: PickListLine, userId: string, now: number): boolean {
    return this.isLivePickableLine(line) && (!this.isClaimActive(line, now) || line.claimedByUserId === userId);
  }

  private isLineAvailableForClaim(line: PickListLine, userId: string, now: number): boolean {
    if (!this.isLivePickableLine(line)) return false;
    if (!this.isClaimActive(line, now)) return true;
    return line.claimedByUserId === userId;
  }

  private buildSummary(lines: PickListLine[], type?: PickListType) {
    const normalizedLines = lines.map((line) => this.normalizeLine(line));
    const orderSummaries = this.buildOrderSummaries(normalizedLines);
    const pickableLines = normalizedLines.filter((line) => this.isSummaryPickable(line));
    const totalRequiredQty = pickableLines.reduce((sum, line) => sum + line.requiredQty, 0);
    const totalPickedQty = pickableLines.reduce((sum, line) => sum + Math.min(line.pickedQty, line.requiredQty), 0);
    const totalPendingQty = normalizedLines.reduce((sum, line) => sum + (line.pendingQty || 0), 0);
    const totalAdditionalPickedQty = normalizedLines
      .filter((line) => line.isAdditional)
      .reduce((sum, line) => sum + line.pickedQty, 0);
    const totalPackedIntoPackingListsQty = normalizedLines
      .reduce((sum, line) => sum + Math.min(line.packedIntoPackingListsQty || 0, line.pickedQty || 0), 0);
    const pickableLineCount = pickableLines.length;
    const completedLineCount = pickableLines.filter((line) => line.remainingQty <= 0).length;
    // Sum of remainingQty across ALL lines (not just pickable ones) — matches
    // exactly what dashboard.component.ts's reservedInventoryQty() used to sum
    // over the (now-legacy) `items` array, so this is a drop-in replacement.
    const totalRemainingQty = normalizedLines.reduce((sum, line) => sum + (line.remainingQty || 0), 0);

    return {
      totalRequiredQty,
      totalPickedQty,
      totalPendingQty,
      totalAdditionalPickedQty,
      totalPackedIntoPackingListsQty,
      totalRemainingQty,
      pickableLineCount,
      completedLineCount,
      status: this.computeEffectiveStatus(type, totalRequiredQty, totalPickedQty, totalPackedIntoPackingListsQty, pickableLineCount, completedLineCount),
      orderSummaries,
      pickedByLineKey: this.buildPickedByLineKey(normalizedLines),
      partGroups: this.buildPartGroups(normalizedLines),
    };
  }

  // Compact replacement for scanning the (legacy) `items` array to find how
  // much of a given order/style/color/size/sleeve combo has already been
  // picked — a flat map (key -> summed pickedQty) costs a tiny fraction of
  // the bytes of an array of full line objects, since it carries no repeated
  // field names, just one string key + one number per line.
  private buildPickedByLineKey(lines: PickListLine[]): Record<string, number> {
    const map: Record<string, number> = {};
    for (const line of lines) {
      const key = `${line.salesOrderId}||${line.styleNo}||${line.color}||${String(line.size)}||${line.sleeveType ?? ''}`;
      map[key] = (map[key] ?? 0) + (line.pickedQty || 0);
    }
    return map;
  }

  // Compact replacement for scanning the (legacy) `items` array to count
  // distinct parts/groups — just the distinct group names, not one entry per
  // line.
  private buildPartGroups(lines: PickListLine[]): string[] {
    const groups = new Set<string>();
    for (const line of lines) {
      groups.add(String(line.group ?? '').trim() || 'General');
    }
    return [...groups];
  }

  private buildOrderSummaries(lines: PickListLine[]): PickListOrderSummary[] {
    const map = new Map<string, PickListOrderSummary>();

    for (const line of lines) {
      const existing = map.get(line.salesOrderId) ?? {
        salesOrderId: line.salesOrderId,
        salesNo: line.salesNo,
        clientId: line.clientId ?? '',
        clientName: line.clientName ?? '',
        requiredQty: 0,
        pickedQty: 0,
        pendingQty: 0,
      };

      if (this.isSummaryPickable(line)) {
        existing.requiredQty += line.requiredQty;
        existing.pickedQty += Math.min(line.pickedQty, line.requiredQty);
      }
      existing.pendingQty += line.pendingQty || 0;
      map.set(line.salesOrderId, existing);
    }

    return [...map.values()];
  }

  private isSummaryPickable(line: PickListLine): boolean {
    return !line.isAdditional && line.requiredQty > 0 && line.status !== 'blocked' && line.status !== 'pending_stock';
  }

  private sanitizeLineIdPart(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private countPickableLines(lines: PickListLine[]): number {
    return lines.filter((line) => this.isSummaryPickable(this.normalizeLine(line))).length;
  }

  private countCompletedPickableLines(lines: PickListLine[]): number {
    return lines.filter((line) => {
      const normalized = this.normalizeLine(line);
      return this.isSummaryPickable(normalized) && normalized.remainingQty <= 0;
    }).length;
  }

  private computePickListStatus(
    totalRequiredQty: number,
    totalPickedQty: number,
    pickableLineCount: number,
    completedLineCount: number
  ): PickList['status'] {
    if (pickableLineCount <= 0 || totalRequiredQty <= 0) return 'Pending';
    if (completedLineCount >= pickableLineCount || totalPickedQty >= totalRequiredQty) return 'Completed';
    if (totalPickedQty <= 0) return 'Draft';
    return 'Partial';
  }

  // Party-wise Pick Lists can be packed in several batches (many Packing
  // Lists over time — see PackingListService.createGeneratedPackingList), so
  // finishing the scanning/picking step alone must not report 'Completed':
  // that would suggest the whole Pick List is done and ready to ship when
  // most of it might still be sitting unpacked. For type 'party', 'Completed'
  // is reserved for "every required unit has actually been carried into a
  // Packing List" — everything short of that is 'Partial' (or the normal
  // Pending/Draft "nothing happened yet" states). Other pick list types keep
  // the original picking-only status, since they don't support multi-batch
  // packing today.
  private computeEffectiveStatus(
    type: PickListType | undefined,
    totalRequiredQty: number,
    totalPickedQty: number,
    totalPackedIntoPackingListsQty: number,
    pickableLineCount: number,
    completedLineCount: number
  ): PickList['status'] {
    const pickingStatus = this.computePickListStatus(totalRequiredQty, totalPickedQty, pickableLineCount, completedLineCount);
    if (type !== 'party') return pickingStatus;
    if (pickingStatus === 'Pending' || pickingStatus === 'Draft') return pickingStatus;
    if (totalPackedIntoPackingListsQty >= totalRequiredQty) return 'Completed';
    return 'Partial';
  }

  private stripUndefined<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((item) => this.stripUndefined(item)) as unknown as T;
    }
    if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .map(([key, entry]) => [key, this.stripUndefined(entry)])
      ) as T;
    }
    return value;
  }
}
