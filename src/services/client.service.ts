
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

import type { Client } from '../models/client.model';
import { from, map, Observable, shareReplay } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ClientService {

  private firestore = inject(Firestore);
  private clientRef = collection(this.firestore, 'clients');

  // Master data is read once and cached in memory; invalidated only when this
  // service writes to the collection, so every screen shares a single read.
  private clientsCache$: Observable<Client[]> | null = null;

  // 🔹 Get all clients (cached one-time read — clients rarely change and every
  // mutation below invalidates the cache, so this stays in sync without a
  // standing realtime listener per screen).
  getClients(): Observable<Client[]> {
    if (!this.clientsCache$) {
      const q = query(this.clientRef, orderBy('createdAt', 'desc'));
      this.clientsCache$ = from(getDocs(q)).pipe(
        map((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() } as Client))),
        shareReplay(1)
      );
    }
    return this.clientsCache$;
  }

  private invalidateCache(): void {
    this.clientsCache$ = null;
  }

    // 🔹 Create client
    async createClient(
        client: Omit<Client, 'id' | 'clientCode'>
    ): Promise<void> {
        await addDoc(this.clientRef, {
        ...client,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
        });
        this.invalidateCache();
    }

  // 🔹 Update client
  async updateClient(client: Client): Promise<void> {
    if (!client.id) return;

    const clientDoc = doc(this.firestore, `clients/${client.id}`);
    await updateDoc(clientDoc, {
      ...client,
      updatedAt: serverTimestamp()
    });
    this.invalidateCache();
  }

  async getClientByIdOnce(clientId: string): Promise<Client | null> {
    if (!clientId) return null;
    const snap = await getDoc(doc(this.firestore, `clients/${clientId}`));
    if (!snap.exists()) return null;
    return this.normalizeClient({ id: snap.id, ...snap.data() });
  }

  async getClientByNameOnce(clientName: string): Promise<Client | null> {
    if (!clientName) return null;
    const snap = await getDocs(query(this.clientRef, where('clientName', '==', clientName), limit(1)));
    if (snap.empty) return null;
    return this.normalizeClient({ id: snap.docs[0].id, ...snap.docs[0].data() });
  }

  async getClientForDC(clientId: string, clientName: string): Promise<Client | null> {
    const byId = await this.getClientByIdOnce(clientId);
    if (byId && (byId.billingAddress || byId.mobile || byId.gstNo)) return byId;
    const byName = await this.getClientByNameOnce(clientName);
    return byName ?? byId ?? null;
  }

  private normalizeClient(raw: any): Client {
    return {
      id: raw?.id,
      clientName: String(raw?.clientName ?? ''),
      clientShortName: raw?.clientShortName ? String(raw.clientShortName) : undefined,
      clientCode: raw?.clientCode ? String(raw.clientCode) : undefined,
      clientType: raw?.clientType === 'Agent' ? 'Agent' : 'Direct',
      agentName: raw?.agentName ? String(raw.agentName) : undefined,
      billingAddress: String(raw?.billingAddress ?? raw?.address ?? raw?.billing_address ?? ''),
      zipCode: String(raw?.zipCode ?? raw?.zip_code ?? raw?.pinCode ?? raw?.pincode ?? ''),
      place: String(raw?.place ?? raw?.city ?? ''),
      state: String(raw?.state ?? ''),
      country: raw?.country ? String(raw.country) : undefined,
      gstNo: String(raw?.gstNo ?? raw?.gst_no ?? raw?.gstin ?? raw?.gstNumber ?? ''),
      mobile: String(raw?.mobile ?? raw?.phone ?? raw?.mobileNo ?? raw?.contact ?? ''),
      contactPerson: raw?.contactPerson ? String(raw.contactPerson) : undefined,
      status: raw?.status === 'Inactive' ? 'Inactive' : 'Active',
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }

  // 🔹 Delete client
  async deleteClient(clientId: string): Promise<void> {
    const clientDoc = doc(this.firestore, `clients/${clientId}`);
    await deleteDoc(clientDoc);
    this.invalidateCache();
  }
}