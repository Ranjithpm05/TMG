import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  addDoc,
  collection,
  collectionData,
  doc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { DCItem, DeliveryChallan } from '../models/delivery-challan.model';

@Injectable({ providedIn: 'root' })
export class DeliveryChallanService {
  private firestore = inject(Firestore);
  private dcRef = collection(this.firestore, 'deliveryChallans');

  getDeliveryChallans(): Observable<DeliveryChallan[]> {
    const q = query(this.dcRef, orderBy('createdAt', 'desc'));
    return (collectionData(q, { idField: 'id' }) as Observable<any[]>).pipe(
      map((docs) => docs.map((d) => this.normalize(d)))
    );
  }

  async getDCsByPackingListIdOnce(packingListId: string): Promise<DeliveryChallan[]> {
    const snap = await getDocs(query(this.dcRef, where('packingListId', '==', packingListId)));
    return snap.docs.map((d) => this.normalize({ id: d.id, ...d.data() }));
  }

  async createDC(
    input: Omit<DeliveryChallan, 'id' | 'dcNo' | 'dcSeq' | 'packedOn' | 'createdAt' | 'updatedAt'>,
  ): Promise<DeliveryChallan> {
    const { dcNo, dcSeq } = await this.generateNextDcNo();
    const data = {
      ...input,
      dcNo,
      dcSeq,
      packedOn: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const docRef = await addDoc(this.dcRef, data);
    return { id: docRef.id, ...data };
  }

  private async generateNextDcNo(): Promise<{ dcNo: string; dcSeq: number }> {
    const counterRef = doc(this.firestore, 'counters/dcCounter');
    const fyCode = this.getFyCode();

    return runTransaction(this.firestore, async (transaction) => {
      const snap = await transaction.get(counterRef);
      const currentSeq = snap.exists() ? (Number(snap.data()?.['seq']) || 0) : 0;
      const nextSeq = currentSeq + 1;
      if (snap.exists()) {
        transaction.update(counterRef, { seq: nextSeq, updatedAt: serverTimestamp() });
      } else {
        transaction.set(counterRef, { seq: nextSeq, fy: fyCode, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }
      return { dcNo: `DCC${fyCode}-${String(nextSeq).padStart(4, '0')}`, dcSeq: nextSeq };
    });
  }

  private getFyCode(): string {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const fyStart = month >= 4 ? year : year - 1;
    const fyEnd = fyStart + 1;
    return `${String(fyStart).slice(2)}${String(fyEnd).slice(2)}`;
  }

  private normalize(raw: any): DeliveryChallan {
    return {
      id: raw?.id,
      dcNo: String(raw?.dcNo ?? ''),
      dcSeq: Number(raw?.dcSeq) || 0,
      packingListId: String(raw?.packingListId ?? ''),
      packingListNo: String(raw?.packingListNo ?? ''),
      salesOrderId: String(raw?.salesOrderId ?? ''),
      salesNo: String(raw?.salesNo ?? ''),
      clientId: String(raw?.clientId ?? ''),
      clientName: String(raw?.clientName ?? ''),
      billingAddress: String(raw?.billingAddress ?? ''),
      place: String(raw?.place ?? ''),
      state: String(raw?.state ?? ''),
      zipCode: String(raw?.zipCode ?? ''),
      clientPhone: String(raw?.clientPhone ?? ''),
      clientGstin: String(raw?.clientGstin ?? ''),
      packedOn: raw?.packedOn,
      totalQty: Number(raw?.totalQty) || 0,
      boxCount: Number(raw?.boxCount) || 0,
      agentName: String(raw?.agentName ?? ''),
      transport: String(raw?.transport ?? ''),
      items: Array.isArray(raw?.items)
        ? raw.items.map((item: any): DCItem => ({
            partName: String(item?.partName ?? ''),
            styleNo: String(item?.styleNo ?? ''),
            color: String(item?.color ?? ''),
            sizeQty: item?.sizeQty && typeof item.sizeQty === 'object' ? item.sizeQty : {},
            total: Number(item?.total) || 0,
          }))
        : [],
      sizes: Array.isArray(raw?.sizes) ? raw.sizes.map((s: any) => String(s)) : [],
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }
}
