// // Read-only diagnostic — no PATCH/write code path exists in this file at all.
// // Reports the inventory drift caused by the non-atomic Goods Inward approval bug
// // (see plan: approval could partially/duplicately apply inventory without the GRN
// // ever settling on 'Approved'). Run this and review the numbers before ever running
// // repair-inventory-drift.mjs.
// import { computeInventoryDrift } from "./lib/inventory-drift.mjs";

// function fmt(n) {
//   return Number(n).toLocaleString("en-IN");
// }

// async function main() {
//   const {
//     grnDocCount, invDocCount, statusCounts,
//     approvedTotal, pendingTotal, otherStatusTotal,
//     currentStockTotal, totalReceivedTotal, rows,
//   } = await computeInventoryDrift();

//   console.log("\n=== Goods Inward ===");
//   console.log(`Docs: ${grnDocCount}  Status counts: ${JSON.stringify(statusCounts)}`);
//   console.log(`Total receivedQty on Approved GRNs: ${fmt(approvedTotal)} pcs  <-- this is the "correct" inward total`);
//   console.log(`Total receivedQty on Pending GRNs:  ${fmt(pendingTotal)} pcs  (should NOT be reflected in inventory)`);
//   if (otherStatusTotal) console.log(`Total receivedQty on other-status GRNs: ${fmt(otherStatusTotal)} pcs`);

//   console.log("\n=== Inventory (current, before any repair) ===");
//   console.log(`Docs: ${invDocCount}`);
//   console.log(`Sum currentStock:   ${fmt(currentStockTotal)} pcs`);
//   console.log(`Sum totalReceived:  ${fmt(totalReceivedTotal)} pcs`);
//   console.log(`Drift (totalReceived - Approved inward): ${fmt(totalReceivedTotal - approvedTotal)} pcs`);

//   const drifted = rows.filter(r => r.delta !== 0);
//   const negatives = drifted.filter(r => r.correctedCurrentStock < 0);
//   const duplicates = rows.filter(r => r.duplicateDocs);
//   const fixable = drifted.filter(r => r.correctedCurrentStock >= 0);
//   const excessPcs = fixable.filter(r => r.delta > 0).reduce((s, r) => s + r.delta, 0);
//   const deficitPcs = fixable.filter(r => r.delta < 0).reduce((s, r) => s + -r.delta, 0);

//   console.log("\n=== Per-barcode drift (top 40 by |delta|) ===");
//   const top = [...drifted].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 40);
//   console.log("barcode".padEnd(18), "style/color/size".padEnd(28), "curTotalRecv".padStart(12), "correctTotalRecv".padStart(16), "delta".padStart(8), "curStock".padStart(10), "correctedStock".padStart(14));
//   for (const r of top) {
//     const label = `${r.styleNo ?? "?"}/${r.color ?? "?"}/${r.size ?? "?"}`;
//     console.log(
//       r.barcode.padEnd(18),
//       label.padEnd(28),
//       fmt(r.currentTotalReceived).padStart(12),
//       fmt(r.correctTotalReceived).padStart(16),
//       fmt(r.delta).padStart(8),
//       fmt(r.currentStock).padStart(10),
//       fmt(r.correctedCurrentStock).padStart(14),
//     );
//   }

//   if (negatives.length) {
//     console.log(`\n=== NOT auto-correctable — needs manual review (${negatives.length} barcode(s)) ===`);
//     console.log("Correcting these would push currentStock negative; excluded from the fixable totals below.");
//     for (const r of negatives.slice(0, 40)) {
//       console.log(`  ${r.barcode}  curStock=${fmt(r.currentStock)}  delta=${fmt(r.delta)}  wouldBecome=${fmt(r.correctedCurrentStock)}`);
//     }
//   }

//   if (duplicates.length) {
//     console.log(`\n=== Duplicate inventory docs for the same barcode (${duplicates.length}) ===`);
//     for (const r of duplicates.slice(0, 40)) {
//       console.log(`  ${r.barcode}  ${r.docs.length} docs: ${r.docs.map(d => d.id).join(", ")}`);
//     }
//   }

//   console.log("\n=== Summary ===");
//   console.log(`Barcodes with nonzero drift: ${drifted.length} (of ${rows.length} total)`);
//   console.log(`Barcodes flagged negative (manual review): ${negatives.length}`);
//   console.log(`Barcodes auto-fixable: ${fixable.length}`);
//   console.log(`Total erroneous excess to remove: ${fmt(excessPcs)} pcs`);
//   if (deficitPcs) console.log(`Total shortfall (delta<0, unusual — investigate): ${fmt(deficitPcs)} pcs`);
//   console.log(`\nAfter a correct repair, sum(currentStock) should drop by ~${fmt(excessPcs - deficitPcs)} pcs`);
//   console.log("(not necessarily down to exactly the Approved-inward total, since any real pick/pack consumption already happened).");
// }

// main().catch((err) => {
//   console.error("Diagnostic failed:", err);
//   process.exit(1);
// });
