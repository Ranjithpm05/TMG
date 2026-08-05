// // Repairs the inventory drift caused by the non-atomic Goods Inward approval bug.
// // Without --apply: prints the exact same report as diagnose-inventory-drift.mjs and
// // exits — there is no PATCH call anywhere in the dry-run path. Only with --apply does
// // it write anything, and even then it first snapshots every doc it's about to touch
// // to a local timestamped JSON file (cheap insurance — the data's already in memory).
// //
// // Usage:
// //   node scripts/repair-inventory-drift.mjs            (dry run, no writes)
// //   node scripts/repair-inventory-drift.mjs --apply     (writes to production)
// import { writeFile } from "node:fs/promises";
// import { fileURLToPath } from "node:url";
// import { dirname, join } from "node:path";
// import { computeInventoryDrift, fetchWithRetry, BASE_URL, API_KEY } from "./lib/inventory-drift.mjs";

// const __dirname = dirname(fileURLToPath(import.meta.url));
// const APPLY = process.argv.includes("--apply");

// function fmt(n) {
//   return Number(n).toLocaleString("en-IN");
// }

// async function patchInventoryDoc(docId, totalReceived, currentStock) {
//   const url = new URL(`${BASE_URL}/inventory/${docId}`);
//   url.searchParams.set("updateMask.fieldPaths", "totalReceived");
//   url.searchParams.append("updateMask.fieldPaths", "currentStock");
//   url.searchParams.set("key", API_KEY);

//   const res = await fetchWithRetry(url, {
//     method: "PATCH",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({
//       fields: {
//         totalReceived: { integerValue: String(Math.round(totalReceived)) },
//         currentStock: { integerValue: String(Math.round(currentStock)) },
//       },
//     }),
//   });

//   if (!res.ok) throw new Error(`Patch failed for inventory/${docId}: ${res.status} ${await res.text()}`);
// }

// async function main() {
//   const { rows } = await computeInventoryDrift();

//   const drifted = rows.filter(r => r.delta !== 0);
//   const negatives = drifted.filter(r => r.correctedCurrentStock < 0);
//   const fixable = drifted.filter(r => r.correctedCurrentStock >= 0 && r.docs.length === 1);
//   const skippedMultiDoc = drifted.filter(r => r.correctedCurrentStock >= 0 && r.docs.length !== 1);

//   console.log(`Barcodes with nonzero drift: ${drifted.length}`);
//   console.log(`Flagged negative (skipped, needs manual review): ${negatives.length}`);
//   console.log(`Skipped (0 or >1 inventory docs for barcode, needs manual review): ${skippedMultiDoc.length}`);
//   console.log(`Will patch: ${fixable.length}`);
//   console.log(`Total pcs to remove: ${fmt(fixable.reduce((s, r) => s + r.delta, 0))}`);

//   if (!fixable.length) {
//     console.log("\nNothing to patch. Exiting.");
//     return;
//   }

//   if (!APPLY) {
//     console.log("\nDry run only (no --apply flag) — no writes performed.");
//     console.log("Re-run with --apply to write these corrections to production Firestore.");
//     return;
//   }

//   const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
//   const backupPath = join(__dirname, `inventory-drift-backup-${timestamp}.json`);
//   const backup = fixable.map(r => ({
//     id: r.docs[0].id,
//     barcode: r.barcode,
//     beforeCurrentStock: r.currentStock,
//     beforeTotalReceived: r.currentTotalReceived,
//     afterCurrentStock: r.correctedCurrentStock,
//     afterTotalReceived: r.correctTotalReceived,
//   }));
//   await writeFile(backupPath, JSON.stringify(backup, null, 2));
//   console.log(`\nBackup of ${backup.length} doc(s) written to ${backupPath}`);

//   console.log(`\nApplying ${fixable.length} correction(s)...`);
//   let patched = 0;
//   for (const r of fixable) {
//     await patchInventoryDoc(r.docs[0].id, r.correctTotalReceived, r.correctedCurrentStock);
//     patched++;
//     if (patched % 200 === 0) console.log(`  ...${patched}/${fixable.length} patched`);
//   }

//   console.log(`\nDone. ${patched} inventory doc(s) corrected.`);
//   if (negatives.length || skippedMultiDoc.length) {
//     console.log(`${negatives.length + skippedMultiDoc.length} barcode(s) were skipped and still need manual review — re-run diagnose-inventory-drift.mjs to see them.`);
//   }
// }

// main().catch((err) => {
//   console.error("Repair failed:", err);
//   process.exit(1);
// });
