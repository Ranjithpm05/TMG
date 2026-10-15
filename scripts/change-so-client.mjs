// Moves one Sales Order to a different Client Master entry (clientId, plus
// clientName if the doc carries one). Companion to change-dc-client.mjs.
// Lists every Pick List / Packing List / DC / Invoice that references the
// Sales Order and STOPS if any of them still belongs to the old client —
// those have to be moved first (or deliberately left) so the SO and its
// documents don't disagree. Dry run by default; --apply writes after a
// JSON backup.
//
// Usage: node scripts/change-so-client.mjs --so SO-1785590347043 --client "N.PARVATHY SILKS - THENI" [--apply]
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const SO_NO = arg("--so");
const CLIENT_NAME = arg("--client");
if (!SO_NO || !CLIENT_NAME) throw new Error("--so and --client are required");

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

async function commit(writes) {
  const url = new URL(`${BASE_URL}:commit`);
  url.searchParams.set("key", API_KEY);
  // 429 = write-bandwidth exhausted; the commit is atomic, so retrying is safe.
  for (let attempt = 1; ; attempt++) {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ writes }),
    });
    if (res.ok) return;
    if (res.status === 429 && attempt < 8) {
      const waitMs = Math.min(60000, 2000 * 2 ** (attempt - 1));
      console.log(`  ...429 write limit, retry ${attempt}/7 in ${waitMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    throw new Error(`Commit failed: ${res.status} ${await res.text()}`);
  }
}

async function getDoc(path) {
  const url = new URL(`${BASE_URL}/${path}`);
  url.searchParams.set("key", API_KEY);
  const res = await fetchWithRetry(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Get failed for ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listDocs(path) {
  const docs = [];
  let pageToken;
  do {
    const url = new URL(`${BASE_URL}/${path}`);
    url.searchParams.set("pageSize", "300");
    url.searchParams.set("key", API_KEY);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`List failed for ${path}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    docs.push(...(data.documents ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs;
}

const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const str = (s) => ({ stringValue: String(s ?? "") });
const decodeAll = (docs) => docs.map((d) => ({ id: docId(d.name), raw: d, ...decodeFields(d.fields) }));

async function main() {
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${SO_NO} → ${CLIENT_NAME}\n`);

  let soDocs = await runQuery("salesOrders", fieldFilter("salesNo", "EQUAL", str(SO_NO)));
  if (!soDocs.length) soDocs = await runQuery("salesOrders", fieldFilter("salesOrderNo", "EQUAL", str(SO_NO)));
  if (soDocs.length !== 1) throw new Error(`Expected 1 Sales Order ${SO_NO}, found ${soDocs.length}`);
  const [so] = decodeAll(soDocs);

  const clients = decodeAll(await listDocs("clients"));
  const matches = clients.filter((c) => norm(c.clientName) === norm(CLIENT_NAME));
  if (matches.length !== 1) throw new Error(`Expected 1 client "${CLIENT_NAME}", found ${matches.length}`);
  const client = matches[0];
  const oldClient = clients.find((c) => c.id === so.clientId);

  console.log(`SO        ${SO_NO} [${so.id}]  status ${so.status ?? ""}  fields: ${Object.keys(so).filter((k) => /client|party|agent|margin/i.test(k)).join(", ")}`);
  console.log(`  from    ${oldClient?.clientName ?? so.clientName ?? "?"} [${so.clientId}]  margin ${oldClient?.marginPct ?? "?"}%`);
  console.log(`  to      ${client.clientName} [${client.id}]  margin ${client.marginPct ?? 0}%`);

  const related = [];
  for (const [coll, label] of [["pickLists", "Pick List"], ["packingLists", "Packing List"], ["deliveryChallans", "DC"], ["invoices", "Invoice"]]) {
    const docs = [
      ...(await runQuery(coll, fieldFilter("salesOrderIds", "ARRAY_CONTAINS", str(so.id)))),
      ...(await runQuery(coll, fieldFilter("salesOrderId", "EQUAL", str(so.id)))),
    ];
    const seen = new Set();
    for (const d of decodeAll(docs)) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const no = d.dcNo || d.invoiceNo || d.packingListNo || d.pickListNo || d.id;
      related.push({ label, no, clientId: d.clientId, clientName: d.clientName });
    }
  }
  for (const r of related) console.log(`  ${r.label.padEnd(13)} ${r.no}  client ${r.clientName ?? ""} [${r.clientId ?? ""}]${r.clientId === client.id ? "" : "  <-- not THENI"}`);
  if (!related.length) console.log("  (no Pick List / Packing List / DC / Invoice found)");

  const problems = [];
  const stale = related.filter((r) => r.clientId && r.clientId !== client.id);
  if (stale.length) problems.push(`${stale.length} related doc(s) still on another client`);
  if ((oldClient?.marginPct ?? 0) !== (client.marginPct ?? 0)) problems.push("Margin% differs between clients");
  if (problems.length) { console.log(`\nSTOP: ${problems.join("; ")}`); return; }

  const patch = { clientId: str(client.id), updatedAt: { timestampValue: new Date().toISOString() } };
  if ("clientName" in so) patch.clientName = str(client.clientName);
  console.log(`\nWill update Sales Order: ${Object.keys(patch).join(", ")}`);
  if (!APPLY) { console.log("\nDry run only — re-run with --apply to write."); return; }

  const backupPath = join(__dirname, `change-so-client-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(backupPath, JSON.stringify({ salesOrder: so.raw }, null, 2));
  console.log(`Backup written: ${backupPath}`);
  await commit([{ update: { name: so.raw.name, fields: patch }, updateMask: { fieldPaths: Object.keys(patch) } }]);
  console.log("Done.");
}

main().catch((err) => { console.error(err); process.exit(1); });
