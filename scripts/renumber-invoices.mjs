// 2026-10-31. Revised bill numbers: four invoices are renumbered and redated
// to 30.10.2026 (from the "REVISED BILL NO." sheet).
//
// Per invoice this rewrites invoiceNo, invoiceSeq and invoiceDate (same IST
// time of day, new calendar date), and every denormalized copy of the number:
//   deliveryChallans.invoiceNo + deliveries[].invoiceNo
//   lrEntries.invoiceNos
//   salesReturns.invoiceNos + lines[].invoiceNo/invoiceDate
//   salesReturnLedger/{invoiceId}.invoiceNo
// counters/invoiceCounter is left alone (it is already past these numbers).
//
// Skipped if the invoice has an IRN / e-way bill (the number is registered on
// the GST portal), the DC/client doesn't match the sheet, or the new number is
// already used by another invoice.
//
// Each invoice is one atomic commit; a JSON backup of every touched doc is
// written first.
//
// Usage:
//   node scripts/renumber-invoices.mjs            (dry run)
//   node scripts/renumber-invoices.mjs --apply
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

// [current invoice no, DC no (sanity check), revised invoice no, revised date yyyy-mm-dd]
const TARGETS = [
  ["TMGC2627-3071", "DCC2627-2523", "TMGC2627-3063", "2026-10-30"],
  ["TMGC2627-3070", "DCC2627-2522", "TMGC2627-3062", "2026-10-30"],
  ["TMGC2627-3069", "DCC2627-2520", "TMGC2627-3061", "2026-10-30"],
  ["TMGC2627-3068", "DCC2627-2521", "TMGC2627-3060", "2026-10-30"],
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

// Raw Firestore value helpers - these edit the REST representation in place so
// every field we don't touch round-trips byte-for-byte.
const str = (s) => ({ stringValue: s });
function renameInStringArray(arrVal, oldNo, newNo) {
  const values = (arrVal?.arrayValue?.values ?? []).map((v) => (v.stringValue === oldNo ? str(newNo) : v));
  return { arrayValue: { values } };
}
function renameInMapArray(arrVal, match, patch) {
  const values = (arrVal?.arrayValue?.values ?? []).map((v) => {
    const f = v.mapValue?.fields;
    if (!f || !match(f)) return v;
    return { mapValue: { fields: { ...f, ...patch } } };
  });
  return { arrayValue: { values } };
}

// Keeps the IST time of day of the original invoiceDate, moves it to newDate.
function redate(oldIso, newDate) {
  const IST_MS = 330 * 60 * 1000;
  const timeOfDay = oldIso ? new Date(new Date(oldIso).getTime() + IST_MS).toISOString().slice(11, 23) : "12:00:00.000";
  return new Date(new Date(`${newDate}T${timeOfDay}Z`).getTime() - IST_MS).toISOString();
}
const fmtIst = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "-");

