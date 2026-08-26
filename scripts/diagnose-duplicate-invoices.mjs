// Read-only diagnostic — no PATCH/write code path exists in this file at all.
//
// Reports every Packing List that currently has more than one Invoice. Before
// the fix in InvoiceService.createInvoice() (see the "ONE DC = ONE INVOICE"
// change), a Packing List that still carried multiple legacy per-Sales-Order
// DC docs (created before the 2026-08-15 "one DC per Packing List" fix) could
// have each of those DCs invoiced independently, producing several Invoices
// for what should be a single Packing List/DC.
//
// This script does NOT delete, merge, or modify anything — it only lists
// what exists today so a human can decide (per business/tax rules) whether
// any of the extra Invoices need to be cancelled/credited. Run with:
//   node scripts/diagnose-duplicate-invoices.mjs
//
// Uses the Firestore REST API directly (not the JS SDK) — same rationale as
// scripts/fix-created-at.mjs: this network has intermittent connection resets
// that break the SDK's streaming transport, but plain request/response HTTPS
// works fine. firestore.rules on this project allows open read, so no auth
// token is needed.
const PROJECT_ID = "tmg-clothings";
const API_KEY = "AIzaSyB8g1fUiGZv_lBPm7FGWBTQtCpo0R35Xgg";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

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

function fmtMoney(n) {
  return "Rs " + Number(n ?? 0).toLocaleString("en-IN");
}

async function main() {
  console.log("Fetching invoices, deliveryChallans, packingLists...");
  const [invoiceDocs, dcDocs, packingListDocs] = await Promise.all([
    listAllDocs("invoices"),
    listAllDocs("deliveryChallans"),
    listAllDocs("packingLists"),
  ]);

  const invoices = invoiceDocs.map(unwrapDoc);
  const dcs = dcDocs.map(unwrapDoc);
  const packingListById = new Map(packingListDocs.map(unwrapDoc).map((pl) => [pl.id, pl]));

  console.log(`Invoices: ${invoices.length}  DeliveryChallans: ${dcs.length}  PackingLists: ${packingListById.size}\n`);

  const invoicesByPackingListId = new Map();
  for (const inv of invoices) {
    const key = inv.packingListId || "(none)";
    const arr = invoicesByPackingListId.get(key);
    if (arr) arr.push(inv); else invoicesByPackingListId.set(key, [inv]);
  }

  const dcsByPackingListId = new Map();
  for (const dc of dcs) {
    const key = dc.packingListId || "(none)";
    const arr = dcsByPackingListId.get(key);
    if (arr) arr.push(dc); else dcsByPackingListId.set(key, [dc]);
  }

  const flagged = [...invoicesByPackingListId.entries()].filter(([, arr]) => arr.length > 1);

  if (!flagged.length) {
    console.log("No Packing List currently has more than one Invoice. Nothing to review.");
    return;
  }

  console.log(`=== ${flagged.length} Packing List(s) with more than one Invoice ===\n`);
  let totalExtraInvoices = 0;
  let totalExtraAmount = 0;

  for (const [packingListId, invs] of flagged.sort((a, b) => b[1].length - a[1].length)) {
    const pl = packingListById.get(packingListId);
    const dcsForPl = dcsByPackingListId.get(packingListId) ?? [];
    console.log(`Packing List: ${pl?.packingListNo ?? "(missing doc)"}  (id: ${packingListId})`);
    console.log(`  Client: ${pl?.clientName ?? "?"}   DC docs on this Packing List: ${dcsForPl.length}`);
    for (const dc of dcsForPl) {
      console.log(`    DC ${dc.dcNo}  (id: ${dc.id})  salesNos: ${(dc.salesNos ?? []).join(", ")}  invoiceId: ${dc.invoiceId ?? "-"}`);
    }
    console.log(`  ${invs.length} Invoice(s):`);
    for (const inv of invs.sort((a, b) => (a.invoiceSeq ?? 0) - (b.invoiceSeq ?? 0))) {
      console.log(`    ${inv.invoiceNo}  (id: ${inv.id})  dcId: ${inv.dcId ?? "-"}  total: ${fmtMoney(inv.totalAmount)}  eInvoiceStatus: ${inv.eInvoiceStatus ?? "-"}`);
    }
    totalExtraInvoices += invs.length - 1;
    totalExtraAmount += invs.slice(1).reduce((s, i) => s + (Number(i.totalAmount) || 0), 0);
    console.log("");
  }

  console.log("=== Summary ===");
  console.log(`${flagged.length} Packing List(s) affected.`);
  console.log(`${totalExtraInvoices} extra Invoice(s) beyond the first per Packing List (sum: ${fmtMoney(totalExtraAmount)}).`);
  console.log("\nThis is a report only — nothing was changed. Review each group above (especially");
  console.log("any with eInvoiceStatus 'generated', which have already been filed with the IRP)");
  console.log("before deciding whether to cancel/credit any of the extra Invoices.");
}

main().catch((err) => {
  console.error("Diagnostic failed:", err);
  process.exit(1);
});
