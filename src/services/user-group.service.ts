import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  collectionData,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
  serverTimestamp
} from '@angular/fire/firestore';

import type { UserGroup } from '../models/user-group.model';
import { Observable, firstValueFrom  } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UserGroupService {

    private firestore = inject(Firestore);
    private groupRef = collection(this.firestore, 'userGroups');

    // 🔹 GET ALL GROUPS
    getGroups(): Observable<UserGroup[]> {
        return collectionData(this.groupRef, { idField: 'id' }) as Observable<UserGroup[]>;
    }

    // 🔹 CREATE GROUP
    async createGroup(group: Omit<UserGroup, 'id'>): Promise<void> {
        await addDoc(this.groupRef, {
        ...group,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
        });
    }

    // 🔹 UPDATE GROUP
    async updateGroup(group: UserGroup): Promise<void> {
        if (!group.id) return;

        const groupDoc = doc(this.firestore, `userGroups/${group.id}`);
        await updateDoc(groupDoc, {
        ...group,
        updatedAt: serverTimestamp()
        });
    }

    // 🔹 DELETE GROUP
    async deleteGroup(groupId: string): Promise<void> {
        const groupDoc = doc(this.firestore, `userGroups/${groupId}`);
        await deleteDoc(groupDoc);
    }

    async getUserGroupById(id: string): Promise<UserGroup | null> {
        const groups = await firstValueFrom(this.getGroups())
        return groups.find(g => g.id === id) ?? null;
    }
}
