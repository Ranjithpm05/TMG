import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from '@angular/fire/firestore';
import { from, Observable, shareReplay } from 'rxjs';
import { Invoice, InvoiceItem, InvoiceTaxSummary } from '../models/invoice.model';
import { fetchAllDocs } from './firestore-pagination.util';
import { DeliveryChallanService } from './delivery-challan.service';
import { PackingListService } from './packing-list.service';

@Injectable({ providedIn: 'root' })
export class InvoiceService {
  private firestore = inject(Firestore);
  private deliveryChallanService = inject(DeliveryChallanService);
  private packingListService = inject(PackingListService);
  private invoicesRef = collection(this.firestore, 'invoices');

  // Read repeatedly (e-Invoice and Packing List screens, every generation
  // refresh) — cached one-time read, invalidated by createInvoice/updateInvoice
  // below, same pattern as ClientService/DesignService/InventoryService.
  private invoicesCache$: Observable<Invoice[]> | null = null;

  // Public: EInvoiceService.saveEInvoice()/cancelEInvoice() write eInvoiceStatus/
  // irn/etc. directly onto an invoices/{id} doc without going through this
  // service, and must invalidate this cache too.
  invalidateCache(): void {
    this.invoicesCache$ = null;
  }

  // One-time read, paged through in full via fetchAllDocs() — a prior fixed
  // limit(100) here silently truncated the list once invoices passed that
  // count. The e-Invoice and Packing List screens snapshot this into a local
  // list and reload manually after their own writes.
  getInvoices(): Observable<Invoice[]> {
    if (!this.invoicesCache$) {
      this.invoicesCache$ = from(
        fetchAllDocs(this.invoicesRef, [orderBy('createdAt', 'desc')], (d) => this.normalize({ id: d.id, ...d.data() }))
      ).pipe(shareReplay(1));
    }
    return this.invoicesCache$;
  }

  async getInvoicesByPackingListIdOnce(packingListId: string): Promise<Invoice[]> {
    const snap = await getDocs(query(this.invoicesRef, where('packingListId', '==', packingListId)));
    return snap.docs.map((d) => this.normalize({ id: d.id, ...d.data() }));
  }

