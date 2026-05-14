
import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  collectionData,
  doc,
  addDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  query,
  orderBy
} from '@angular/fire/firestore';

import type { Client } from '../models/client.model';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ClientService {

  private firestore = inject(Firestore);
  private clientRef = collection(this.firestore, 'clients');

  // 🔹 Get all clients
  getClients(): Observable<Client[]> {
    const q = query(this.clientRef, orderBy('createdAt', 'desc'));
    return collectionData(q, { idField: 'id' }) as Observable<Client[]>;
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
    }

  // 🔹 Update client
  async updateClient(client: Client): Promise<void> {
    if (!client.id) return;

    const clientDoc = doc(this.firestore, `clients/${client.id}`);
    await updateDoc(clientDoc, {
      ...client,
      updatedAt: serverTimestamp()
    });
  }

  async getClientByIdOnce(clientId: string): Promise<Client | null> {
    if (!clientId) return null;
    const snap = await getDoc(doc(this.firestore, `clients/${clientId}`));
    if (!snap.exists()) return null;
    return this.normalizeClient({ id: snap.id, ...snap.data() });
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
  }
}