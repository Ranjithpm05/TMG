// READ-ONLY review — no writes anywhere in this file. Lists Invoices whose
// source DC(s) predate the size-wise MRP fix (a row spanning several sizes
// billed every size at one flat MRP instead of each size's own MRP) and
// whose Invoice does NOT yet carry an E-Invoice IRN, so a correction is at
// least legally possible (GST law forbids editing an already-reported
// e-invoice). This does not touch any document — it only reports, per
// affected Invoice, the current total vs. what it would be if recomputed
// with each size's correct MRP, so a human can decide case-by-case whether
// to correct+reissue.
//
// The DC item's own historical margin factor (stored price/mrp ratio) is
// reused rather than recomputing from the Client's current marginPct, so a
// margin change made since the Invoice was raised doesn't get folded in as
// if it were part of this bug.
//
// Usage: node scripts/review-invoiced-dc-mrp.mjs
import { writeFile } from "node:fs/promises";

const PROJECT_ID = "tmg-clothings";
const API_KEY = "AIzaSyB8g1fUiGZv_lBPm7FGWBTQtCpo0R35Xgg";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function fetchWithRetry(url, options, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
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
    if (Array.isArray(data.documents)) docs.push(...data.documents);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs;
}

function decodeValue(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return v.timestampValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields ?? {});
  return v;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = decodeValue(v);
  return out;
}

