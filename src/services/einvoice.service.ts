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
  EInvoiceShipDtls,
  EInvoiceSupplyType,
} from '../models/einvoice.model';
import { CompanySettingsService } from './company-settings.service';
import { InvoiceService } from './invoice.service';
import { ClientService } from './client.service';
import { resolveGstPlaceOfSupply, stateCodeFromName } from './gst-state.util';

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
  private clientService = inject(ClientService);

  // Builds the IRP-shaped payload from the invoice's own data plus the
  // client's Ship To Address (fetched here, not embedded on Invoice — see
  // Client.shipToAddress) so BuyerDtls (Bill To) and ShipDtls (Ship To) can
  // legitimately differ, as GST rules allow.
  async preparePayload(invoice: Invoice, company: CompanySettings): Promise<EInvoicePayload> {
    const sellerStateCode = company.stateCode;
    // For a B2C/URP buyer (no valid GSTIN), there is no GSTIN prefix to read
    // the state from — fall back to the buyer's actual Bill To state name
    // (Client.state, via invoice.clientState) before ever assuming "same as
    // seller". Defaulting straight to the seller's state made every B2C
    // invoice register as intra-state regardless of where the buyer actually
    // is, so CGST+SGST got charged instead of IGST for real inter-state B2C
    // sales — GST rules never permit charging both splits on one invoice, so
    // the fix is getting isInterState right, not summing them after the fact.
    const hasValidBuyerGstin = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(
      invoice.clientGstin?.toUpperCase() || ''
    );
    const supplyType: EInvoiceSupplyType = hasValidBuyerGstin ? 'B2B' : 'B2C';
    const buyerAddr1 = invoice.clientAddress || 'N/A';

    const sellerDtls: EInvoicePartyDtls = {
      Gstin: company.gstin,
      LglNm: company.legalName,
      ...(company.tradeName ? { TrdNm: company.tradeName } : {}),
      Addr1: company.address1,
      ...(company.address2 ? { Addr2: company.address2 } : {}),
      Loc: company.place,
      Pin: parseInt(company.pinCode) || 0,
      Stcd: sellerStateCode,
      ...(company.phone ? { Ph: company.phone } : {}),
      ...(company.email ? { Em: company.email } : {}),
    };

    // Ship-to is only sent when the client's Ship To Address is actually a
    // different location from the Bill To Address used above for BuyerDtls —
    // otherwise NIC/Webtel treat the buyer's own address as the ship-to.
    const client = invoice.clientId ? await this.clientService.getClientByIdOnce(invoice.clientId) : null;
    const shipToDiffers = !!client?.shipToAddress && !client.shipToSameAsBilling &&
      client.shipToAddress.trim() !== buyerAddr1.trim();

    // Place of Supply is where the goods are actually delivered — under
    // GST's Bill-To-Ship-To rule (IGST Act s.10(1)(b)) that's the Ship To
    // state whenever it genuinely differs from the Bill To Address, NOT the
    // buyer's Bill To/GSTIN-registration state. A buyer registered in the
    // same state as the seller but having goods delivered to a different
    // state is still an inter-state (IGST) supply — comparing sellerStateCode
    // to the buyer's own state instead of to the real POS was why
    // IgstAmt/IgstVal stayed 0 for exactly that case. Shared with Invoice
    // generation (packing-list.component.ts) so both always agree on
    // CGST+SGST vs IGST for the same invoice.
    const { buyerStateCode, posStateCode, isInterState, buyerStateUnresolved, shipToStateUnresolved } =
      resolveGstPlaceOfSupply(sellerStateCode, invoice.clientGstin, invoice.clientState, shipToDiffers, client?.shipToState);
    const shipToStateCode = shipToDiffers ? stateCodeFromName(client!.shipToState) : '';

    const buyerDtls: EInvoiceBuyerDtls = {
      Gstin: hasValidBuyerGstin ? invoice.clientGstin.toUpperCase() : 'URP',
      LglNm: invoice.clientName,
      Addr1: buyerAddr1,
      Loc: invoice.clientPlace || invoice.destination || 'N/A',
      Pin: parseInt(invoice.clientZipCode) || 0,
      // Buyer's own Bill To/GSTIN-registration state. This is deliberately
      // NOT what decides IGST vs CGST+SGST below — see posStateCode.
      Stcd: buyerStateCode,
      Pos: posStateCode,
      ...(invoice.clientPhone ? { Ph: invoice.clientPhone } : {}),
    };
    const shipDtls = this.buildShipDtls(client, buyerDtls, shipToStateCode);

    const itemList: EInvoiceItem[] = invoice.items.map((item, index) => {
      const totAmt = Math.round(item.price * item.quantity * 100) / 100;
      const gstRate = item.taxRate;
      // item.discountPct mirrors the invoice-level discount % applied to every
      // line (see packing-list.component.ts invoice generation) — apply it
      // per line so sum(AssAmt) reconciles with invoice.taxableValue instead
      // of double-counting the pre-discount gross amount as the taxable value.
      const discount = Math.round((totAmt * (item.discountPct || 0) / 100) * 100) / 100;
      const assAmt = Math.round((totAmt - discount) * 100) / 100;
      const igstAmt = isInterState ? Math.round(assAmt * (gstRate / 100) * 100) / 100 : 0;
      const cgstAmt = !isInterState ? Math.round(assAmt * (gstRate / 2 / 100) * 100) / 100 : 0;
      const sgstAmt = !isInterState ? Math.round(assAmt * (gstRate / 2 / 100) * 100) / 100 : 0;
      const totItemVal = Math.round((assAmt + igstAmt + cgstAmt + sgstAmt) * 100) / 100;

      return {
        SlNo: String(index + 1),
        PrdDesc: item.description,
        IsServc: 'N',
        HsnCd: item.hsnSac,
        Qty: item.quantity,
        // This business never ships free/sample quantity — 0 is a real fact,
        // not a placeholder.
        FreeQty: 0,
        Unit: item.uom || 'NOS',
        UnitPrice: item.price,
        TotAmt: totAmt,
        Discount: discount,
        // Deprecated in the NIC schema and not used in total computation —
        // sent as 0 per Webtel's sandbox convention, never fabricated.
        PreTaxVal: 0,
        AssAmt: assAmt,
        GstRt: gstRate,
        IgstAmt: igstAmt,
        CgstAmt: cgstAmt,
        SgstAmt: sgstAmt,
        // Garments carry no Compensation Cess or state cess — sent as
        // explicit 0s (required by the sandbox schema) rather than omitted.
        CesRt: 0,
        CesAmt: 0,
        CesNonAdvlAmt: 0,
        StateCesRt: 0,
        StateCesAmt: 0,
        StateCesNonAdvlAmt: 0,
        OthChrg: 0,
        TotItemVal: totItemVal,
      };
    });

    const payload: EInvoicePayload = {
      Version: '1.1',
      TranDtls: {
        TaxSch: 'GST',
        SupTyp: supplyType,
        RegRev: 'N',
        EcmGstin: null,
        IgstOnIntra: 'N',
      },
      DocDtls: {
        Typ: 'INV',
        No: invoice.invoiceNo,
        Dt: this.formatDateDDMMYYYY(invoice.invoiceDate),
      },
      SellerDtls: sellerDtls,
      BuyerDtls: buyerDtls,
      ...(shipDtls ? { ShipDtls: shipDtls } : {}),
      ItemList: itemList,
      // Summed from ItemList itself, not from invoice.cgstAmount/sgstAmount/
      // igstAmount — those are computed at invoice-creation time in
      // packing-list.component.ts, which always assumes CGST+SGST and never
      // looks at the buyer's actual state (igstAmount is hardcoded to 0
      // there). Copying them here would let ValDtls claim CGST+SGST for an
      // invoice ItemList just computed as IGST-only (real inter-state buyer)
      // — the exact mismatch NIC/Webtel rejects. Summing ItemList guarantees
      // ValDtls always agrees with what the items actually say.
      ValDtls: {
        AssVal: Math.round(itemList.reduce((s, i) => s + i.AssAmt, 0) * 100) / 100,
        CgstVal: Math.round(itemList.reduce((s, i) => s + i.CgstAmt, 0) * 100) / 100,
        SgstVal: Math.round(itemList.reduce((s, i) => s + i.SgstAmt, 0) * 100) / 100,
        IgstVal: Math.round(itemList.reduce((s, i) => s + i.IgstAmt, 0) * 100) / 100,
        CesVal: 0,
        StCesVal: 0,
        Discount: 0,
        OthChrg: 0,
        RndOffAmt: Math.round(invoice.roundOff * 100) / 100,
        TotInvVal: Math.round(invoice.totalAmount * 100) / 100,
      },
    };

    this.validatePayload(payload, buyerStateUnresolved, invoice.clientState, shipToStateUnresolved, client?.shipToState);
    return payload;
  }

  // Ship-to is a different party address only when the client explicitly has
  // a Ship To Address that isn't flagged "same as billing" and differs from
  // the Bill To Address already used for BuyerDtls. GSTIN/legal name mirror
  // the buyer's — this app has no concept of shipping to a third-party
  // consignee, only to a client's alternate address.
  private buildShipDtls(
    client: { shipToAddress?: string; shipToSameAsBilling?: boolean; shipToPlace?: string; shipToState?: string; shipToZipCode?: string } | null,
    buyerDtls: EInvoiceBuyerDtls,
    shipToStateCode: string
  ): EInvoiceShipDtls | null {
    if (!client?.shipToAddress || client.shipToSameAsBilling) return null;
    if (client.shipToAddress.trim() === buyerDtls.Addr1.trim()) return null;

    return {
      Gstin: buyerDtls.Gstin !== 'URP' ? buyerDtls.Gstin : undefined,
      LglNm: buyerDtls.LglNm,
      Addr1: client.shipToAddress,
      Loc: client.shipToPlace || buyerDtls.Loc,
      Pin: parseInt(client.shipToZipCode || '') || buyerDtls.Pin,
      // The Ship To Address's own state (already resolved by the caller,
      // since it's also what determines Place of Supply) — falls back to
      // buyerDtls.Stcd only if Client Master's Ship To State didn't resolve.
      Stcd: shipToStateCode || buyerDtls.Stcd,
    };
  }

  // Requirement: validate the payload before calling the E-Invoice API and
  // surface the exact missing/invalid field instead of letting Webtel/NIC
  // reject it with an opaque error, or silently dropping fields.
  private validatePayload(
    payload: EInvoicePayload,
    buyerStateUnresolved: boolean,
    clientState?: string,
    shipToStateUnresolved?: boolean,
    shipToState?: string
  ): void {
    const errors: string[] = [];
    const pinOk = (pin: number) => /^[1-9][0-9]{5}$/.test(String(pin));

    if (buyerStateUnresolved) {
      errors.push(
        `Client's State ("${clientState}") doesn't match a recognized Indian state name, so IGST vs CGST+SGST ` +
        `can't be determined reliably — fix the State field in Client Master (or set a valid client GSTIN) before generating this e-Invoice.`
      );
    }

    if (shipToStateUnresolved) {
      errors.push(
        `Client's Ship To State ("${shipToState}") doesn't match a recognized Indian state name, so the Place of ` +
        `Supply (and IGST vs CGST+SGST) can't be determined reliably — fix the Ship To State field in Client Master before generating this e-Invoice.`
      );
    }

    if (!payload.DocDtls.No) errors.push('Invoice number (DocDtls.No) is missing.');
    if (!payload.DocDtls.Dt) errors.push('Invoice date (DocDtls.Dt) is missing.');

    if (!payload.SellerDtls.Gstin) errors.push('Company GSTIN (SellerDtls.Gstin) is missing.');
    if (!payload.SellerDtls.LglNm) errors.push('Company legal name (SellerDtls.LglNm) is missing.');
    if (!payload.SellerDtls.Addr1) errors.push('Company address (SellerDtls.Addr1) is missing.');
    if (!payload.SellerDtls.Loc) errors.push('Company place (SellerDtls.Loc) is missing.');
    if (!pinOk(payload.SellerDtls.Pin)) errors.push('Company PIN code (SellerDtls.Pin) must be a valid 6-digit pincode.');

    if (!payload.BuyerDtls.LglNm) errors.push('Client name (BuyerDtls.LglNm) is missing.');
    if (!payload.BuyerDtls.Addr1 || payload.BuyerDtls.Addr1 === 'N/A') errors.push('Client Bill To Address (BuyerDtls.Addr1) is missing.');
    if (!pinOk(payload.BuyerDtls.Pin)) errors.push('Client PIN code (BuyerDtls.Pin) must be a valid 6-digit pincode.');

    if (!payload.ItemList.length) errors.push('Invoice has no items.');
    payload.ItemList.forEach((item, i) => {
      const line = `Item #${i + 1}`;
      if (!item.HsnCd) errors.push(`${line}: HSN/SAC code is missing.`);
      if (!item.Qty || item.Qty <= 0) errors.push(`${line}: quantity must be greater than 0.`);
      if (item.GstRt === undefined || item.GstRt < 0) errors.push(`${line}: GST rate is missing.`);
      if (item.AssAmt <= 0) errors.push(`${line}: taxable amount must be greater than 0.`);
    });

    if (payload.ValDtls.TotInvVal <= 0) errors.push('Total invoice value must be greater than 0.');

    if (errors.length) {
      throw new Error('E-Invoice payload is incomplete:\n' + errors.join('\n'));
    }
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
    const payload = await this.preparePayload(invoice, company);
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

}
