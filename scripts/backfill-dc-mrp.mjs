// Backfills size-wise MRP into pre-fix DC (Delivery Challan) documents that
// have NOT been invoiced yet. Before the DC-generation fix, a row grouping
// several sizes of the same design/color/sleeve stored ONE flat `mrp` (taken
// from whichever size was scanned first) and billed every size in the row at
// that single price. This recomputes each item's `mrpBySize` (per size) and
// `amount` from CURRENT Design Master prices, matched by styleNo+color+
// sleeveType+size (not by raw barcode, to sidestep any barcode duplication).
//
// Scope: only DCs where dc.invoiceId is unset (no Invoice/E-Invoice exists
// yet), so this can never touch an already-issued financial document.
//
// Usage:
//   node scripts/backfill-dc-mrp.mjs            (dry run, no writes)
//   node scripts/backfill-dc-mrp.mjs --apply     (writes to production)
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

async function patchDCDoc(docId, items, totalAmount) {
  const url = new URL(`${BASE_URL}/deliveryChallans/${docId}`);
  url.searchParams.set("updateMask.fieldPaths", "items");
  url.searchParams.append("updateMask.fieldPaths", "totalAmount");
  url.searchParams.append("updateMask.fieldPaths", "updatedAt");
  url.searchParams.set("key", API_KEY);

  const res = await fetchWithRetry(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        items: encodeValue(items),
        totalAmount: { doubleValue: totalAmount },
        updatedAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  if (!res.ok) throw new Error(`Patch failed for deliveryChallans/${docId}: ${res.status} ${await res.text()}`);
}

async function main() {
  const [dcRaw, designRaw, clientRaw] = await Promise.all([
    listAllDocs("deliveryChallans"),
    listAllDocs("designs"),
    listAllDocs("clients"),
  ]);
  const dcs = dcRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const designs = designRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const clients = clientRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  // designPriceIndex: `${styleNo}|${color}` -> { `${size}|${sleeveType}` -> price }
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

  const targets = dcs.filter((dc) => !dc.invoiceId && (dc.items ?? []).some((it) => it.mrpBySize == null));
  console.log(`Target DCs (no Invoice yet, pre-fix items): ${targets.length}`);

  const plans = [];
  for (const dc of targets) {
    // Derive each item's own margin factor from its ALREADY-STORED price/mrp
    // (price = mrp * (1 - marginPct/100) at creation time) rather than
    // recomputing from the Client's CURRENT marginPct — the Client's margin
    // may have changed since this DC was created, and that is a separate
    // concern from the size-wise MRP bug this script targets. Falling back
    // to the client's current margin only when the item has no usable
    // stored price/mrp to derive a factor from.
    const fallbackMarginPct = clientById.get(dc.clientId)?.marginPct ?? 0;
    let changedAny = false;
    const newItems = (dc.items ?? []).map((item) => {
      const designKey = `${(item.styleNo ?? "").trim()}|${(item.color ?? "").trim()}`.toLowerCase();
      const sizeMap = designPriceIndex.get(designKey);
      const storedMrp = Number(item.mrp) || 0;
      const storedPrice = Number(item.price) || 0;
      const factor = storedMrp > 0 && storedPrice > 0 ? storedPrice / storedMrp : (1 - fallbackMarginPct / 100);
      const mrpBySize = {};
      let amount = 0;
      for (const [size, qty] of Object.entries(item.sizeQty ?? {})) {
        const sizeKey = `${size}|${(item.sleeveType ?? "").trim()}`.toLowerCase();
        const price = sizeMap?.get(sizeKey);
        const effectiveMrp = price != null && price > 0 ? price : storedMrp;
        if (price != null && price > 0) mrpBySize[size] = price;
        amount += qty * Math.round(effectiveMrp * factor * 100) / 100;
      }
      amount = Math.round(amount * 100) / 100;
      if (Math.abs(amount - (Number(item.amount) || 0)) > 0.01) changedAny = true;
      return { ...item, mrpBySize, amount };
    });
    const totalAmount = Math.round(newItems.reduce((s, it) => s + (it.amount || 0), 0) * 100) / 100;
    plans.push({ dc, newItems, totalAmount, changedAny, oldTotalAmount: dc.totalAmount });
  }

  const willChangeAmount = plans.filter((p) => p.changedAny);
  console.log(`Of those, ${willChangeAmount.length} have at least one item whose amount actually changes.`);
  console.log(`(The rest get mrpBySize populated for future consistency, but their totals were already correct.)`);

  for (const p of willChangeAmount.slice(0, 20)) {
    console.log(`  DC ${p.dc.dcNo}: totalAmount ${p.oldTotalAmount} -> ${p.totalAmount}`);
  }

  if (!APPLY) {
    console.log(`\nDry run only (no --apply flag) — no writes performed.`);
    console.log(`Re-run with --apply to write mrpBySize + corrected amounts to these ${targets.length} DC(s).`);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(__dirname, `dc-mrp-backfill-backup-${timestamp}.json`);
  await writeFile(backupPath, JSON.stringify(targets.map((dc) => ({ id: dc.id, dcNo: dc.dcNo, items: dc.items, totalAmount: dc.totalAmount })), null, 2));
  console.log(`\nBackup of ${targets.length} doc(s) written to ${backupPath}`);

  console.log(`\nApplying ${plans.length} correction(s)...`);
  let patched = 0;
  for (const p of plans) {
    await patchDCDoc(p.dc.id, p.newItems, p.totalAmount);
    patched++;
    if (patched % 50 === 0) console.log(`  ...${patched}/${plans.length} patched`);
  }
  console.log(`\nDone. ${patched} DC doc(s) updated with size-wise MRP.`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