async function main() {
  const [dcRaw, designRaw, invoiceRaw, clientRaw] = await Promise.all([
    listAllDocs("deliveryChallans"),
    listAllDocs("designs"),
    listAllDocs("invoices"),
    listAllDocs("clients"),
  ]);
  const dcs = dcRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const designs = designRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const invoices = invoiceRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const clients = clientRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const dcById = new Map(dcs.map((d) => [d.id, d]));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  const designPriceIndex = new Map();
  for (const d of designs) {
    const key = `${(d.styleNo ?? "").trim()}|${(d.color ?? "").trim()}`.toLowerCase();
    let sizeMap = designPriceIndex.get(key);
    if (!sizeMap) { sizeMap = new Map(); designPriceIndex.set(key, sizeMap); }
    for (const s of d.sizes ?? []) {
      const sizeKey = `${(s.size ?? "").trim()}|${(s.sleeveType ?? "").trim()}`.toLowerCase();
      sizeMap.set(sizeKey, Number(s.price) || 0);
    }
  }

  // Invoice generation recomputes price fresh from dcItem.mrp using the
  // Client's marginPct AT INVOICE-GENERATION TIME (see packing-list.component.ts
  // ~line 1195) — it does NOT reuse the DC item's own stored price/amount. So
  // the DC item's price/mrp ratio is *not* a reliable stand-in for the margin
  // actually billed on this Invoice; the truth for that lives on the
  // INVOICE ITEM itself (invoiceItem.price / invoiceItem.mrp), which is what
  // was really charged. Zip each DC item with its corresponding Invoice item
  // (built 1:1, in order, by the same flatMap that created invoice.items) and
  // derive the factor from there.
  function recomputeItem(dcItem, invoiceItem, fallbackMarginPct) {
    const designKey = `${(dcItem.styleNo ?? "").trim()}|${(dcItem.color ?? "").trim()}`.toLowerCase();
    const sizeMap = designPriceIndex.get(designKey);
    const invMrp = Number(invoiceItem?.mrp) || 0;
    const invPrice = Number(invoiceItem?.price) || 0;
    const factor = invMrp > 0 && invPrice > 0 ? invPrice / invMrp : (1 - fallbackMarginPct / 100);
    const storedMrp = Number(dcItem.mrp) || 0;
    let amount = 0;
    let anySizeDiffers = false;
    for (const [size, qty] of Object.entries(dcItem.sizeQty ?? {})) {
      const sizeKey = `${size}|${(dcItem.sleeveType ?? "").trim()}`.toLowerCase();
      const price = sizeMap?.get(sizeKey);
      const effectiveMrp = price != null && price > 0 ? price : storedMrp;
      if (price != null && price > 0 && price !== storedMrp) anySizeDiffers = true;
      amount += qty * Math.round(effectiveMrp * factor * 100) / 100;
    }
    return { amount: Math.round(amount * 100) / 100, anySizeDiffers };
  }

  const results = [];
  for (const invoice of invoices) {
    if (invoice.irn) continue; // legally locked, out of scope for this report
    const dcIds = invoice.dcIds?.length ? invoice.dcIds : (invoice.dcId ? [invoice.dcId] : []);
    const invDcs = dcIds.map((id) => dcById.get(id)).filter(Boolean);
    if (!invDcs.length) continue;
    const predatesFix = invDcs.some((dc) => (dc.items ?? []).some((it) => it.mrpBySize == null));
    if (!predatesFix) continue;

    // Flatten DC items in the same order the Invoice's items were originally
    // built in (dcIds order, then dc.items order) so index i always pairs
    // the right DC item with the right Invoice item.
    const flatDcItems = invDcs.flatMap((dc) => (dc.items ?? []).map((item) => ({ item, dc })));
    if (flatDcItems.length !== (invoice.items ?? []).length) {
      // Item counts no longer line up (e.g. a DC was edited after invoicing) —
      // skip rather than risk pairing the wrong item to the wrong price.
      continue;
    }

    let grossNew = 0;
    let anyDiff = false;
    flatDcItems.forEach(({ item, dc }, i) => {
      const fallbackMarginPct = clientById.get(dc.clientId)?.marginPct ?? 0;
      const { amount, anySizeDiffers } = recomputeItem(item, invoice.items[i], fallbackMarginPct);
      grossNew += amount;
      if (anySizeDiffers) anyDiff = true;
    });
    if (!anyDiff) continue; // recompute is a no-op for this invoice

    grossNew = Math.round(grossNew * 100) / 100;
    const discountPct = Number(invoice.discountPct) || 0;
    const discountNew = Math.round(grossNew * discountPct / 100 * 100) / 100;
    const taxableNew = Math.round((grossNew - discountNew) * 100) / 100;
    const cgstRate = Number(invoice.cgstRate) || 0;
    const sgstRate = Number(invoice.sgstRate) || 0;
    const igstRate = Number(invoice.igstRate) || 0;
    const cgstNew = Math.round(taxableNew * cgstRate / 100 * 100) / 100;
    const sgstNew = Math.round(taxableNew * sgstRate / 100 * 100) / 100;
    const igstNew = igstRate ? Math.round(taxableNew * igstRate / 100 * 100) / 100 : 0;
    const rawTotalNew = taxableNew + cgstNew + sgstNew + igstNew;
    const totalNew = Math.round(rawTotalNew);

    const delta = Math.round((totalNew - (Number(invoice.totalAmount) || 0)) * 100) / 100;
    if (Math.abs(delta) < 0.5) continue;

    results.push({
      invoiceNo: invoice.invoiceNo,
      clientName: invoice.clientName,
      dcNo: invDcs.map((d) => d.dcNo).join(", "),
      invoiceId: invoice.id,
      oldTotal: invoice.totalAmount,
      newTotal: totalNew,
      delta,
    });
  }

  results.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  console.log(`Invoices reviewed (no IRN): ${invoices.filter((i) => !i.irn).length}`);
  console.log(`Invoices whose recomputed total actually differs: ${results.length}\n`);
  console.log("Invoice No".padEnd(14), "Client".padEnd(28), "DC No".padEnd(16), "Old Total".padStart(12), "New Total".padStart(12), "Delta".padStart(10));
  for (const r of results) {
    console.log(
      String(r.invoiceNo).padEnd(14),
      String(r.clientName ?? "").slice(0, 27).padEnd(28),
      String(r.dcNo).padEnd(16),
      String(r.oldTotal).padStart(12),
      String(r.newTotal).padStart(12),
      String(r.delta > 0 ? "+" + r.delta : r.delta).padStart(10),
    );
  }

  await writeFile("invoiced-dc-mrp-review.json", JSON.stringify(results, null, 2));
  console.log(`\nFull list written to scripts/invoiced-dc-mrp-review.json (${results.length} row(s)). No writes were made to Firestore.`);
}

main().catch((err) => {
  console.error("Review failed:", err);
  process.exit(1);
});
