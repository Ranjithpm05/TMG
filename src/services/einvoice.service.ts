import { Injectable, inject } from '@angular/core';
import { Firestore, doc, updateDoc, serverTimestamp } from '@angular/fire/firestore';
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

@Injectable({ providedIn: 'root' })
export class EInvoiceService {
  private firestore = inject(Firestore);
  private companySettingsService = inject(CompanySettingsService);

  async generateIRN(sellerGstin: string, fy: string, docType: string, docNo: string): Promise<string> {
    const text = `${sellerGstin}|${fy}|${docType}|${docNo}`;
    const msgBuffer = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async generateQRCodeDataUrl(content: string): Promise<string> {
    const QRCode = await import('qrcode');
    return QRCode.toDataURL(content, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 256,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
  }

  preparePayload(invoice: Invoice, company: CompanySettings): EInvoicePayload {
    const sellerStateCode = company.stateCode;
    const buyerStateCode = this.extractStateCodeFromGstin(invoice.clientGstin) || sellerStateCode;
    const isInterState = sellerStateCode !== buyerStateCode;
    const hasValidBuyerGstin = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(
      invoice.clientGstin?.toUpperCase() || ''
    );
    const supplyType: EInvoiceSupplyType = hasValidBuyerGstin ? 'B2B' : 'B2C';

    const sellerDtls: EInvoicePartyDtls = {
      Gstin: company.gstin,
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
      Gstin: invoice.clientGstin?.toUpperCase() || 'URP',
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

  async processEInvoice(invoice: Invoice): Promise<{ irn: string; qrDataUrl: string; payload: EInvoicePayload }> {
    const company = await this.companySettingsService.getCompanySettingsOnce();
    if (!company?.gstin) {
      throw new Error('Company GSTIN not configured. Please set up company settings first.');
    }

    const fy = this.getFYForIRN(invoice.invoiceDate);
    const irn = await this.generateIRN(company.gstin, fy, 'INV', invoice.invoiceNo);
    const payload = this.preparePayload(invoice, company);
    const ackNo = this.generateAckNo();
    const ackDt = this.formatDateTimeForAck();

    const qrContent = JSON.stringify({
      Irn: irn,
      AckNo: ackNo,
      AckDt: ackDt,
      SelGstin: company.gstin,
      BuyGstin: invoice.clientGstin?.toUpperCase() || 'URP',
      DocNo: invoice.invoiceNo,
      DocTyp: 'INV',
      DocDt: this.formatDateDDMMYYYY(invoice.invoiceDate),
      TotInvVal: invoice.totalAmount,
      ItemCnt: invoice.items.length,
      MainHsnCode: invoice.items[0]?.hsnSac || '',
    });

    const qrDataUrl = await this.generateQRCodeDataUrl(qrContent);
    return { irn, qrDataUrl, payload };
  }

  async saveEInvoice(invoiceId: string, irn: string, qrDataUrl: string, ackNo: string, ackDt: string, payload: EInvoicePayload): Promise<void> {
    const invoiceRef = doc(this.firestore, 'invoices', invoiceId);
    await updateDoc(invoiceRef, {
      eInvoiceStatus: 'generated',
      irn,
      irnGeneratedAt: serverTimestamp(),
      ackNo,
      ackDt,
      signedQrCode: qrDataUrl,
      eInvoicePayload: this.deepStripUndefined(payload),
      updatedAt: serverTimestamp(),
    });
  }

  async cancelEInvoice(invoiceId: string, reason: string): Promise<void> {
    const invoiceRef = doc(this.firestore, 'invoices', invoiceId);
    await updateDoc(invoiceRef, {
      eInvoiceStatus: 'cancelled',
      cancelReason: reason,
      cancelledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
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

  private generateAckNo(): string {
    const ts = Date.now().toString();
    return ts.substring(ts.length - 13);
  }

  private formatDateTimeForAck(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

  private getFYForIRN(timestamp: any): string {
    let d: Date;
    if (timestamp?.toDate) d = timestamp.toDate();
    else if (timestamp?.seconds) d = new Date(timestamp.seconds * 1000);
    else d = new Date();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    const fyStart = month >= 4 ? year : year - 1;
    return `${fyStart}-${String(fyStart + 1).slice(2)}`;
  }

  private extractStateCodeFromGstin(gstin: string): string {
    if (!gstin || gstin.length < 2) return '';
    return gstin.substring(0, 2);
  }
}
