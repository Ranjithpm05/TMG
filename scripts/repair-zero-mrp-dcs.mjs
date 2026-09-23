// Repairs Delivery Challans (and any not-yet-e-invoiced Invoice raised from
// them) whose items were saved with MRP ₹0 because Design Master failed to
// load at DC-generation time (the cache fallback served an empty design
// list, so every barcode's MRP resolved to 0 — see diagnose-zero-mrp-dcs.mjs).
//
// For each affected DC, every item's MRP is looked up per size from CURRENT
// Design Master (styleNo+color+size+sleeveType — DC items carry no barcode),
// and items are split into one row per distinct MRP exactly the way
// createDCForPackingList() builds a fresh DC; price = MRP after the client's
// Margin% (priceAfterMargin). A DC with any size still unresolvable is
// SKIPPED entirely (reported) rather than partially fixed.
//
// Its Invoice (if any) is rebuilt the same way invoice generation does —
// one line per DC item per MRP, merged by description/design/sleeve/HSN/MRP/
// tax/discount — keeping the Invoice's own stored discountPct, HSN, tax
// rates and CGST+SGST vs IGST type. Invoices carrying an IRN are never
// touched (GST forbids editing a reported e-invoice).
//
// Usage:
//   node scripts/repair-zero-mrp-dcs.mjs            (dry run, no writes)
//   node scripts/repair-zero-mrp-dcs.mjs --apply     (writes to production)
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
  const res = await fetchWithRetry(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: encodeFields(fieldValues) }),
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
  const parts = amount.toFixed(2).split(".");
  const rupees = parseInt(parts[0], 10);
  const paisa = parseInt(parts[1], 10);
  const rupeeWords = numberToWords(rupees);
  if (paisa > 0) return rupeeWords + " AND " + numberToWords(paisa) + " PAISE ONLY";
  return rupeeWords + " RUPEES ONLY";
}
// ---------------------------------------------------------------------------

