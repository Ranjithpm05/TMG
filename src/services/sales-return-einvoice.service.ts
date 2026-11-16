import { Injectable, inject } from '@angular/core';
import { Firestore, doc, serverTimestamp, updateDoc } from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import type { Client } from '../models/client.model';
import type { CompanySettings, EInvoiceItem, EInvoicePayload } from '../models/einvoice.model';
import type { Invoice } from '../models/invoice.model';
import type { SalesReturn } from '../models/sales-return.model';
import { ClientService } from './client.service';
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
  /** Customer-Based Scanned Return only — the customer from Client Master, standing in for the missing invoice. */
  party: Invoice | null;
}

/**
 * Credit Note e-Invoice (IRP Doc type CRN) for a Posted Sales Return, through
 * the same generateEInvoiceIrn / cancelEInvoiceIrn Cloud Functions (Webtel
 * GenIRN2 / CanIRN) the Tax Invoice uses. Seller, buyer, ship-to and place of
 * supply are taken from the original invoice's own payload builder
 * (EInvoiceService.preparePayload) so the credit note always names the same
 * parties as the bill it reverses; items and values come from
 * buildCreditNote(), the same figures the Sales Return PDF prints.
 *
 * A Customer-Based Scanned Return has no invoice: its parties come from the
 * same builder fed with the Client Master record (customerAsInvoice), and the
 * credit note carries no RefDtls.PrecDocDtls (optional in the IRP schema).
 */
@Injectable({ providedIn: 'root' })
export class SalesReturnEInvoiceService {
  private firestore = inject(Firestore);
  private functions = inject(Functions);
  private companySettingsService = inject(CompanySettingsService);
  private einvoiceService = inject(EInvoiceService);
  private invoiceService = inject(InvoiceService);
  private salesReturnService = inject(SalesReturnService);
  private clientService = inject(ClientService);

  async loadContext(ret: SalesReturn): Promise<CreditNoteContext> {
    const customer = ret.mode === 'customer';
    const [company, invoices, client] = await Promise.all([
      this.companySettingsService.getCompanySettingsOnce(),
      Promise.all((ret.invoiceIds ?? []).map((id) => this.invoiceService.getInvoiceByIdOnce(id))),
      customer ? this.clientService.getClientByIdOnce(ret.clientId) : Promise.resolve(null),
    ]);
    const found = invoices.filter((inv): inv is Invoice => !!inv);
    const isInterState = customer ? !!ret.isInterState : found.length ? invoiceIsInterState(found[0]) : false;
    const creditNote = buildCreditNote(ret, new Map(found.map((inv) => [inv.id!, inv])), isInterState);
    return { company, invoices: found, creditNote, party: client ? customerAsInvoice(client, ret, creditNote) : null };
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
    const { company, invoices, creditNote, party } = await this.loadContext(ret);
    const customer = ret.mode === 'customer';
    const errors: string[] = [];
    if (!company?.gstin) throw new Error('Company GSTIN not configured. Please set up company settings first.');
    if (customer) {
      if (!party) throw new Error(`${ret.clientName} no longer exists in Client Master.`);
    } else {
      if (invoices.length !== (ret.invoiceIds ?? []).length) errors.push('One or more original invoices of this return no longer exist.');
      if (!invoices.length) throw new Error(errors.join('\n'));
      if (new Set(invoices.map(invoiceIsInterState)).size > 1) {
        errors.push('The original invoices differ in IGST vs CGST+SGST — return them in separate Sales Returns.');
      }
    }

    // Seller / buyer / ship-to / place of supply exactly as the original
    // invoice's e-Invoice would carry them (client master is synced first,
    // unless that invoice already has an IRN — then its registered details stand).
    // With no invoice, the same builder reads them from Client Master.
    const original = customer
      ? await this.einvoiceService.preparePayload(party!, company)
      : await this.einvoiceService.preparePayload(await this.invoiceService.syncClientFromMaster(invoices[0]), company);
    if (customer && (original.BuyerDtls.Pos !== original.SellerDtls.Stcd) !== creditNote.isInterState) {
      // The return's tax split was fixed at entry; Client Master's state has changed since.
      errors.push(`The state / place of supply of ${ret.clientName} in Client Master no longer matches the ` +
        `${creditNote.isInterState ? 'IGST' : 'CGST+SGST'} this return was entered with — cancel it and enter it again.`);
    }
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
      if (!item.HsnCd) errors.push(`Item #${i + 1}: HSN code could not be resolved${customer ? '' : ' from its invoice'}.`);
      if (!(item.AssAmt > 0)) errors.push(`Item #${i + 1}: taxable value must be greater than 0.`);
    });
    if (!(creditNote.netAmount > 0)) errors.push('Credit note value must be greater than 0.');
    if (errors.length) throw new Error('Credit Note e-Invoice cannot be generated:\n' + errors.join('\n'));

    const remark = [ret.referenceNo ? `Ref ${ret.referenceNo}` : '', ret.remarks ?? ''].filter(Boolean).join(' · ').trim();
    const precDocDtls = invoices.map((inv) => ({ InvNo: inv.invoiceNo, InvDt: this.einvoiceService.formatDateDDMMYYYY(inv.invoiceDate) }));
    const refDtls = {
      ...(remark.length >= 3 ? { InvRm: remark.slice(0, 100) } : {}),
      ...(precDocDtls.length ? { PrecDocDtls: precDocDtls } : {}),
    };
    return {
      Version: original.Version,
      TranDtls: original.TranDtls,
      DocDtls: { Typ: 'CRN', No: ret.returnNo, Dt: ddmmyyyy(ret.returnDate) },
      SellerDtls: original.SellerDtls,
      BuyerDtls: original.BuyerDtls,
      ...(original.ShipDtls ? { ShipDtls: original.ShipDtls } : {}),
      ...(Object.keys(refDtls).length ? { RefDtls: refDtls } : {}),
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

/**
 * The customer of a Customer-Based Scanned Return shaped as the Invoice that
 * EInvoiceService.preparePayload() reads parties from — bill-to from Client
 * Master exactly as InvoiceService.syncClientFromMaster() maps it, items from
 * the credit note so the builder's own item checks pass. Only the parties and
 * place of supply of its result are used. No id, so nothing is ever synced or
 * written back.
 */
function customerAsInvoice(client: Client, ret: SalesReturn, creditNote: CreditNote): Invoice {
  return {
    invoiceNo: ret.returnNo,
    invoiceDate: new Date(`${ret.returnDate}T00:00:00`),
    clientId: client.id ?? ret.clientId,
    clientName: client.clientName || ret.clientName,
    clientAddress: client.billingAddress ?? '',
    clientPlace: client.place ?? '',
    clientState: client.state ?? '',
    clientZipCode: client.zipCode ?? '',
    clientPhone: client.mobile ?? '',
    clientGstin: client.gstNo || ret.clientGstin || '',
    destination: client.shipToPlace || client.place || '',
    orderNo: '',
    salesNos: [],
    items: creditNote.items.map((item) => ({
      description: item.line.description, styleNo: item.line.styleNo, sleeveType: item.line.sleeveType,
      hsnSac: item.hsnSac, discountPct: 0, taxRate: item.gstRate, mrp: item.line.mrp, uom: item.uom,
      quantity: item.line.qty, price: item.line.taxableValue / (item.line.qty || 1), amount: item.line.taxableValue,
    })),
    freightAmount: 0,
    roundOff: creditNote.roundOff,
    totalAmount: creditNote.netAmount,
  } as unknown as Invoice;
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
