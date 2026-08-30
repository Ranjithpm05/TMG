// Applies the size-wise MRP correction to the 27 Invoices (and their source
// DCs) identified by review-invoiced-dc-mrp.mjs — Invoices that predate the
// fix, have NOT been e-invoiced (no IRN — legally untouchable ones are
// skipped), and whose recomputed total actually differs from what's stored.
//
// For each affected Invoice: pairs each DC item with its corresponding
// Invoice item (built 1:1, in order, by the original flatMap in
// packing-list.component.ts), derives the margin factor from the INVOICE
// item's own stored price/mrp (the actual historically-billed margin — see
// review-invoiced-dc-mrp.mjs's comment on why this differs from the DC
// item's own price/mrp), applies each size's correct Design Master MRP, and
// rebuilds: DC item.mrpBySize/amount + DC.totalAmount, and Invoice
// items/grossAmount/discountAmount/taxableValue/cgst/sgst/igst/
// totalTaxAmount/roundOff/totalAmount/amountInWords.
//
// Usage:
//   node scripts/apply-invoiced-dc-mrp-fix.mjs            (dry run, no writes)
//   node scripts/apply-invoiced-dc-mrp-fix.mjs --apply     (writes to production)
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

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
function encodeValue(v) {
  if (v == null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
  throw new Error(`Cannot encode value: ${JSON.stringify(v)}`);
}
function encodeFields(obj) {
  const fields = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    fields[k] = encodeValue(val);
  }
  return fields;
}