const round2 = (n) => Math.round(n * 100) / 100;
// Same as src/services/pricing.util.ts priceAfterMargin().
const priceAfterMargin = (mrp, marginPct) => round2(mrp * (1 - (Number(marginPct) || 0) / 100));
const norm = (s) => String(s ?? "").trim().toLowerCase();
const hasZeroMrp = (dc) => (dc?.items ?? []).some((i) => !(Number(i.mrp) > 0));

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
  if (designs.length === 0) throw new Error("Design Master returned 0 designs — refusing to run.");
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const dcById = new Map(dcs.map((d) => [d.id, d]));

  // styleNo|color|size|sleeveType -> Set of MRPs (a Set, so duplicate design
  // docs disagreeing on price are detected instead of silently picked).
  const mrpIndex = new Map();
  const mrpAnySleeveIndex = new Map(); // styleNo|color|size -> Set of MRPs
  for (const d of designs) {
    for (const s of d.sizes ?? []) {
      const price = Number(s.price) || 0;
      if (price <= 0) continue;
      const key = [norm(d.styleNo), norm(d.color), norm(s.size), norm(s.sleeveType)].join("|");
      if (!mrpIndex.has(key)) mrpIndex.set(key, new Set());
      mrpIndex.get(key).add(price);
      const anySleeveKey = [norm(d.styleNo), norm(d.color), norm(s.size)].join("|");
      if (!mrpAnySleeveIndex.has(anySleeveKey)) mrpAnySleeveIndex.set(anySleeveKey, new Set());
      mrpAnySleeveIndex.get(anySleeveKey).add(price);
    }
  }
  // Fallback for Design Master entries whose sizes carry no sleeveType (e.g.
  // ROYAL PICK LITE shade 18): match ignoring sleeve, but only when every
  // sleeve variant of that size agrees on one MRP (checked via found.size).
  const lookupMrp = (item, size) =>
    mrpIndex.get([norm(item.styleNo), norm(item.color), norm(size), norm(item.sleeveType)].join("|")) ??
    mrpAnySleeveIndex.get([norm(item.styleNo), norm(item.color), norm(size)].join("|"));

  const affectedDcs = dcs.filter(hasZeroMrp);
  const dcPlans = new Map(); // dcId -> { dc, items, totalAmount, marginPct }
  const skipped = [];

  for (const dc of affectedDcs) {
    const marginPct = clientById.get(dc.clientId)?.marginPct ?? 0;
    const problems = [];
    const rows = new Map(); // same row key as createDCForPackingList: design/color/sleeve/mrp
    for (const item of dc.items ?? []) {
      for (const [size, qty] of Object.entries(item.sizeQty ?? {})) {
        if (!(qty > 0)) continue;
        let mrp = Number(item.mrpBySize?.[size]) || Number(item.mrp) || 0;
        if (!(mrp > 0)) {
          const found = lookupMrp(item, size);
          if (!found) { problems.push(`${item.styleNo} ${item.sleeveType ?? ""} size ${size}: not in Design Master`); continue; }
          if (found.size > 1) { problems.push(`${item.styleNo} ${item.sleeveType ?? ""} size ${size}: conflicting MRPs ${[...found].join("/")}`); continue; }
          mrp = [...found][0];
        }
        const key = [item.partName, item.styleNo, item.color, item.sleeveType ?? "", mrp].join("||");
        if (!rows.has(key)) rows.set(key, { ...item, sizeQty: {}, mrpBySize: {}, total: 0, mrp });
        const row = rows.get(key);
        row.sizeQty[size] = (row.sizeQty[size] ?? 0) + qty;
        row.mrpBySize[size] = mrp;
        row.total += qty;
      }
    }
    if (problems.length) { skipped.push({ dcNo: dc.dcNo, reason: problems }); continue; }
    const items = [...rows.values()].map((row) => {
      const price = priceAfterMargin(row.mrp, marginPct);
      return { ...row, price, amount: round2(row.total * price) };
    });
    const oldQty = (dc.items ?? []).reduce((s, i) => s + (Number(i.total) || 0), 0);
    const newQty = items.reduce((s, i) => s + i.total, 0);
    if (oldQty !== newQty) { skipped.push({ dcNo: dc.dcNo, reason: [`quantity mismatch ${oldQty} vs ${newQty}`] }); continue; }
    dcPlans.set(dc.id, { dc, items, totalAmount: round2(items.reduce((s, i) => s + i.amount, 0)), marginPct });
  }

  // Invoices raised from any affected DC.
  const invoicePlans = [];
  for (const invoice of invoices) {
    const dcIds = [...new Set([...(invoice.dcIds ?? []), invoice.dcId].filter(Boolean))];
    if (!dcIds.some((id) => hasZeroMrp(dcById.get(id)))) continue;
    if (invoice.irn) { skipped.push({ dcNo: invoice.dcNo, reason: [`Invoice ${invoice.invoiceNo} has an IRN — cancel & reissue instead`] }); continue; }
    if (!dcIds.every((id) => dcPlans.has(id) || !hasZeroMrp(dcById.get(id)))) {
      skipped.push({ dcNo: invoice.dcNo, reason: [`Invoice ${invoice.invoiceNo}: a source DC could not be repaired`] });
      continue;
    }

    const oldItems = invoice.items ?? [];
    const discountPct = Number(invoice.discountPct) || 0;
    const igstRate = Number(invoice.igstRate) || 0;
    const isInterState = igstRate > 0;
    const taxRate = Number(oldItems[0]?.taxRate) || (isInterState ? igstRate : (Number(invoice.cgstRate) || 0) + (Number(invoice.sgstRate) || 0));
    const halfTax = taxRate / 2;
    const hsnByDesc = new Map(oldItems.map((i) => [i.description, i.hsnSac]));
    const fallbackHsn = oldItems[0]?.hsnSac ?? "62059090";
    const marginPct = clientById.get(invoice.clientId)?.marginPct ?? 0;

    // Mirrors invoice generation in packing-list.component.ts: one line per
    // DC item per distinct MRP, then merged by the same key.
    const flat = dcIds.flatMap((id) => (dcPlans.get(id)?.items ?? dcById.get(id)?.items ?? []).flatMap((dcItem) => {
      const qtyByMrp = new Map();
      for (const [size, qty] of Object.entries(dcItem.sizeQty ?? {})) {
        const mrp = dcItem.mrpBySize?.[size] ?? dcItem.mrp;
        qtyByMrp.set(mrp, (qtyByMrp.get(mrp) ?? 0) + qty);
      }
      if (qtyByMrp.size === 0) qtyByMrp.set(dcItem.mrp, dcItem.total);
      return [...qtyByMrp.entries()].map(([mrp, quantity]) => {
        const price = priceAfterMargin(mrp, marginPct);
        return {
          description: dcItem.partName,
          styleNo: dcItem.styleNo || undefined,
          sleeveType: dcItem.sleeveType || undefined,
          hsnSac: hsnByDesc.get(dcItem.partName) ?? fallbackHsn,
          discountPct, taxRate, mrp, uom: "NOS", quantity, price, amount: round2(quantity * price),
        };
      });
    }));
    const merged = new Map();
    for (const item of flat) {
      const key = [item.description, item.styleNo ?? "", item.sleeveType ?? "", item.hsnSac, item.mrp, item.taxRate, item.discountPct].join("|");
      const existing = merged.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.amount = round2(existing.amount + item.amount);
      } else merged.set(key, { ...item });
    }
    const items = [...merged.values()];
    if (items.some((i) => !(i.mrp > 0) || !(i.price > 0))) {
      skipped.push({ dcNo: invoice.dcNo, reason: [`Invoice ${invoice.invoiceNo}: still has ₹0 lines after repair`] });
      continue;
    }
    const oldQty = oldItems.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    const newQty = items.reduce((s, i) => s + i.quantity, 0);
    if (oldQty !== newQty) {
      skipped.push({ dcNo: invoice.dcNo, reason: [`Invoice ${invoice.invoiceNo}: quantity mismatch ${oldQty} vs ${newQty}`] });
      continue;
    }

    const grossAmount = round2(items.reduce((s, i) => s + i.amount, 0));
    const discountAmount = round2(grossAmount * discountPct / 100);
    const taxableValue = round2(grossAmount - discountAmount);
    const cgstAmount = isInterState ? 0 : round2(taxableValue * halfTax / 100);
    const sgstAmount = cgstAmount;
    const igstAmount = isInterState ? round2(taxableValue * taxRate / 100) : 0;
    const totalTaxAmount = round2(cgstAmount + sgstAmount + igstAmount);
    const rawTotal = taxableValue + totalTaxAmount;
    const totalAmount = Math.round(rawTotal);
    const roundOff = round2(totalAmount - rawTotal);

    const grossByHsn = new Map();
    for (const item of items) grossByHsn.set(item.hsnSac, (grossByHsn.get(item.hsnSac) ?? 0) + item.amount);
    const taxSummary = [...grossByHsn.entries()].map(([hsn, groupGross]) => {
      const groupTaxable = round2(groupGross - groupGross * discountPct / 100);
      const groupCgst = isInterState ? 0 : round2(groupTaxable * halfTax / 100);
      const groupIgst = isInterState ? round2(groupTaxable * taxRate / 100) : 0;
      return {
        hsnSac: hsn,
        taxableValue: groupTaxable,
        cgstRate: isInterState ? 0 : halfTax, cgstAmount: groupCgst,
        sgstRate: isInterState ? 0 : halfTax, sgstAmount: groupCgst,
        igstRate: isInterState ? taxRate : 0, igstAmount: groupIgst,
      };
    });

    invoicePlans.push({
      invoice,
      patch: {
        items, grossAmount, discountAmount, taxableValue,
        cgstAmount, sgstAmount, igstAmount, totalTaxAmount, roundOff, totalAmount,
        amountInWords: amountToWords(totalAmount), taxSummary, updatedAt: new Date(),
      },
    });
  }

  console.log(`DCs with ₹0 MRP: ${affectedDcs.length}; repairable: ${dcPlans.size}; invoices to repair: ${invoicePlans.length}; skipped: ${skipped.length}\n`);
  for (const { dc, items, totalAmount, marginPct } of dcPlans.values()) {
    console.log(`  DC ${dc.dcNo}  ${dc.clientName}  margin ${marginPct}%  rows ${dc.items.length}->${items.length}  qty ${items.reduce((s, i) => s + i.total, 0)}  ₹${dc.totalAmount ?? 0} -> ₹${totalAmount}`);
  }
  for (const { invoice, patch } of invoicePlans) {
    console.log(`\n  Invoice ${invoice.invoiceNo} (DC ${invoice.dcNo})  gross ₹${patch.grossAmount}  disc ₹${patch.discountAmount}  taxable ₹${patch.taxableValue}  CGST ₹${patch.cgstAmount}  SGST ₹${patch.sgstAmount}  IGST ₹${patch.igstAmount}  roundOff ${patch.roundOff}  TOTAL ₹${invoice.totalAmount} -> ₹${patch.totalAmount}`);
    console.log(`    ${patch.amountInWords}`);
    for (const i of patch.items) console.log(`      ${i.styleNo} ${i.sleeveType ?? ""}  MRP ${i.mrp}  qty ${i.quantity}  price ${i.price}  amt ${i.amount}`);
  }
  for (const s of skipped) console.log(`\n  SKIPPED ${s.dcNo}: ${s.reason.join("; ")}`);

  if (!APPLY) {
    console.log("\nDry run only (no --apply flag) — no writes performed.");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(__dirname, `zero-mrp-repair-backup-${timestamp}.json`);
  await writeFile(backupPath, JSON.stringify({
    dcs: [...dcPlans.values()].map((p) => p.dc),
    invoices: invoicePlans.map((p) => p.invoice),
  }, null, 2));
  console.log(`\nBackup written to ${backupPath}`);

  for (const { dc, items, totalAmount } of dcPlans.values()) {
    await patchDoc("deliveryChallans", dc.id, { items, totalAmount, updatedAt: new Date() });
    console.log(`  patched DC ${dc.dcNo}`);
  }
  for (const { invoice, patch } of invoicePlans) {
    await patchDoc("invoices", invoice.id, patch);
    console.log(`  patched Invoice ${invoice.invoiceNo}`);
  }
  console.log(`\nDone. ${dcPlans.size} DC(s), ${invoicePlans.length} Invoice(s) repaired.`);
}

main().catch((err) => {
  console.error("Repair failed:", err);
  process.exit(1);
});
