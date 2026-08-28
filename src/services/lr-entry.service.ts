import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  orderBy,
  runTransaction,
  serverTimestamp,
  setDoc,
} from '@angular/fire/firestore';
import { from, Observable, shareReplay } from 'rxjs';
import { LrEntry } from '../models/lr-entry.model';
import { fetchAllDocs } from './firestore-pagination.util';
import { InvoiceService } from './invoice.service';

@Injectable({ providedIn: 'root' })
export class LrEntryService {
  private firestore = inject(Firestore);
  // Mapping/unmapping writes straight to invoices/{id} without going through
  // InvoiceService — same reasoning as EInvoiceService: must invalidate its
  // cache too or the Invoice screen keeps showing the pre-mapping lrEntryId.
  private invoiceService = inject(InvoiceService);
  private lrRef = collection(this.firestore, 'lrEntries');

  private lrEntriesCache$: Observable<LrEntry[]> | null = null;

  invalidateCache(): void {
    this.lrEntriesCache$ = null;
  }

  getLrEntries(): Observable<LrEntry[]> {
    if (!this.lrEntriesCache$) {
      this.lrEntriesCache$ = from(
        fetchAllDocs(this.lrRef, [orderBy('createdAt', 'desc')], (d) => this.normalize({ id: d.id, ...d.data() }))
      ).pipe(shareReplay(1));
    }
    return this.lrEntriesCache$;
  }

