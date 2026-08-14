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
  doc,
  addDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  limit,
  startAfter,
  QueryDocumentSnapshot,
  serverTimestamp
} from '@angular/fire/firestore';
import { Storage, ref, uploadBytes, getDownloadURL, deleteObject } from '@angular/fire/storage';
import { firstValueFrom, from, map, Observable, shareReplay } from 'rxjs';
import type { Design, SizePrice } from '../models/design.model';

@Injectable({ providedIn: 'root' })
export class DesignService {

    private firestore = inject(Firestore);
    private storage = inject(Storage);
    private designRef = collection(this.firestore, 'designs');

    // Master data — cached one-time read, invalidated on write (see ClientService for rationale).
    private designsCache$: Observable<Design[]> | null = null;

    // Page size for each individual Firestore request, NOT a cap on total
    // records returned — getDesigns() pages through with startAfter() until a
    // page comes back short, so the full collection is always returned no
    // matter how large it grows (a prior fixed limit() here silently
    // truncated the list once the collection passed that count). Each page is
    // an awaited round trip before the next starts, so a larger page size
    // directly cuts round-trip count for a large catalog (matches
    // firestore-pagination.util.ts's fetchAllDocs()).
    private static readonly PAGE_SIZE = 5000;

    // 🔹 GET ALL DESIGNS (cached one-time read)
    // No `orderBy('createdAt')` on the query itself: Firestore silently drops any
    // document missing that field from an orderBy'd result, which was hiding
    // designs created without a createdAt (e.g. from before that field existed)
    // from every screen, including this export. Sort client-side instead — the
    // full list is already loaded into memory for client-side search/filter.
    getDesigns(): Observable<Design[]> {
        if (!this.designsCache$) {
            this.designsCache$ = from(this.fetchAllDesigns()).pipe(shareReplay(1));
        }
        return this.designsCache$;
    }

    private async fetchAllDesigns(): Promise<Design[]> {
        const results: Design[] = [];
        let cursor: QueryDocumentSnapshot | undefined;

        while (true) {
            const constraints = cursor
                ? [limit(DesignService.PAGE_SIZE), startAfter(cursor)]
                : [limit(DesignService.PAGE_SIZE)];
            const snap = await getDocs(query(this.designRef, ...constraints));

            // Spread order matters: the real document ID must win over any stray
            // `id` field that ended up inside the document's own data (see the
            // id-stripping note on createDesign/updateDesign below).
            results.push(...snap.docs.map((d) => ({ ...d.data(), id: d.id } as Design)));

            if (snap.docs.length < DesignService.PAGE_SIZE) break;
            cursor = snap.docs[snap.docs.length - 1];
        }

        return results.sort((a, b) => this.toMillis(b.createdAt) - this.toMillis(a.createdAt));
    }

    private toMillis(value: any): number {
        if (value?.toMillis) return value.toMillis();
        if (value?.seconds != null) return value.seconds * 1000;
        if (value) {
            const parsed = new Date(value);
            if (!isNaN(parsed.getTime())) return parsed.getTime();
        }
        return 0;
    }

    private invalidateCache(): void {
        this.designsCache$ = null;
    }

    // 🔹 CREATE DESIGN (no id) — returns the new document's id
    async createDesign(
        design: Omit<Design, 'id'>
    ): Promise<string> {
        // Never persist `id` as a data field — it's redundant with the doc path and,
        // if it ever drifts from the real doc id, silently redirects future reads/
        // writes to the wrong document (see fetchAllDesigns).
        const { id, ...data } = design as Design;
        const docRef = await addDoc(this.designRef, {
        ...data,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
        });
        this.invalidateCache();
        return docRef.id;
    }

    // 🔹 UPDATE DESIGN (id required)
    async updateDesign(design: Design): Promise<void> {
        if (!design.id) return;

        const { id, ...data } = design;
        const designDoc = doc(this.firestore, `designs/${id}`);
        await updateDoc(designDoc, {
        ...data,
        updatedAt: serverTimestamp()
        });
        this.invalidateCache();
    }

    // 🔹 UPDATE JUST THE IMAGE URL — used after an image upload completes so a slow
    // or failing Storage upload never blocks/loses the rest of the design's details.
    async updateDesignImageUrl(designId: string, imageUrl: string): Promise<void> {
        const designDoc = doc(this.firestore, `designs/${designId}`);
        await updateDoc(designDoc, { imageUrl, updatedAt: serverTimestamp() });
        this.invalidateCache();
    }

    // 🔹 DELETE DESIGN
    async deleteDesign(designId: string): Promise<void> {
        const designDoc = doc(this.firestore, `designs/${designId}`);
        await deleteDoc(designDoc);
        this.invalidateCache();
    }

    // 🔹 UPLOAD DESIGN IMAGE — returns the public download URL to store on the Design doc
    async uploadDesignImage(file: File): Promise<string> {
        const path = `design-images/${Date.now()}_${file.name}`;
        const storageRef = ref(this.storage, path);
        await uploadBytes(storageRef, file);
        return getDownloadURL(storageRef);
    }

    async deleteDesignImage(imageUrl: string): Promise<void> {
        try {
            await deleteObject(ref(this.storage, imageUrl));
        } catch {
            // Ignore failures (e.g. already deleted or URL isn't a Storage ref) — non-critical cleanup.
        }
    }

    // Barcode → Design/Size lookup — the single source of truth for barcode
    // identity during Pick List scanning (see PickListService.processScan /
    // processPartyScan and PickListComponent.computeOrderLines). BARCODE lives
    // nested per-size inside each Design's `sizes[]`, so Firestore can't query
    // it directly (no querying a sub-field inside an array of maps) — this is
    // a client-side scan over the same cached list every other Design Master
    // read already uses. Inventory must NOT be used for this lookup: a
    // barcode is valid the moment it's defined here, regardless of whether an
    // `inventory` document (i.e. stock) exists for it yet.
    async findDesignSizeByBarcode(barcode: string): Promise<{ design: Design; sizeEntry: SizePrice } | null> {
        const trimmed = String(barcode ?? '').trim();
        if (!trimmed) return null;
        const designs = await firstValueFrom(this.getDesigns());
        for (const design of designs) {
            const sizeEntry = (design.sizes ?? []).find((s) => String(s.BARCODE ?? '').trim() === trimmed);
            if (sizeEntry) return { design, sizeEntry };
        }
        return null;
    }

    async findDesignByStyleNo(styleNo: string): Promise<Design | null> {
        const q = query(
            collection(this.firestore, 'designs'),
            where('BARCODE', '==', styleNo),
            limit(1)
        );

        const snap = await getDocs(q);
        return snap.empty ? null : ({ ...snap.docs[0].data(), id: snap.docs[0].id } as Design);
    }
}