import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from '@angular/fire/firestore';
import { from, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Invoice, InvoiceItem, InvoiceTaxSummary } from '../models/invoice.model';

@Injectable({ providedIn: 'root' })
export class InvoiceService {
  private firestore = inject(Firestore);
  private invoicesRef = collection(this.firestore, 'invoices');

  // One-time read: the e-Invoice and Packing List screens snapshot this into a
  // local list and reload manually after their own writes.
  getInvoices(pageLimit = 100): Observable<Invoice[]> {
    const q = query(this.invoicesRef, orderBy('createdAt', 'desc'), limit(pageLimit));
    return from(getDocs(q)).pipe(
      map((snap) => snap.docs.map((d) => this.normalize({ id: d.id, ...d.data() })))
    );
  }

  async getInvoicesByPackingListIdOnce(packingListId: string): Promise<Invoice[]> {
    const snap = await getDocs(query(this.invoicesRef, where('packingListId', '==', packingListId)));
    return snap.docs.map((d) => this.normalize({ id: d.id, ...d.data() }));
  }

  async createInvoice(
    input: Omit<Invoice, 'id' | 'invoiceNo' | 'invoiceSeq' | 'invoiceDate' | 'createdAt' | 'updatedAt'>
  ): Promise<Invoice> {
    const { invoiceNo, invoiceSeq } = await this.generateNextInvoiceNo();
    const data = {
      ...input,
      invoiceNo,
      invoiceSeq,
      invoiceDate: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const docRef = await addDoc(this.invoicesRef, this.stripUndefined(data));
    return { id: docRef.id, ...data };
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

  private async generateNextInvoiceNo(): Promise<{ invoiceNo: string; invoiceSeq: number }> {
    const counterRef = doc(this.firestore, 'counters/invoiceCounter');
    const fyCode = this.getFyCode();
    return runTransaction(this.firestore, async (transaction) => {
      const snap = await transaction.get(counterRef);
      const currentSeq = snap.exists() ? (Number(snap.data()?.['seq']) || 0) : 0;
      const nextSeq = currentSeq + 1;
      if (snap.exists()) {
        transaction.update(counterRef, { seq: nextSeq, updatedAt: serverTimestamp() });
      } else {
        transaction.set(counterRef, { seq: nextSeq, fy: fyCode, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }
      return { invoiceNo: 'TMGC' + fyCode + '-' + String(nextSeq).padStart(4, '0'), invoiceSeq: nextSeq };
    });
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
