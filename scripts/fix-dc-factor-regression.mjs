// Fixes a regression introduced by apply-invoiced-dc-mrp-fix.mjs: that
// script derived ONE margin factor per DC item (from the Invoice item's own
// price/mrp) and used it to recompute BOTH the Invoice item's amount AND the
// DC item's amount. That's correct for the Invoice (Invoice always re-derives
// price fresh from the Client's marginPct at invoice-generation time), but
// WRONG for the DC — a DC applies its own margin captured at DC-creation
// time (see DC comment "DC applies Margin only"), which is frequently a
// DIFFERENT number than what the Invoice used later (margin can change
// between DC creation and invoicing). For DCs whose own stored price/mrp
// ratio was 1.0 (no margin), this bug replaced their DC Amount with a
// margin-discounted figure that DC was never supposed to carry.
//
// This re-derives each affected DC item's amount using THAT DC's OWN
// original price/mrp ratio (read from the backup file written by
// apply-invoiced-dc-mrp-fix.mjs, i.e. the true pre-regression value), with
// each size's corrected MRP from Design Master. The Invoice documents are
// NOT touched — they were already correct.
//
// Usage:
//   node scripts/fix-dc-factor-regression.mjs <backup-file.json>            (dry run)
//   node scripts/fix-dc-factor-regression.mjs <backup-file.json> --apply    (writes)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const backupFile = process.argv[2];
if (!backupFile || backupFile === "--apply") {
  console.error("Usage: node scripts/fix-dc-factor-regression.mjs <backup-file.json> [--apply]");
  process.exit(1);
}

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

async function main() {
  const backup = JSON.parse(await readFile(backupFile, "utf8"));

  const [designRaw, clientRaw, currentDcRaw] = await Promise.all([
    listAllDocs("designs"),
    listAllDocs("clients"),
    listAllDocs("deliveryChallans"),
  ]);
  const designs = designRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const clients = clientRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const currentDcs = currentDcRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const currentDcById = new Map(currentDcs.map((d) => [d.id, d]));

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

  const plans = [];
  for (const entry of backup) {
    for (const beforeDc of entry.beforeDCs) {
      const currentDc = currentDcById.get(beforeDc.id);
      if (!currentDc) { console.log(`  !! DC ${beforeDc.dcNo} not found currently, skipping`); continue; }
      const fallbackMarginPct = clientById.get(beforeDc.clientId)?.marginPct ?? 0;

      const newItems = beforeDc.items.map((origItem) => {
        const designKey = `${(origItem.styleNo ?? "").trim()}|${(origItem.color ?? "").trim()}`.toLowerCase();
        const sizeMap = designPriceIndex.get(designKey);
        const storedMrp = Number(origItem.mrp) || 0;
        const storedPrice = Number(origItem.price) || 0;
        // THE FIX: use THIS DC's own original factor, not the Invoice's.
        const factor = storedMrp > 0 && storedPrice > 0 ? storedPrice / storedMrp : (1 - fallbackMarginPct / 100);
        const mrpBySize = {};
        let amount = 0;
        for (const [size, qty] of Object.entries(origItem.sizeQty ?? {})) {
          const sizeKey = `${size}|${(origItem.sleeveType ?? "").trim()}`.toLowerCase();
          const price = sizeMap?.get(sizeKey);
          const effectiveMrp = price != null && price > 0 ? price : storedMrp;
          if (price != null && price > 0) mrpBySize[size] = price;
          amount += qty * Math.round(effectiveMrp * factor * 100) / 100;
        }
        amount = Math.round(amount * 100) / 100;
        return { ...origItem, mrpBySize, amount };
      });
      const totalAmount = Math.round(newItems.reduce((s, it) => s + (it.amount || 0), 0) * 100) / 100;

      const currentTotal = currentDc.totalAmount;
      if (Math.abs((currentTotal ?? 0) - totalAmount) < 0.01) continue; // already correct, nothing to fix

      plans.push({ dcId: beforeDc.id, dcNo: beforeDc.dcNo, items: newItems, totalAmount, currentTotal });
    }
  }

  console.log(`DC docs needing correction: ${plans.length}`);
  for (const p of plans) console.log(`  ${p.dcNo}: currently ${p.currentTotal} -> corrected ${p.totalAmount}`);

  if (!APPLY) {
    console.log("\nDry run only (no --apply flag) — no writes performed.");
    console.log("Re-run with --apply to write these corrections to production Firestore.");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(__dirname, `dc-factor-regression-fix-backup-${timestamp}.json`);
  await writeFile(backupPath, JSON.stringify(plans.map((p) => ({ dcId: p.dcId, dcNo: p.dcNo, beforeCurrentState: currentDcById.get(p.dcId) })), null, 2));
  console.log(`\nBackup of ${plans.length} doc(s) (current, pre-repair state) written to ${backupPath}`);

  for (const p of plans) {
    await patchDoc("deliveryChallans", p.dcId, { items: p.items, totalAmount: p.totalAmount, updatedAt: new Date() });
  }
  console.log(`\nDone. ${plans.length} DC doc(s) corrected back to their own margin factor.`);
}

main().catch((err) => {
  console.error("Fix failed:", err);
  process.exit(1);
});
