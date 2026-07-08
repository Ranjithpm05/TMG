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
import { from, map, Observable, shareReplay } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UserGroupService {

    private firestore = inject(Firestore);
    private groupRef = collection(this.firestore, 'userGroups');

    // Small admin-only master list — cached one-time read, invalidated on write.
    private groupsCache$: Observable<UserGroup[]> | null = null;

    // 🔹 GET ALL GROUPS (cached one-time read — used only by the User Management screen)
    getGroups(): Observable<UserGroup[]> {
        if (!this.groupsCache$) {
            this.groupsCache$ = from(getDocs(this.groupRef)).pipe(
                map((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() } as UserGroup))),
                shareReplay(1)
            );
        }
        return this.groupsCache$;
    }

    private invalidateCache(): void {
        this.groupsCache$ = null;
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
