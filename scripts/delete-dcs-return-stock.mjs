// Deletes the listed Delivery Challans and returns their pieces to inventory
// (currentStock increment). Stock left inventory once, at Packing List
// completion (PackingListService.deductInventoryOnCompletion, gated by the
// Packing List's stockDeducted flag), so the return mirrors that deduction
// exactly: each Packing List line's packedQty goes back to its inventoryId
// (else its barcode's inventory record).
//
// A DC is SKIPPED (reported, never partially done) when it has an Invoice,
// a delivery, a closed balance or an LR Entry, when its Packing List never
// deducted stock, when that Packing List holds other DCs, or when the
// packed qty doesn't match the DC qty.
//
// Each DC is one atomic Firestore commit: DC delete + inventory increments +
// delete of its Packing List and that list's lines subcollection (user's
// choice, 2026-10-05 — goods restart from picking if sent later). Source Pick
// List claims are NOT released, same "permanently gone" rule as an in-app
// Packing List delete. A JSON backup of every touched doc is written first.
//
// --with-pick-list (2026-10-11, DCC2627-1903): also deletes the DC's source
// Pick List(s) + lines and returns their picked stock — a Pick List scan
// deducts currentStock itself (unless inventoryReserved), separately from
// the packing-completion deduction, same as PickListService.deletePickList.
// SKIPPED if that Pick List also fed any other Packing List.
//
// Usage:
//   node scripts/delete-dcs-return-stock.mjs            (dry run, no writes)
//   node scripts/delete-dcs-return-stock.mjs --apply     (writes to production)
//   node scripts/delete-dcs-return-stock.mjs --dc DCC2627-1903 --with-pick-list [--apply]
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const WITH_PICK_LIST = process.argv.includes("--with-pick-list");
// --dc <DC No.> (repeatable) overrides TARGETS; no sheet qty to cross-check then.
const CLI_DCS = process.argv.flatMap((arg, i, all) => (arg === "--dc" && all[i + 1] ? [all[i + 1]] : []));

