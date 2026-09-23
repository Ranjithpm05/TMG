// One-off fix for TMGC2627-1907 and TMGC2627-1908 (client: POTHYS RETAIL
// PRIVATE LIMITED - BANGALORE, id K3Uu9XhTx4bcV3P2RYUn).
//
// Both were created on 2026-09-19 while the client's Ship To State was
// mistakenly set to "TAMILNADU" in Client Master (corrected to "KARNATAKA"
// ~5 minutes later, after both invoices' IRN/E-Way Bill were already
// generated) — see chat history for the full diagnosis
// (scripts/diagnose-gst-mismatch.mjs). The client is genuinely in Karnataka
// (GSTIN prefix 29) with the seller in Tamil Nadu (state code 33), so this
// is an inter-state sale that should carry IGST only, not CGST+SGST.
//
// This does NOT touch eInvoiceStatus/irn/ewbStatus/ewbNo/eInvoicePayload —
// those already reflect what was actually filed with the IRP as CGST+SGST.
// This only corrects the app's own stored tax split (top-level + taxSummary)
// so the two documents stop displaying/printing the wrong tax type going
// forward. Whether/how to formally correct the GST filing (credit note +
// fresh invoice) is a separate compliance decision, made by the user.
//
// Usage:
//   node scripts/fix-gst-tax-type-pothys.mjs            (dry run — prints only)
//   node scripts/fix-gst-tax-type-pothys.mjs --apply     (writes, after backup)
import { writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");

const PROJECT_ID = "tmg-clothings";
const API_KEY = "AIzaSyB8g1fUiGZv_lBPm7FGWBTQtCpo0R35Xgg";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const TARGET_IDS = ["1KoSLNZCv2NqxIMlIzzI", "KOmuWO2I5KtvRidaBIeH"]; // TMGC2627-1907, TMGC2627-1908

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

function unwrapValue(value) {
  if (value == null) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(unwrapValue);
  if ("mapValue" in value) return unwrapFields(value.mapValue.fields ?? {});
  return null;
}
function unwrapFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) out[key] = unwrapValue(value);
  return out;
}
function unwrapDoc(doc) {
  return { id: doc.name.split("/").pop(), name: doc.name, ...unwrapFields(doc.fields ?? {}) };
}

async function getDoc(id) {
  const url = new URL(`${BASE_URL}/invoices/${id}`);
  url.searchParams.set("key", API_KEY);
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`Get failed for ${id}: ${res.status} ${await res.text()}`);
  return unwrapDoc(await res.json());
}

async function patchInvoice(name, fieldsObj) {
  const url = new URL(`https://firestore.googleapis.com/v1/${name}`);
  for (const path of Object.keys(fieldsObj)) url.searchParams.append("updateMask.fieldPaths", path);
  url.searchParams.set("key", API_KEY);

  const numVal = (n) => ({ doubleValue: Number(n) });
  const wrappedFields = {
    cgstRate: numVal(fieldsObj.cgstRate),
    cgstAmount: numVal(fieldsObj.cgstAmount),
    sgstRate: numVal(fieldsObj.sgstRate),
    sgstAmount: numVal(fieldsObj.sgstAmount),
    igstRate: numVal(fieldsObj.igstRate),
    igstAmount: numVal(fieldsObj.igstAmount),
    taxSummary: {
      arrayValue: {
        values: fieldsObj.taxSummary.map((row) => ({
          mapValue: {
            fields: {
              hsnSac: { stringValue: row.hsnSac },
              taxableValue: numVal(row.taxableValue),
              cgstRate: numVal(row.cgstRate),
              cgstAmount: numVal(row.cgstAmount),
              sgstRate: numVal(row.sgstRate),
              sgstAmount: numVal(row.sgstAmount),
              igstRate: numVal(row.igstRate),
              igstAmount: numVal(row.igstAmount),
            },
          },
        })),
      },
    },
  };

  const res = await fetchWithRetry(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: wrappedFields }),
  });
  if (!res.ok) throw new Error(`Patch failed for ${name}: ${res.status} ${await res.text()}`);
}

async function main() {
  const docs = await Promise.all(TARGET_IDS.map(getDoc));

  const backup = {};
  const plans = [];

  for (const inv of docs) {
    backup[inv.id] = inv;

    const combinedRate = Number(inv.cgstRate) + Number(inv.sgstRate);
    const combinedAmount = Math.round((Number(inv.cgstAmount) + Number(inv.sgstAmount)) * 100) / 100;

    const newTop = {
      cgstRate: 0, cgstAmount: 0,
      sgstRate: 0, sgstAmount: 0,
      igstRate: combinedRate, igstAmount: combinedAmount,
      taxSummary: inv.taxSummary.map((row) => {
        const rowCombinedRate = Number(row.cgstRate) + Number(row.sgstRate);
        const rowCombinedAmount = Math.round((Number(row.cgstAmount) + Number(row.sgstAmount)) * 100) / 100;
        return {
          hsnSac: row.hsnSac,
          taxableValue: row.taxableValue,
          cgstRate: 0, cgstAmount: 0,
          sgstRate: 0, sgstAmount: 0,
          igstRate: rowCombinedRate, igstAmount: rowCombinedAmount,
        };
      }),
    };

    plans.push({ inv, newTop });

    console.log(`\n=== ${inv.invoiceNo} (${inv.id}) ===`);
    console.log("  Before:", { cgstRate: inv.cgstRate, cgstAmount: inv.cgstAmount, sgstRate: inv.sgstRate, sgstAmount: inv.sgstAmount, igstRate: inv.igstRate, igstAmount: inv.igstAmount });
    console.log("  After: ", { cgstRate: newTop.cgstRate, cgstAmount: newTop.cgstAmount, sgstRate: newTop.sgstRate, sgstAmount: newTop.sgstAmount, igstRate: newTop.igstRate, igstAmount: newTop.igstAmount });
    console.log(`  totalTaxAmount unchanged: ${inv.totalTaxAmount} (cgst+sgst+igst before: ${(Number(inv.cgstAmount) + Number(inv.sgstAmount) + Number(inv.igstAmount)).toFixed(2)}, after: ${(newTop.cgstAmount + newTop.sgstAmount + newTop.igstAmount).toFixed(2)})`);
  }

  if (!APPLY) {
    console.log("\nDry run only — no writes made. Re-run with --apply to write these changes (a backup will be saved first).");
    return;
  }

  const backupPath = new URL(`./gst-tax-type-fix-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
  await writeFile(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written: ${backupPath.pathname}`);

  for (const { inv, newTop } of plans) {
    await patchInvoice(inv.name, newTop);
    console.log(`Patched ${inv.invoiceNo} (${inv.id}).`);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fix failed:", err);
  process.exit(1);
});
