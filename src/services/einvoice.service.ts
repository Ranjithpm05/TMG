import { Injectable, inject } from '@angular/core';
import { Firestore, doc, updateDoc, serverTimestamp } from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { Invoice } from '../models/invoice.model';
import {
  CompanySettings,
  EInvoiceBuyerDtls,
  EInvoiceItem,
  EInvoicePartyDtls,
  EInvoicePayload,
  EInvoiceSupplyType,
} from '../models/einvoice.model';
import { CompanySettingsService } from './company-settings.service';
import { InvoiceService } from './invoice.service';

// Appendix-5 (E-Invoice sandbox doc) — Cancel Reasons numeric codes. The UI
// (CANCEL_REASONS in einvoice.model.ts) shows the labels; this maps a chosen
// label back to the code Webtel's CanIRN API expects.
const CANCEL_REASON_CODES: Record<string, string> = {
  'Duplicate': '1',
  'Data Entry Mistake': '2',
  'Order Cancelled': '3',
  'Others': '4',
};

export interface EInvoiceSubmitResult {
  irn: string;
  ackNo: string;
  ackDt: string;
  signedQrCode: string;
  signedInvoice: string;
}

@Injectable({ providedIn: 'root' })
export class EInvoiceService {
  private firestore = inject(Firestore);
  private functions = inject(Functions);
  private companySettingsService = inject(CompanySettingsService);
  private invoiceService = inject(InvoiceService);

  preparePayload(invoice: Invoice, company: CompanySettings): EInvoicePayload {
    const sellerStateCode = company.stateCode;
    const buyerStateCode = this.extractStateCodeFromGstin(invoice.clientGstin) || sellerStateCode;
    const isInterState = sellerStateCode !== buyerStateCode;
    const hasValidBuyerGstin = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(
      invoice.clientGstin?.toUpperCase() || ''
    );
    const supplyType: EInvoiceSupplyType = hasValidBuyerGstin ? 'B2B' : 'B2C';

    const sellerDtls: EInvoicePartyDtls = {
      Gstin: '29AAACW3775F000',//company.gstin,
      LglNm: company.legalName,
      ...(company.tradeName ? { TrdNm: company.tradeName } : {}),
      Addr1: company.address1,
      ...(company.address2 ? { Addr2: company.address2 } : {}),
      Loc: company.place,
      Pin: parseInt(company.pinCode) || 0,
      Stcd: company.stateCode,
      ...(company.phone ? { Ph: company.phone } : {}),
      ...(company.email ? { Em: company.email } : {}),
    };

    const buyerDtls: EInvoiceBuyerDtls = {
      Gstin: '29AAACW3775F000',//invoice.clientGstin?.toUpperCase() || 'URP',
      LglNm: invoice.clientName,
      Addr1: invoice.clientAddress || 'N/A',
      Loc: invoice.clientPlace || invoice.destination || 'N/A',
      Pin: parseInt(invoice.clientZipCode) || 0,
      Stcd: buyerStateCode,
      Pos: buyerStateCode,
      ...(invoice.clientPhone ? { Ph: invoice.clientPhone } : {}),
    };

    const itemList: EInvoiceItem[] = invoice.items.map((item, index) => {
      const assAmt = Math.round(item.amount * 100) / 100;
      const gstRate = item.taxRate;
      const igstAmt = isInterState ? Math.round(assAmt * (gstRate / 100) * 100) / 100 : 0;
      const cgstAmt = !isInterState ? Math.round(assAmt * (gstRate / 2 / 100) * 100) / 100 : 0;
      const sgstAmt = !isInterState ? Math.round(assAmt * (gstRate / 2 / 100) * 100) / 100 : 0;
      const totItemVal = Math.round((assAmt + igstAmt + cgstAmt + sgstAmt) * 100) / 100;
      const grossItemAmt = Math.round(item.price * item.quantity * 100) / 100;

      return {
        SlNo: String(index + 1),
        PrdDesc: item.description,
        IsServc: 'N',
        HsnCd: item.hsnSac,
        Qty: item.quantity,
        Unit: item.uom || 'NOS',
        UnitPrice: item.price,
        TotAmt: grossItemAmt,
        Discount: Math.round((grossItemAmt - assAmt) * 100) / 100,
        AssAmt: assAmt,
        GstRt: gstRate,
        IgstAmt: igstAmt,
        CgstAmt: cgstAmt,
        SgstAmt: sgstAmt,
        TotItemVal: totItemVal,
      };
    });

    return {
      Version: '1.1',
      TranDtls: {
        TaxSch: 'GST',
        SupTyp: supplyType,
        RegRev: 'N',
        IgstOnIntra: 'N',
      },
      DocDtls: {
        Typ: 'INV',
        No: invoice.invoiceNo,
        Dt: this.formatDateDDMMYYYY(invoice.invoiceDate),
      },
      SellerDtls: sellerDtls,
      BuyerDtls: buyerDtls,
      ItemList: itemList,
      ValDtls: {
        AssVal: Math.round(invoice.taxableValue * 100) / 100,
        CgstVal: Math.round(invoice.cgstAmount * 100) / 100,
        SgstVal: Math.round(invoice.sgstAmount * 100) / 100,
        IgstVal: Math.round(invoice.igstAmount * 100) / 100,
        Discount: Math.round(invoice.discountAmount * 100) / 100,
        RndOffAmt: Math.round(invoice.roundOff * 100) / 100,
        TotInvVal: Math.round(invoice.totalAmount * 100) / 100,
      },
    };
  }

