// 2026-10-14, SS ANDAVAR SILKS - KANGEYAM. DCC2627-1981/1982/1983 were made
// with "Generate New DC" on the same Packing Lists as DCC2627-1917/1918/1919
// (after Client Master margin 36% / discount 10% was set), then "Generate New
// Invoice" billed EVERY DC on the Packing List — so TMGC2627-2589/2590/2591
// each carry the old DC's lines too (double qty and amount).
//
// Per invoice, this rebuilds items + totals from the new DC only, using the
// same math as PackingListComponent.generateInvoice (price = MRP after
// margin, one line per DC item per MRP, discount/GST at invoice level), and
// re-points dcIds/dcId/dcNo/totalPkgs/shipmentDate at the new DC.
//
// --delete-old also deletes the old DC and its original invoice
// (TMGC2627-2516/2517/2518, which carry an IRN + e-way bill — those must be
// cancelled on the GST portal separately; this does not do that).
//
// Each pair is one atomic commit; a JSON backup of every touched doc is
// written first.
//
// Usage:
//   node scripts/fix-regenerated-dc-invoices.mjs                 (dry run)
//   node scripts/fix-regenerated-dc-invoices.mjs --delete-old --apply
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const DELETE_OLD = process.argv.includes("--delete-old");

// [invoice to fix, new DC kept on it, old DC removed from it, old DC's original invoice]
const TARGETS = [
  ["TMGC2627-2589", "DCC2627-1981", "DCC2627-1918", "TMGC2627-2517"],
  ["TMGC2627-2590", "DCC2627-1982", "DCC2627-1917", "TMGC2627-2516"],
  ["TMGC2627-2591", "DCC2627-1983", "DCC2627-1919", "TMGC2627-2518"],
];

const PROJECT_ID = "tmg-clothings";
const API_KEY = "AIzaSyB8g1fUiGZv_lBPm7FGWBTQtCpo0R35Xgg";
const DB = `projects/${PROJECT_ID}/databases/(default)`;
const BASE_URL = `https://firestore.googleapis.com/v1/${DB}/documents`;

async function fetchWithRetry(url, options, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      console.log(`  ...request failed (${err.cause?.code ?? err.name}), retry ${attempt}/${retries}`);
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
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
  if (v === null) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(v) } };
}
function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = encodeValue(v);
  return out;
}
const docId = (name) => name.split("/").pop();

async function runQuery(collectionId, where) {
  const url = new URL(`${BASE_URL}:runQuery`);
  url.searchParams.set("key", API_KEY);
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], where } }),
  });
  if (!res.ok) throw new Error(`Query failed for ${collectionId}: ${res.status} ${await res.text()}`);
  return (await res.json()).filter((r) => r.document).map((r) => r.document);
}
const fieldFilter = (field, op, value) => ({ fieldFilter: { field: { fieldPath: field }, op, value } });

