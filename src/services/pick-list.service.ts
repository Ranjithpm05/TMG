import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, collectionData, doc, addDoc,
  updateDoc, query, orderBy, where, getDocs, serverTimestamp
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import type { PickList, PickListLine } from '../models/pick-list.model';

@Injectable({ providedIn: 'root' })
export class PickListService {
  private firestore = inject(Firestore);
  private plRef     = collection(this.firestore, 'pickLists');
  private invRef    = collection(this.firestore, 'inventory');

  getPickLists(): Observable<PickList[]> {
    const q = query(this.plRef, orderBy('createdAt', 'desc'));
    return collectionData(q, { idField: 'id' }) as Observable<PickList[]>;
  }

  getPickListBySalesOrder(salesOrderId: string): Promise<PickList | null> {
    return getDocs(query(this.plRef, where('salesOrderId', '==', salesOrderId)))
      .then(snap => snap.empty ? null : ({ id: snap.docs[0].id, ...snap.docs[0].data() } as PickList));
  }

  async createPickList(pl: Omit<PickList, 'id'>): Promise<string> {
    const ref = await addDoc(this.plRef, {
      ...pl,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return ref.id;
  }

  async updatePickList(pl: PickList): Promise<void> {
    if (!pl.id) return;
    const { id, ...rest } = pl;
    await updateDoc(doc(this.firestore, `pickLists/${id}`), {
      ...rest,
      updatedAt: serverTimestamp()
    });
  }

  /** Deducts stock from inventory for each picked item */
  async deductStock(pickedItems: { styleNo: string; color: string; size: string; sleeveType?: string; qty: number }[]): Promise<void> {
    for (const item of pickedItems) {
      if (item.qty <= 0) continue;
      // Match by styleNo + color + size (+ sleeveType if present)
      let q = query(
        this.invRef,
        where('styleNo', '==', item.styleNo),
        where('color',   '==', item.color),
        where('size',    '==', item.size)
      );
      const snap = await getDocs(q);
      for (const docSnap of snap.docs) {
        const data = docSnap.data() as any;
        // If sleeveType is specified, match it; otherwise take whatever we find
        if (item.sleeveType && data.sleeveType && data.sleeveType !== item.sleeveType) continue;
        const current = Number(data.currentStock) || 0;
        const newStock = Math.max(0, current - item.qty);
        await updateDoc(doc(this.firestore, `inventory/${docSnap.id}`), {
          currentStock: newStock,
          updatedAt:    serverTimestamp()
        });
        break; // matched
      }
    }
  }
}