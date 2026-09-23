// READ-ONLY — no writes. Lists Delivery Challans that carry one or more
// items with MRP ₹0 (built while Design Master failed to load — the cache
// fallback served an empty design list, so every barcode's MRP resolved to
// 0), plus any Invoice raised from them and whether it already has an IRN
// (an e-invoiced Invoice can't be edited, only cancelled + reissued).
//
// Usage: node scripts/diagnose-zero-mrp-dcs.mjs
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  const [dcRaw, invoiceRaw] = await Promise.all([listAllDocs("deliveryChallans"), listAllDocs("invoices")]);
  const dcs = dcRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
  const invoices = invoiceRaw.map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));

  const invoicesByDcId = new Map();
  for (const inv of invoices) {
    for (const dcId of new Set([...(inv.dcIds ?? []), inv.dcId].filter(Boolean))) {
      if (!invoicesByDcId.has(dcId)) invoicesByDcId.set(dcId, []);
      invoicesByDcId.get(dcId).push(inv);
    }
  }

  const affected = [];
  for (const dc of dcs) {
    const items = dc.items ?? [];
    const zeroItems = items.filter((i) => !(Number(i.mrp) > 0));
    if (zeroItems.length === 0) continue;
    const invs = invoicesByDcId.get(dc.id) ?? [];
    affected.push({
      dcId: dc.id,
      dcNo: dc.dcNo,
      clientName: dc.clientName,
      createdAt: dc.createdAt,
      zeroItems: zeroItems.length,
      totalItems: items.length,
      dcTotalAmount: dc.totalAmount ?? null,
      invoices: invs.map((i) => ({ id: i.id, invoiceNo: i.invoiceNo, totalAmount: i.totalAmount, irn: i.irn ?? null })),
    });
  }
  affected.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  console.log(`DCs scanned: ${dcs.length}; with ₹0-MRP items: ${affected.length}\n`);
  for (const a of affected) {
    const inv = a.invoices.length
      ? a.invoices.map((i) => `${i.invoiceNo} (₹${i.totalAmount}${i.irn ? ", HAS IRN" : ""})`).join(", ")
      : "not invoiced";
    console.log(`${a.dcNo}  ${a.createdAt}  ${a.clientName}  zero items ${a.zeroItems}/${a.totalItems}  → ${inv}`);
  }

  const outPath = join(__dirname, "zero-mrp-dcs-review.json");
  await writeFile(outPath, JSON.stringify(affected, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
