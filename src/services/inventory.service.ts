import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, collectionData, doc, addDoc,
  updateDoc, query, orderBy, where, getDocs, serverTimestamp
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import type { InventoryItem } from '../models/inventory.model';
import type { GoodsInwardItem } from '../models/goods-inward.model';

@Injectable({ providedIn: 'root' })
export class InventoryService {
  private firestore = inject(Firestore);
  private invRef = collection(this.firestore, 'inventory');

  getInventory(): Observable<InventoryItem[]> {
    const q = query(this.invRef, orderBy('styleNo', 'asc'));
    return collectionData(q, { idField: 'id' }) as Observable<InventoryItem[]>;
  }

  async upsertFromGrn(items: GoodsInwardItem[], grnNo: string): Promise<void> {
    for (const item of items) {
      if ((Number(item.receivedQty) || 0) <= 0) continue;
      const q = query(this.invRef, where('barcode', '==', item.barcode));
      const snap = await getDocs(q);
      if (snap.empty) {
        await addDoc(this.invRef, {
          barcode: item.barcode, designId: item.designId,
          styleNo: item.styleNo, color: item.color, group: item.group,
          size: item.size, ...(item.sleeveType ? { sleeveType: item.sleeveType } : {}),
          fabricType: item.fabricType, currentStock: Number(item.receivedQty),
          totalReceived: Number(item.receivedQty),
          WSP: item.WSP, price: item.price, lastGrnNo: grnNo,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
      } else {
        const existing = snap.docs[0];
        const data = existing.data() as InventoryItem;
        await updateDoc(doc(this.firestore, `inventory/${existing.id}`), {
          currentStock: (Number(data.currentStock) || 0) + Number(item.receivedQty),
          totalReceived: (Number(data.totalReceived) || 0) + Number(item.receivedQty),
          WSP: item.WSP, price: item.price, lastGrnNo: grnNo,
          updatedAt: serverTimestamp()
        });
      }
    }
  }

  async getInventoryByBarcodes(barcodes: string[]): Promise<InventoryItem[]> {
    if (!barcodes.length) return [];
    const results: InventoryItem[] = [];
    for (let i = 0; i < barcodes.length; i += 30) {
      const batch = barcodes.slice(i, i + 30);
      const snap = await getDocs(query(this.invRef, where('barcode', 'in', batch)));
      snap.docs.forEach(d => results.push({ id: d.id, ...d.data() } as InventoryItem));
    }
    return results;
  }
}