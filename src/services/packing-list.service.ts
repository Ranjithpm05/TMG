import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  collectionData,
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
} from '@angular/fire/firestore';
import { map, Observable } from 'rxjs';
import { PickListLine } from '../models/pick-list.model';
import {
  PackingCarton,
  PackingCartonEntry,
  PackingList,
  PackingListLine,
  PackingMode,
  PackingPartSummary,
  PackingPartyProgress,
  PackingScanResult,
} from '../models/packing-list.model';

@Injectable({ providedIn: 'root' })
export class PackingListService {
  private firestore = inject(Firestore);
  private packingRef = collection(this.firestore, 'packingLists');
  private inventoryRef = collection(this.firestore, 'inventory');

  getPackingLists(): Observable<PackingList[]> {
    const q = query(this.packingRef, orderBy('createdAt', 'desc'));
    return (collectionData(q, { idField: 'id' }) as Observable<any[]>).pipe(
      map((packingLists) => packingLists.map((packingList) => this.normalizePackingList(packingList)))
    );
  }

  getPackingListById(id: string): Observable<PackingList | null> {
    return (docData(doc(this.firestore, `packingLists/${id}`), { idField: 'id' }) as Observable<any>).pipe(
      map((packingList) => (packingList ? this.normalizePackingList(packingList) : null))
    );
  }

  async getPackingListByIdOnce(id: string): Promise<PackingList | null> {
    const snap = await getDoc(doc(this.firestore, `packingLists/${id}`));
    return snap.exists() ? this.normalizePackingList({ id: snap.id, ...snap.data() }) : null;
  }

  getPackingListLines(id: string): Observable<PackingListLine[]> {
    const q = query(this.linesCollection(id), orderBy('sortOrder', 'asc'));
    return (collectionData(q, { idField: 'lineId' }) as Observable<any[]>).pipe(
      map((lines) => lines.map((line) => this.normalizeLine(line)))
    );
  }

  async getPackingListLinesOnce(id: string): Promise<PackingListLine[]> {
    const snap = await getDocs(query(this.linesCollection(id), orderBy('sortOrder', 'asc')));
    return snap.docs.map((docSnap) => this.normalizeLine({ lineId: docSnap.id, ...docSnap.data() }));
  }

  async getPackingListByPickListIdOnce(pickListId: string): Promise<PackingList | null> {
    const snap = await getDocs(query(this.packingRef, where('pickListId', '==', pickListId), limit(1)));
    const first = snap.docs[0];
    return first ? this.normalizePackingList({ id: first.id, ...first.data() }) : null;
  }

  async getPackingListsByPickListIdOnce(pickListId: string): Promise<PackingList[]> {
    const snap = await getDocs(query(this.packingRef, where('pickListId', '==', pickListId)));
    return snap.docs.map((docSnap) => this.normalizePackingList({ id: docSnap.id, ...docSnap.data() }));
  }

