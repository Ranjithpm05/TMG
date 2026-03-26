import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  collectionData,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import type { GoodsInward } from '../models/goods-inward.model';

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

  // 🔹 Get all GRNs
  getGoodsInwards(): Observable<GoodsInward[]> {
    const q = query(this.grnRef, orderBy('createdAt', 'desc'));
    return collectionData(q, { idField: 'id' }) as Observable<GoodsInward[]>;
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