  // Called once per dispatch, from PackingListComponent.generateAndPrintDC —
  // only when the user actually entered an LR No. (self/door delivery has no
  // LR, so this is never forced). invoiceIds/invoiceNos always start empty;
  // they're populated later via mapInvoiceToLrEntry from the Invoice screen.
  async createLrEntry(
    input: Omit<LrEntry, 'id' | 'invoiceIds' | 'invoiceNos' | 'createdAt' | 'updatedAt'>
  ): Promise<LrEntry> {
    const docRef = doc(this.lrRef);
    const data = this.stripUndefined({
      ...input,
      invoiceIds: [],
      invoiceNos: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await setDoc(docRef, data);
    this.invalidateCache();
    return this.normalize({ id: docRef.id, ...data });
  }

  // Maps (or re-maps) one invoice to an LR Entry. At most one LR per invoice
  // (Invoice.lrEntryId), but one LR can hold many invoices — so this only
  // ever adds/moves this single invoice id, never touches any other invoice
  // already on either LR. Runs as a transaction so switching from LR A to LR
  // B atomically drops it from A's invoiceIds and adds it to B's, and two
  // rapid clicks can't add the same invoice twice.
  //
  // Validates the LR Entry's transporter actually matches the invoice's
  // Transport before mapping — the Invoice screen's picker already only
  // *offers* matching LR Entries, but this re-checks server-side-equivalent
  // (a Firestore transaction, this app's "backend") so a stale/cached list
  // can't slip an incorrect mapping through.
  async mapInvoiceToLrEntry(
    invoice: { id: string; invoiceNo: string; transport?: string; lrEntryId?: string },
    lrEntry: LrEntry
  ): Promise<void> {
    if (!lrEntry.id) throw new Error('Invalid LR Entry.');
    if (invoice.lrEntryId === lrEntry.id) return; // already mapped — no-op, not an error

    const invoiceTransport = (invoice.transport || '').trim().toLowerCase();
    const lrTransport = (lrEntry.transport || '').trim().toLowerCase();
    if (!invoiceTransport || invoiceTransport !== lrTransport) {
      throw new Error('This LR Entry\'s Transport does not match the invoice\'s Transport.');
    }

    const invoiceRef = doc(this.firestore, 'invoices', invoice.id);
    const newLrRef = doc(this.lrRef, lrEntry.id);
    const oldLrRef = invoice.lrEntryId ? doc(this.lrRef, invoice.lrEntryId) : null;

    await runTransaction(this.firestore, async (tx) => {
      const newLrSnap = await tx.get(newLrRef);
      if (!newLrSnap.exists()) throw new Error('lr_not_found');
      const oldLrSnap = oldLrRef ? await tx.get(oldLrRef) : null;

      const newLrData: any = newLrSnap.data();
      const newInvoiceIds: string[] = Array.isArray(newLrData?.invoiceIds) ? newLrData.invoiceIds : [];
      const newInvoiceNos: string[] = Array.isArray(newLrData?.invoiceNos) ? newLrData.invoiceNos : [];
      if (!newInvoiceIds.includes(invoice.id)) {
        tx.update(newLrRef, {
          invoiceIds: [...newInvoiceIds, invoice.id],
          invoiceNos: [...new Set([...newInvoiceNos, invoice.invoiceNo])],
          updatedAt: serverTimestamp(),
        });
      }

      if (oldLrSnap?.exists()) {
        const oldData: any = oldLrSnap.data();
        const oldInvoiceIds: string[] = Array.isArray(oldData?.invoiceIds) ? oldData.invoiceIds : [];
        const oldInvoiceNos: string[] = Array.isArray(oldData?.invoiceNos) ? oldData.invoiceNos : [];
        tx.update(oldLrRef!, {
          invoiceIds: oldInvoiceIds.filter((id) => id !== invoice.id),
          invoiceNos: oldInvoiceNos.filter((no) => no !== invoice.invoiceNo),
          updatedAt: serverTimestamp(),
        });
      }

      tx.update(invoiceRef, {
        lrEntryId: lrEntry.id,
        lrNo: newLrData?.lrNo ?? lrEntry.lrNo,
        lrDate: newLrData?.lrDate ?? lrEntry.lrDate ?? null,
        updatedAt: serverTimestamp(),
      });
    });

    this.invalidateCache();
    this.invoiceService.invalidateCache();
  }

  async unmapInvoiceFromLrEntry(invoice: { id: string; invoiceNo: string; lrEntryId?: string }): Promise<void> {
    if (!invoice.lrEntryId) return;
    const invoiceRef = doc(this.firestore, 'invoices', invoice.id);
    const lrRef = doc(this.lrRef, invoice.lrEntryId);

    await runTransaction(this.firestore, async (tx) => {
      const lrSnap = await tx.get(lrRef);
      if (lrSnap.exists()) {
        const data: any = lrSnap.data();
        const invoiceIds: string[] = Array.isArray(data?.invoiceIds) ? data.invoiceIds : [];
        const invoiceNos: string[] = Array.isArray(data?.invoiceNos) ? data.invoiceNos : [];
        tx.update(lrRef, {
          invoiceIds: invoiceIds.filter((id) => id !== invoice.id),
          invoiceNos: invoiceNos.filter((no) => no !== invoice.invoiceNo),
          updatedAt: serverTimestamp(),
        });
      }
      tx.update(invoiceRef, {
        lrEntryId: null,
        lrNo: null,
        lrDate: null,
        updatedAt: serverTimestamp(),
      });
    });

    this.invalidateCache();
    this.invoiceService.invalidateCache();
  }

  private stripUndefined<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.filter((entry) => entry !== undefined).map((entry) => this.stripUndefined(entry)) as T;
    }
    if (value && typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return value;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .map(([key, entry]) => [key, this.stripUndefined(entry)])
      ) as T;
    }
    return value;
  }

  private normalize(raw: any): LrEntry {
    return {
      id: raw?.id,
      lrNo: String(raw?.lrNo ?? ''),
      lrDate: raw?.lrDate,
      transport: String(raw?.transport ?? ''),
      transportId: raw?.transportId ? String(raw.transportId) : undefined,
      vehicleNo: raw?.vehicleNo ? String(raw.vehicleNo) : undefined,
      packingListId: String(raw?.packingListId ?? ''),
      packingListNo: String(raw?.packingListNo ?? ''),
      dcId: String(raw?.dcId ?? ''),
      dcNo: String(raw?.dcNo ?? ''),
      clientId: String(raw?.clientId ?? ''),
      clientName: String(raw?.clientName ?? ''),
      invoiceIds: Array.isArray(raw?.invoiceIds) ? raw.invoiceIds.map((s: any) => String(s)) : [],
      invoiceNos: Array.isArray(raw?.invoiceNos) ? raw.invoiceNos.map((s: any) => String(s)) : [],
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }
}
