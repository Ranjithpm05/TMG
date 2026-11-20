// Reconciles a COMPLETED stock adjustment that was completed while unscanned
// products kept their book stock (completion rule between commit e4b3207 and the
// 2026-11-20 fix — e.g. SA-0001 DENIM TROUSER: 587 pcs scanned, 602 in inventory).
// The current rule (stock-adjustment.engine.ts completeSession) treats a completed
// adjustment as a full count: products with book stock that were neither scanned
// nor zero-confirmed are set to 0. This script applies exactly that, after the fact:
//
//  - Targets: inventory docs of the session's group with currentStock != 0 and no
//    applied line in the session. Design Master "DM_" items are never targets.
//  - A target is applied only if its inventory doc was NOT written since the
//    session completed (commit precondition on updateTime) — any movement after
//    completion means a person must look at it, so it is SKIPPED and reported.
//  - One atomic commit: inventory currentStock := 0, an audit line per product in
//    the session's lines subcollection (applied, previousStock, countedQty 0,
//    variance, unscannedZeroed, reconciledBy/At/Note — same shape the app writes),
//    the session's result counters incremented, and a `reconciliations` entry on
//    the session. Nothing is deleted or overwritten in history.
//  - Idempotent: a re-run finds the audit lines already applied and does nothing.
//  - A JSON backup of every doc it touches is written before any write.
//
// Usage:
//   node scripts/reconcile-stock-adjustment-unscanned.mjs --adjustment SA-0001           (dry run)
//   node scripts/reconcile-stock-adjustment-unscanned.mjs --adjustment SA-0001 --apply   (writes to production)
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const argAfter = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const ADJUSTMENT_NO = argAfter("--adjustment");
const NOTE = "Not scanned in a completed full count — set to 0 (completion previously left unscanned products at book stock).";
const BY = "script:reconcile-stock-adjustment-unscanned";

const PROJECT_ID = "tmg-clothings";
const API_KEY = "AIzaSyB8g1fUiGZv_lBPm7FGWBTQtCpo0R35Xgg";
const DB = `projects/${PROJECT_ID}/databases/(default)`;
const BASE_URL = `https://firestore.googleapis.com/v1/${DB}/documents`;

async function fetchWithRetry(url, options, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
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
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeValue(x)])) } };
}
const docId = (name) => name.split("/").pop();
const asRecord = (d) => ({ id: docId(d.name), name: d.name, updateTime: d.updateTime, ...decodeFields(d.fields) });

async function runQuery(collectionId, where, parent = "") {
  const url = new URL(`${BASE_URL}${parent ? "/" + parent : ""}:runQuery`);
  url.searchParams.set("key", API_KEY);
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], where } }),
  });
  if (!res.ok) throw new Error(`Query failed for ${collectionId}: ${res.status} ${await res.text()}`);
  return (await res.json()).filter((r) => r.document).map((r) => asRecord(r.document));
}
const fieldFilter = (field, op, value) => ({ fieldFilter: { field: { fieldPath: field }, op, value } });

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
    docs.push(...(data.documents ?? []).map(asRecord));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs;
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

const sameGroup = (a, b) => String(a ?? "").trim().toUpperCase() === String(b ?? "").trim().toUpperCase();
const serverTime = (fieldPath) => ({ fieldPath, setToServerValue: "REQUEST_TIME" });

