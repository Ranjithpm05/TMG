import { Injectable, inject } from '@angular/core';
import { Firestore, doc, updateDoc, serverTimestamp } from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { EwayBillGenerateResult, EwayBillTransportDetails } from '../models/eway-bill.model';
import { Invoice } from '../models/invoice.model';
import { InvoiceService } from './invoice.service';

export interface EwayBillShipTo {
  addr1?: string;
  addr2?: string;
  loc?: string;
  pin?: number;
  stcd?: string;
}

@Injectable({ providedIn: 'root' })
export class EwayBillService {
  private firestore = inject(Firestore);
  private functions = inject(Functions);
  private invoiceService = inject(InvoiceService);

  // Generates an E-Way Bill from an already-registered e-Invoice's IRN via
  // the generateEwayBillByIrn Cloud Function (Webtel E-Way Bill sandbox —
  // credentials stay server-side, same reasoning as EInvoiceService). Guards
  // against calling this before the e-Invoice exists and against generating
  // a second E-Way Bill for the same invoice.
  async generateEWayBill(invoice: Invoice, input: EwayBillTransportDetails, gstin: string, shipTo?: EwayBillShipTo): Promise<EwayBillGenerateResult> {
    if (invoice.eInvoiceStatus !== 'generated' || !invoice.irn) {
      throw new Error('This invoice does not have a generated E-Invoice (IRN) yet.');
    }
    if (invoice.ewbStatus === 'generated') {
      throw new Error('An E-Way Bill has already been generated for this invoice.');
    }

    const callable = httpsCallable<
      {
        irn: string;
        gstin: string;
        distance: number;
        transMode: string;
        transporterId?: string;
        transporterName?: string;
        vehicleNo?: string;
        vehicleType?: string;
        transDocNo?: string;
        transDocDt?: string;
        shipTo?: EwayBillShipTo;
      },
      EwayBillGenerateResult
    >(this.functions, 'generateEwayBillByIrn');

    try {
      const response = await callable({
        irn: invoice.irn,
        gstin,
        distance: input.distance,
        transMode: input.transMode,
        transporterId: input.transporterId,
        transporterName: input.transporterName,
        vehicleNo: input.vehicleNo,
        vehicleType: input.vehicleType,
        transDocNo: input.transDocNo,
        transDocDt: input.transDocDt,
        shipTo,
      });
      const result = response.data;
      await this.saveEWayBill(invoice.id!, result, input);
      return result;
    } catch (err: any) {
      const message = this.extractCallableErrorMessage(err);
      await this.saveEWayBillFailure(invoice.id!, message, err?.details?.errorCode);
      throw new Error(message);
    }
  }

  async cancelEWayBill(invoice: Invoice, reasonCode: string, reasonLabel: string, remark: string, gstin: string): Promise<void> {
    if (!invoice.ewbNo) throw new Error('This invoice has no E-Way Bill number to cancel.');

    const invoiceDate = this.toDate(invoice.invoiceDate) || new Date();
    const callable = httpsCallable<
      { gstin: string; ewbNumber: string; cancelReasonCode: string; cancelRemark: string; year: number; month: number },
      { cancelDate: string }
    >(this.functions, 'cancelEwayBill');

    try {
      await callable({
        gstin,
        ewbNumber: invoice.ewbNo,
        cancelReasonCode: reasonCode,
        cancelRemark: remark || reasonLabel,
        year: invoiceDate.getFullYear(),
        month: invoiceDate.getMonth() + 1,
      });
    } catch (err: any) {
      throw new Error(this.extractCallableErrorMessage(err));
    }

    const invoiceRef = doc(this.firestore, 'invoices', invoice.id!);
    await updateDoc(invoiceRef, {
      ewbStatus: 'cancelled',
      ewbCancelReason: reasonLabel,
      ewbCancelledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    this.invoiceService.invalidateCache();
  }

  private async saveEWayBill(invoiceId: string, result: EwayBillGenerateResult, input: EwayBillTransportDetails): Promise<void> {
    const invoiceRef = doc(this.firestore, 'invoices', invoiceId);
    await updateDoc(invoiceRef, {
      ewbStatus: 'generated',
      ewbNo: result.ewbNo,
      ewbGeneratedAt: serverTimestamp(),
      ewbDate: result.ewbDate,
      ewbValidTill: result.ewbValidTill,
      ewbTransportDetails: this.stripUndefined(input),
      ewbErrorMessage: null,
      ewbErrorCode: null,
      updatedAt: serverTimestamp(),
    });
    this.invoiceService.invalidateCache();
  }

  private async saveEWayBillFailure(invoiceId: string, message: string, code?: string): Promise<void> {
    const invoiceRef = doc(this.firestore, 'invoices', invoiceId);
    await updateDoc(invoiceRef, {
      ewbStatus: 'failed',
      ewbErrorMessage: message,
      ewbErrorCode: code ?? null,
      updatedAt: serverTimestamp(),
    });
    this.invoiceService.invalidateCache();
  }

  private extractCallableErrorMessage(err: any): string {
    const code = err?.details?.errorCode ? ` (code ${err.details.errorCode})` : '';
    return (err?.message || 'Request to the sandbox failed.') + code;
  }

  private stripUndefined<T extends Record<string, any>>(obj: T): T {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
  }

  private toDate(timestamp: any): Date | null {
    if (!timestamp) return null;
    if (timestamp?.toDate) return timestamp.toDate();
    if (timestamp?.seconds) return new Date(timestamp.seconds * 1000);
    if (timestamp instanceof Date) return timestamp;
    return new Date(timestamp);
  }
}
