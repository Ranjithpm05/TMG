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
import { from, Observable } from 'rxjs';
import { Invoice, InvoiceItem, InvoiceTaxSummary } from '../models/invoice.model';
import { fetchAllDocs } from './firestore-pagination.util';

@Injectable({ providedIn: 'root' })
export class InvoiceService {
  private firestore = inject(Firestore);
  private invoicesRef = collection(this.firestore, 'invoices');

  // One-time read, paged through in full via fetchAllDocs() — a prior fixed
  // limit(100) here silently truncated the list once invoices passed that
  // count. The e-Invoice and Packing List screens snapshot this into a local
  // list and reload manually after their own writes.
  getInvoices(): Observable<Invoice[]> {
    return from(
      fetchAllDocs(this.invoicesRef, [orderBy('createdAt', 'desc')], (d) => this.normalize({ id: d.id, ...d.data() }))
    );
  }

  async getInvoicesByPackingListIdOnce(packingListId: string): Promise<Invoice[]> {
    const snap = await getDocs(query(this.invoicesRef, where('packingListId', '==', packingListId)));
    return snap.docs.map((d) => this.normalize({ id: d.id, ...d.data() }));
  }

  // Atomically enforces "at most one Invoice per Packing List" the same way
  // DeliveryChallanService.createDC() enforces at most one DC per (Packing
  // List, Sales Order) — a transaction reads the packing list's `invoiceId`
  // and aborts if already set, closing the double-click/two-tab race that a
  // plain pre-check can't. Throws 'already_has_invoice' unless
  // `options.allowDuplicate` is set (an explicit, user-confirmed "Generate
  // New Invoice" override).
  async createInvoice(
    input: Omit<Invoice, 'id' | 'invoiceNo' | 'invoiceSeq' | 'invoiceDate' | 'createdAt' | 'updatedAt'>,
    options?: { allowDuplicate?: boolean },
  ): Promise<Invoice> {
    const packingListRef = doc(this.firestore, `packingLists/${input.packingListId}`);
    const counterRef = doc(this.firestore, 'counters/invoiceCounter');
    const invoiceDocRef = doc(this.invoicesRef);
    const fyCode = this.getFyCode();

    const data = await runTransaction(this.firestore, async (transaction) => {
      const packingSnap = await transaction.get(packingListRef);
      if (!packingSnap.exists()) throw new Error('packinglist_not_found');
      if (packingSnap.data()?.['invoiceId'] && !options?.allowDuplicate) throw new Error('already_has_invoice');

      const counterSnap = await transaction.get(counterRef);
      const currentSeq = counterSnap.exists() ? (Number(counterSnap.data()?.['seq']) || 0) : 0;
      const nextSeq = currentSeq + 1;

      const invoiceData = {
        ...input,
        invoiceNo: 'TMGC' + fyCode + '-' + String(nextSeq).padStart(4, '0'),
        invoiceSeq: nextSeq,
        invoiceDate: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      transaction.set(invoiceDocRef, this.stripUndefined(invoiceData));
      transaction.update(packingListRef, { invoiceId: invoiceDocRef.id, updatedAt: serverTimestamp() });
      if (counterSnap.exists()) {
        transaction.update(counterRef, { seq: nextSeq, updatedAt: serverTimestamp() });
      } else {
        transaction.set(counterRef, { seq: nextSeq, fy: fyCode, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }

      return invoiceData;
    });

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