// ─────────────────────────────────────────────────────────────────────────────
if (!ADJUSTMENT_NO) {
  console.error("Usage: node scripts/reconcile-stock-adjustment-unscanned.mjs --adjustment SA-0001 [--apply]");
  process.exit(1);
}
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${ADJUSTMENT_NO}`);

const sessions = await runQuery("stockAdjustments", fieldFilter("adjustmentNo", "EQUAL", { stringValue: ADJUSTMENT_NO }));
if (sessions.length !== 1) throw new Error(`Expected exactly one session ${ADJUSTMENT_NO}, found ${sessions.length}`);
const session = sessions[0];
if (session.status !== "Completed") throw new Error(`${ADJUSTMENT_NO} is ${session.status}, not Completed — complete it in the app instead.`);
const completedAtMs = Date.parse(session.completedAt);
if (!Number.isFinite(completedAtMs)) throw new Error(`${ADJUSTMENT_NO} has no completedAt`);
console.log(`Group ${session.group} · completed ${session.completedAt} by ${session.completedBy} · result ${JSON.stringify(session.result)}`);

const lines = await listDocs(`stockAdjustments/${session.id}/lines`);
const linesById = new Map(lines.map((l) => [l.id, l]));
const allInventory = await listDocs("inventory");
const groupInventory = allInventory.filter((i) => sameGroup(i.group, session.group));

const targets = [];
const skipped = [];
for (const item of groupInventory) {
  const stock = Number(item.currentStock) || 0;
  if (stock === 0 || item.id.startsWith("DM_")) continue;
  const line = linesById.get(item.id);
  if (line?.applied) continue; // counted (or already reconciled)
  if (line && ((Number(line.scannedQty) || 0) > 0 || line.zeroConfirmed)) {
    skipped.push({ item, reason: "has an un-applied counted line — inspect manually" });
  } else if (Date.parse(item.updateTime) > completedAtMs) {
    skipped.push({ item, reason: `inventory changed after completion (${item.updateTime}) — inspect manually` });
  } else {
    targets.push({ item, stock, line });
  }
}

const scanned = lines.filter((l) => l.applied).reduce((s, l) => s + (Number(l.countedQty) || 0), 0);
const groupStock = groupInventory.reduce((s, i) => s + (Number(i.currentStock) || 0), 0);
console.log(`Applied lines: ${lines.filter((l) => l.applied).length} · counted ${scanned} pcs · group inventory now ${groupStock} pcs`);
console.log(`\nTo set to 0 (${targets.length}):`);
for (const { item, stock } of targets) console.log(`  ${item.barcode.padEnd(14)} ${item.styleNo} · ${item.color} · ${item.size}  stock ${stock} → 0  (last change ${item.updateTime})`);
if (skipped.length) {
  console.log(`\nSKIPPED (${skipped.length}):`);
  for (const { item, reason } of skipped) console.log(`  ${item.barcode}  stock ${item.currentStock}: ${reason}`);
}

const units = targets.reduce((s, t) => s + t.stock, 0);
const decrease = targets.filter((t) => t.stock > 0).reduce((s, t) => s + t.stock, 0);
const increase = targets.filter((t) => t.stock < 0).reduce((s, t) => s - t.stock, 0);
console.log(`\nNet change ${-units} pcs → group inventory ${groupStock - units} pcs (counted total ${scanned})`);
if (!targets.length) { console.log("Nothing to do."); process.exit(0); }
if (!APPLY) { console.log("\nDry run only — re-run with --apply to write."); process.exit(0); }

// ── Backup ───────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(__dirname, `stock-adjustment-reconcile-backup-${ADJUSTMENT_NO}-${stamp}.json`);
await writeFile(backupPath, JSON.stringify({
  adjustmentNo: ADJUSTMENT_NO, takenAt: new Date().toISOString(),
  session, inventory: targets.map((t) => t.item), existingLines: targets.filter((t) => t.line).map((t) => t.line),
}, null, 2));
console.log(`\nBackup written: ${backupPath}`);

// ── One atomic commit ────────────────────────────────────────────────────────
const writes = [];
for (const { item, stock, line } of targets) {
  writes.push({
    update: { name: item.name, fields: { currentStock: encodeValue(0) } },
    updateMask: { fieldPaths: ["currentStock"] },
    updateTransforms: [serverTime("updatedAt")],
    currentDocument: { updateTime: item.updateTime }, // fails the whole commit if it moved since we read it
  });
  const lineFields = {
    barcode: item.barcode, styleNo: item.styleNo ?? "", color: item.color ?? "", size: item.size ?? "",
    ...(item.sleeveType ? { sleeveType: item.sleeveType } : {}),
    startStock: stock, scannedQty: 0,
    applied: true, previousStock: stock, countedQty: 0, variance: -stock, unscannedZeroed: true,
    reconciledBy: BY, reconcileNote: NOTE,
  };
  writes.push({
    update: { name: `${BASE_URL.replace("https://firestore.googleapis.com/v1/", "")}/stockAdjustments/${session.id}/lines/${item.id}`,
      fields: Object.fromEntries(Object.entries(lineFields).map(([k, v]) => [k, encodeValue(v)])) },
    ...(line ? { updateMask: { fieldPaths: Object.keys(lineFields) }, currentDocument: { updateTime: line.updateTime } } : { currentDocument: { exists: false } }),
    updateTransforms: [serverTime("appliedAt"), serverTime("reconciledAt"), serverTime("updatedAt")],
  });
}
writes.push({
  transform: {
    document: session.name,
    fieldTransforms: [
      { fieldPath: "result.appliedLines", increment: encodeValue(targets.length) },
      { fieldPath: "result.changedLines", increment: encodeValue(targets.length) },
      { fieldPath: "result.decreaseQty", increment: encodeValue(decrease) },
      { fieldPath: "result.increaseQty", increment: encodeValue(increase) },
      { fieldPath: "reconciliations", appendMissingElements: { values: [encodeValue({
        at: new Date().toISOString(), by: BY, note: NOTE, products: targets.length, decreaseQty: decrease, increaseQty: increase,
        barcodes: targets.map((t) => t.item.barcode), backupFile: backupPath.split(/[\\/]/).pop(),
      })] } },
      serverTime("updatedAt"),
    ],
  },
  currentDocument: { updateTime: session.updateTime },
});

await commit(writes);
console.log(`Committed ${writes.length} writes atomically.`);

// ── Verify ───────────────────────────────────────────────────────────────────
const after = await listDocs(`stockAdjustments/${session.id}/lines`);
const afterInventory = (await listDocs("inventory")).filter((i) => sameGroup(i.group, session.group));
const afterCounted = after.filter((l) => l.applied).reduce((s, l) => s + (Number(l.countedQty) || 0), 0);
const afterStock = afterInventory.reduce((s, i) => s + (Number(i.currentStock) || 0), 0);
const invById = new Map(afterInventory.map((i) => [i.id, i]));
const mismatched = after.filter((l) => l.applied && invById.has(l.id) && (Number(invById.get(l.id).currentStock) || 0) !== (Number(l.countedQty) || 0));
console.log(`After: applied lines ${after.filter((l) => l.applied).length} · counted ${afterCounted} pcs · group inventory ${afterStock} pcs · line≠inventory ${mismatched.length}`);
