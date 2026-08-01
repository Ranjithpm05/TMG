import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  addDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  orderBy,
  serverTimestamp
} from '@angular/fire/firestore';
import { from, Observable } from 'rxjs';
import type { GoodsInward } from '../models/goods-inward.model';
import { fetchAllDocs } from './firestore-pagination.util';

@Injectable({ providedIn: 'root' })
export class GoodsInwardService {

  private firestore = inject(Firestore);
  private grnRef = collection(this.firestore, 'goodsInward');

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
    return from(
      fetchAllDocs(this.grnRef, [orderBy('createdAt', 'desc')], (d) => ({ id: d.id, ...d.data() } as GoodsInward))
    );
  }

  // 🔹 Create GRN
  async createGoodsInward(grn: Omit<GoodsInward, 'id'>): Promise<void> {
    const clean = this.stripUndefined(grn);
    await addDoc(this.grnRef, {
      ...clean,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
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
  }

  // 🔹 Delete GRN
  async deleteGoodsInward(id: string): Promise<void> {
    const grnDoc = doc(this.firestore, `goodsInward/${id}`);
    await deleteDoc(grnDoc);
  }
}