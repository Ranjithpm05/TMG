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

export interface EInvoiceItem {
  SlNo: string;
  PrdDesc?: string;
  IsServc: 'Y' | 'N';
  HsnCd: string;
  Qty?: number;
  Unit?: string;
  UnitPrice: number;
  TotAmt: number;
  Discount?: number;
  AssAmt: number;
  GstRt: number;
  IgstAmt: number;
  CgstAmt: number;
  SgstAmt: number;
  CesRt?: number;
  CesAmt?: number;
  OthChrg?: number;
  TotItemVal: number;
}

export interface EInvoiceValDtls {
  AssVal: number;
  CgstVal: number;
  SgstVal: number;
  IgstVal: number;
  CesVal?: number;
  Discount?: number;
  OthChrg?: number;
  RndOffAmt?: number;
  TotInvVal: number;
}

export interface EInvoicePayload {
  Version: string;
  TranDtls: EInvoiceTranDtls;
  DocDtls: EInvoiceDocDtls;
  SellerDtls: EInvoicePartyDtls;
  BuyerDtls: EInvoiceBuyerDtls;
  ItemList: EInvoiceItem[];
  ValDtls: EInvoiceValDtls;
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
