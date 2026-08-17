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

@Injectable({ providedIn: 'root' })
export class InvoiceService {
  private firestore = inject(Firestore);
  private deliveryChallanService = inject(DeliveryChallanService);
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

  // Chunked (Firestore 'in' caps at 30 values) lookup of every invoice
  // already generated for a set of DCs — lets callers figure out which of a
  // Packing List's (possibly several, one per Sales Order) DCs still need an
  // invoice without a full collection scan.
  async getInvoicesByDCIdsOnce(dcIds: string[]): Promise<Invoice[]> {
    const uniqueIds = [...new Set(dcIds.filter(Boolean))];
    if (!uniqueIds.length) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += 30) chunks.push(uniqueIds.slice(i, i + 30));
    const results = await Promise.all(
      chunks.map((chunk) => getDocs(query(this.invoicesRef, where('dcId', 'in', chunk))))
    );
    return results.flatMap((snap) => snap.docs.map((d) => this.normalize({ id: d.id, ...d.data() })));
  }

  // Atomically enforces "at most one Invoice per Delivery Challan" — a
  // Packing List can now produce several DCs (one per Sales Order), each of
  // which is invoiced independently so the Invoice always mirrors exactly
  // one DC's items. A transaction reads the DC's `invoiceId` and aborts if
  // already set, closing the double-click/two-tab race that a plain
  // pre-check can't. Throws 'already_has_invoice' unless
  // `options.allowDuplicate` is set (an explicit, user-confirmed "Generate
  // New Invoice" override).
  async createInvoice(
    input: Omit<Invoice, 'id' | 'invoiceNo' | 'invoiceSeq' | 'invoiceDate' | 'createdAt' | 'updatedAt'> & { dcId: string },
    options?: { allowDuplicate?: boolean },
  ): Promise<Invoice> {
    const dcRef = doc(this.firestore, `deliveryChallans/${input.dcId}`);
    const counterRef = doc(this.firestore, 'counters/invoiceCounter');
    const invoiceDocRef = doc(this.invoicesRef);
    const fyCode = this.getFyCode();

    const data = await runTransaction(this.firestore, async (transaction) => {
      const dcSnap = await transaction.get(dcRef);
      if (!dcSnap.exists()) throw new Error('dc_not_found');
      if (dcSnap.data()?.['invoiceId'] && !options?.allowDuplicate) throw new Error('already_has_invoice');

      const counterSnap = await transaction.get(counterRef);
      const currentSeq = counterSnap.exists() ? (Number(counterSnap.data()?.['seq']) || 0) : 0;
      const nextSeq = currentSeq + 1;

      const invoiceNo = 'TMGC' + fyCode + '-' + String(nextSeq).padStart(4, '0');
      const invoiceData = {
        ...input,
        invoiceNo,
        invoiceSeq: nextSeq,
        invoiceDate: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      transaction.set(invoiceDocRef, this.stripUndefined(invoiceData));
      transaction.update(dcRef, { invoiceId: invoiceDocRef.id, invoiceNo, updatedAt: serverTimestamp() });
      if (counterSnap.exists()) {
        transaction.update(counterRef, { seq: nextSeq, updatedAt: serverTimestamp() });
      } else {
        transaction.set(counterRef, { seq: nextSeq, fy: fyCode, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }

      return invoiceData;
    });

    this.invalidateCache();
    // This transaction also stamped invoiceId/invoiceNo onto the source DC doc —
    // invalidate its cached list too so a subsequent Packing List/e-Invoice
    // screen visit doesn't show the DC as still not-yet-invoiced.
    this.deliveryChallanService.invalidateCache();
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

  private getFyCode(): string {
    const d = new Date();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    const fyStart = month >= 4 ? year : year - 1;
    const fyEnd = fyStart + 1;
    return String(fyStart).slice(2) + String(fyEnd).slice(2);
  }

  private stripUndefined(obj: Record<string, any>): Record<string, any> {
    return Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== undefined)
    );
  }

  private normalize(raw: any): Invoice {
    return {
      id: raw?.id,
      invoiceNo: String(raw?.invoiceNo ?? ''),
      invoiceSeq: Number(raw?.invoiceSeq) || 0,
      invoiceDate: raw?.invoiceDate,
      dcNo: String(raw?.dcNo ?? ''),
      dcId: raw?.dcId ? String(raw.dcId) : undefined,
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
      eInvoicePayload: raw?.eInvoicePayload || undefined,
      cancelReason: raw?.cancelReason ? String(raw.cancelReason) : undefined,
      cancelledAt: raw?.cancelledAt,
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }
}
