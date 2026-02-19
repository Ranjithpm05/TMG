// import { Injectable } from '@angular/core';
// import { of, Observable } from 'rxjs';
// import { Design } from '../models/design.model';

// @Injectable({ providedIn: 'root' })
// export class DesignService {
//   private designs: Design[] = [
//     {
//       id: 'des1',
//       styleNo: 'TSH001',
//       color: 'Blue',
//       sleeveType: 'Half',
//       sizes: [
//         { size: 'S', price: 15.99 },
//         { size: 'M', price: 15.99 },
//         { size: 'L', price: 17.99 },
//       ],
//       cost: 8.50,
//       group: 'T-Shirts',
//       fabricType: 'Cotton'
//     },
//     {
//       id: 'des2',
//       styleNo: 'POLO002',
//       color: 'Red',
//       sleeveType: 'Half',
//       sizes: [
//         { size: 'M', price: 22.50 },
//         { size: 'L', price: 22.50 },
//         { size: 'XL', price: 24.50 },
//       ],
//       cost: 12.00,
//       group: 'Polos',
//       fabricType: 'Pique'
//     },
//     {
//       id: 'des3',
//       styleNo: 'JNS005',
//       color: 'Indigo',
//       sleeveType: 'Full', // Not applicable but for data consistency
//       sizes: [
//         { size: '30', price: 49.99 },
//         { size: '32', price: 49.99 },
//         { size: '34', price: 49.99 },
//       ],
//       cost: 25.00,
//       group: 'Jeans',
//       fabricType: 'Denim'
//     }
//   ];

//   getDesigns(): Observable<Design[]> {
//     return of(JSON.parse(JSON.stringify(this.designs)));
//   }
  
//   findDesignByStyleNo(styleNo: string): Observable<Design | undefined> {
//     const found = this.designs.find(d => d.styleNo.toLowerCase() === styleNo.toLowerCase());
//     return of(found ? JSON.parse(JSON.stringify(found)) : undefined);
//   }

//   saveDesign(design: Omit<Design, 'id'>): Observable<Design> {
//     const newDesign: Design = {
//       ...design,
//       id: `des${this.designs.length + 1}_${Date.now()}`,
//     };
//     this.designs.push(newDesign);
//     return of(JSON.parse(JSON.stringify(newDesign)));
//   }

//   updateDesign(designToUpdate: Design): Observable<Design> {
//     const index = this.designs.findIndex(d => d.id === designToUpdate.id);
//     if (index !== -1) {
//       this.designs[index] = designToUpdate;
//     }
//     return of(JSON.parse(JSON.stringify(designToUpdate)));
//   }

//   deleteDesign(designId: string): Observable<void> {
//     this.designs = this.designs.filter(d => d.id !== designId);
//     return of(undefined);
//   }
// }
import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  collectionData,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  serverTimestamp
} from '@angular/fire/firestore';
import { map, Observable } from 'rxjs';
import type { Design } from '../models/design.model';

@Injectable({ providedIn: 'root' })
export class DesignService {

    private firestore = inject(Firestore);
    private designRef = collection(this.firestore, 'designs');

    // 🔹 GET ALL DESIGNS
    getDesigns(): Observable<Design[]> {
        const q = query(this.designRef, orderBy('createdAt', 'desc'));
        return collectionData(q, { idField: 'id' }) as Observable<Design[]>;
    }

    // 🔹 CREATE DESIGN (no id)
    async createDesign(
        design: Omit<Design, 'id'>
    ): Promise<void> {
        await addDoc(this.designRef, {
        ...design,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
        });
    }

    // 🔹 UPDATE DESIGN (id required)
    async updateDesign(design: Design): Promise<void> {
        if (!design.id) return;

        const designDoc = doc(this.firestore, `designs/${design.id}`);
        await updateDoc(designDoc, {
        ...design,
        updatedAt: serverTimestamp()
        });
    }

    // 🔹 DELETE DESIGN
    async deleteDesign(designId: string): Promise<void> {
        const designDoc = doc(this.firestore, `designs/${designId}`);
        await deleteDoc(designDoc);
    }

    findDesignByStyleNo(styleNo: string): Observable<Design | null> {
        const q = query(
            collection(this.firestore, 'designs'),
            where('BARCODE', '==', styleNo)
        );

        return collectionData(q, { idField: 'id' }).pipe(
            map((designs: any[]) => designs.length ? designs[0] : null)
        );
    }
}