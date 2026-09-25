import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
  where,
  limit,
  serverTimestamp,
} from '@angular/fire/firestore';
import { getDoc, getDocs } from './firestore-reads';

import type { User } from '../models/user.model';
import { defer, map, Observable, retry, shareReplay, throwError, timer } from 'rxjs';
import { backgroundRetryDelayMs, isTransientFirestoreError } from './firestore-health';

@Injectable({ providedIn: 'root' })
export class UserService {

    private firestore = inject(Firestore);
    private userRef = collection(this.firestore, 'users');

    // Small admin-only master list — cached one-time read, invalidated on write.
    private usersCache$: Observable<User[]> | null = null;

    // 🔹 GET ALL USERS (cached one-time read — used only by the User Management screen)
    getUsers(): Observable<User[]> {
        if (!this.usersCache$) {
            this.usersCache$ = defer(() => getDocs(this.userRef)).pipe(
                map((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() } as User))),
                // Quota exceeded / unreachable: retry in the background instead of replaying the error forever.
                retry({ delay: (err, count) => (isTransientFirestoreError(err) ? timer(backgroundRetryDelayMs(count - 1)) : throwError(() => err)) }),
                shareReplay(1)
            );
        }
        return this.usersCache$;
    }

    private invalidateCache(): void {
        this.usersCache$ = null;
    }

    // 🔹 CREATE USER
    async createUser(user: Omit<User, 'id'>): Promise<void> {
        await addDoc(this.userRef, {
        ...user,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
        });
        this.invalidateCache();
    }

    // 🔹 UPDATE USER
    async updateUser(user: User): Promise<void> {
        if (!user.id) return;

        const userDoc = doc(this.firestore, `users/${user.id}`);
        await updateDoc(userDoc, {
        ...user,
        updatedAt: serverTimestamp()
        });
        this.invalidateCache();
    }

    // 🔹 DELETE USER
    async deleteUser(userId: string): Promise<void> {
        const userDoc = doc(this.firestore, `users/${userId}`);
        await deleteDoc(userDoc);
        this.invalidateCache();
    }

    // 🔹 RESET PASSWORD (only touches passwordHash, avoids clobbering other fields)
    async resetPassword(userId: string, newPasswordHash: string): Promise<void> {
        const userDoc = doc(this.firestore, `users/${userId}`);
        await updateDoc(userDoc, {
            passwordHash: newPasswordHash,
            updatedAt: serverTimestamp()
        });
        this.invalidateCache();
    }

    // Targeted single-document lookups for the login flow — avoids reading the
    // entire users collection on every login attempt.
    async getUserByUsername(username: string): Promise<User | null> {
        const snap = await getDocs(query(this.userRef, where('username', '==', username), limit(1)));
        if (snap.empty) return null;
        return { id: snap.docs[0].id, ...snap.docs[0].data() } as User;
    }

    async getUserById(id: string): Promise<User | null> {
        if (!id) return null;
        const snap = await getDoc(doc(this.firestore, `users/${id}`));
        if (!snap.exists()) return null;
        return { id: snap.id, ...snap.data() } as User;
    }
}
