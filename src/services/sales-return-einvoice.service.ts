import { Injectable, inject } from '@angular/core';
import { Firestore, doc, serverTimestamp, updateDoc } from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import type { CompanySettings, EInvoiceItem, EInvoicePayload } from '../models/einvoice.model';
import type { Invoice } from '../models/invoice.model';
import type { SalesReturn } from '../models/sales-return.model';
import { CompanySettingsService } from './company-settings.service';
import { EInvoiceService, type EInvoiceSubmitResult } from './einvoice.service';
import { InvoiceService } from './invoice.service';
import { SalesReturnService } from './sales-return.service';
import { retryAsync } from './einvoice-ewb.engine';
import { CreditNote, buildCreditNote, invoiceIsInterState } from './sales-return-credit-note.util';
import { round2 } from './sales-return.engine';

export interface CreditNoteContext {
  company: CompanySettings | null;
  /** Original invoices of the return, in ret.invoiceIds order (missing ones left out). */
  invoices: Invoice[];
  creditNote: CreditNote;
}

/**
 * Credit Note e-Invoice (IRP Doc type CRN) for a Posted Sales Return, through
 * the same generateEInvoiceIrn / cancelEInvoiceIrn Cloud Functions (Webtel
 * GenIRN2 / CanIRN) the Tax Invoice uses. Seller, buyer, ship-to and place of
 * supply are taken from the original invoice's own payload builder
 * (EInvoiceService.preparePayload) so the credit note always names the same
 * parties as the bill it reverses; items and values come from
 * buildCreditNote(), the same figures the Sales Return PDF prints.
 */
@Injectable({ providedIn: 'root' })
export class SalesReturnEInvoiceService {
  private firestore = inject(Firestore);
  private functions = inject(Functions);
  private companySettingsService = inject(CompanySettingsService);
  private einvoiceService = inject(EInvoiceService);
  private invoiceService = inject(InvoiceService);
  private salesReturnService = inject(SalesReturnService);

  async loadContext(ret: SalesReturn): Promise<CreditNoteContext> {
    const [company, invoices] = await Promise.all([
      this.companySettingsService.getCompanySettingsOnce(),
      Promise.all((ret.invoiceIds ?? []).map((id) => this.invoiceService.getInvoiceByIdOnce(id))),
    ]);
    const found = invoices.filter((inv): inv is Invoice => !!inv);
    const isInterState = found.length ? invoiceIsInterState(found[0]) : false;
    const creditNote = buildCreditNote(ret, new Map(found.map((inv) => [inv.id!, inv])), isInterState);
    return { company, invoices: found, creditNote };
  }

  async generate(returnId: string): Promise<SalesReturn> {
    const ret = await this.salesReturnService.getReturnOnce(returnId);
    if (!ret) throw new Error('Sales return not found.');
    if (ret.status !== 'Posted') throw new Error(`${ret.returnNo} is ${ret.status} — only a Posted return can get a Credit Note e-Invoice.`);
    if (ret.eInvoiceStatus === 'generated') throw new Error(`${ret.returnNo} already has a Credit Note e-Invoice (IRN ${ret.irn}).`);
    if (ret.eInvoiceStatus === 'cancelled') {
      throw new Error(`The Credit Note e-Invoice of ${ret.returnNo} was cancelled — the IRP does not accept the same document number again.`);
    }

    let payload: EInvoicePayload;
    let result: EInvoiceSubmitResult;
    try {
      payload = await this.buildPayload(ret);
      const callable = httpsCallable<{ gstin: string; payload: EInvoicePayload }, EInvoiceSubmitResult>(this.functions, 'generateEInvoiceIrn');
      try {
        result = (await callable({ gstin: payload.SellerDtls.Gstin, payload })).data;
      } catch (err: any) {
        throw new Error(callableErrorMessage(err));
      }
    } catch (err: any) {
      const message = err?.message || 'Could not generate the Credit Note e-Invoice.';
      await this.patch(returnId, { eInvoiceStatus: 'failed', eInvoiceErrorMessage: message }).catch(() => undefined);
      throw new Error(message);
    }

    try {
      await retryAsync(() => this.patch(returnId, {
        eInvoiceStatus: 'generated',
        irn: result.irn,
        ackNo: result.ackNo,
        ackDt: result.ackDt,
        signedQrCode: result.signedQrCode,
        signedInvoice: result.signedInvoice,
        eInvoicePayload: stripUndefined(payload),
        irnGeneratedAt: serverTimestamp(),
        eInvoiceErrorMessage: null,
      }));
    } catch {
      throw new Error(
        `The IRP issued IRN ${result.irn} (Ack No. ${result.ackNo}) but it could not be saved to ${ret.returnNo}. ` +
        `Do NOT generate it again — note this IRN and contact support so it can be recorded.`
      );
    }
    return { ...ret, eInvoiceStatus: 'generated', irn: result.irn, ackNo: result.ackNo, ackDt: result.ackDt, signedQrCode: result.signedQrCode, eInvoicePayload: payload };
  }

  async cancel(ret: SalesReturn, reason: string): Promise<void> {
    if (ret.eInvoiceStatus !== 'generated' || !ret.irn) throw new Error(`${ret.returnNo} has no active Credit Note e-Invoice.`);
    const company = await this.companySettingsService.getCompanySettingsOnce();
    if (!company?.gstin) throw new Error('Company GSTIN not configured. Please set up company settings first.');
    const callable = httpsCallable<{ irn: string; gstin: string; reasonCode: string; remark: string }, { cancelDate: string }>(this.functions, 'cancelEInvoiceIrn');
    try {
      await callable({ irn: ret.irn, gstin: company.gstin, reasonCode: this.einvoiceService.getCancelReasonCode(reason), remark: reason });
    } catch (err: any) {
      throw new Error(callableErrorMessage(err));
    }
    await this.patch(ret.id!, { eInvoiceStatus: 'cancelled', eInvoiceCancelReason: reason, eInvoiceCancelledAt: serverTimestamp() });
  }

