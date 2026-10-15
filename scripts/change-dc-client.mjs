// Moves one Delivery Challan (and its Packing List) to a different Client
// Master entry: clientId + the client snapshot fields the DC carries (name,
// Ship To address, GSTIN, phone). clientId must change too, not just the
// name — DeliveryChallanService.syncClientFromMaster re-pulls the snapshot
// by clientId before every print. Items/prices are left as they are; the
// script reports when the two clients' Margin% differs. Refuses a DC that
// already has an Invoice. Dry run by default; --apply writes one atomic
// commit after a JSON backup.
//
// Usage: node scripts/change-dc-client.mjs --dc DCC2627-1838 --client "N.PARVATHY SILKS - THENI" [--apply]
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const DC_NO = arg("--dc");
const CLIENT_NAME = arg("--client");
if (!DC_NO || !CLIENT_NAME) throw new Error("--dc and --client are required");

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

async function main() {
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${DC_NO} → ${CLIENT_NAME}\n`);

  const dcDocs = await runQuery("deliveryChallans", fieldFilter("dcNo", "EQUAL", str(DC_NO)));
  if (dcDocs.length !== 1) throw new Error(`Expected 1 DC ${DC_NO}, found ${dcDocs.length}`);
  const dcRaw = dcDocs[0];
  const dc = { id: docId(dcRaw.name), ...decodeFields(dcRaw.fields) };

  const clients = (await listDocs("clients")).map((d) => ({ id: docId(d.name), ...decodeFields(d.fields) }));
  const matches = clients.filter((c) => norm(c.clientName) === norm(CLIENT_NAME));
  if (matches.length !== 1) {
    const near = clients.filter((c) => norm(c.clientName).includes("PARVATH")).map((c) => `${c.clientName} [${c.id}] ${c.status ?? ""}`);
    throw new Error(`Expected 1 client "${CLIENT_NAME}", found ${matches.length}. Similar: ${near.join(" | ")}`);
  }
  const client = matches[0];
  const oldClient = clients.find((c) => c.id === dc.clientId);

  const plRaw = dc.packingListId ? await getDoc(`packingLists/${dc.packingListId}`) : null;
  const pl = plRaw ? { id: docId(plRaw.name), ...decodeFields(plRaw.fields) } : null;
  const otherDCs = pl
    ? (await runQuery("deliveryChallans", fieldFilter("packingListId", "EQUAL", str(pl.id)))).filter((d) => docId(d.name) !== dc.id)
    : [];
  const invoices = [
    ...(await runQuery("invoices", fieldFilter("dcIds", "ARRAY_CONTAINS", str(dc.id)))),
    ...(await runQuery("invoices", fieldFilter("dcId", "EQUAL", str(dc.id)))),
  ];

  console.log(`DC        ${dc.dcNo}  qty ${dc.totalQty}  amount ${dc.totalAmount}  SO ${(dc.salesNos ?? []).join(",")}`);
  console.log(`  from    ${dc.clientName} [${dc.clientId}]  margin ${oldClient?.marginPct ?? "?"}%  agent ${oldClient?.agentName ?? ""}`);
  console.log(`  to      ${client.clientName} [${client.id}]  margin ${client.marginPct ?? 0}%  agent ${client.agentName ?? ""}  status ${client.status}`);
  console.log(`          ${client.shipToAddress || client.billingAddress || ""}, ${client.shipToPlace || client.place || ""}, ${client.shipToState || client.state || ""} ${client.shipToZipCode || client.zipCode || ""}  GSTIN ${client.gstNo ?? ""}`);
  console.log(`Packing List ${pl ? `${pl.packingListNo} client ${pl.clientName} [${pl.clientId}]` : "none"}  other DCs on it: ${otherDCs.length}`);
  console.log(`Invoices: ${invoices.length}  deliveries: ${(dc.deliveries ?? []).length}  LR/agent on DC: ${dc.agentName ?? ""}`);

  const problems = [];
  if (invoices.length || dc.invoiceId) problems.push("DC already has an Invoice");
  if (otherDCs.length) problems.push("Packing List holds other DCs");
  if ((oldClient?.marginPct ?? 0) !== (client.marginPct ?? 0)) problems.push(`Margin% differs (${oldClient?.marginPct ?? 0} vs ${client.marginPct ?? 0}) — DC prices would need recalculating`);
  if (problems.length) { console.log(`\nSTOP: ${problems.join("; ")}`); return; }

  const now = { timestampValue: new Date().toISOString() };
  const dcPatch = {
    clientId: str(client.id),
    clientName: str(client.clientName),
    billingAddress: str(client.shipToAddress || client.billingAddress || ""),
    place: str(client.shipToPlace || client.place || ""),
    state: str(client.shipToState || client.state || ""),
    zipCode: str(client.shipToZipCode || client.zipCode || ""),
    clientPhone: str(client.mobile ?? ""),
    clientGstin: str(client.gstNo ?? ""),
    updatedAt: now,
  };
  const writes = [{ update: { name: dcRaw.name, fields: dcPatch }, updateMask: { fieldPaths: Object.keys(dcPatch) } }];
  if (pl) {
    const plPatch = { clientId: str(client.id), clientName: str(client.clientName), updatedAt: now };
    writes.push({ update: { name: plRaw.name, fields: plPatch }, updateMask: { fieldPaths: Object.keys(plPatch) } });
  }
  console.log(`\nWill update: DC ${dc.dcNo}${pl ? ` + Packing List ${pl.packingListNo}` : ""} (clientId/name/address/GSTIN/phone)`);
  if (!APPLY) { console.log("\nDry run only — re-run with --apply to write."); return; }

  const backupPath = join(__dirname, `change-dc-client-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(backupPath, JSON.stringify({ dc: dcRaw, packingList: plRaw }, null, 2));
  console.log(`Backup written: ${backupPath}`);
  await commit(writes);
  console.log("Done.");
}

main().catch((err) => { console.error(err); process.exit(1); });
