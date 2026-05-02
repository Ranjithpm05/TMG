
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
    const snap = await getDoc(doc(this.firestore, `clients/${clientId}`));
    return snap.exists() ? ({ id: snap.id, ...snap.data() } as Client) : null;
  }

  // 🔹 Delete client
  async deleteClient(clientId: string): Promise<void> {
    const clientDoc = doc(this.firestore, `clients/${clientId}`);
    await deleteDoc(clientDoc);
  }
}