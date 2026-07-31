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
import { from, firstValueFrom, Observable, map } from 'rxjs';
import type { SalesOrder } from '../models/sales-order.model';
import type {
  PickList,
  PickListClaimUser,
  PickListLine,
  PickListLineItem,
  PickListOrderSummary,
  PickListScanResult,
} from '../models/pick-list.model';
import type { InventoryItem } from '../models/inventory.model';
import { InventoryService } from './inventory.service';

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
  private plRef = collection(this.firestore, 'pickLists');

  // One-time read for the list screen — the active picking session for a single
  // pick list uses getPickListById()/getPickListLines() below, which stay live.
  getPickLists(pageLimit = 100): Observable<PickList[]> {
    const q = query(this.plRef, orderBy('createdAt', 'desc'), limit(pageLimit));
    return from(getDocs(q)).pipe(
      map((snap) => snap.docs.map((d) => this.normalizePickList({ id: d.id, ...d.data() })))
    );
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
    const normalizedLines = input.lines
      .map((line, index) => this.normalizeLine({ ...line, sortOrder: line.sortOrder ?? index }))
      .filter((line) => line.requiredQty > 0 && !!line.inventoryId && !!line.barcode && line.status !== 'blocked' && line.status !== 'pending_stock')
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    if (!normalizedLines.length) {
      throw new Error('no_scannable_lines');
    }

    const summary = this.buildSummary(normalizedLines);
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
        pickableLineCount: summary.pickableLineCount,
        completedLineCount: summary.completedLineCount,
        orderSummaries: summary.orderSummaries,
        items: summary.items,
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
    return pickListDoc.id;
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

    const summary = this.buildSummary(resetLines);
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
        items: summary.items.map((line) => ({
          ...line,
          pickedQty: 0,
          remainingQty: line.requiredQty,
          balanceQty: line.requiredQty + (line.pendingQty || 0),
          status: line.requiredQty > 0 && line.inventoryId && line.barcode ? 'ready' : line.status,
          claimedByUserId: undefined,
          claimedByUsername: undefined,
          claimExpiresAt: undefined,
          completedAt: undefined,
          completedByUserId: undefined,
          completedByUsername: undefined,
        })),
        inventoryReserved: true,
        legacyPickingPending: false,
        updatedAt: serverTimestamp(),
      })),
    ];

    await this.commitInChunks(operations);
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
      if (!liveLine.inventoryId) throw new Error('blocked');
      if (claimActive && liveLine.claimedByUserId && liveLine.claimedByUserId !== user.id) {
        throw new Error('line_claimed');
      }

      const inventoryRef = doc(this.firestore, `inventory/${liveLine.inventoryId}`);
      const inventorySnap = await transaction.get(inventoryRef);
      if (!inventorySnap.exists()) throw new Error('blocked');

      const inventory = inventorySnap.data() as any;
      const currentStock = Number(inventory.currentStock) || 0;
      if (!inventoryReserved && currentStock <= 0) throw new Error('stock_exhausted');

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
        claimedByUserId: lineCompleted ? null : user.id,
        claimedByUsername: lineCompleted ? null : user.username,
        claimExpiresAt: lineCompleted ? null : now + this.CLAIM_TTL_MS,
        completedAt: lineCompleted ? now : deleteField(),
        completedByUserId: lineCompleted ? user.id : deleteField(),
        completedByUsername: lineCompleted ? user.username : deleteField(),
        updatedAt: serverTimestamp(),
      }));

      if (!inventoryReserved) {
        transaction.update(inventoryRef, {
          currentStock: currentStock - 1,
          updatedAt: serverTimestamp(),
        });
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
    return result;
  }

  async recalculatePickListStatus(pickListId: string): Promise<void> {
    const [pickList, lines] = await Promise.all([
      this.getPickListByIdOnce(pickListId),
      this.getPickListLinesOnce(pickListId),
    ]);
    if (!pickList) return;
    // Once combined into a Packing List, a pick list's status must not be
    // recomputed back to 'Completed' — 'Packed' is a one-way terminal state.
    if (pickList.status === 'Packed') return;

    const summary = this.buildSummary(lines);
    await updateDoc(doc(this.firestore, `pickLists/${pickListId}`), this.stripUndefined({
      status: summary.status,
      totalRequiredQty: summary.totalRequiredQty,
      totalPickedQty: summary.totalPickedQty,
      totalPendingQty: summary.totalPendingQty,
      pickableLineCount: summary.pickableLineCount,
      completedLineCount: summary.completedLineCount,
      orderSummaries: summary.orderSummaries,
      items: summary.items,
      updatedAt: serverTimestamp(),
    }));
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
      : this.buildSummary(items);

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
      pickableLineCount: Number(raw?.pickableLineCount) || this.countPickableLines(items),
      completedLineCount: Number(raw?.completedLineCount) || this.countCompletedPickableLines(items),
      orderSummaries: orderSummaries.length ? orderSummaries : this.buildOrderSummaries(items),
      inventoryReserved: raw?.inventoryReserved === true,
      legacyPickingPending,
      items,
      remarks: raw?.remarks ?? '',
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

  private normalizeLineStatus(line: PickListLine): PickListLine['status'] {
    if (line.status === 'blocked' || line.status === 'pending_stock' || line.status === 'completed') {
      return line.status;
    }
    if (line.remainingQty <= 0) return 'completed';
    if (!line.inventoryId || !line.barcode) return line.requiredQty > 0 ? 'blocked' : 'pending_stock';
    if (line.requiredQty <= 0) return 'pending_stock';
    return this.deriveOpenStatus(line);
  }

  private deriveOpenStatus(line: PickListLine): PickListLine['status'] {
    if (line.remainingQty <= 0) return 'completed';
    if (!line.inventoryId || !line.barcode) return line.requiredQty > 0 ? 'blocked' : 'pending_stock';
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

  private buildSummary(lines: PickListLine[]) {
    const normalizedLines = lines.map((line) => this.normalizeLine(line));
    const orderSummaries = this.buildOrderSummaries(normalizedLines);
    const pickableLines = normalizedLines.filter((line) => this.isSummaryPickable(line));
    const totalRequiredQty = pickableLines.reduce((sum, line) => sum + line.requiredQty, 0);
    const totalPickedQty = pickableLines.reduce((sum, line) => sum + Math.min(line.pickedQty, line.requiredQty), 0);
    const totalPendingQty = normalizedLines.reduce((sum, line) => sum + (line.pendingQty || 0), 0);
    const pickableLineCount = pickableLines.length;
    const completedLineCount = pickableLines.filter((line) => line.remainingQty <= 0).length;

    return {
      totalRequiredQty,
      totalPickedQty,
      totalPendingQty,
      pickableLineCount,
      completedLineCount,
      status: this.computePickListStatus(totalRequiredQty, totalPickedQty, pickableLineCount, completedLineCount),
      orderSummaries,
      items: normalizedLines.map((line) => this.normalizeLine(line)),
    };
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
    return line.requiredQty > 0 && line.status !== 'blocked' && line.status !== 'pending_stock';
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
