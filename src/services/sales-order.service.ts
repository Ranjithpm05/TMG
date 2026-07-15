import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  where,
  Timestamp,
  serverTimestamp
} from '@angular/fire/firestore';

import type { SalesOrder } from '../models/sales-order.model';
import { from, map, Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SalesOrderService {

    private firestore = inject(Firestore);
    private salesOrderRef = collection(this.firestore, 'salesOrders');

    private buildSalesOrder(
        order: Omit<SalesOrder, 'id' | 'status' | 'orderDate'>
    ): Omit<SalesOrder, 'id'> {
        return {
            ...order,
            salesNo: `SO-${Date.now()}`,
            status: 'Pending',
            orderDate: new Date().toISOString().split('T')[0]
        } as Omit<SalesOrder, 'id'>;
    }

    // One-time read: every screen that lists sales orders just snapshots into a
    // signal/array and manually reloads after its own writes, so a standing
    // realtime listener buys nothing but extra reads on every remote change.
    getSalesOrders(pageLimit = 100): Observable<SalesOrder[]> {
        const q = query(this.salesOrderRef, orderBy('createdAt', 'desc'), limit(pageLimit));
        return from(getDocs(q)).pipe(
            // Spread doc data first, then override with the real Firestore doc id last —
            // some legacy documents have a stale/blank "id" field stored in their body
            // (see createSalesOrder), which must never win over the actual doc reference id.
            map((snap) => snap.docs.map((d) => ({ ...d.data(), id: d.id } as SalesOrder)))
        );
    }

    // 🔹 Date-bounded one-time query for reports — avoids pulling the full collection
    // for large datasets and avoids leaving a listener open while a report is viewed.
    getSalesOrdersInRange(start: Date, end: Date, hardLimit = 5000): Observable<SalesOrder[]> {
        const q = query(
            this.salesOrderRef,
            where('createdAt', '>=', Timestamp.fromDate(start)),
            where('createdAt', '<=', Timestamp.fromDate(end)),
            orderBy('createdAt', 'desc'),
            limit(hardLimit)
        );
        return from(getDocs(q)).pipe(
            map((snap) => snap.docs.map((d) => ({ ...d.data(), id: d.id } as SalesOrder)))
        );
    }

    // 🔹 Create sales order
    // async createSalesOrder(order: SalesOrder): Promise<void> {
    //     await addDoc(this.salesOrderRef, {
    //         ...order,
    //         createdAt: serverTimestamp(),
    //         updatedAt: serverTimestamp()
    //     });
    // }
    createSalesOrder(
        order: Omit<SalesOrder, 'id' | 'status' | 'orderDate'>
    ): Observable<SalesOrder> {
        const promise = (async () => {
            // Pre-allocate the doc ref so the real Firestore id can be stored in the
            // document body too, instead of the old placeholder id:"" that used to get
            // written and then clobber the real id on every subsequent read.
            const docRef = doc(this.salesOrderRef);
            const newOrder: SalesOrder = { ...this.buildSalesOrder(order), id: docRef.id };
            await setDoc(docRef, {
                ...newOrder,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            return newOrder;
        })();

        return from(promise);
    }

    // 🔹 Update sales order
    updateSalesOrder(order: SalesOrder): Observable<void> {
        // Wrapped in an async IIFE so any synchronous error (e.g. an invalid/missing
        // doc id, or a Firestore rejection on undefined field values) becomes a
        // rejected promise routed through the caller's error handler, instead of
        // throwing before subscribe() ever attaches — which previously left the
        // "Updating..." loading dialog stuck forever with nothing saved.
        const promise = (async () => {
            if (!order.id) {
                throw new Error('Cannot update sales order: missing document ID.');
            }
            // Strip any stray undefined values (Firestore rejects them) before writing.
            const sanitized = JSON.parse(JSON.stringify(order));
            await updateDoc(doc(this.firestore, `salesOrders/${order.id}`), {
                ...sanitized,
                updatedAt: serverTimestamp()
            });
        })();

        return from(promise);
    }

    // 🔹 Delete sales order
    async deleteSalesOrder(orderId: string): Promise<void> {
        const orderDoc = doc(this.firestore, `salesOrders/${orderId}`);
        await deleteDoc(orderDoc);
    }
}