// Read-only diagnostic — no write code path exists in this file at all.
//
// Looks up specific invoices by invoiceNo and prints the client/GST fields
// that decide CGST+SGST vs IGST (see gst-state.util.ts resolveGstPlaceOfSupply),
// alongside what the CURRENT (fixed) logic would compute for the same data,
// so we can see exactly why an older invoice was saved with the wrong split.
//
// Uses the Firestore REST API directly with the public API key, same as
// scripts/diagnose-duplicate-invoices.mjs (firestore.rules allows open read).
// Run with: node scripts/diagnose-gst-mismatch.mjs TMGC2627-1907 TMGC2627-1908
const PROJECT_ID = "tmg-clothings";
const API_KEY = "AIzaSyB8g1fUiGZv_lBPm7FGWBTQtCpo0R35Xgg";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const targetInvoiceNos = process.argv.slice(2);
if (!targetInvoiceNos.length) {
  console.error("Usage: node scripts/diagnose-gst-mismatch.mjs <invoiceNo> [invoiceNo...]");
  process.exit(1);
}

async function fetchWithRetry(url, options, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      const delayMs = attempt * 1000;
      console.log(`  ...fetch failed (${err.cause?.code ?? err.message}), retrying in ${delayMs}ms (attempt ${attempt}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function listAllDocs(collectionName) {
  const docs = [];
  let pageToken;
  do {
    const url = new URL(`${BASE_URL}/${collectionName}`);
    url.searchParams.set("pageSize", "300");
    url.searchParams.set("key", API_KEY);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`List failed for ${collectionName}: ${res.status} ${await res.text()}`);
    const data = await res.json();

    docs.push(...(data.documents ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs;
}

async function getDoc(path) {
  const url = new URL(`${BASE_URL}/${path}`);
  url.searchParams.set("key", API_KEY);
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  return res.json();
}

function unwrapValue(value) {
  if (value == null) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(unwrapValue);
  if ("mapValue" in value) return unwrapFields(value.mapValue.fields ?? {});
  return null;
}
function unwrapFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) out[key] = unwrapValue(value);
  return out;
}
function unwrapDoc(doc) {
  return { id: doc.name.split("/").pop(), ...unwrapFields(doc.fields ?? {}) };
}

// --- mirrors src/services/gst-state.util.ts ---
const INDIA_STATE_CODES = [
  { code: '01', name: 'Jammu and Kashmir' }, { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' }, { code: '04', name: 'Chandigarh' }, { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' }, { code: '07', name: 'Delhi' }, { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' }, { code: '10', name: 'Bihar' }, { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' }, { code: '13', name: 'Nagaland' }, { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' }, { code: '16', name: 'Tripura' }, { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' }, { code: '19', name: 'West Bengal' }, { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' }, { code: '22', name: 'Chhattisgarh' }, { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' }, { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' }, { code: '28', name: 'Andhra Pradesh' }, { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' }, { code: '31', name: 'Lakshadweep' }, { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' }, { code: '34', name: 'Puducherry' }, { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' }, { code: '37', name: 'Andhra Pradesh (New)' }, { code: '38', name: 'Ladakh' },
];
const STATE_NAME_ALIASES = {
  'tamilnadu': 'tamil nadu', 'pondicherry': 'puducherry', 'orissa': 'odisha',
  'uttaranchal': 'uttarakhand', 'nct of delhi': 'delhi', 'new delhi': 'delhi',
  'andhra pradesh': 'andhra pradesh (new)',
};
function extractStateCodeFromGstin(gstin) {
  if (!gstin || gstin.length < 2) return '';
  return gstin.substring(0, 2);
}
function stateCodeFromName(stateName) {
  if (!stateName) return '';
  const norm = stateName.trim().toLowerCase().replace(/\s+/g, ' ');
  const resolved = STATE_NAME_ALIASES[norm] || norm;
  return INDIA_STATE_CODES.find((s) => s.name.toLowerCase() === resolved)?.code || '';
}
function resolveGstPlaceOfSupply(sellerStateCode, buyerGstin, buyerStateName, shipToDiffers, shipToStateName) {
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
// --- end mirror ---

async function main() {
  const companyDoc = await getDoc("settings/company");
  const company = companyDoc ? unwrapFields(companyDoc.fields ?? {}) : null;
  console.log("Company settings:", { stateCode: company?.stateCode, state: company?.state, gstNo: company?.gstNo });

  console.log("\nFetching invoices + clients...");
  const [invoiceDocs, clientDocs] = await Promise.all([listAllDocs("invoices"), listAllDocs("clients")]);
  const invoices = invoiceDocs.map(unwrapDoc);
  const clientsById = new Map(clientDocs.map(unwrapDoc).map((c) => [c.id, c]));

  for (const invoiceNo of targetInvoiceNos) {
    const inv = invoices.find((i) => i.invoiceNo === invoiceNo);
    console.log(`\n=== ${invoiceNo} ===`);
    if (!inv) { console.log("  NOT FOUND"); continue; }

    const client = clientsById.get(inv.clientId);

    console.log("  Stored on invoice:");
    console.log(`    clientId: ${inv.clientId}   clientName: ${inv.clientName}`);
    console.log(`    clientState (denormalized): "${inv.clientState}"   clientGstin: "${inv.clientGstin}"`);
    console.log(`    clientShipToState (denormalized): "${inv.clientShipToState ?? ''}"`);
    console.log(`    cgstAmount: ${inv.cgstAmount}  sgstAmount: ${inv.sgstAmount}  igstAmount: ${inv.igstAmount}`);
    console.log(`    createdAt: ${inv.createdAt}`);

    console.log("  Live Client Master record (current data):");
    if (!client) {
      console.log("    NOT FOUND (client deleted since?)");
    } else {
      console.log(`    state: "${client.state}"   gstNo: "${client.gstNo}"`);
      console.log(`    shipToSameAsBilling: ${client.shipToSameAsBilling}   shipToState: "${client.shipToState ?? ''}"`);
    }

    const sellerStateCode = company?.stateCode ?? '';
    const shipToDiffers = !!client?.shipToAddress && !client?.shipToSameAsBilling &&
      (client?.shipToAddress ?? '').trim() !== (client?.billingAddress ?? '').trim();
    const result = resolveGstPlaceOfSupply(sellerStateCode, client?.gstNo, client?.state, shipToDiffers, client?.shipToState);
    console.log("  What CURRENT logic computes from live Client Master data:");
    console.log(`    buyerStateCode: ${result.buyerStateCode}  posStateCode: ${result.posStateCode}  isInterState: ${result.isInterState}`);
    console.log(`    buyerStateUnresolved: ${result.buyerStateUnresolved}  shipToStateUnresolved: ${result.shipToStateUnresolved}`);
    console.log(`    => Should be: ${result.isInterState ? 'IGST only' : 'CGST+SGST'}`);
    console.log(`    Invoice actually has: ${Number(inv.cgstAmount) > 0 ? 'CGST+SGST' : 'IGST only'}`);
  }
}

main().catch((err) => {
  console.error("Diagnostic failed:", err);
  process.exit(1);
});