  // Chunked (Firestore 'in'/'array-contains-any' cap at 30 values) lookup of
  // every invoice touching a set of DCs — used by reports to join a DC row to
  // its invoice. Queries both the legacy singular `dcId` field and the
  // `dcIds` array (a consolidated invoice covering several legacy per-SO DCs
  // only matches the latter) and dedupes the results.
  async getInvoicesByDCIdsOnce(dcIds: string[]): Promise<Invoice[]> {
    const uniqueIds = [...new Set(dcIds.filter(Boolean))];
    if (!uniqueIds.length) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += 30) chunks.push(uniqueIds.slice(i, i + 30));
    const results = await Promise.all(
      chunks.flatMap((chunk) => [
        getDocs(query(this.invoicesRef, where('dcId', 'in', chunk))),
        getDocs(query(this.invoicesRef, where('dcIds', 'array-contains-any', chunk))),
      ])
    );
    const byId = new Map<string, Invoice>();
    for (const snap of results) {
      for (const d of snap.docs) {
        const inv = this.normalize({ id: d.id, ...d.data() });
        byId.set(inv.id!, inv);
      }
    }
    return [...byId.values()];
  }

  // Atomically enforces "at most one Invoice per Packing List" (and, by
  // extension, per DC — a Packing List produces at most one DC going
  // forward; see DeliveryChallanService.createDC). The gate lives on the
  // Packing List doc's `invoiceId` field rather than on the DC(s), because a
  // Packing List created before that DC fix can still carry several legacy
  // per-Sales-Order DC docs — gating per-DC let each of those slip through
  // and spawn its own Invoice. A transaction reads the Packing List's
  // `invoiceId` and aborts if already set, closing the double-click/two-tab
  // race a plain pre-check can't. Throws 'already_has_invoice' unless
  // `options.allowDuplicate` is set (an explicit, user-confirmed "Generate
  // New Invoice" override). `input.dcIds` lists every DC (usually just one)
  // being consolidated into this single Invoice; each gets invoiceId/invoiceNo
  // stamped back so DC-keyed lookups (reports, e-Invoice) still resolve it.
  async createInvoice(
    input: Omit<Invoice, 'id' | 'invoiceNo' | 'invoiceSeq' | 'invoiceDate' | 'createdAt' | 'updatedAt'> & { dcIds: string[] },
    options?: { allowDuplicate?: boolean },
  ): Promise<Invoice> {
    if (!input.dcIds.length) throw new Error('dc_not_found');
    const packingListRef = doc(this.firestore, `packingLists/${input.packingListId}`);
    const dcRefs = input.dcIds.map((id) => doc(this.firestore, `deliveryChallans/${id}`));
    const counterRef = doc(this.firestore, 'counters/invoiceCounter');
    const invoiceDocRef = doc(this.invoicesRef);
    const fyCode = this.getFyCode();

    const data = await runTransaction(this.firestore, async (transaction) => {
      const packingSnap = await transaction.get(packingListRef);
      if (!packingSnap.exists()) throw new Error('packinglist_not_found');
      if (packingSnap.data()?.['invoiceId'] && !options?.allowDuplicate) throw new Error('already_has_invoice');

      const dcSnaps = await Promise.all(dcRefs.map((ref) => transaction.get(ref)));
      if (dcSnaps.some((snap) => !snap.exists())) throw new Error('dc_not_found');

      const counterSnap = await transaction.get(counterRef);
      const currentSeq = counterSnap.exists() ? (Number(counterSnap.data()?.['seq']) || 0) : 0;
      const nextSeq = currentSeq + 1;

      const invoiceNo = 'TMGC' + fyCode + '-' + String(nextSeq).padStart(4, '0');
      const invoiceData = {
        ...input,
        dcId: input.dcId ?? input.dcIds[0],
        invoiceNo,
        invoiceSeq: nextSeq,
        invoiceDate: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      transaction.set(invoiceDocRef, this.stripUndefined(invoiceData));
      transaction.update(packingListRef, { invoiceId: invoiceDocRef.id, updatedAt: serverTimestamp() });
      for (const dcRef of dcRefs) {
        transaction.update(dcRef, { invoiceId: invoiceDocRef.id, invoiceNo, updatedAt: serverTimestamp() });
      }
      if (counterSnap.exists()) {
        transaction.update(counterRef, { seq: nextSeq, updatedAt: serverTimestamp() });
      } else {
        transaction.set(counterRef, { seq: nextSeq, fy: fyCode, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }

      return invoiceData;
    });

    this.invalidateCache();
    // This transaction also stamped invoiceId/invoiceNo onto the source DC
    // doc(s) and the Packing List doc — invalidate both caches too so a
    // subsequent Packing List/e-Invoice screen visit doesn't show them as
    // still not-yet-invoiced.
    this.deliveryChallanService.invalidateCache();
    this.packingListService.invalidateCache();
    return { id: invoiceDocRef.id, ...data };
  }

  async getInvoiceByIdOnce(invoiceId: string): Promise<Invoice | null> {
    const snap = await getDoc(doc(this.firestore, 'invoices', invoiceId));
    if (!snap.exists()) return null;
    return this.normalize({ id: snap.id, ...snap.data() });
  }

  async updateInvoice(invoiceId: string, updates: Partial<Invoice>): Promise<void> {
    const invoiceRef = doc(this.firestore, 'invoices', invoiceId);
    await updateDoc(invoiceRef, this.stripUndefined({ ...updates, updatedAt: serverTimestamp() }));
    this.invalidateCache();
  }

  // Invoices created before styleNo/sleeveType were added to InvoiceItem
  // (see project memory, added 2026-08-28) have items missing those fields
  // even though the source DC always had them — the DC print already shows
  // Design/Sleeve correctly, only the Invoice print didn't. Re-derives them
  // from the invoice's source DC(s) by position: invoice.items was built via
  // `dcsToInvoice.flatMap((dc) => dc.items.map(...))` in invoice.dcIds order
  // (see PackingListComponent.createInvoiceForPackingList), so the same
  // flatten-in-dcIds-order lines back up 1:1 with invoice.items as long as
  // the item count hasn't changed since creation. Bails out (returns the
  // invoice unchanged) rather than guess if the counts don't match, or if
  // nothing is actually missing. Persists the fix so this only ever runs
  // once per invoice, not on every print.
  async backfillItemDesignInfoIfNeeded(invoice: Invoice): Promise<Invoice> {
    if (!invoice.id) return invoice;
    const needsBackfill = invoice.items.some((item) => !item.styleNo && !item.sleeveType);
    if (!needsBackfill) return invoice;

    const dcIds = invoice.dcIds.length ? invoice.dcIds : (invoice.dcId ? [invoice.dcId] : []);
    if (!dcIds.length) return invoice;

    const dcs = await this.deliveryChallanService.getDCsByIdsOnce(dcIds);
    const dcById = new Map(dcs.map((dc) => [dc.id, dc]));
    const orderedDcItems = dcIds.flatMap((id) => dcById.get(id)?.items ?? []);
    if (orderedDcItems.length !== invoice.items.length) return invoice;

    let changed = false;
    const items = invoice.items.map((item, i) => {
      if (item.styleNo && item.sleeveType) return item;
      const src = orderedDcItems[i];
      if (!src || (!src.styleNo && !src.sleeveType)) return item;
      changed = true;
      return { ...item, styleNo: item.styleNo || src.styleNo || undefined, sleeveType: item.sleeveType || src.sleeveType };
    });
    if (!changed) return invoice;

    await this.updateInvoice(invoice.id, { items });
    return { ...invoice, items };
  }

  private getFyCode(): string {
    const d = new Date();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    const fyStart = month >= 4 ? year : year - 1;
    const fyEnd = fyStart + 1;
    return String(fyStart).slice(2) + String(fyEnd).slice(2);
  }

  // Deep — a shallow (top-level-only) filter isn't enough once Invoice.items
  // (or any nested array of objects) can carry an optional field like
  // styleNo/sleeveType left `undefined`: Firestore's SDK only auto-strips
  // undefined at the top level of the object passed to updateDoc/set, not
  // inside nested arrays/objects, so an `undefined` buried in items[] throws
  // "Unsupported field value: undefined" instead of just being omitted (hit
  // by backfillItemDesignInfoIfNeeded above). Leaves non-plain-object values
  // (Date, serverTimestamp()'s FieldValue sentinel, etc.) untouched — only
  // recurses into plain object literals and arrays, same pattern as
  // DeliveryChallanService.stripUndefined.
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

  private normalize(raw: any): Invoice {
    return {
      id: raw?.id,
      invoiceNo: String(raw?.invoiceNo ?? ''),
      invoiceSeq: Number(raw?.invoiceSeq) || 0,
      invoiceDate: raw?.invoiceDate,
      dcNo: String(raw?.dcNo ?? ''),
      dcId: raw?.dcId ? String(raw.dcId) : undefined,
      dcIds: Array.isArray(raw?.dcIds) && raw.dcIds.length
        ? raw.dcIds.map((s: any) => String(s))
        : (raw?.dcId ? [String(raw.dcId)] : []),
      packingListId: String(raw?.packingListId ?? ''),
      packingListNo: String(raw?.packingListNo ?? ''),
      salesOrderIds: Array.isArray(raw?.salesOrderIds) ? raw.salesOrderIds.map(String) : [],
      salesNos: Array.isArray(raw?.salesNos) ? raw.salesNos.map(String) : [],
      orderNo: String(raw?.orderNo ?? ''),
      clientId: String(raw?.clientId ?? ''),
      clientName: String(raw?.clientName ?? ''),
      clientAddress: String(raw?.clientAddress ?? ''),
      clientPlace: String(raw?.clientPlace ?? ''),
      clientState: String(raw?.clientState ?? ''),
      clientZipCode: String(raw?.clientZipCode ?? ''),
      clientPhone: String(raw?.clientPhone ?? ''),
      clientGstin: String(raw?.clientGstin ?? ''),
      destination: String(raw?.destination ?? ''),
      transport: String(raw?.transport ?? ''),
      transportId: raw?.transportId ? String(raw.transportId) : undefined,
      transportAddress: raw?.transportAddress ? String(raw.transportAddress) : undefined,
      transportGstNo: raw?.transportGstNo ? String(raw.transportGstNo) : undefined,
      vehicleNo: String(raw?.vehicleNo ?? ''),
      docNo: String(raw?.docNo ?? ''),
      shipmentDate: raw?.shipmentDate,
      totalPkgs: Number(raw?.totalPkgs) || 0,
      agentName: String(raw?.agentName ?? ''),
      items: Array.isArray(raw?.items)
        ? raw.items.map((item: any): InvoiceItem => ({
            description: String(item?.description ?? ''),
            styleNo: item?.styleNo ? String(item.styleNo) : undefined,
            sleeveType: item?.sleeveType ? String(item.sleeveType) : undefined,
            hsnSac: String(item?.hsnSac ?? ''),
            discountPct: Number(item?.discountPct) || 0,
            taxRate: Number(item?.taxRate) || 0,
            mrp: Number(item?.mrp) || 0,
            uom: String(item?.uom ?? 'NOS'),
            quantity: Number(item?.quantity) || 0,
            price: Number(item?.price) || 0,
            amount: Number(item?.amount) || 0,
          }))
        : [],
      grossAmount: Number(raw?.grossAmount) || 0,
      discountPct: Number(raw?.discountPct) || 0,
      discountAmount: Number(raw?.discountAmount) || 0,
      taxableValue: Number(raw?.taxableValue) || 0,
      cgstRate: Number(raw?.cgstRate) || 0,
      cgstAmount: Number(raw?.cgstAmount) || 0,
      sgstRate: Number(raw?.sgstRate) || 0,
      sgstAmount: Number(raw?.sgstAmount) || 0,
      igstRate: Number(raw?.igstRate) || 0,
      igstAmount: Number(raw?.igstAmount) || 0,
      totalTaxAmount: Number(raw?.totalTaxAmount) || 0,
      roundOff: Number(raw?.roundOff) || 0,
      totalAmount: Number(raw?.totalAmount) || 0,
      amountInWords: String(raw?.amountInWords ?? ''),
      taxSummary: Array.isArray(raw?.taxSummary)
        ? raw.taxSummary.map((t: any): InvoiceTaxSummary => ({
            hsnSac: String(t?.hsnSac ?? ''),
            taxableValue: Number(t?.taxableValue) || 0,
            cgstRate: Number(t?.cgstRate) || 0,
            cgstAmount: Number(t?.cgstAmount) || 0,
            sgstRate: Number(t?.sgstRate) || 0,
            sgstAmount: Number(t?.sgstAmount) || 0,
            igstRate: Number(t?.igstRate) || 0,
            igstAmount: Number(t?.igstAmount) || 0,
          }))
        : [],
      eInvoiceStatus: raw?.eInvoiceStatus || undefined,
      irn: raw?.irn ? String(raw.irn) : undefined,
      irnGeneratedAt: raw?.irnGeneratedAt,
      ackNo: raw?.ackNo ? String(raw.ackNo) : undefined,
      ackDt: raw?.ackDt ? String(raw.ackDt) : undefined,
      signedQrCode: raw?.signedQrCode ? String(raw.signedQrCode) : undefined,
      signedInvoice: raw?.signedInvoice ? String(raw.signedInvoice) : undefined,
      eInvoicePayload: raw?.eInvoicePayload || undefined,
      eInvoiceErrorMessage: raw?.eInvoiceErrorMessage ? String(raw.eInvoiceErrorMessage) : undefined,
      eInvoiceErrorCode: raw?.eInvoiceErrorCode ? String(raw.eInvoiceErrorCode) : undefined,
      cancelReason: raw?.cancelReason ? String(raw.cancelReason) : undefined,
      cancelledAt: raw?.cancelledAt,
      ewbStatus: raw?.ewbStatus || undefined,
      ewbNo: raw?.ewbNo ? String(raw.ewbNo) : undefined,
      ewbGeneratedAt: raw?.ewbGeneratedAt,
      ewbDate: raw?.ewbDate ? String(raw.ewbDate) : undefined,
      ewbValidTill: raw?.ewbValidTill ? String(raw.ewbValidTill) : undefined,
      ewbTransportDetails: raw?.ewbTransportDetails || undefined,
      ewbErrorMessage: raw?.ewbErrorMessage ? String(raw.ewbErrorMessage) : undefined,
      ewbErrorCode: raw?.ewbErrorCode ? String(raw.ewbErrorCode) : undefined,
      ewbCancelReason: raw?.ewbCancelReason ? String(raw.ewbCancelReason) : undefined,
      ewbCancelledAt: raw?.ewbCancelledAt,
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }
}
