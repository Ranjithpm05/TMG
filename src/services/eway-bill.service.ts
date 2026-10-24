import { Injectable, inject } from '@angular/core';
import { Firestore, doc, updateDoc, serverTimestamp } from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { EwayBillGenerateResult, EwayBillTransportDetails } from '../models/eway-bill.model';
import { Invoice } from '../models/invoice.model';
import { CompanySettings } from '../models/einvoice.model';
import { Transport } from '../models/transport.model';
import { InvoiceService } from './invoice.service';
import { ClientService } from './client.service';
import { retryAsync } from './einvoice-ewb.engine';

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
  private clientService = inject(ClientService);

  // Pre-filled E-Way Bill transport form for an invoice — shared by the E-Way
  // Bill screen and the combined E-Invoice & E-Way Bill flow. Destination
  // comes from the live Client Master record — read directly because
  // syncClientFromMaster() is skipped once an IRN exists. The transporter is
  // matched from Transport Master — first by the exact record the invoice/DC
  // already used (transportId), falling back to a name match.
  async buildDefaultTransportDetails(
    invoice: Invoice | null,
    transports: Transport[]
  ): Promise<{ form: EwayBillTransportDetails; transportId: string }> {
    const client = invoice?.clientId
      ? await this.clientService.getClientForDC(invoice.clientId, invoice.clientName).catch(() => null)
      : null;
    const destination = client?.destination?.trim()
      || invoice?.clientShipToPlace || invoice?.clientPlace || invoice?.destination || '';
    const matched = this.findTransportForInvoice(invoice, transports);
    return {
      transportId: matched?.id || '',
      form: {
        distance: 0,
        transMode: '1',
        transporterId: matched?.gstNo || '',
        transporterName: matched?.transportName || '',
        vehicleNo: '',
        vehicleType: 'R',
        // No transport document reference is sent — the DC No. is no longer
        // used as the Transport Doc No. (not needed on the E-Way Bill).
        transDocNo: '',
        transDocDt: '',
        destination,
      },
    };
  }

  private findTransportForInvoice(invoice: Invoice | null, list: Transport[]): Transport | undefined {
    if (!invoice) return undefined;
    if (invoice.transportId) {
      const byId = list.find((t) => t.id === invoice.transportId);
      if (byId) return byId;
    }
    return invoice.transport ? list.find((t) => t.transportName === invoice.transport) : undefined;
  }

  // Generates the E-Way Bill for an invoice using its ship-to (buyer) and
  // ship-from (company) addresses, and resolves with the invoice as it now
  // stands (ewbStatus 'generated').
  async generateForInvoice(invoice: Invoice, details: EwayBillTransportDetails, settings: CompanySettings): Promise<Invoice> {
    const form = { ...details, destination: details.destination?.trim() || '' };
    const stateCode = this.extractStateCodeFromGstin(invoice.clientGstin) || settings.stateCode;
    const result = await this.generateEWayBill(
      invoice,
      form,
      settings.gstin,
      {
        addr1: invoice.clientShipToAddress || invoice.clientAddress,
        loc: form.destination || invoice.clientShipToPlace || invoice.clientPlace || invoice.destination,
        pin: parseInt(invoice.clientShipToZipCode || invoice.clientZipCode) || undefined,
        stcd: stateCode,
      },
      {
        addr1: settings.address1,
        addr2: settings.address2,
        loc: settings.place,
        pin: parseInt(settings.pinCode) || undefined,
        stcd: settings.stateCode,
      }
    );
    return {
      ...invoice,
      ewbStatus: 'generated',
      ewbNo: result.ewbNo,
      ewbDate: result.ewbDate,
      ewbValidTill: result.ewbValidTill,
      ewbGstin: result.gstin,
      ewbTransportDetails: form,
      ewbErrorMessage: undefined,
      ewbErrorCode: undefined,
    };
  }

  private extractStateCodeFromGstin(gstin: string): string {
    if (!gstin || gstin.length < 2) return '';
    return gstin.substring(0, 2);
  }

  // Generates an E-Way Bill from an already-registered e-Invoice's IRN via
  // the generateEwayBillByIrn Cloud Function (Webtel E-Way Bill sandbox —
  // credentials stay server-side, same reasoning as EInvoiceService). Guards
  // against calling this before the e-Invoice exists and against generating
  // a second E-Way Bill for the same invoice.
  async generateEWayBill(invoice: Invoice, input: EwayBillTransportDetails, gstin: string, shipTo?: EwayBillShipTo, shipFrom?: EwayBillShipTo): Promise<EwayBillGenerateResult> {
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
        shipFrom?: EwayBillShipTo;
        shipTo?: EwayBillShipTo;
      },
      EwayBillGenerateResult
    >(this.functions, 'generateEwayBillByIrn');

    let result: EwayBillGenerateResult;
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
        shipFrom,
        shipTo,
      });
      result = response.data;
    } catch (err: any) {
      const message = this.extractCallableErrorMessage(err);
      // The failure record is best-effort — surface the original error regardless.
      await this.saveEWayBillFailure(invoice.id!, message, err?.details?.errorCode).catch(() => undefined);
      throw new Error(message);
    }

    // The E-Way Bill now exists on the portal — a Firestore hiccup must not
    // record it as 'failed' (a retry would only be rejected as a duplicate).
    try {
      await retryAsync(() => this.saveEWayBill(invoice.id!, result, input));
    } catch {
      throw new Error(
        `E-Way Bill ${result.ewbNo} was generated on the portal but could not be saved to this invoice. ` +
        `Do NOT generate it again — note this E-Way Bill No. and contact support so it can be recorded.`
      );
    }
    return result;
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
      ewbGstin: result.gstin,
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