async function getDoc(path) {
  const url = new URL(`${BASE_URL}/${path}`);
  url.searchParams.set("key", API_KEY);
  const res = await fetchWithRetry(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Get failed for ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function commit(writes) {
  const url = new URL(`${BASE_URL}:commit`);
  url.searchParams.set("key", API_KEY);
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) throw new Error(`Commit failed: ${res.status} ${await res.text()}`);
}

async function findOne(collectionId, field, value) {
  const docs = await runQuery(collectionId, fieldFilter(field, "EQUAL", { stringValue: value }));
  if (docs.length !== 1) throw new Error(`${collectionId} ${field}=${value}: expected 1 doc, found ${docs.length}`);
  return { id: docId(docs[0].name), raw: docs[0], ...decodeFields(docs[0].fields) };
}

// Same as src/services/pricing.util.ts priceAfterMargin.
const priceAfterMargin = (mrp, marginPct) => Math.round(mrp * (1 - (Number(marginPct) || 0) / 100) * 100) / 100;
const round2 = (n) => Math.round(n * 100) / 100;

// Same as PackingListComponent.amountToWords / numberToWords.
function numberToWords(n) {
  if (n === 0) return "ZERO";
  const ones = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
    "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
  const tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
  const twoD = (num) => num < 20 ? ones[num] : (tens[Math.floor(num / 10)] + (num % 10 ? " " + ones[num % 10] : "")).trim();
  const threeD = (num) => num >= 100 ? ones[Math.floor(num / 100)] + " HUNDRED" + (num % 100 ? " " + twoD(num % 100) : "") : twoD(num);
  const parts = [];
  if (n >= 10000000) { parts.push(threeD(Math.floor(n / 10000000)) + " CRORE"); n %= 10000000; }
  if (n >= 100000) { parts.push(twoD(Math.floor(n / 100000)) + " LAKH"); n %= 100000; }
  if (n >= 1000) { parts.push(twoD(Math.floor(n / 1000)) + " THOUSAND"); n %= 1000; }
  if (n > 0) parts.push(threeD(n));
  return parts.join(" ");
}
function amountToWords(amount) {
  const [r, p] = amount.toFixed(2).split(".");
  const paisa = parseInt(p, 10);
  if (paisa > 0) return numberToWords(parseInt(r, 10)) + " AND " + numberToWords(paisa) + " PAISE ONLY";
  return numberToWords(parseInt(r, 10)) + " RUPEES ONLY";
}

function rebuild(inv, dc, marginPct) {
  const problems = [];
  const discountPct = Number(inv.discountPct) || 0;
  const taxRate = Number(inv.items[0]?.taxRate) || 5;
  const halfTax = taxRate / 2;
  const isInterState = (Number(inv.igstAmount) || 0) > 0;
  const freightAmount = Number(inv.freightAmount) || 0;
  if (freightAmount > 0) problems.push(`invoice has freight ${freightAmount} — not handled`);
  const hsnByDesc = new Map(inv.items.map((i) => [i.description, i.hsnSac]));

  const items = dc.items.flatMap((dcItem) => {
    const qtyByMrp = new Map();
    for (const [size, qty] of Object.entries(dcItem.sizeQty ?? {})) {
      const mrp = dcItem.mrpBySize?.[size] ?? dcItem.mrp;
      qtyByMrp.set(mrp, (qtyByMrp.get(mrp) ?? 0) + qty);
    }
    if (qtyByMrp.size === 0) qtyByMrp.set(dcItem.mrp, dcItem.total);
    const hsnSac = hsnByDesc.get(dcItem.partName);
    if (!hsnSac) problems.push(`no HSN on invoice for ${dcItem.partName}`);
    return [...qtyByMrp.entries()].map(([mrp, quantity]) => {
      const price = priceAfterMargin(mrp, marginPct);
      if (price !== dcItem.price) problems.push(`${dcItem.styleNo} ${dcItem.color}: invoice price ${price} ≠ DC price ${dcItem.price}`);
      return {
        description: dcItem.partName,
        styleNo: dcItem.styleNo || undefined,
        sleeveType: dcItem.sleeveType || undefined,
        hsnSac, discountPct, taxRate, mrp, uom: "NOS", quantity, price, amount: round2(quantity * price),
      };
    });
  });

  const grossAmount = round2(items.reduce((s, i) => s + i.amount, 0));
  const discountAmount = round2(grossAmount * discountPct / 100);
  const taxableValue = round2(grossAmount - discountAmount + freightAmount);
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
      hsnSac: hsn, taxableValue: groupTaxable,
      cgstRate: isInterState ? 0 : halfTax, cgstAmount: groupCgst,
      sgstRate: isInterState ? 0 : halfTax, sgstAmount: groupCgst,
      igstRate: isInterState ? taxRate : 0, igstAmount: groupIgst,
    };
  });

  const patch = {
    items, grossAmount, discountAmount, taxableValue, cgstAmount, sgstAmount, igstAmount,
    totalTaxAmount, roundOff, totalAmount, amountInWords: amountToWords(totalAmount), taxSummary,
    dcIds: [dc.id], dcId: dc.id, dcNo: dc.dcNo, totalPkgs: Number(dc.boxCount) || 0,
  };
  return { patch, problems };
}

