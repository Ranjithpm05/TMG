import { limit, query, startAfter, CollectionReference, QueryConstraint, QueryDocumentSnapshot } from '@angular/fire/firestore';
import { getDocs } from './firestore-reads';

/**
 * Docs per Firestore request for paged reads. Was 5000: a cold device then
 * pulled ~11 MB through the single Listen stream within seconds and Firestore
 * dropped the stream with resource-exhausted (see sync.engine.ts). 500 keeps
 * each response ~0.5 MB. Tunable per device for measurement:
 * localStorage['tmg:syncPageSize'] = '300' (clamped to 100–1000).
 */
export const DEFAULT_PAGE_SIZE = 500;

export function syncPageSize(): number {
  try {
    const override = Number(localStorage.getItem('tmg:syncPageSize'));
    if (Number.isFinite(override) && override > 0) return Math.min(1000, Math.max(100, Math.round(override)));
  } catch {
    // localStorage unavailable — use the default.
  }
  return DEFAULT_PAGE_SIZE;
}

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
  // Each page is an awaited round trip before the next starts (cursor
  // pagination can't be parallelized — page N+1's cursor depends on page N's
  // last doc). Large pages looked cheaper in round trips but got the Listen
  // stream dropped mid-download — see DEFAULT_PAGE_SIZE.
  pageSize = syncPageSize()
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
