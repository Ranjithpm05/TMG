import {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QuerySnapshot,
  Transaction,
  TransactionOptions,
  getCountFromServer as sdkGetCountFromServer,
  getDocFromServer,
  getDocsFromServer,
  onSnapshot,
  runTransaction as sdkRunTransaction,
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { isTransientFirestoreError, noteFirestoreError, noteFirestoreSuccess } from './firestore-health';
import { ReadKind, listenerClosed, listenerOpened, recordRead, recordReadError } from './firestore-read-meter';

/**
 * The only entry points the app uses to READ Firestore — drop-in replacements
 * for the same-named @angular/fire/firestore functions. They add:
 *
 *  - Server-only one-time reads. Plain getDocs()/getDoc() fall back to the
 *    local cache once the SDK decides it's offline — which is exactly what
 *    happens while the quota is exhausted — and this app runs a memory-only
 *    cache, so that "fallback" is an empty or partial result presented as
 *    real data (no designs → ₹0 MRPs, no inventory match → duplicate
 *    inventory docs on GRN approval). getDocsFromServer()/getDocFromServer()
 *    reject instead, which every caller already handles as a failed load.
 *  - A short automatic retry (1 s, then 3 s) when Firestore is momentarily
 *    unavailable or over quota. Longer outages are retried in the background
 *    by the list caches, which keep showing the copy saved on this device.
 *  - Read metering per screen/query (see firestore-read-meter.ts — temporary).
 */

export async function getDocs<T = DocumentData>(q: Query<T>): Promise<QuerySnapshot<T>> {
  const label = describeQuery(q);
  const t0 = performance.now();
  try {
    const snap = await withRetry(() => getDocsFromServer(q));
    noteFirestoreSuccess();
    recordRead('getDocs', label, Math.max(1, snap.size), performance.now() - t0, snap.size);
    return snap;
  } catch (err) {
    fail('getDocs', label, err);
  }
}

export async function getDoc<T = DocumentData>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const label = normalizePath(ref.path);
  const t0 = performance.now();
  try {
    const snap = await withRetry(() => getDocFromServer(ref));
    noteFirestoreSuccess();
    recordRead('getDoc', label, 1, performance.now() - t0);
    return snap;
  } catch (err) {
    fail('getDoc', label, err);
  }
}

export async function getCountFromServer<T = DocumentData>(q: Query<T>) {
  const label = describeQuery(q);
  const t0 = performance.now();
  try {
    const snap = await withRetry(() => sdkGetCountFromServer(q));
    noteFirestoreSuccess();
    recordRead('count', label, Math.max(1, Math.ceil(snap.data().count / 1000)), performance.now() - t0, 0);
    return snap;
  } catch (err) {
    fail('count', label, err);
  }
}

/** Same contract as AngularFire's collectionData (rxfire): emits the mapped docs on every snapshot, including metadata-only changes. */
export function collectionData<T = DocumentData>(q: Query<T>, options: { idField?: string } = {}): Observable<DocumentData[]> {
  const label = describeQuery(q);
  return new Observable<DocumentData[]>((subscriber) => {
    let serverSnapshots = 0;
    listenerOpened(label);
    const unsubscribe = onSnapshot(q, { includeMetadataChanges: true }, {
      next: (snap) => {
        if (!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) {
          const reads = serverSnapshots++ === 0 ? Math.max(1, snap.size) : snap.docChanges().length;
          if (reads) recordRead('listen', label, reads, 0, snap.size);
          noteFirestoreSuccess();
        }
        subscriber.next(snap.docs.map((d) => snapToData(d, options)));
      },
      error: (err) => {
        noteFirestoreError(err);
        recordReadError('listen', label, err);
        subscriber.error(err);
      },
    });
    return () => {
      unsubscribe();
      listenerClosed(label);
    };
  });
}

