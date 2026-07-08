import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  addDoc,
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
    ): SalesOrder {
        return {
            ...order,
            id:"",
            salesNo: `SO-${Date.now()}`,
            status: 'Pending',
            orderDate: new Date().toISOString().split('T')[0]
        } as SalesOrder;
    }

    // One-time read: every screen that lists sales orders just snapshots into a
    // signal/array and manually reloads after its own writes, so a standing
    // realtime listener buys nothing but extra reads on every remote change.
    getSalesOrders(pageLimit = 100): Observable<SalesOrder[]> {
        const q = query(this.salesOrderRef, orderBy('createdAt', 'desc'), limit(pageLimit));
        return from(getDocs(q)).pipe(
            map((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() } as SalesOrder)))
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
            map((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() } as SalesOrder)))
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
            const newOrder = this.buildSalesOrder(order);
            await addDoc(this.salesOrderRef, {
                ...newOrder,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            return newOrder;
        })();

        return from(promise);
    }

    // 🔹 Update sales order
    // async updateSalesOrder(order: SalesOrder): Promise<void> {
    //     const orderDoc = doc(this.firestore, `salesOrders/${order.id}`);
    //     await updateDoc(orderDoc, {
    //     ...order,
    //     updatedAt: serverTimestamp()
    //     });
    // }
    updateSalesOrder(order: SalesOrder): Observable<void> {
        return from(
            updateDoc(doc(this.firestore, `salesOrders/${order.id}`), {
            ...order,
            updatedAt: serverTimestamp()
            })
        );
    }

    // 🔹 Delete sales order
    async deleteSalesOrder(orderId: string): Promise<void> {
        const orderDoc = doc(this.firestore, `salesOrders/${orderId}`);
        await deleteDoc(orderDoc);
    }
}