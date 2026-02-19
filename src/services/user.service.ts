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

import type { User } from '../models/user.model';
import { Observable, firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UserService {

    private firestore = inject(Firestore);
    private userRef = collection(this.firestore, 'users');

    // 🔹 GET ALL USERS
    getUsers(): Observable<User[]> {
        return collectionData(this.userRef, { idField: 'id' }) as Observable<User[]>;
    }

    // 🔹 CREATE USER
    async createUser(user: Omit<User, 'id'>): Promise<void> {
        await addDoc(this.userRef, {
        ...user,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
        });
    }

    // 🔹 UPDATE USER
    async updateUser(user: User): Promise<void> {
        if (!user.id) return;

        const userDoc = doc(this.firestore, `users/${user.id}`);
        await updateDoc(userDoc, {
        ...user,
        updatedAt: serverTimestamp()
        });
    }

    // 🔹 DELETE USER
    async deleteUser(userId: string): Promise<void> {
        const userDoc = doc(this.firestore, `users/${userId}`);
        await deleteDoc(userDoc);
    }

    async getUserByUsername(username: string): Promise<User | null> {
        const users = await firstValueFrom(this.getUsers());
        return users.find(u => u.username === username) ?? null;
    }
    async getUserById(id: string): Promise<User | null> {
        const users = await firstValueFrom(this.getUsers());
        return users.find(u => u.id === id) ?? null;
    }

    async validatePassword(userId: string, passwordHash: string): Promise<boolean> {
        const user = await this.getUserById(userId);
        return user?.passwordHash === passwordHash;
    }
}