  // Builds the IRP-shaped payload locally (preparePayload, above — unchanged
  // business logic) then calls the generateEInvoiceIrn Cloud Function, which
  // holds the Webtel CDKey/EF/EInv credentials server-side and forwards the
  // request to Webtel's GenIRN2 sandbox API. Throws with a user-facing
  // message on any failure (network, validation, duplicate IRN, etc.) —
  // callers should catch and, on failure, call saveEInvoiceFailure() so the
  // failed attempt is visible in the UI instead of silently reverting to
  // "pending".
  async submitToIRP(invoice: Invoice, company: CompanySettings): Promise<{ result: EInvoiceSubmitResult; payload: EInvoicePayload }> {
    if (!company?.gstin) {
      throw new Error('Company GSTIN not configured. Please set up company settings first.');
    }
    const payload = this.preparePayload(invoice, company);
    const callable = httpsCallable<{ gstin: string; payload: EInvoicePayload }, EInvoiceSubmitResult>(
      this.functions,
      'generateEInvoiceIrn'
    );
    try {
      const response = await callable({ gstin: company.gstin, payload });
      return { result: response.data, payload };
    } catch (err: any) {
      throw new Error(this.extractCallableErrorMessage(err));
    }
  }

  async saveEInvoice(invoiceId: string, result: EInvoiceSubmitResult, payload: EInvoicePayload): Promise<void> {
    const invoiceRef = doc(this.firestore, 'invoices', invoiceId);
    await updateDoc(invoiceRef, {
      eInvoiceStatus: 'generated',
      irn: result.irn,
      irnGeneratedAt: serverTimestamp(),
      ackNo: result.ackNo,
      ackDt: result.ackDt,
      signedQrCode: result.signedQrCode,
      signedInvoice: result.signedInvoice,
      eInvoicePayload: this.deepStripUndefined(payload),
      eInvoiceErrorMessage: null,
      eInvoiceErrorCode: null,
      updatedAt: serverTimestamp(),
    });
    this.invoiceService.invalidateCache();
  }

  // Persists a failed generation attempt so the E-Invoice list can show
  // "Failed" (with the reason) instead of silently staying "Pending" —
  // the user can retry, since eInvoiceStatus !== 'generated' still allows it.
  async saveEInvoiceFailure(invoiceId: string, message: string, code?: string): Promise<void> {
    const invoiceRef = doc(this.firestore, 'invoices', invoiceId);
    await updateDoc(invoiceRef, {
      eInvoiceStatus: 'failed',
      eInvoiceErrorMessage: message,
      eInvoiceErrorCode: code ?? null,
      updatedAt: serverTimestamp(),
    });
    this.invoiceService.invalidateCache();
  }

  getCancelReasonCode(label: string): string {
    return CANCEL_REASON_CODES[label] || '4';
  }

  // Calls Webtel's CanIRN sandbox API (via the cancelEInvoiceIrn Cloud
  // Function) then, only on success, marks the invoice cancelled locally —
  // keeps Firestore from ever showing "cancelled" for an IRN that Webtel
  // still considers active.
  async cancelEInvoiceRemote(invoice: Invoice, reason: string, gstin: string): Promise<void> {
    if (!invoice.irn) throw new Error('This invoice has no IRN to cancel.');
    const callable = httpsCallable<
      { irn: string; gstin: string; reasonCode: string; remark: string },
      { cancelDate: string }
    >(this.functions, 'cancelEInvoiceIrn');
    try {
      await callable({ irn: invoice.irn, gstin, reasonCode: this.getCancelReasonCode(reason), remark: reason });
    } catch (err: any) {
      throw new Error(this.extractCallableErrorMessage(err));
    }
    await this.cancelEInvoice(invoice.id!, reason);
  }

  async cancelEInvoice(invoiceId: string, reason: string): Promise<void> {
    const invoiceRef = doc(this.firestore, 'invoices', invoiceId);
    await updateDoc(invoiceRef, {
      eInvoiceStatus: 'cancelled',
      cancelReason: reason,
      cancelledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    this.invoiceService.invalidateCache();
  }

  private extractCallableErrorMessage(err: any): string {
    // Firebase callable errors surface the HttpsError message on `.message`
    // and any extra detail object on `.details` (errorCode/infoDtls here).
    const code = err?.details?.errorCode ? ` (code ${err.details.errorCode})` : '';
    return (err?.message || 'Request to the sandbox failed.') + code;
  }

  private deepStripUndefined(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.deepStripUndefined(item));
    }
    if (obj !== null && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, this.deepStripUndefined(v)])
      );
    }
    return obj;
  }

  formatDateDDMMYYYY(timestamp: any): string {
    let d: Date;
    if (timestamp?.toDate) d = timestamp.toDate();
    else if (timestamp?.seconds) d = new Date(timestamp.seconds * 1000);
    else if (timestamp instanceof Date) d = timestamp;
    else if (typeof timestamp === 'string' || typeof timestamp === 'number') d = new Date(timestamp);
    else d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  }

  private extractStateCodeFromGstin(gstin: string): string {
    if (!gstin || gstin.length < 2) return '';
    return gstin.substring(0, 2);
  }
}
