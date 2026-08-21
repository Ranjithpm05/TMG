export type EInvoiceStatus = 'pending' | 'generated' | 'failed' | 'cancelled';
export type EInvoiceDocType = 'INV' | 'CRN' | 'DBN';
export type EInvoiceSupplyType = 'B2B' | 'B2C' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP' | 'DEXP';

export interface EInvoiceTranDtls {
  TaxSch: 'GST';
  SupTyp: EInvoiceSupplyType;
  RegRev: 'Y' | 'N';
  EcmGstin?: string | null;
  IgstOnIntra: 'Y' | 'N';
}

export interface EInvoiceDocDtls {
  Typ: EInvoiceDocType;
  No: string;
  Dt: string;
}

export interface EInvoicePartyDtls {
  Gstin: string;
  LglNm: string;
  TrdNm?: string;
  Addr1: string;
  Addr2?: string;
  Loc: string;
  Pin: number;
  Stcd: string;
  Ph?: string;
  Em?: string;
}

export interface EInvoiceBuyerDtls extends EInvoicePartyDtls {
  Pos: string;
}

// Ship-to party — only present when goods are shipped to a location other
// than the buyer's own address (e.g. a client's separate Ship To Address).
export interface EInvoiceShipDtls {
  Gstin?: string;
  LglNm: string;
  TrdNm?: string;
  Addr1: string;
  Addr2?: string;
  Loc: string;
  Pin: number;
  Stcd: string;
}

// Dispatch-from party — only present when goods are dispatched from a
// location other than the seller's registered address.
export interface EInvoiceDispDtls {
  Nm: string;
  Addr1: string;
  Addr2?: string;
  Loc: string;
  Pin: number;
  Stcd: string;
}

export interface EInvoiceBchDtls {
  Nm: string;
  Expdt?: string;
  WrDt?: string;
}

export interface EInvoiceAttribDtls {
  Nm: string;
  Val: string;
}

export interface EInvoiceItem {
  SlNo: string;
  PrdDesc?: string;
  IsServc: 'Y' | 'N';
  HsnCd: string;
  Barcde?: string;
  Qty?: number;
  FreeQty?: number;
  Unit?: string;
  UnitPrice: number;
  TotAmt: number;
  Discount?: number;
  PreTaxVal?: number;
  AssAmt: number;
  GstRt: number;
  IgstAmt: number;
  CgstAmt: number;
  SgstAmt: number;
  CesRt?: number;
  CesAmt?: number;
  CesNonAdvlAmt?: number;
  StateCesRt?: number;
  StateCesAmt?: number;
  StateCesNonAdvlAmt?: number;
  OthChrg?: number;
  TotItemVal: number;
  OrdLineRef?: string;
  OrgCntry?: string;
  PrdSlNo?: string;
  BchDtls?: EInvoiceBchDtls;
  AttribDtls?: EInvoiceAttribDtls[];
}

export interface EInvoiceValDtls {
  AssVal: number;
  CgstVal: number;
  SgstVal: number;
  IgstVal: number;
  CesVal?: number;
  StCesVal?: number;
  Discount?: number;
  OthChrg?: number;
  RndOffAmt?: number;
  TotInvVal: number;
  TotInvValFc?: number;
}

// Optional — only meaningful when the invoice records a payment made against
// it at generation time. Omit entirely (do not send zeros/placeholders) when
// no payment data exists for the invoice.
export interface EInvoicePayDtls {
  Nm?: string;
  Accdet?: string;
  Mode?: string;
  Fininsbr?: string;
  Payterm?: string;
  Payinstr?: string;
  Crtrn?: string;
  Dirdr?: string;
  Crday?: number;
  Paidamt?: number;
  Paymtdue?: number;
}

export interface EInvoiceDocPerdDtls {
  InvStDt: string;
  InvEndDt: string;
}

export interface EInvoicePrecDocDtls {
  InvNo: string;
  InvDt: string;
  OthRefNo?: string;
}

export interface EInvoiceContrDtls {
  RecAdvRefr?: string;
  RecAdvDt?: string;
  Tendrefr?: string;
  Contrrefr?: string;
  Extrefr?: string;
  Projrefr?: string;
  Porefr?: string;
  PoRefDt?: string;
}

// Optional — only when this invoice references a prior document (e.g. a
// credit/debit note against a previous invoice) or a contract/PO.
export interface EInvoiceRefDtls {
  InvRm?: string;
  DocPerdDtls?: EInvoiceDocPerdDtls;
  PrecDocDtls?: EInvoicePrecDocDtls[];
  ContrDtls?: EInvoiceContrDtls[];
}

export interface EInvoiceAddlDocDtls {
  Url?: string;
  Docs?: string;
  Info?: string;
}

// Optional — export invoices only (SupTyp EXPWP/EXPWOP/SEZWP/SEZWOP/DEXP).
// Must never be sent for a domestic B2B/B2C invoice.
export interface EInvoiceExpDtls {
  ShipBNo?: string;
  ShipBDt?: string;
  Port?: string;
  RefClm?: 'Y' | 'N';
  ForCur?: string;
  CntCode?: string;
  ExpDuty?: number | null;
}

// Optional — only when the E-Way Bill is generated together with the IRN.
// This application generates the E-Way Bill as a separate subsequent step
// (generateEwayBillByIrn, by IRN) instead, so this is not populated by
// preparePayload() today; kept here for completeness/future use.
export interface EInvoiceEwbDtls {
  Transid?: string;
  Transname?: string;
  Distance?: number;
  Transdocno?: string;
  TransdocDt?: string;
  Vehno?: string;
  Vehtype?: 'R' | 'O';
  TransMode?: '1' | '2' | '3' | '4';
}

export interface EInvoicePayload {
  Version: string;
  TranDtls: EInvoiceTranDtls;
  DocDtls: EInvoiceDocDtls;
  SellerDtls: EInvoicePartyDtls;
  BuyerDtls: EInvoiceBuyerDtls;
  DispDtls?: EInvoiceDispDtls;
  ShipDtls?: EInvoiceShipDtls;
  ItemList: EInvoiceItem[];
  ValDtls: EInvoiceValDtls;
  PayDtls?: EInvoicePayDtls;
  RefDtls?: EInvoiceRefDtls;
  AddlDocDtls?: EInvoiceAddlDocDtls[];
  ExpDtls?: EInvoiceExpDtls;
  EwbDtls?: EInvoiceEwbDtls;
}

export interface CompanySettings {
  id?: string;
  legalName: string;
  tradeName?: string;
  gstin: string;
  address1: string;
  address2?: string;
  place: string;
  pinCode: string;
  stateCode: string;
  phone?: string;
  email?: string;
  // Bank details for invoice print
  bankAccountName?: string;
  bankAccountNo?: string;
  bankIfscCode?: string;
  bankName?: string;
  updatedAt?: any;
}

export const INDIA_STATE_CODES: { code: string; name: string }[] = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '28', name: 'Andhra Pradesh (New)' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh (Old)' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' },
  { code: '99', name: 'Centre Jurisdiction' },
];

export const CANCEL_REASONS: string[] = [
  'Duplicate',
  'Data Entry Mistake',
  'Order Cancelled',
  'Others',
];
