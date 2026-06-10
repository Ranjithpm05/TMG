import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  addDoc,
  collection,
  collectionData,
  doc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Invoice, InvoiceItem, InvoiceTaxSummary } from '../models/invoice.model';

@Injectable({ providedIn: 'root' })
export class InvoiceService {
  private firestore = inject(Firestore);
  private invoicesRef = collection(this.firestore, 'invoices');

  getInvoices(): Observable<Invoice[]> {
    const q = query(this.invoicesRef, orderBy('createdAt', 'desc'));
    return (collectionData(q, { idField: 'id' }) as Observable<any[]>).pipe(
      map((docs) => docs.map((d) => this.normalize(d)))
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
    const docRef = await addDoc(this.invoicesRef, data);
    return { id: docRef.id, ...data };
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
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt,
    };
  }
}
