import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp
} from '@angular/fire/firestore';

import type { UserGroup } from '../models/user-group.model';
import { Observable } from 'rxjs';
import { PersistentCollectionCache } from './persistent-cache.util';

@Injectable({ providedIn: 'root' })
export class UserGroupService {

    private firestore = inject(Firestore);
    private groupRef = collection(this.firestore, 'userGroups');

    // Small admin-only master list — cached one-time read, invalidated on
    // write. Also persisted to localStorage with a TTL
    // (PersistentCollectionCache) — group permissions carry no credentials,
    // unlike UserService (passwordHash), so this is safe to persist; see
    // ClientService's clientsCache comment.
    private readonly groupsCache = new PersistentCollectionCache<UserGroup>('tmg:cache:userGroups:v1', async () => {
        const snap = await getDocs(this.groupRef);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() } as UserGroup));
    });

    // 🔹 GET ALL GROUPS (cached one-time read — used only by the User Management screen)
    getGroups(): Observable<UserGroup[]> {
        return this.groupsCache.get$();
    }

    private invalidateCache(): void {
        this.groupsCache.invalidate();
    }

    // 🔹 CREATE GROUP
    async createGroup(group: Omit<UserGroup, 'id'>): Promise<void> {
        await addDoc(this.groupRef, {
        ...group,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
        });
        this.invalidateCache();
    }

    // 🔹 UPDATE GROUP
    async updateGroup(group: UserGroup): Promise<void> {
        if (!group.id) return;

        const groupDoc = doc(this.firestore, `userGroups/${group.id}`);
        await updateDoc(groupDoc, {
        ...group,
        updatedAt: serverTimestamp()
        });
        this.invalidateCache();
    }

    // 🔹 DELETE GROUP
    async deleteGroup(groupId: string): Promise<void> {
        const groupDoc = doc(this.firestore, `userGroups/${groupId}`);
        await deleteDoc(groupDoc);
        this.invalidateCache();
    }

    // Targeted single-document lookup — called on every login, so this must not
    // scan the whole userGroups collection.
    async getUserGroupById(id: string): Promise<UserGroup | null> {
        if (!id) return null;
        const snap = await getDoc(doc(this.firestore, `userGroups/${id}`));
        if (!snap.exists()) return null;
        return { id: snap.id, ...snap.data() } as UserGroup;
    }
}
