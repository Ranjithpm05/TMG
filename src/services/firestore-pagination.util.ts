import { getDocs, limit, query, startAfter, CollectionReference, QueryConstraint, QueryDocumentSnapshot } from '@angular/fire/firestore';

// A fixed `limit()` with no follow-up page silently truncates a collection's
// results once it grows past that number — several services here originally
// did exactly that (see project memory on the Design Master export bug).
// This walks a query with startAfter() cursors until a page comes back
// shorter than `pageSize`, so every caller gets the complete result set no
// matter how large the collection has grown. Works with or without an
// explicit orderBy in `constraints` — Firestore falls back to ordering by
// document ID, which is enough for stable, gap-free cursor pagination.
export async function fetchAllDocs<T>(
  collectionRef: CollectionReference,
  constraints: QueryConstraint[],
  mapDoc: (doc: QueryDocumentSnapshot) => T,
  pageSize = 1000
): Promise<T[]> {
  const results: T[] = [];
  let cursor: QueryDocumentSnapshot | undefined;

  while (true) {
    const pageConstraints = cursor
      ? [...constraints, limit(pageSize), startAfter(cursor)]
      : [...constraints, limit(pageSize)];
    const snap = await getDocs(query(collectionRef, ...pageConstraints));

    results.push(...snap.docs.map(mapDoc));

    if (snap.docs.length < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  return results;
}
