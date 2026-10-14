// Deletes the listed Delivery Challans and their Invoice(s) — nothing else
// (user's choice, 2026-10-14, DCC2627-1917/1918/1919): no stock return, and
// the Packing List, Pick List, LR Entries and invoice counter are left as-is.
//
// A DC is SKIPPED (reported, never partially done) when its invoice also
// covers a DC outside the target list. Invoices with an IRN / e-way bill are
// flagged — deleting here does NOT cancel them on the GST portal.
//
// Each DC + its invoice(s) is one atomic Firestore commit. A JSON backup of
// every deleted doc is written first.
//
// Usage:
//   node scripts/delete-dcs-and-invoices.mjs            (dry run, no writes)
//   node scripts/delete-dcs-and-invoices.mjs --apply     (writes to production)
//   node scripts/delete-dcs-and-invoices.mjs --dc DCC2627-1917 [--apply]
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const CLI_DCS = process.argv.flatMap((arg, i, all) => (arg === "--dc" && all[i + 1] ? [all[i + 1]] : []));
const TARGETS = ["DCC2627-1917", "DCC2627-1918", "DCC2627-1919"];

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
const strArray = (values) => ({ arrayValue: { values: values.map((s) => ({ stringValue: s })) } });

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

async function main() {
  const dcNos = CLI_DCS.length ? CLI_DCS : TARGETS;
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${dcNos.length} DC(s)\n`);

  const dcs = (await runQuery("deliveryChallans", fieldFilter("dcNo", "IN", strArray(dcNos))))
    .map((d) => ({ id: docId(d.name), raw: d, ...decodeFields(d.fields) }));
  const missing = dcNos.filter((no) => !dcs.some((dc) => dc.dcNo === no));
  const dupes = dcNos.filter((no) => dcs.filter((dc) => dc.dcNo === no).length > 1);
  if (missing.length) console.log(`NOT FOUND: ${missing.join(", ")}`);
  if (dupes.length) console.log(`DUPLICATE DC NO.: ${dupes.join(", ")}`);

  const dcIds = dcs.map((dc) => dc.id);
  const invoiceDocs = new Map();
  if (dcIds.length) {
    for (const d of [
      ...(await runQuery("invoices", fieldFilter("dcIds", "ARRAY_CONTAINS_ANY", strArray(dcIds)))),
      ...(await runQuery("invoices", fieldFilter("dcId", "IN", strArray(dcIds)))),
    ]) invoiceDocs.set(docId(d.name), d);
  }
  // Also pick up invoices only linked from the DC side (dc.invoiceId).
  for (const dc of dcs) {
    if (dc.invoiceId && !invoiceDocs.has(dc.invoiceId)) {
      const d = await getDoc(`invoices/${dc.invoiceId}`);
      if (d) invoiceDocs.set(dc.invoiceId, d);
    }
  }
  const invoices = [...invoiceDocs.values()].map((d) => ({ id: docId(d.name), raw: d, ...decodeFields(d.fields) }));

  const plans = [];
  for (const dcNo of dcNos) {
    const dc = dcs.find((d) => d.dcNo === dcNo);
    if (!dc || dupes.includes(dcNo)) continue;
    const problems = [];
    const warnings = [];
    const linked = invoices.filter((inv) => inv.id === dc.invoiceId || inv.dcId === dc.id || (inv.dcIds ?? []).includes(dc.id));
    for (const inv of linked) {
      const otherDcIds = [...new Set([inv.dcId, ...(inv.dcIds ?? [])].filter((id) => id && !dcIds.includes(id)))];
      if (otherDcIds.length) problems.push(`invoice ${inv.invoiceNo} also covers other DC id(s) ${otherDcIds.join(", ")}`);
      if (inv.irn || inv.ewbNo) warnings.push(`invoice ${inv.invoiceNo} has IRN/e-way bill — cancel on GST portal separately`);
    }
    if (dc.invoiceId && !linked.some((inv) => inv.id === dc.invoiceId)) warnings.push(`dc.invoiceId ${dc.invoiceId} not found`);
    plans.push({ dc, invoices: linked, problems, warnings });
  }

  for (const p of plans) {
    const status = p.problems.length ? `SKIP — ${p.problems.join("; ")}` : "OK";
    console.log(`${p.dc.dcNo}  ${p.dc.clientName}  qty ${p.dc.totalQty}  → invoice(s) ${p.invoices.map((i) => `${i.invoiceNo} (₹${i.grandTotal ?? i.totalAmount ?? "?"})`).join(", ") || "none"}  [${status}]`);
    for (const w of p.warnings) console.log(`    WARNING: ${w}`);
  }
  // An invoice shared by two target DCs must only be deleted once.
  const ok = plans.filter((p) => !p.problems.length);
  const seen = new Set();
  for (const p of ok) p.invoices = p.invoices.filter((inv) => !seen.has(inv.id) && seen.add(inv.id));
  console.log(`\n${ok.length} ready, ${plans.length - ok.length} skipped, ${missing.length} not found. Invoices to delete: ${seen.size}.`);

  if (!APPLY) { console.log("\nDry run only — re-run with --apply to write."); return; }
  if (!ok.length) return;

  const backupPath = join(__dirname, `dc-invoice-delete-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(backupPath, JSON.stringify(ok.map((p) => ({ dc: p.dc.raw, invoices: p.invoices.map((i) => i.raw) })), null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  for (const p of ok) {
    await commit([
      { delete: p.dc.raw.name, currentDocument: { updateTime: p.dc.raw.updateTime } },
      ...p.invoices.map((inv) => ({ delete: inv.raw.name, currentDocument: { updateTime: inv.raw.updateTime } })),
    ]);
    console.log(`  deleted ${p.dc.dcNo}${p.invoices.length ? ` + invoice ${p.invoices.map((i) => i.invoiceNo).join(", ")}` : ""}`);
  }
  console.log("\nDone.");
}

main().catch((err) => { console.error(err); process.exit(1); });