  async createGeneratedPackingList(input: {
    packingListNo: string;
    pickListId: string;
    pickListNo: string;
    salesOrderIds: string[];
    salesNos: string[];
    clientId: string;
    clientName: string;
    packingMode: PackingMode;
    remarks?: string;
    lines: PickListLine[];
  }): Promise<string> {
    const normalizedLines = this.buildPackableLines(input.lines);
    if (!normalizedLines.length) {
      throw new Error('no_packable_lines');
    }

    const summary = this.buildSummary(normalizedLines, [], input.clientName);
    const packingListDoc = doc(this.packingRef);
    const batch = writeBatch(this.firestore);

    batch.set(packingListDoc, this.stripUndefined({
      packingListNo: input.packingListNo,
      pickListId: input.pickListId,
      pickListNo: input.pickListNo,
      salesOrderIds: [...new Set(input.salesOrderIds)],
      salesNos: [...new Set(input.salesNos)],
      clientId: input.clientId,
      clientName: input.clientName,
      packingMode: input.packingMode,
      remarks: input.remarks,
      status: summary.status,
      totalRequiredQty: summary.totalRequiredQty,
      totalPackedQty: summary.totalPackedQty,
      lineCount: summary.lineCount,
      completedLineCount: summary.completedLineCount,
      cartonCount: summary.cartonCount,
      partSummaries: summary.partSummaries,
      partyProgress: summary.partyProgress,
      cartons: [],
      items: normalizedLines,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    for (const line of normalizedLines) {
      batch.set(this.lineDoc(packingListDoc.id, line.lineId), this.stripUndefined({
        ...line,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }));
    }

    await batch.commit();
    return packingListDoc.id;
  }

  async processScan(
    packingListId: string,
    cartonNo: string,
    barcode: string,
    qty: number,
    salesOrderId?: string,
  ): Promise<PackingScanResult> {
    const trimmedCartonNo = cartonNo.trim();
    const trimmedBarcode = barcode.trim();
    const normalizedQty = Math.max(0, Math.floor(Number(qty) || 0));

    if (!trimmedCartonNo) throw new Error('carton_required');
    if (!trimmedBarcode) throw new Error('barcode_not_found');
    if (normalizedQty <= 0) throw new Error('qty_invalid');

    const line = await this.resolveScannableLine(packingListId, trimmedBarcode, salesOrderId);
    if (!line) throw new Error('barcode_not_found');

    const txResult = await runTransaction(this.firestore, async (transaction) => {
      const lineRef = this.lineDoc(packingListId, line.lineId);
      const packingListRef = doc(this.firestore, `packingLists/${packingListId}`);
      const [lineSnap, packingListSnap] = await Promise.all([
        transaction.get(lineRef),
        transaction.get(packingListRef),
      ]);

      if (!lineSnap.exists()) throw new Error('barcode_not_found');
      if (!packingListSnap.exists()) throw new Error('packinglist_not_found');

      const liveLine = this.normalizeLine({ lineId: lineSnap.id, ...lineSnap.data() });
      const packingList = this.normalizePackingList({ id: packingListSnap.id, ...packingListSnap.data() });

      if (trimmedBarcode !== String(liveLine.barcode ?? '').trim()) throw new Error('barcode_not_found');
      if (liveLine.remainingQty <= 0 || liveLine.status === 'completed') throw new Error('line_completed');
      if (normalizedQty > liveLine.remainingQty) throw new Error('qty_exceeds_remaining');

      const now = Date.now();
      const nextPackedQty = liveLine.packedQty + normalizedQty;
      const nextRemainingQty = Math.max(0, liveLine.requiredQty - nextPackedQty);
      const lineCompleted = nextRemainingQty === 0;
      const updatedLine = this.normalizeLine({
        ...liveLine,
        packedQty: nextPackedQty,
        remainingQty: nextRemainingQty,
        status: lineCompleted ? 'completed' : 'in_progress',
        lastCartonNo: trimmedCartonNo,
        updatedAt: now,
      });

      const updatedItems = (packingList.items ?? []).map((item) =>
        item.lineId === updatedLine.lineId ? updatedLine : this.normalizeLine(item)
      );

      const { cartons, carton } = this.upsertCartons(packingList.cartons ?? [], updatedLine, trimmedCartonNo, normalizedQty, now);
      const summary = this.buildSummary(updatedItems, cartons, packingList.clientName);

      transaction.update(lineRef, this.stripUndefined({
        packedQty: updatedLine.packedQty,
        remainingQty: updatedLine.remainingQty,
        status: updatedLine.status,
        lastCartonNo: updatedLine.lastCartonNo,
        updatedAt: serverTimestamp(),
      }));

      transaction.update(packingListRef, this.stripUndefined({
        totalPackedQty: summary.totalPackedQty,
        completedLineCount: summary.completedLineCount,
        cartonCount: summary.cartonCount,
        status: summary.status,
        partSummaries: summary.partSummaries,
        partyProgress: summary.partyProgress,
        cartons,
        items: updatedItems,
        updatedAt: serverTimestamp(),
      }));

      return {
        line: updatedLine,
        carton,
        lineCompleted,
        packingListCompleted: summary.status === 'Completed',
        totalPackedQty: summary.totalPackedQty,
        completedLineCount: summary.completedLineCount,
        cartonCount: summary.cartonCount,
        status: summary.status,
        partSummaries: summary.partSummaries,
        partyProgress: summary.partyProgress,
        _updatedItems: updatedItems,
      };
    });

    let stockDeducted = false;
    if (txResult.packingListCompleted) {
      stockDeducted = await this.deductInventoryOnCompletion(packingListId, txResult._updatedItems);
    }

    const { _updatedItems: _unused, ...scanResult } = txResult;
    return { ...scanResult, stockDeducted } satisfies PackingScanResult;
  }

  async markLinePacked(
    packingListId: string,
    lineId: string,
    packed: boolean,
    cartonNo?: string,
  ): Promise<{
    line: PackingListLine;
    cartons: PackingCarton[];
    packingListCompleted: boolean;
    stockDeducted: boolean;
    totalPackedQty: number;
    completedLineCount: number;
    cartonCount: number;
    status: PackingList['status'];
    partyProgress: PackingPartyProgress[];
  }> {
    const txResult = await runTransaction(this.firestore, async (transaction) => {
      const lineRef = this.lineDoc(packingListId, lineId);
      const packingListRef = doc(this.firestore, `packingLists/${packingListId}`);
      const [lineSnap, plSnap] = await Promise.all([transaction.get(lineRef), transaction.get(packingListRef)]);
      if (!lineSnap.exists() || !plSnap.exists()) throw new Error('not_found');

      const liveLine = this.normalizeLine({ lineId: lineSnap.id, ...lineSnap.data() });
      const packingList = this.normalizePackingList({ id: plSnap.id, ...plSnap.data() });
      const now = Date.now();

      const nextPackedQty = packed ? liveLine.requiredQty : 0;
      const nextRemainingQty = packed ? 0 : liveLine.requiredQty;
      const updatedLine = this.normalizeLine({
        ...liveLine,
        packedQty: nextPackedQty,
        remainingQty: nextRemainingQty,
        status: packed ? 'completed' : 'ready',
        lastCartonNo: packed && cartonNo ? cartonNo : undefined,
        updatedAt: now,
      });

      // Handle carton assignment
      let cartons = packingList.cartons ?? [];
      if (packed && cartonNo) {
        cartons = this.upsertCartons(cartons, updatedLine, cartonNo, updatedLine.requiredQty, now).cartons;
      } else if (!packed && liveLine.lastCartonNo) {
        cartons = this.removeLineFromCarton(cartons, lineId, liveLine.lastCartonNo);
      }

      const updatedItems = (packingList.items ?? []).map((item) =>
        item.lineId === lineId ? updatedLine : this.normalizeLine(item)
      );
      const summary = this.buildSummary(updatedItems, cartons, packingList.clientName);

      transaction.update(lineRef, this.stripUndefined({
        packedQty: updatedLine.packedQty,
        remainingQty: updatedLine.remainingQty,
        status: updatedLine.status,
        lastCartonNo: updatedLine.lastCartonNo ?? null,
        updatedAt: serverTimestamp(),
      }));
      transaction.update(packingListRef, this.stripUndefined({
        totalPackedQty: summary.totalPackedQty,
        completedLineCount: summary.completedLineCount,
        cartonCount: summary.cartonCount,
        status: summary.status,
        partSummaries: summary.partSummaries,
        partyProgress: summary.partyProgress,
        cartons,
        items: updatedItems,
        updatedAt: serverTimestamp(),
      }));

      return {
        line: updatedLine,
        cartons,
        packingListCompleted: summary.status === 'Completed',
        totalPackedQty: summary.totalPackedQty,
        completedLineCount: summary.completedLineCount,
        cartonCount: summary.cartonCount,
        status: summary.status,
        partyProgress: summary.partyProgress,
        _updatedItems: updatedItems,
      };
    });

    let stockDeducted = false;
    if (txResult.packingListCompleted) {
      stockDeducted = await this.deductInventoryOnCompletion(packingListId, txResult._updatedItems);
    }
    const { _updatedItems: _, ...rest } = txResult;
    return { ...rest, stockDeducted };
  }

  private removeLineFromCarton(cartons: PackingCarton[], lineId: string, cartonNo: string): PackingCarton[] {
    return cartons.map((c) => {
      if (c.cartonNo.toLowerCase() !== cartonNo.toLowerCase()) return c;
      const entries = c.entries.filter((e) => e.lineId !== lineId);
      return this.normalizeCarton({ ...c, entries, totalQty: entries.reduce((s, e) => s + e.qty, 0) });
    });
  }

  async recalculatePackingListStatus(packingListId: string): Promise<void> {
    const [packingList, lines] = await Promise.all([
      this.getPackingListByIdOnce(packingListId),
      this.getPackingListLinesOnce(packingListId),
    ]);
    if (!packingList) return;

    const summary = this.buildSummary(lines, packingList.cartons ?? [], packingList.clientName);
    const normalizedItems = lines.map((line) => this.normalizeLine(line));

    await runTransaction(this.firestore, async (transaction) => {
      const packingListRef = doc(this.firestore, `packingLists/${packingListId}`);
      transaction.update(packingListRef, this.stripUndefined({
        totalRequiredQty: summary.totalRequiredQty,
        totalPackedQty: summary.totalPackedQty,
        lineCount: summary.lineCount,
        completedLineCount: summary.completedLineCount,
        cartonCount: summary.cartonCount,
        status: summary.status,
        partSummaries: summary.partSummaries,
        partyProgress: summary.partyProgress,
        items: normalizedItems,
        updatedAt: serverTimestamp(),
      }));
    });
  }

  async updateDispatchInfo(
    packingListId: string,
    agentName: string,
    transport: string,
  ): Promise<void> {
    const packingListRef = doc(this.firestore, `packingLists/${packingListId}`);
    await updateDoc(packingListRef, this.stripUndefined({
      agentName: agentName.trim() || null,
      transport: transport.trim() || null,
      updatedAt: serverTimestamp(),
    }));
  }

  async markQcVerified(packingListId: string): Promise<void> {
    const packingListRef = doc(this.firestore, `packingLists/${packingListId}`);
    await updateDoc(packingListRef, { qcVerifiedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }

  private async deductInventoryOnCompletion(
    packingListId: string,
    items: PackingListLine[],
  ): Promise<boolean> {
    type Deduction = { ref: ReturnType<typeof doc>; qty: number };
    const deductions = new Map<string, Deduction>();

    for (const item of items) {
      const qty = item.packedQty;
      if (qty <= 0) continue;

      if (item.inventoryId) {
        const existing = deductions.get(item.inventoryId);
        if (existing) {
          existing.qty += qty;
        } else {
          deductions.set(item.inventoryId, {
            ref: doc(this.firestore, `inventory/${item.inventoryId}`),
            qty,
          });
        }
      } else if (item.barcode) {
        const snap = await getDocs(query(this.inventoryRef, where('barcode', '==', item.barcode), limit(1)));
        if (!snap.empty) {
          const invId = snap.docs[0].id;
          const existing = deductions.get(invId);
          if (existing) {
            existing.qty += qty;
          } else {
            deductions.set(invId, {
              ref: doc(this.firestore, `inventory/${invId}`),
              qty,
            });
          }
        }
      }
    }

    if (deductions.size === 0) return false;

    const resolvedList = [...deductions.values()];
    const packingListRef = doc(this.firestore, `packingLists/${packingListId}`);

    return runTransaction(this.firestore, async (transaction) => {
      const [plSnap, ...invSnaps] = await Promise.all([
        transaction.get(packingListRef),
        ...resolvedList.map(({ ref }) => transaction.get(ref)),
      ]);

      if (!plSnap.exists() || plSnap.data()?.['stockDeducted'] === true) return false;

      for (let i = 0; i < resolvedList.length; i++) {
        const invSnap = invSnaps[i];
        if (!invSnap.exists()) continue;
        const current = Math.max(0, Number(invSnap.data()?.['currentStock'] ?? 0) - resolvedList[i].qty);
        transaction.update(resolvedList[i].ref, { currentStock: current, updatedAt: serverTimestamp() });
      }

      transaction.update(packingListRef, { stockDeducted: true, updatedAt: serverTimestamp() });
      return true;
    });
  }

  async sealCarton(packingListId: string, cartonNo: string): Promise<void> {
    const packingListRef = doc(this.firestore, `packingLists/${packingListId}`);
    const snap = await getDoc(packingListRef);
    if (!snap.exists()) throw new Error('packinglist_not_found');
    const packingList = this.normalizePackingList({ id: snap.id, ...snap.data() });
    const cartons = (packingList.cartons ?? []).map((c) =>
      c.cartonNo.toLowerCase() === cartonNo.toLowerCase()
        ? { ...c, cartonStatus: 'sealed' as const, updatedAt: Date.now() }
        : c
    );
    await updateDoc(packingListRef, this.stripUndefined({ cartons, updatedAt: serverTimestamp() }));
  }

  private async resolveScannableLine(
    packingListId: string,
    barcode: string,
    salesOrderId?: string,
  ): Promise<PackingListLine | null> {
    const snap = await getDocs(
      query(this.linesCollection(packingListId), where('barcode', '==', barcode), limit(20))
    );
    if (snap.empty) return null;

    const available = snap.docs
      .map((docSnap) => this.normalizeLine({ lineId: docSnap.id, ...docSnap.data() }))
      .filter((line) => line.remainingQty > 0)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    if (!salesOrderId) return available[0] ?? null;

    const partyLines = available.filter((line) => line.salesOrderIds.includes(salesOrderId));
    return (partyLines[0] ?? available[0]) ?? null;
  }

  private buildSummary(lines: PackingListLine[], cartons: PackingCarton[], clientName = '') {
    const normalizedLines = lines.map((line) => this.normalizeLine(line)).filter((line) => line.requiredQty > 0);
    const normalizedCartons = cartons.map((carton) => this.normalizeCarton(carton));
    const totalRequiredQty = normalizedLines.reduce((sum, line) => sum + line.requiredQty, 0);
    const totalPackedQty = normalizedLines.reduce((sum, line) => sum + Math.min(line.packedQty, line.requiredQty), 0);
    const lineCount = normalizedLines.length;
    const completedLineCount = normalizedLines.filter((line) => line.remainingQty <= 0).length;
    const cartonCount = normalizedCartons.length;
    const partSummaries = this.buildPartSummaries(normalizedLines);
    const partyProgress = this.buildPartyProgress(normalizedLines, clientName);

    return {
      totalRequiredQty,
      totalPackedQty,
      lineCount,
      completedLineCount,
      cartonCount,
      partSummaries,
      partyProgress,
      status: this.computePackingListStatus(totalRequiredQty, totalPackedQty, lineCount, completedLineCount),
    };
  }

  private buildPartSummaries(lines: PackingListLine[]): PackingPartSummary[] {
    const map = new Map<string, PackingPartSummary>();
    for (const line of lines) {
      const key = line.partName || 'General';
      const existing = map.get(key) ?? { partName: key, requiredQty: 0, packedQty: 0 };
      existing.requiredQty += line.requiredQty;
      existing.packedQty += Math.min(line.packedQty, line.requiredQty);
      map.set(key, existing);
    }
    return [...map.values()].sort((left, right) => left.partName.localeCompare(right.partName, undefined, { numeric: true }));
  }

  private buildPartyProgress(lines: PackingListLine[], defaultClientName = ''): PackingPartyProgress[] {
    const map = new Map<string, PackingPartyProgress>();
    for (const line of lines) {
      for (let i = 0; i < line.salesOrderIds.length; i++) {
        const salesOrderId = line.salesOrderIds[i] ?? '';
        const salesNo = line.salesNos[i] ?? '';
        const clientId = line.clientId || undefined;
        const clientName = line.clientName || defaultClientName;
        if (!salesOrderId) continue;
        const existing = map.get(salesOrderId) ?? {
          salesOrderId, salesNo, clientId, clientName, requiredQty: 0, packedQty: 0, pendingQty: 0,
        };
        existing.requiredQty += line.requiredQty;
        existing.packedQty += Math.min(line.packedQty, line.requiredQty);
        existing.pendingQty = existing.requiredQty - existing.packedQty;
        map.set(salesOrderId, existing);
      }
    }
    return [...map.values()].sort((a, b) => a.salesNo.localeCompare(b.salesNo, undefined, { numeric: true }));
  }

  private buildPackableLines(lines: PickListLine[]): PackingListLine[] {
    const aggregated = new Map<string, PackingListLine>();

    for (const source of lines) {
      const pickedQty = Math.max(0, Math.min(Number(source.pickedQty) || 0, Number(source.requiredQty) || Number(source.pickedQty) || 0));
      const barcode = String(source.barcode ?? '').trim();
      if (!barcode || pickedQty <= 0) continue;

      const styleNo = String(source.styleNo ?? '').trim();
      const color = String(source.color ?? '').trim();
      const partName = String(source.group ?? '').trim() || 'General';
      const size = String(source.size ?? '').trim();
      const sleeveType = source.sleeveType ? String(source.sleeveType).trim() : '';
      const inventoryId = source.inventoryId ? String(source.inventoryId).trim() : '';
      const designId = String(source.designId ?? '').trim();
      const salesOrderId = String(source.salesOrderId ?? '').trim();
      const salesNo = String(source.salesNo ?? '').trim();
      const clientId = String(source.clientId ?? '').trim();
      const clientName = String(source.clientName ?? '').trim();
      const key = `${salesOrderId}||${styleNo}||${color}||${partName}||${size}||${sleeveType}||${barcode}||${inventoryId}`;

      if (!aggregated.has(key)) {
        aggregated.set(key, this.normalizeLine({
          lineId: this.buildPackingLineId(styleNo, color, partName, size, sleeveType, aggregated.size),
          pickListLineId: String(source.lineId ?? '').trim() || this.buildPackingLineId(styleNo, color, partName, size, sleeveType, aggregated.size),
          salesOrderIds: salesOrderId ? [salesOrderId] : [],
          salesNos: salesNo ? [salesNo] : [],
          clientId: clientId || undefined,
          clientName: clientName || undefined,
          designId,
          styleNo,
          color,
          partName,
          size,
          sleeveType: sleeveType || undefined,
          barcode,
          inventoryId: inventoryId || undefined,
          pickedQty,
          requiredQty: pickedQty,
          packedQty: 0,
          remainingQty: pickedQty,
          status: 'ready',
          sortOrder: Number(source.sortOrder) || aggregated.size,
        }));
        continue;
      }

      const existing = aggregated.get(key)!;
      existing.requiredQty += pickedQty;
      existing.remainingQty += pickedQty;
      if (salesOrderId && !existing.salesOrderIds.includes(salesOrderId)) {
        existing.salesOrderIds.push(salesOrderId);
      }
      if (salesNo && !existing.salesNos.includes(salesNo)) {
        existing.salesNos.push(salesNo);
      }
      aggregated.set(key, existing);
    }

    return [...aggregated.values()];
  }

  private upsertCartons(
    cartons: PackingCarton[],
    line: PackingListLine,
    cartonNo: string,
    qty: number,
    now: number,
  ): { cartons: PackingCarton[]; carton: PackingCarton } {
    const normalizedCartons = cartons.map((carton) => this.normalizeCarton(carton));
    const cartonIndex = normalizedCartons.findIndex((carton) => carton.cartonNo.toLowerCase() === cartonNo.toLowerCase());
    const entry: PackingCartonEntry = {
      lineId: line.lineId,
      pickListLineId: line.pickListLineId,
      salesOrderIds: [...line.salesOrderIds],
      salesNos: [...line.salesNos],
      styleNo: line.styleNo,
      color: line.color,
      partName: line.partName,
      size: line.size,
      sleeveType: line.sleeveType,
      barcode: line.barcode,
      qty,
    };

    if (cartonIndex === -1) {
      const nextCarton = this.normalizeCarton({
        cartonNo,
        totalQty: qty,
        entries: [entry],
        createdAt: now,
        updatedAt: now,
      });
      return { cartons: [...normalizedCartons, nextCarton], carton: nextCarton };
    }

    const current = normalizedCartons[cartonIndex];
    const entries = [...current.entries];
    const entryIndex = entries.findIndex((existing) => existing.lineId === line.lineId);
    if (entryIndex === -1) {
      entries.push(entry);
    } else {
      entries[entryIndex] = { ...entries[entryIndex], qty: entries[entryIndex].qty + qty };
    }

    const updatedCarton = this.normalizeCarton({
      ...current,
      totalQty: current.totalQty + qty,
      entries,
      updatedAt: now,
    });
    const updatedCartons = [...normalizedCartons];
    updatedCartons[cartonIndex] = updatedCarton;
    return { cartons: updatedCartons, carton: updatedCarton };
  }

  private linesCollection(packingListId: string) {
    return collection(this.firestore, `packingLists/${packingListId}/lines`);
  }

  private lineDoc(packingListId: string, lineId: string) {
    return doc(this.firestore, `packingLists/${packingListId}/lines/${lineId}`);
  }

  private normalizePackingList(raw: any): PackingList {
    const items = Array.isArray(raw?.items) ? raw.items.map((item: any) => this.normalizeLine(item)) : [];
    const cartons = Array.isArray(raw?.cartons) ? raw.cartons.map((carton: any) => this.normalizeCarton(carton)) : [];
    const summary = this.buildSummary(items, cartons, String(raw?.clientName ?? ''));

    const rawMode = raw?.packingMode;
    const packingMode: PackingMode = rawMode === 'order' ? 'order' : 'customer';

    return {
      id: raw?.id,
      packingListNo: String(raw?.packingListNo ?? ''),
      pickListId: String(raw?.pickListId ?? ''),
      pickListNo: String(raw?.pickListNo ?? ''),
      salesOrderIds: Array.isArray(raw?.salesOrderIds) ? raw.salesOrderIds.map((id: any) => String(id)) : [],
      salesNos: Array.isArray(raw?.salesNos) ? raw.salesNos.map((salesNo: any) => String(salesNo)) : [],
      clientId: String(raw?.clientId ?? ''),
      clientName: String(raw?.clientName ?? ''),
      packingMode,
      status: raw?.status ?? summary.status,
      totalRequiredQty: Number(raw?.totalRequiredQty) || summary.totalRequiredQty,
      totalPackedQty: Number(raw?.totalPackedQty) || summary.totalPackedQty,
      lineCount: Number(raw?.lineCount) || summary.lineCount,
      completedLineCount: Number(raw?.completedLineCount) || summary.completedLineCount,
      cartonCount: Number(raw?.cartonCount) || summary.cartonCount,
      partSummaries: Array.isArray(raw?.partSummaries) && raw.partSummaries.length
        ? raw.partSummaries.map((entry: any) => ({
            partName: String(entry?.partName ?? 'General'),
            requiredQty: Math.max(0, Number(entry?.requiredQty) || 0),
            packedQty: Math.max(0, Number(entry?.packedQty) || 0),
          }))
        : summary.partSummaries,
      partyProgress: summary.partyProgress,
      cartons,
      items,
      agentName: raw?.agentName ? String(raw.agentName) : undefined,
      transport: raw?.transport ? String(raw.transport) : undefined,
      qcVerifiedAt: raw?.qcVerifiedAt,
      stockDeducted: raw?.stockDeducted === true,
      remarks: raw?.remarks,
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }

  private normalizeLine(raw: any): PackingListLine {
    const requiredQty = Math.max(0, Number(raw?.requiredQty) || Number(raw?.pickedQty) || 0);
    const packedQty = Math.max(0, Number(raw?.packedQty) || 0);
    const remainingQty = raw?.remainingQty != null
      ? Math.max(0, Number(raw?.remainingQty) || 0)
      : Math.max(0, requiredQty - packedQty);

    return {
      lineId: String(raw?.lineId ?? ''),
      pickListLineId: String(raw?.pickListLineId ?? raw?.lineId ?? ''),
      salesOrderIds: Array.isArray(raw?.salesOrderIds) ? raw.salesOrderIds.map((id: any) => String(id)) : [],
      salesNos: Array.isArray(raw?.salesNos) ? raw.salesNos.map((salesNo: any) => String(salesNo)) : [],
      clientId: raw?.clientId ? String(raw.clientId) : undefined,
      clientName: raw?.clientName ? String(raw.clientName) : undefined,
      designId: String(raw?.designId ?? ''),
      styleNo: String(raw?.styleNo ?? ''),
      color: String(raw?.color ?? ''),
      partName: String(raw?.partName ?? raw?.group ?? '') || 'General',
      size: String(raw?.size ?? ''),
      sleeveType: raw?.sleeveType ? String(raw.sleeveType) : undefined,
      barcode: raw?.barcode ? String(raw.barcode) : undefined,
      inventoryId: raw?.inventoryId ? String(raw.inventoryId) : undefined,
      pickedQty: Math.max(0, Number(raw?.pickedQty) || 0),
      requiredQty,
      packedQty,
      remainingQty,
      status: this.normalizeLineStatus(raw?.status, packedQty, remainingQty),
      lastCartonNo: raw?.lastCartonNo ? String(raw.lastCartonNo) : undefined,
      sortOrder: Number(raw?.sortOrder) || 0,
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }

  private normalizeCarton(raw: any): PackingCarton {
    return {
      cartonNo: String(raw?.cartonNo ?? ''),
      totalQty: Math.max(0, Number(raw?.totalQty) || 0),
      cartonStatus: raw?.cartonStatus === 'sealed' ? 'sealed' : 'open',
      entries: Array.isArray(raw?.entries) ? raw.entries.map((entry: any) => this.normalizeCartonEntry(entry)) : [],
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }

  private normalizeCartonEntry(raw: any): PackingCartonEntry {
    return {
      lineId: String(raw?.lineId ?? ''),
      pickListLineId: String(raw?.pickListLineId ?? raw?.lineId ?? ''),
      salesOrderIds: Array.isArray(raw?.salesOrderIds) ? raw.salesOrderIds.map((id: any) => String(id)) : [],
      salesNos: Array.isArray(raw?.salesNos) ? raw.salesNos.map((salesNo: any) => String(salesNo)) : [],
      styleNo: String(raw?.styleNo ?? ''),
      color: String(raw?.color ?? ''),
      partName: String(raw?.partName ?? raw?.group ?? '') || 'General',
      size: String(raw?.size ?? ''),
      sleeveType: raw?.sleeveType ? String(raw.sleeveType) : undefined,
      barcode: raw?.barcode ? String(raw.barcode) : undefined,
      qty: Math.max(0, Number(raw?.qty) || 0),
    };
  }

  private normalizeLineStatus(rawStatus: any, packedQty: number, remainingQty: number): PackingListLine['status'] {
    if (remainingQty <= 0) return 'completed';
    if (packedQty > 0) return 'in_progress';
    return rawStatus === 'in_progress' || rawStatus === 'completed' ? rawStatus : 'ready';
  }

  private computePackingListStatus(
    totalRequiredQty: number,
    totalPackedQty: number,
    lineCount: number,
    completedLineCount: number,
  ): PackingList['status'] {
    if (lineCount <= 0 || totalRequiredQty <= 0 || totalPackedQty <= 0) return 'Draft';
    if (completedLineCount >= lineCount || totalPackedQty >= totalRequiredQty) return 'Completed';
    return 'Partial';
  }

  private buildPackingLineId(styleNo: string, color: string, partName: string, size: string, sleeveType: string, index: number): string {
    const safe = [styleNo, color, partName, size, sleeveType].map((value) =>
      value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    );
    return `pk-${safe.filter(Boolean).join('-') || 'line'}-${index + 1}`;
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
}