async function patchDoc(collection, docId, fieldValues) {
  const url = new URL(`${BASE_URL}/${collection}/${docId}`);
  for (const key of Object.keys(fieldValues)) url.searchParams.append("updateMask.fieldPaths", key);
  url.searchParams.set("key", API_KEY);
  const fields = {};
  for (const [k, v] of Object.entries(fieldValues)) fields[k] = encodeValue(v);
  const res = await fetchWithRetry(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Patch failed for ${collection}/${docId}: ${res.status} ${await res.text()}`);
}

// --- ported from packing-list.component.ts's amountToWords/numberToWords ---
function numberToWords(n) {
  if (n === 0) return "ZERO";
  const ones = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
    "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
  const tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
  const twoD = (num) => (num < 20 ? ones[num] : (tens[Math.floor(num / 10)] + (num % 10 ? " " + ones[num % 10] : "")).trim());
  const threeD = (num) => (num >= 100 ? ones[Math.floor(num / 100)] + " HUNDRED" + (num % 100 ? " " + twoD(num % 100) : "") : twoD(num));
  const parts = [];
  if (n >= 10000000) { parts.push(threeD(Math.floor(n / 10000000)) + " CRORE"); n %= 10000000; }
  if (n >= 100000) { parts.push(twoD(Math.floor(n / 100000)) + " LAKH"); n %= 100000; }
  if (n >= 1000) { parts.push(twoD(Math.floor(n / 1000)) + " THOUSAND"); n %= 1000; }
  if (n > 0) parts.push(threeD(n));
  return parts.join(" ");
}
function amountToWords(amount) {
  const rounded = Math.round(amount);
  const parts = amount.toFixed(2).split(".");
  const paisa = parseInt(parts[1], 10);
  const rupeeWords = numberToWords(rounded);
  if (paisa > 0) return rupeeWords + " AND " + numberToWords(paisa) + " PAISE ONLY";
  return rupeeWords + " RUPEES ONLY";
}
// ---------------------------------------------------------------------------

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

  function recomputeItem(dcItem, invoiceItem, fallbackMarginPct) {
    const designKey = `${(dcItem.styleNo ?? "").trim()}|${(dcItem.color ?? "").trim()}`.toLowerCase();
    const sizeMap = designPriceIndex.get(designKey);
    const invMrp = Number(invoiceItem?.mrp) || 0;
    const invPrice = Number(invoiceItem?.price) || 0;
    const factor = invMrp > 0 && invPrice > 0 ? invPrice / invMrp : (1 - fallbackMarginPct / 100);
    const storedMrp = Number(dcItem.mrp) || 0;
    const mrpBySize = {};
    let amount = 0;
    let anySizeDiffers = false;
    for (const [size, qty] of Object.entries(dcItem.sizeQty ?? {})) {
      const sizeKey = `${size}|${(dcItem.sleeveType ?? "").trim()}`.toLowerCase();
      const price = sizeMap?.get(sizeKey);
      const effectiveMrp = price != null && price > 0 ? price : storedMrp;
      if (price != null && price > 0) mrpBySize[size] = price;
      if (price != null && price > 0 && price !== storedMrp) anySizeDiffers = true;
      amount += qty * Math.round(effectiveMrp * factor * 100) / 100;
    }
    amount = Math.round(amount * 100) / 100;
    return { amount, anySizeDiffers, factor };
  }

  const plans = [];
  for (const invoice of invoices) {
    if (invoice.irn) continue;
    const dcIds = invoice.dcIds?.length ? invoice.dcIds : (invoice.dcId ? [invoice.dcId] : []);
    const invDcs = dcIds.map((id) => dcById.get(id)).filter(Boolean);
    if (!invDcs.length) continue;
    const predatesFix = invDcs.some((dc) => (dc.items ?? []).some((it) => it.mrpBySize == null));
    if (!predatesFix) continue;

    const flatDcItems = invDcs.flatMap((dc) => (dc.items ?? []).map((item) => ({ item, dc })));
    if (flatDcItems.length !== (invoice.items ?? []).length) continue;

    let grossNew = 0;
    let anyDiff = false;
    const newInvoiceItems = [];
    const newDcItemsByDc = new Map(); // dcId -> array of {item index in dc.items, item}
    flatDcItems.forEach(({ item, dc }, i) => {
      const fallbackMarginPct = clientById.get(dc.clientId)?.marginPct ?? 0;
      const { amount, anySizeDiffers } = recomputeItem(item, invoice.items[i], fallbackMarginPct);
      grossNew += amount;
      if (anySizeDiffers) anyDiff = true;

      const designKey = `${(item.styleNo ?? "").trim()}|${(item.color ?? "").trim()}`.toLowerCase();
      const sizeMap = designPriceIndex.get(designKey);
      const storedMrp = Number(item.mrp) || 0;
      const mrpBySize = {};
      for (const size of Object.keys(item.sizeQty ?? {})) {
        const sizeKey = `${size}|${(item.sleeveType ?? "").trim()}`.toLowerCase();
        const price = sizeMap?.get(sizeKey);
        if (price != null && price > 0) mrpBySize[size] = price;
      }
      const newDcItem = { ...item, mrpBySize, amount };
      if (!newDcItemsByDc.has(dc.id)) newDcItemsByDc.set(dc.id, []);
      newDcItemsByDc.get(dc.id).push(newDcItem);

      newInvoiceItems.push({ ...invoice.items[i], amount });
    });
    if (!anyDiff) continue;

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
    const totalTaxNew = Math.round((cgstNew + sgstNew + igstNew) * 100) / 100;
    const rawTotalNew = taxableNew + totalTaxNew;
    const totalNew = Math.round(rawTotalNew);
    const roundOffNew = Math.round((totalNew - rawTotalNew) * 100) / 100;
    const delta = Math.round((totalNew - (Number(invoice.totalAmount) || 0)) * 100) / 100;
    if (Math.abs(delta) < 0.5) continue;

    const dcPatches = [...newDcItemsByDc.entries()].map(([dcId, items]) => {
      const dc = dcById.get(dcId);
      const totalAmount = Math.round(items.reduce((s, it) => s + (it.amount || 0), 0) * 100) / 100;
      return { dcId, items, totalAmount, dcNo: dc.dcNo };
    });

    plans.push({
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      oldTotal: invoice.totalAmount,
      newTotal: totalNew,
      delta,
      invoicePatch: {
        items: newInvoiceItems,
        grossAmount: grossNew,
        discountAmount: discountNew,
        taxableValue: taxableNew,
        cgstAmount: cgstNew,
        sgstAmount: sgstNew,
        igstAmount: igstNew,
        totalTaxAmount: totalTaxNew,
        roundOff: roundOffNew,
        totalAmount: totalNew,
        amountInWords: amountToWords(totalNew),
      },
      dcPatches,
    });
  }

  console.log(`Invoices to correct: ${plans.length}`);
  for (const p of plans) console.log(`  ${p.invoiceNo}: ${p.oldTotal} -> ${p.newTotal} (${p.delta > 0 ? "+" : ""}${p.delta})  [DCs: ${p.dcPatches.map((d) => d.dcNo).join(", ")}]`);

  if (!APPLY) {
    console.log("\nDry run only (no --apply flag) — no writes performed.");
    console.log("Re-run with --apply to write these corrections to production Firestore.");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(__dirname, `invoiced-dc-mrp-fix-backup-${timestamp}.json`);
  const backup = plans.map((p) => ({
    invoiceId: p.invoiceId,
    invoiceNo: p.invoiceNo,
    beforeInvoice: invoices.find((i) => i.id === p.invoiceId),
    beforeDCs: p.dcPatches.map((d) => dcById.get(d.dcId)),
  }));
  await writeFile(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup of ${backup.length} invoice+DC set(s) written to ${backupPath}`);

  console.log(`\nApplying ${plans.length} correction(s)...`);
  for (const p of plans) {
    await patchDoc("invoices", p.invoiceId, p.invoicePatch);
    for (const d of p.dcPatches) {
      await patchDoc("deliveryChallans", d.dcId, { items: d.items, totalAmount: d.totalAmount, updatedAt: new Date() });
    }
  }
  console.log(`\nDone. ${plans.length} Invoice(s) + their DC(s) corrected.`);
}

main().catch((err) => {
  console.error("Fix failed:", err);
  process.exit(1);
});
