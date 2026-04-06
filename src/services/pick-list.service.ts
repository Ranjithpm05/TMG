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

  /** Get all pick lists that include a given sales order ID */
  async getPickListsForOrder(salesOrderId: string): Promise<PickList[]> {
    const snap = await getDocs(
      query(this.plRef, where('salesOrderIds', 'array-contains', salesOrderId))
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as PickList));
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

  /** Deducts currentStock from inventory for confirmed pick items */
  async deductStock(
    pickedItems: { styleNo: string; color: string; size: string; sleeveType?: string; qty: number }[]
  ): Promise<void> {
    for (const item of pickedItems) {
      if (item.qty <= 0) continue;
      const snap = await getDocs(query(
        this.invRef,
        where('styleNo', '==', item.styleNo),
        where('color',   '==', item.color),
        where('size',    '==', item.size)
      ));
      for (const docSnap of snap.docs) {
        const data = docSnap.data() as any;
        if (item.sleeveType && data.sleeveType && data.sleeveType !== item.sleeveType) continue;
        const newStock = Math.max(0, (Number(data.currentStock) || 0) - item.qty);
        await updateDoc(doc(this.firestore, `inventory/${docSnap.id}`), {
          currentStock: newStock,
          updatedAt:    serverTimestamp()
        });
        break;
      }
    }
  }
}