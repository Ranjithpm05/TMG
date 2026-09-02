import { INDIA_STATE_CODES } from '../models/einvoice.model';

// A handful of state names as they're commonly typed in Client Master
// (free-text field, sometimes imported from Excel) that don't exactly match
// the official INDIA_STATE_CODES names below.
const STATE_NAME_ALIASES: Record<string, string> = {
  'tamilnadu': 'tamil nadu',
  'pondicherry': 'puducherry',
  'orissa': 'odisha',
  'uttaranchal': 'uttarakhand',
  'nct of delhi': 'delhi',
  'new delhi': 'delhi',
  'andhra pradesh': 'andhra pradesh (new)',
};

export function extractStateCodeFromGstin(gstin: string | undefined): string {
  if (!gstin || gstin.length < 2) return '';
  return gstin.substring(0, 2);
}

export function stateCodeFromName(stateName: string | undefined): string {
  if (!stateName) return '';
  const norm = stateName.trim().toLowerCase().replace(/\s+/g, ' ');
  const resolved = STATE_NAME_ALIASES[norm] || norm;
  return INDIA_STATE_CODES.find((s) => s.name.toLowerCase() === resolved)?.code || '';
}

export interface GstPlaceOfSupplyResult {
  buyerStateCode: string;
  posStateCode: string;
  isInterState: boolean;
  // A buyer/ship-to state that's present in Client Master but didn't
  // resolve to a known state code — a data problem to flag/fix there
  // rather than silently guessing CGST+SGST vs IGST.
  buyerStateUnresolved: boolean;
  shipToStateUnresolved: boolean;
}

// Single source of truth for "is this sale intra-state (CGST+SGST) or
// inter-state (IGST)?", shared by Invoice generation and the E-Invoice/IRN
// payload builder so both always agree. Place of Supply is the Ship To
// state whenever the client has a genuinely different Ship To Address
// (GST Bill-To-Ship-To rule, IGST Act s.10(1)(b)); otherwise it's the
// buyer's own Bill To state, taken from their GSTIN prefix first (most
// authoritative) and falling back to the free-text state name.
export function resolveGstPlaceOfSupply(
  sellerStateCode: string,
  buyerGstin: string | undefined,
  buyerStateName: string | undefined,
  shipToDiffers: boolean,
  shipToStateName: string | undefined
): GstPlaceOfSupplyResult {
  const buyerStateCodeFromGstin = extractStateCodeFromGstin(buyerGstin);
  const buyerStateCodeFromName = stateCodeFromName(buyerStateName);
  const buyerStateUnresolved = !buyerStateCodeFromGstin && !buyerStateCodeFromName && !!buyerStateName?.trim();
  const buyerStateCode = buyerStateCodeFromGstin || buyerStateCodeFromName || sellerStateCode;

  const shipToStateCode = shipToDiffers ? stateCodeFromName(shipToStateName) : '';
  const shipToStateUnresolved = shipToDiffers && !shipToStateCode && !!shipToStateName?.trim();
  const posStateCode = shipToStateCode || buyerStateCode;
  const isInterState = sellerStateCode !== posStateCode;

  return { buyerStateCode, posStateCode, isInterState, buyerStateUnresolved, shipToStateUnresolved };
}
