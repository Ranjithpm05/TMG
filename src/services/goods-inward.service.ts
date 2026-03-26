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

  // 🔹 Get all GRNs
  getGoodsInwards(): Observable<GoodsInward[]> {
    const q = query(this.grnRef, orderBy('createdAt', 'desc'));
    return collectionData(q, { idField: 'id' }) as Observable<GoodsInward[]>;
  }

  // 🔹 Create GRN
  async createGoodsInward(grn: Omit<GoodsInward, 'id'>): Promise<void> {
    await addDoc(this.grnRef, {
      ...grn,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  // 🔹 Update GRN
  async updateGoodsInward(grn: GoodsInward): Promise<void> {
    if (!grn.id) return;
    const grnDoc = doc(this.firestore, `goodsInward/${grn.id}`);
    await updateDoc(grnDoc, {
      ...grn,
      updatedAt: serverTimestamp()
    });
  }

  // 🔹 Delete GRN
  async deleteGoodsInward(id: string): Promise<void> {
    const grnDoc = doc(this.firestore, `goodsInward/${id}`);
    await deleteDoc(grnDoc);
  }
}