async function main() {
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}${DELETE_OLD ? " (+ delete old DC & invoice)" : ""}\n`);
  const plans = [];
  for (const [invNo, newDcNo, oldDcNo, oldInvNo] of TARGETS) {
    const inv = await findOne("invoices", "invoiceNo", invNo);
    const newDc = await findOne("deliveryChallans", "dcNo", newDcNo);
    const oldDc = await findOne("deliveryChallans", "dcNo", oldDcNo);
    const oldInv = await findOne("invoices", "invoiceNo", oldInvNo);
    const client = decodeFields((await getDoc(`clients/${inv.clientId}`)).fields);

    const problems = [];
    const dcIds = [...(inv.dcIds ?? [])].sort();
    if (dcIds.join() !== [newDc.id, oldDc.id].sort().join()) problems.push(`${invNo} dcIds ${dcIds} ≠ {${newDcNo}, ${oldDcNo}}`);
    if (inv.irn || inv.ewbNo) problems.push(`${invNo} already has IRN/e-way bill — fix on portal first`);
    if (newDc.invoiceId !== inv.id) problems.push(`${newDcNo}.invoiceId ${newDc.invoiceId} ≠ ${invNo}`);
    if (newDc.clientId !== inv.clientId || oldDc.clientId !== inv.clientId) problems.push("client mismatch");
    const oldInvDcIds = [oldInv.dcId, ...(oldInv.dcIds ?? [])].filter(Boolean);
    if (DELETE_OLD && oldInvDcIds.some((id) => id !== oldDc.id)) problems.push(`${oldInvNo} also covers another DC`);

    const { patch, problems: rebuildProblems } = rebuild(inv, newDc, client.marginPct);
    problems.push(...rebuildProblems);
    const newQty = patch.items.reduce((s, i) => s + i.quantity, 0);
    if (newQty !== Number(newDc.totalQty)) problems.push(`rebuilt qty ${newQty} ≠ DC qty ${newDc.totalQty}`);

    const oldQty = inv.items.reduce((s, i) => s + i.quantity, 0);
    console.log(`${invNo}  [${problems.length ? "SKIP — " + problems.join("; ") : "OK"}]`);
    console.log(`    DCs    : ${inv.dcNo}  →  ${patch.dcNo}`);
    console.log(`    Qty    : ${oldQty}  →  ${newQty}   (lines ${inv.items.length} → ${patch.items.length}, pkgs ${inv.totalPkgs} → ${patch.totalPkgs})`);
    console.log(`    Gross  : ${inv.grossAmount ?? "-"}  →  ${patch.grossAmount}`);
    console.log(`    Disc ${inv.discountPct}%: ${inv.discountAmount}  →  ${patch.discountAmount}`);
    console.log(`    Taxable: ${inv.taxableValue}  →  ${patch.taxableValue}`);
    console.log(`    GST    : ${inv.totalTaxAmount}  →  ${patch.totalTaxAmount}`);
    console.log(`    Total  : ${inv.totalAmount}  →  ${patch.totalAmount}  (${patch.amountInWords})`);
    if (DELETE_OLD) console.log(`    Delete : ${oldDcNo} + ${oldInvNo} (₹${oldInv.totalAmount}, IRN ${oldInv.irn ? "yes" : "no"}, EWB ${oldInv.ewbNo ?? "-"})`);
    plans.push({ inv, newDc, oldDc, oldInv, patch, problems });
  }

  const ok = plans.filter((p) => !p.problems.length);
  console.log(`\n${ok.length} ready, ${plans.length - ok.length} skipped.`);
  if (!APPLY) { console.log("Dry run only — re-run with --apply to write."); return; }
  if (!ok.length) return;

  const backupPath = join(__dirname, `regenerated-dc-invoice-fix-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(backupPath, JSON.stringify(ok.map((p) => ({
    invoice: p.inv.raw, ...(DELETE_OLD ? { oldDc: p.oldDc.raw, oldInvoice: p.oldInv.raw } : {}),
  })), null, 2));
  console.log(`Backup written: ${backupPath}`);

  const now = new Date().toISOString();
  for (const p of ok) {
    const fields = { ...encodeFields(p.patch), updatedAt: { timestampValue: now } };
    if (p.newDc.createdAt) fields.shipmentDate = { timestampValue: p.newDc.createdAt };
    await commit([
      {
        update: { name: p.inv.raw.name, fields },
        updateMask: { fieldPaths: Object.keys(fields) },
        currentDocument: { updateTime: p.inv.raw.updateTime },
      },
      ...(DELETE_OLD ? [
        { delete: p.oldDc.raw.name, currentDocument: { updateTime: p.oldDc.raw.updateTime } },
        { delete: p.oldInv.raw.name, currentDocument: { updateTime: p.oldInv.raw.updateTime } },
      ] : []),
    ]);
    console.log(`  fixed ${p.inv.invoiceNo} → ₹${p.patch.totalAmount}${DELETE_OLD ? `; deleted ${p.oldDc.dcNo} + ${p.oldInv.invoiceNo}` : ""}`);
  }
  console.log("\nDone.");
}

main().catch((err) => { console.error(err); process.exit(1); });