async function main() {
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}\n`);
  const plans = [];
  for (const [oldNo, dcNo, newNo, newDate] of TARGETS) {
    const problems = [];
    const invDocs = await runQuery("invoices", fieldFilter("invoiceNo", "EQUAL", str(oldNo)));
    if (invDocs.length !== 1) {
      console.log(`${oldNo}  [SKIP - expected 1 invoice, found ${invDocs.length}]`);
      continue;
    }
    const invRaw = invDocs[0];
    const invId = docId(invRaw.name);
    const inv = decodeFields(invRaw.fields);

    const clash = await runQuery("invoices", fieldFilter("invoiceNo", "EQUAL", str(newNo)));
    if (clash.length) problems.push(`${newNo} already used by invoice doc ${clash.map((d) => docId(d.name)).join(", ")}`);
    if (inv.irn || inv.ewbNo || inv.eInvoiceStatus === "generated") problems.push(`has IRN/e-way bill (${inv.eInvoiceStatus ?? ""} ${inv.ewbNo ?? ""}) - cancel on portal first`);
    if (inv.dcNo !== dcNo && !String(inv.dcNo ?? "").split(/[,\s]+/).includes(dcNo)) problems.push(`dcNo ${inv.dcNo} != ${dcNo}`);

    const newSeq = Number(newNo.split("-").pop());
    const newDateIso = redate(inv.invoiceDate, newDate);
    const writes = [];
    const backup = { invoice: invRaw };

    writes.push({
      update: {
        name: invRaw.name,
        fields: {
          invoiceNo: str(newNo),
          invoiceSeq: { integerValue: String(newSeq) },
          invoiceDate: { timestampValue: newDateIso },
          updatedAt: { timestampValue: new Date().toISOString() },
        },
      },
      updateMask: { fieldPaths: ["invoiceNo", "invoiceSeq", "invoiceDate", "updatedAt"] },
      currentDocument: { updateTime: invRaw.updateTime },
    });

    // DCs: by invoiceId (covers dcIds) plus any still carrying the old number.
    const dcById = new Map();
    for (const d of [
      ...(await runQuery("deliveryChallans", fieldFilter("invoiceId", "EQUAL", str(invId)))),
      ...(await runQuery("deliveryChallans", fieldFilter("invoiceNo", "EQUAL", str(oldNo)))),
    ]) dcById.set(d.name, d);
    for (const id of inv.dcIds ?? []) {
      if ([...dcById.keys()].some((n) => docId(n) === id)) continue;
      const d = await getDoc(`deliveryChallans/${id}`);
      if (d) dcById.set(d.name, d);
    }
    const dcNos = [];
    backup.deliveryChallans = [];
    for (const d of dcById.values()) {
      const f = d.fields ?? {};
      const fields = {};
      if (f.invoiceNo?.stringValue === oldNo) fields.invoiceNo = str(newNo);
      if (f.deliveries) {
        const hit = (m) => m.invoiceNo?.stringValue === oldNo || m.invoiceId?.stringValue === invId;
        if ((f.deliveries.arrayValue?.values ?? []).some((v) => v.mapValue?.fields && hit(v.mapValue.fields))) {
          fields.deliveries = renameInMapArray(f.deliveries, hit, { invoiceNo: str(newNo) });
        }
      }
      dcNos.push(f.dcNo?.stringValue);
      if (!Object.keys(fields).length) continue;
      backup.deliveryChallans.push(d);
      writes.push({
        update: { name: d.name, fields },
        updateMask: { fieldPaths: Object.keys(fields) },
        currentDocument: { updateTime: d.updateTime },
      });
    }
    if (!dcNos.includes(dcNo)) problems.push(`linked DCs [${dcNos.join(", ")}] don't include ${dcNo}`);

    backup.lrEntries = await runQuery("lrEntries", fieldFilter("invoiceNos", "ARRAY_CONTAINS", str(oldNo)));
    for (const d of backup.lrEntries) {
      writes.push({
        update: { name: d.name, fields: { invoiceNos: renameInStringArray(d.fields.invoiceNos, oldNo, newNo) } },
        updateMask: { fieldPaths: ["invoiceNos"] },
        currentDocument: { updateTime: d.updateTime },
      });
    }

    backup.salesReturns = await runQuery("salesReturns", fieldFilter("invoiceIds", "ARRAY_CONTAINS", str(invId)));
    for (const d of backup.salesReturns) {
      const sr = decodeFields(d.fields);
      if (sr.irn || sr.eInvoiceStatus === "generated") problems.push(`sales return ${sr.returnNo} has a credit note IRN against ${oldNo}`);
      writes.push({
        update: {
          name: d.name,
          fields: {
            invoiceNos: renameInStringArray(d.fields.invoiceNos, oldNo, newNo),
            lines: renameInMapArray(d.fields.lines, (m) => m.invoiceId?.stringValue === invId,
              { invoiceNo: str(newNo), invoiceDate: { timestampValue: newDateIso } }),
          },
        },
        updateMask: { fieldPaths: ["invoiceNos", "lines"] },
        currentDocument: { updateTime: d.updateTime },
      });
    }

    const ledger = await getDoc(`salesReturnLedger/${invId}`);
    backup.salesReturnLedger = ledger;
    if (ledger) {
      writes.push({
        update: { name: ledger.name, fields: { invoiceNo: str(newNo) } },
        updateMask: { fieldPaths: ["invoiceNo"] },
        currentDocument: { updateTime: ledger.updateTime },
      });
    }

    console.log(`${oldNo} -> ${newNo}  [${problems.length ? "SKIP - " + problems.join("; ") : "OK"}]`);
    console.log(`    Client : ${inv.clientName}   DC ${inv.dcNo}   Qty ${(inv.items ?? []).reduce((s, i) => s + (Number(i.quantity) || 0), 0)}   Rs.${inv.totalAmount}`);
    console.log(`    Date   : ${fmtIst(inv.invoiceDate)}  ->  ${fmtIst(newDateIso)}`);
    console.log(`    Seq    : ${inv.invoiceSeq}  ->  ${newSeq}`);
    console.log(`    Also   : ${backup.deliveryChallans.length} DC, ${backup.lrEntries.length} LR entry, ${backup.salesReturns.length} sales return, ${ledger ? 1 : 0} return ledger`);
    plans.push({ oldNo, newNo, writes, backup, problems });
  }

  // Two targets must not swap into each other's old number within this run.
  const newNos = new Set(plans.map((p) => p.newNo));
  for (const p of plans) if (newNos.has(p.oldNo)) p.problems.push("old number is another target's new number");

  const ok = plans.filter((p) => !p.problems.length);
  console.log(`\n${ok.length} ready, ${TARGETS.length - ok.length} skipped.`);
  if (!APPLY) { console.log("Dry run only - re-run with --apply to write."); return; }
  if (!ok.length) return;

  const backupPath = join(__dirname, `renumber-invoices-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(backupPath, JSON.stringify(ok.map((p) => p.backup), null, 2));
  console.log(`Backup written: ${backupPath}`);

  for (const p of ok) {
    await commit(p.writes);
    console.log(`  renumbered ${p.oldNo} -> ${p.newNo} (${p.writes.length} docs)`);
  }
  console.log("\nDone.");
}

main().catch((err) => { console.error(err); process.exit(1); });