  /** The CRN payload for a Posted return — throws with every problem found before anything is sent. */
  async buildPayload(ret: SalesReturn): Promise<EInvoicePayload> {
    const { company, invoices, creditNote } = await this.loadContext(ret);
    const errors: string[] = [];
    if (!company?.gstin) throw new Error('Company GSTIN not configured. Please set up company settings first.');
    if (invoices.length !== (ret.invoiceIds ?? []).length) errors.push('One or more original invoices of this return no longer exist.');
    if (!invoices.length) throw new Error(errors.join('\n'));
    if (new Set(invoices.map(invoiceIsInterState)).size > 1) {
      errors.push('The original invoices differ in IGST vs CGST+SGST — return them in separate Sales Returns.');
    }

    // Seller / buyer / ship-to / place of supply exactly as the original
    // invoice's e-Invoice would carry them (client master is synced first,
    // unless that invoice already has an IRN — then its registered details stand).
    const original = await this.einvoiceService.preparePayload(await this.invoiceService.syncClientFromMaster(invoices[0]), company);
    if (original.TranDtls.SupTyp !== 'B2B') {
      errors.push(`${ret.clientName} has no valid GSTIN — a Credit Note e-Invoice can only be issued to a registered (B2B) customer.`);
    }

    const itemList: EInvoiceItem[] = creditNote.items.map((item, index) => {
      const l = item.line;
      const desc = [l.description, l.styleNo, l.color, l.sleeveType, `Size ${l.size}`, l.condition === 'Damage' ? 'Damage' : '']
        .filter(Boolean).join(' ').slice(0, 300);
      return {
        SlNo: String(index + 1),
        PrdDesc: desc,
        IsServc: 'N',
        HsnCd: item.hsnSac,
        Qty: l.qty,
        FreeQty: 0,
        Unit: item.uom,
        UnitPrice: l.price,
        TotAmt: item.grossAmount,
        Discount: item.discount,
        PreTaxVal: 0,
        AssAmt: l.taxableValue,
        GstRt: item.gstRate,
        IgstAmt: item.igstAmount,
        CgstAmt: item.cgstAmount,
        SgstAmt: item.sgstAmount,
        CesRt: 0,
        CesAmt: 0,
        CesNonAdvlAmt: 0,
        StateCesRt: 0,
        StateCesAmt: 0,
        StateCesNonAdvlAmt: 0,
        OthChrg: 0,
        TotItemVal: round2(l.taxableValue + item.igstAmount + item.cgstAmount + item.sgstAmount),
      };
    });
    itemList.forEach((item, i) => {
      if (!item.HsnCd) errors.push(`Item #${i + 1}: HSN code could not be resolved from its invoice.`);
      if (!(item.AssAmt > 0)) errors.push(`Item #${i + 1}: taxable value must be greater than 0.`);
    });
    if (!(creditNote.netAmount > 0)) errors.push('Credit note value must be greater than 0.');
    if (errors.length) throw new Error('Credit Note e-Invoice cannot be generated:\n' + errors.join('\n'));

    const remark = [ret.referenceNo ? `Ref ${ret.referenceNo}` : '', ret.remarks ?? ''].filter(Boolean).join(' · ').trim();
    return {
      Version: original.Version,
      TranDtls: original.TranDtls,
      DocDtls: { Typ: 'CRN', No: ret.returnNo, Dt: ddmmyyyy(ret.returnDate) },
      SellerDtls: original.SellerDtls,
      BuyerDtls: original.BuyerDtls,
      ...(original.ShipDtls ? { ShipDtls: original.ShipDtls } : {}),
      RefDtls: {
        ...(remark.length >= 3 ? { InvRm: remark.slice(0, 100) } : {}),
        PrecDocDtls: invoices.map((inv) => ({ InvNo: inv.invoiceNo, InvDt: this.einvoiceService.formatDateDDMMYYYY(inv.invoiceDate) })),
      },
      ItemList: itemList,
      ValDtls: {
        AssVal: creditNote.taxableValue,
        CgstVal: creditNote.cgstAmount,
        SgstVal: creditNote.sgstAmount,
        IgstVal: creditNote.igstAmount,
        CesVal: 0,
        StCesVal: 0,
        Discount: 0,
        OthChrg: 0,
        RndOffAmt: creditNote.roundOff,
        TotInvVal: creditNote.netAmount,
      },
    } as EInvoicePayload;
  }

  private async patch(returnId: string, data: Record<string, unknown>): Promise<void> {
    await updateDoc(doc(this.firestore, 'salesReturns', returnId), { ...data, updatedAt: serverTimestamp() });
    this.salesReturnService.refreshReturns();
  }
}

/** yyyy-MM-dd (the return's own date field) → dd/MM/yyyy, without a timezone round-trip. */
function ddmmyyyy(isoDate: string): string {
  const [y, m, d] = String(isoDate ?? '').split('-');
  return `${d}/${m}/${y}`;
}

function callableErrorMessage(err: any): string {
  const code = err?.details?.errorCode ? ` (code ${err.details.errorCode})` : '';
  return (err?.message || 'Request to the e-Invoice service failed.') + code;
}

function stripUndefined(value: any): any {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, stripUndefined(v)]));
  }
  return value;
}
