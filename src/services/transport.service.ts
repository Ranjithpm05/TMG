
import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  query,
  orderBy,
  where,
  limit,
} from '@angular/fire/firestore';

import type { Transport } from '../models/transport.model';
import { from, map, Observable, shareReplay } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class TransportService {

  private firestore = inject(Firestore);
  private transportRef = collection(this.firestore, 'transports');

  // Master data is read once and cached in memory; invalidated only when this
  // service writes to the collection, so every screen shares a single read.
  private transportsCache$: Observable<Transport[]> | null = null;

  getTransports(): Observable<Transport[]> {
    if (!this.transportsCache$) {
      const q = query(this.transportRef, orderBy('createdAt', 'desc'));
      this.transportsCache$ = from(getDocs(q)).pipe(
        map((snap) => snap.docs.map((d) => this.normalizeTransport({ id: d.id, ...d.data() }))),
        shareReplay(1)
      );
    }
    return this.transportsCache$;
  }

  private invalidateCache(): void {
    this.transportsCache$ = null;
  }

  async createTransport(transport: Omit<Transport, 'id'>): Promise<void> {
    await addDoc(this.transportRef, {
      ...transport,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    this.invalidateCache();
  }

  async updateTransport(transport: Transport): Promise<void> {
    if (!transport.id) return;

    const transportDoc = doc(this.firestore, `transports/${transport.id}`);
    await updateDoc(transportDoc, {
      ...transport,
      updatedAt: serverTimestamp()
    });
    this.invalidateCache();
  }

  async getTransportByIdOnce(transportId: string): Promise<Transport | null> {
    if (!transportId) return null;
    const snap = await getDoc(doc(this.firestore, `transports/${transportId}`));
    if (!snap.exists()) return null;
    return this.normalizeTransport({ id: snap.id, ...snap.data() });
  }

  async getTransportByNameOnce(transportName: string): Promise<Transport | null> {
    if (!transportName) return null;
    const snap = await getDocs(query(this.transportRef, where('transportName', '==', transportName), limit(1)));
    if (snap.empty) return null;
    return this.normalizeTransport({ id: snap.docs[0].id, ...snap.docs[0].data() });
  }

  private normalizeTransport(raw: any): Transport {
    return {
      id: raw?.id,
      transportName: String(raw?.transportName ?? ''),
      transportAddress: raw?.transportAddress ? String(raw.transportAddress) : undefined,
      gstNo: raw?.gstNo ? String(raw.gstNo) : undefined,
      status: raw?.status === 'Inactive' ? 'Inactive' : 'Active',
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }

  async deleteTransport(transportId: string): Promise<void> {
    const transportDoc = doc(this.firestore, `transports/${transportId}`);
    await deleteDoc(transportDoc);
    this.invalidateCache();
  }
}