/** Same contract as AngularFire's docData (rxfire). */
export function docData<T = DocumentData>(ref: DocumentReference<T>, options: { idField?: string } = {}): Observable<DocumentData | undefined> {
  const label = normalizePath(ref.path);
  return new Observable<DocumentData | undefined>((subscriber) => {
    let hadPendingWrites = false;
    listenerOpened(label);
    const unsubscribe = onSnapshot(ref, { includeMetadataChanges: true }, {
      next: (snap) => {
        // A pending-write → acknowledged flip is metadata only, not a billed read.
        if (!snap.metadata.fromCache && !snap.metadata.hasPendingWrites && !hadPendingWrites) {
          recordRead('listen', label, 1, 0);
          noteFirestoreSuccess();
        }
        hadPendingWrites = snap.metadata.hasPendingWrites;
        subscriber.next(snapToData(snap, options));
      },
      error: (err) => {
        noteFirestoreError(err);
        recordReadError('listen', label, err);
        subscriber.error(err);
      },
    });
    return () => {
      unsubscribe();
      listenerClosed(label);
    };
  });
}

/** runTransaction with each transaction.get() metered (every attempt of a retried transaction is billed, and counted). */
export async function runTransaction<T>(
  firestore: Firestore,
  updateFunction: (transaction: Transaction) => Promise<T>,
  options?: TransactionOptions
): Promise<T> {
  try {
    const result = await sdkRunTransaction(firestore, (transaction) => updateFunction(meterTransaction(transaction)), options);
    noteFirestoreSuccess();
    return result;
  } catch (err) {
    noteFirestoreError(err);
    throw err;
  }
}

function meterTransaction(transaction: Transaction): Transaction {
  return new Proxy(transaction, {
    get(target, prop) {
      if (prop === 'get') {
        return (ref: DocumentReference) => {
          recordRead('tx.get', normalizePath(ref.path), 1, 0);
          return target.get(ref);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const QUICK_RETRY_DELAYS_MS = [1000, 3000];

async function withRetry<R>(read: () => Promise<R>): Promise<R> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      if (!isTransientFirestoreError(err) || attempt >= QUICK_RETRY_DELAYS_MS.length) throw err;
      noteFirestoreError(err);
      await new Promise((resolve) => setTimeout(resolve, QUICK_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function fail(kind: ReadKind, label: string, err: unknown): never {
  noteFirestoreError(err);
  recordReadError(kind, label, err);
  throw err;
}

function snapToData(snap: DocumentSnapshot, options: { idField?: string }): DocumentData | undefined {
  const data = snap.data();
  if (!snap.exists() || typeof data !== 'object' || data === null || !options.idField) return data;
  return { ...data, [options.idField]: snap.id };
}

// ── Labels for the read meter ────────────────────────────────────────────
// Built from the SDK's internal query representation (best-effort — this is
// diagnostics only, so any shape change just degrades to the bare path).

/** "pickLists/abc123/lines" → "pickLists/{id}/lines" so per-parent queries aggregate into one row. */
function normalizePath(path: string): string {
  return path.split('/').map((s, i) => (i % 2 === 1 ? '{id}' : s)).join('/');
}

function describeQuery(q: Query<any>): string {
  try {
    const internal = (q as any)._query;
    const base = internal.collectionGroup
      ? `**/${internal.collectionGroup}`
      : normalizePath(internal.path.canonicalString());
    const filters = (internal.filters ?? []).map(describeFilter).filter(Boolean);
    const orderBy = (internal.explicitOrderBy ?? []).map((o: any) => `orderBy ${o.field.canonicalString()}`);
    const limit = internal.limit != null ? [`limit ${internal.limit}`] : [];
    const parts = [...filters, ...orderBy, ...limit];
    return parts.length ? `${base} [${parts.join(', ')}]` : base;
  } catch {
    return 'query';
  }
}

function describeFilter(filter: any): string {
  if (Array.isArray(filter?.filters)) return `(${filter.filters.map(describeFilter).join(` ${filter.op} `)})`;
  const field = filter?.field?.canonicalString?.();
  return field ? `${field} ${filter.op}` : '';
}