// From the user's sheet, 2026-10-05: DC No. -> DC Qty.
const TARGETS = {
  "DCC2627-1293": 48, "DCC2627-1294": 49, "DCC2627-1295": 79, "DCC2627-1296": 42,
  "DCC2627-1297": 97, "DCC2627-1298": 104, "DCC2627-1300": 52, "DCC2627-1301": 48,
  "DCC2627-1302": 124, "DCC2627-1304": 153, "DCC2627-1376": 49, "DCC2627-1377": 42,
  "DCC2627-1418": 43, "DCC2627-1425": 40, "DCC2627-1428": 44, "DCC2627-1429": 44,
  "DCC2627-1430": 52,
};

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
  const dcNos = CLI_DCS.length ? CLI_DCS : Object.keys(TARGETS);
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${dcNos.length} DC(s)\n`);

  const dcDocs = await runQuery("deliveryChallans", fieldFilter("dcNo", "IN", strArray(dcNos)));
  const dcs = dcDocs.map((d) => ({ id: docId(d.name), raw: d, ...decodeFields(d.fields) }));
  const missing = dcNos.filter((no) => !dcs.some((dc) => dc.dcNo === no));
  const dupes = dcNos.filter((no) => dcs.filter((dc) => dc.dcNo === no).length > 1);
  if (missing.length) console.log(`NOT FOUND: ${missing.join(", ")}`);
  if (dupes.length) console.log(`DUPLICATE DC NO.: ${dupes.join(", ")}`);

  const dcIds = dcs.map((dc) => dc.id);
  const invoices = [
    ...(await runQuery("invoices", fieldFilter("dcIds", "ARRAY_CONTAINS_ANY", strArray(dcIds)))),
    ...(await runQuery("invoices", fieldFilter("dcId", "IN", strArray(dcIds)))),
  ].map((d) => ({ id: docId(d.name), ...decodeFields(d.fields) }));
  const lrEntries = (await runQuery("lrEntries", fieldFilter("dcId", "IN", strArray(dcIds))))
    .map((d) => ({ id: docId(d.name), ...decodeFields(d.fields) }));

  // Packing Lists may hold more than one DC (legacy pre-1:1 data) — check it.
  const plIds = [...new Set(dcs.map((dc) => dc.packingListId).filter(Boolean))];
  const allDcsOfPls = plIds.length
    ? (await runQuery("deliveryChallans", fieldFilter("packingListId", "IN", strArray(plIds)))).map((d) => ({ id: docId(d.name), ...decodeFields(d.fields) }))
    : [];

  const plans = [];
  const inventoryCache = new Map();
  for (const dcNo of dcNos) {
    const dc = dcs.find((d) => d.dcNo === dcNo);
    if (!dc || dupes.includes(dcNo)) continue;
    const problems = [];
    const dcQty = Number(dc.totalQty) || 0;
    if (!CLI_DCS.length && dcQty !== TARGETS[dcNo]) problems.push(`DC qty ${dcQty} ≠ sheet qty ${TARGETS[dcNo]}`);
    const linkedInvoices = invoices.filter((inv) => inv.dcId === dc.id || (inv.dcIds ?? []).includes(dc.id));
    if (dc.invoiceId || linkedInvoices.length) problems.push(`has invoice ${[dc.invoiceNo, ...linkedInvoices.map((i) => i.invoiceNo)].filter(Boolean).join("/") || dc.invoiceId}`);
    if ((dc.deliveries ?? []).length) problems.push(`has ${dc.deliveries.length} delivery record(s)`);
    if (dc.balanceClosure) problems.push("balance already closed (stock partly returned)");
    const lrs = lrEntries.filter((lr) => lr.dcId === dc.id);
    if (lrs.length) problems.push(`has LR entry ${lrs.map((l) => l.lrNo || l.id).join("/")}`);

    let pl = null;
    const returns = new Map();
    let packedTotal = 0;
    if (!dc.packingListId) problems.push("no packing list");
    else {
      const plDoc = await getDoc(`packingLists/${dc.packingListId}`);
      if (!plDoc) problems.push(`packing list ${dc.packingListId} not found`);
      else {
        pl = { id: dc.packingListId, raw: plDoc, ...decodeFields(plDoc.fields) };
        if (pl.stockDeducted !== true) problems.push("packing list never deducted stock (stockDeducted≠true)");
        const others = allDcsOfPls.filter((o) => o.packingListId === pl.id && o.id !== dc.id);
        if (others.length) problems.push(`packing list also holds DC ${others.map((o) => o.dcNo).join(", ")}`);
        const lines = (await listDocs(`packingLists/${pl.id}/lines`)).map((d) => ({ lineId: docId(d.name), raw: d, ...decodeFields(d.fields) }));
        pl.lines = lines;
        for (const line of lines) {
          const qty = Number(line.packedQty) || 0;
          if (qty <= 0) continue;
          packedTotal += qty;
          let invId = line.inventoryId;
          if (!invId && line.barcode) {
            const found = await runQuery("inventory", fieldFilter("barcode", "EQUAL", { stringValue: line.barcode }));
            invId = found[0] ? docId(found[0].name) : undefined;
          }
          if (!invId) { problems.push(`line ${line.styleNo} ${line.size} ×${qty} has no inventory record`); continue; }
          returns.set(invId, (returns.get(invId) ?? 0) + qty);
        }
        if (packedTotal !== dcQty) problems.push(`packed qty ${packedTotal} ≠ DC qty ${dcQty}`);
      }
    }

    const pickLists = [];
    const pickReturns = new Map();
    let pickedTotal = 0;
    if (WITH_PICK_LIST && pl) {
      const pickListIds = [...new Set([...(pl.pickListIds ?? []), pl.pickListId].filter(Boolean))];
      if (!pickListIds.length) problems.push("packing list has no source pick list");
      for (const pickListId of pickListIds) {
        const pickDoc = await getDoc(`pickLists/${pickListId}`);
        if (!pickDoc) { problems.push(`pick list ${pickListId} not found`); continue; }
        const pick = { id: pickListId, raw: pickDoc, ...decodeFields(pickDoc.fields) };
        const feeding = [
          ...(await runQuery("packingLists", fieldFilter("pickListIds", "ARRAY_CONTAINS", { stringValue: pickListId }))),
          ...(await runQuery("packingLists", fieldFilter("pickListId", "EQUAL", { stringValue: pickListId }))),
        ].map((d) => ({ id: docId(d.name), ...decodeFields(d.fields) }));
        const otherPls = [...new Map(feeding.filter((p) => p.id !== pl.id).map((p) => [p.id, p])).values()];
        if (otherPls.length) problems.push(`pick list ${pick.pickListNo} also fed packing list ${otherPls.map((p) => p.packingListNo || p.id).join(", ")}`);
        pick.lines = (await listDocs(`pickLists/${pickListId}/lines`)).map((d) => ({ lineId: docId(d.name), raw: d, ...decodeFields(d.fields) }));
        if (!pick.inventoryReserved) {
          for (const line of pick.lines) {
            const qty = Number(line.pickedQty) || 0;
            if (qty <= 0) continue;
            pickedTotal += qty;
            if (!line.inventoryId) { problems.push(`pick line ${line.styleNo} ${line.size} ×${qty} has no inventoryId`); continue; }
            pickReturns.set(line.inventoryId, (pickReturns.get(line.inventoryId) ?? 0) + qty);
          }
        }
        pickLists.push(pick);
      }
    }

    for (const invId of new Set([...returns.keys(), ...pickReturns.keys()])) {
      if (!inventoryCache.has(invId)) {
        const d = await getDoc(`inventory/${invId}`);
        inventoryCache.set(invId, d ? { id: invId, raw: d, ...decodeFields(d.fields) } : null);
      }
      if (!inventoryCache.get(invId)) problems.push(`inventory ${invId} not found`);
    }
    const totalReturns = new Map(returns);
    for (const [invId, qty] of pickReturns) totalReturns.set(invId, (totalReturns.get(invId) ?? 0) + qty);
    plans.push({ dc, pl, returns: totalReturns, packedTotal, pickLists, pickedTotal, problems });
  }

  for (const p of plans) {
    const status = p.problems.length ? `SKIP — ${p.problems.join("; ")}` : "OK";
    console.log(`${p.dc.dcNo}  ${p.dc.clientName}  DC qty ${p.dc.totalQty}  PL ${p.dc.packingListNo || p.dc.packingListId}  → return ${[...p.returns.values()].reduce((s, q) => s + q, 0)} pcs to ${p.returns.size} item(s)  [${status}]`);
    if (WITH_PICK_LIST) {
      console.log(`    packed qty returned: ${p.packedTotal}; pick list(s) ${p.pickLists.map((k) => `${k.pickListNo} (${k.status}, ${k.lines.length} lines${k.inventoryReserved ? ", inventoryReserved" : ""})`).join(", ") || "-"} → picked qty returned: ${p.pickedTotal}`);
    }
    if (process.argv.includes("--verbose")) {
      for (const [invId, qty] of p.returns) {
        const inv = inventoryCache.get(invId);
        console.log(`    ${inv?.styleNo} ${inv?.color} ${inv?.sleeveType ?? ""} ${inv?.size}: stock ${inv?.currentStock} + ${qty}`);
      }
    }
  }
  const ok = plans.filter((p) => !p.problems.length);
  console.log(`\n${ok.length} ready, ${plans.length - ok.length} skipped, ${missing.length} not found. Total return: ${ok.reduce((s, p) => s + p.packedTotal + p.pickedTotal, 0)} pcs.`);

  if (!APPLY) { console.log("\nDry run only — re-run with --apply to write."); return; }
  if (!ok.length) return;

  const backupPath = join(__dirname, `dc-delete-return-stock-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(backupPath, JSON.stringify(ok.map((p) => ({
    dc: p.dc.raw,
    packingList: p.pl.raw,
    packingListLines: p.pl.lines.map((l) => l.raw),
    pickLists: p.pickLists.map((k) => ({ pickList: k.raw, lines: k.lines.map((l) => l.raw) })),
    inventoryBefore: [...p.returns.keys()].map((id) => inventoryCache.get(id).raw),
    returns: Object.fromEntries(p.returns),
  })), null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  const now = new Date().toISOString();
  for (const p of ok) {
    const writes = [
      { delete: p.dc.raw.name, currentDocument: { exists: true } },
      ...[...p.returns].map(([invId, qty]) => ({
        update: { name: `${DB}/documents/inventory/${invId}`, fields: { updatedAt: { timestampValue: now } } },
        updateMask: { fieldPaths: ["updatedAt"] },
        updateTransforms: [{ fieldPath: "currentStock", increment: { integerValue: String(qty) } }],
        currentDocument: { exists: true },
      })),
      { delete: p.pl.raw.name, currentDocument: { updateTime: p.pl.raw.updateTime } },
      ...p.pickLists.map((k) => ({ delete: k.raw.name, currentDocument: { updateTime: k.raw.updateTime } })),
    ];
    // DC + stock + parent docs in one atomic commit; the lines subcollections
    // (a Pick List can hold 600+ lines, over the 500-write commit limit) after.
    await commit(writes);
    const lineDeletes = [...p.pl.lines, ...p.pickLists.flatMap((k) => k.lines)].map((line) => ({ delete: line.raw.name }));
    for (let i = 0; i < lineDeletes.length; i += 450) await commit(lineDeletes.slice(i, i + 450));
    console.log(`  deleted ${p.dc.dcNo} + ${p.dc.packingListNo}${p.pickLists.length ? ` + ${p.pickLists.map((k) => k.pickListNo).join(", ")}` : ""}, returned ${p.packedTotal + p.pickedTotal} pcs`);
  }
  console.log("\nDone.");
}

main().catch((err) => { console.error(err); process.exit(1); });
