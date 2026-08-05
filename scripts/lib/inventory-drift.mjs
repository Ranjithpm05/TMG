// // Shared Firestore REST helpers + drift-aggregation logic used by both
// // diagnose-inventory-drift.mjs (read-only) and repair-inventory-drift.mjs (writes,
// // --apply only). Keeping the aggregation in one place means the report you review
// // and the numbers actually written can never drift apart from each other.
// //
// // Uses the Firestore REST API directly instead of the JS SDK — same rationale as
// // fix-created-at.mjs: this network has intermittent ECONNRESET issues that break
// // the SDK's streaming transport, but plain request/response HTTPS works fine.
// // firestore.rules on this project allows open read/write, so no auth token is needed.
// const PROJECT_ID = "tmg-clothings";
// const API_KEY = "AIzaSyB8g1fUiGZv_lBPm7FGWBTQtCpo0R35Xgg";
// export const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
// export { API_KEY };

// export async function fetchWithRetry(url, options, retries = 5) {
//   for (let attempt = 1; attempt <= retries; attempt++) {
//     try {
//       return await fetch(url, options);
//     } catch (err) {
//       if (attempt === retries) throw err;
//       const delayMs = attempt * 1000;
//       console.log(`  ...fetch failed (${err.cause?.code ?? err.message}), retrying in ${delayMs}ms (attempt ${attempt}/${retries})`);
//       await new Promise((resolve) => setTimeout(resolve, delayMs));
//     }
//   }
// }

// export async function listAllDocs(collectionName) {
//   const docs = [];
//   let pageToken;

//   do {
//     const url = new URL(`${BASE_URL}/${collectionName}`);
//     url.searchParams.set("pageSize", "300");
//     url.searchParams.set("key", API_KEY);
//     if (pageToken) url.searchParams.set("pageToken", pageToken);

//     const res = await fetchWithRetry(url);
//     if (!res.ok) throw new Error(`List failed for ${collectionName}: ${res.status} ${await res.text()}`);
//     const data = await res.json();

//     docs.push(...(data.documents ?? []));
//     pageToken = data.nextPageToken;
//     console.log(`  ...${collectionName}: ${docs.length} document(s) so far`);
//   } while (pageToken);

//   return docs;
// }

// // Generic Firestore REST field-value unwrapper — handles nested arrayValue/mapValue,
// // unlike fix-created-at.mjs's ad-hoc timestamp-only unwrapping (goodsInward.items is
// // an array of maps, so this needs to be fully general).
// export function unwrapValue(value) {
//   if (value == null) return null;
//   if ("stringValue" in value) return value.stringValue;
//   if ("integerValue" in value) return Number(value.integerValue);
//   if ("doubleValue" in value) return Number(value.doubleValue);
//   if ("booleanValue" in value) return value.booleanValue;
//   if ("timestampValue" in value) return value.timestampValue;
//   if ("nullValue" in value) return null;
//   if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(unwrapValue);
//   if ("mapValue" in value) return unwrapFields(value.mapValue.fields ?? {});
//   return null;
// }

// export function unwrapFields(fields) {
//   const out = {};
//   for (const [key, value] of Object.entries(fields ?? {})) {
//     out[key] = unwrapValue(value);
//   }
//   return out;
// }

// export function unwrapDoc(doc) {
//   return { id: doc.name.split("/").pop(), ...unwrapFields(doc.fields ?? {}) };
// }

// /**
//  * Computes, per barcode: the correct totalReceived (sum of receivedQty across every
//  * item in every Approved goodsInward doc only), the drift against the inventory doc's
//  * current totalReceived, and the corrected currentStock that preserves whatever
//  * legitimate pick/pack consumption already happened (currentStock is decremented
//  * elsewhere by pick-list/packing-list, which never touch totalReceived — see plan).
//  */
// export async function computeInventoryDrift() {
//   console.log("Fetching goodsInward...");
//   const grnDocs = (await listAllDocs("goodsInward")).map(unwrapDoc);
//   console.log("Fetching inventory...");
//   const invDocs = (await listAllDocs("inventory")).map(unwrapDoc);

//   const approvedReceivedByBarcode = new Map();
//   let approvedTotal = 0;
//   let pendingTotal = 0;
//   let otherStatusTotal = 0;
//   const statusCounts = {};

//   for (const grn of grnDocs) {
//     statusCounts[grn.status] = (statusCounts[grn.status] || 0) + 1;
//     const items = Array.isArray(grn.items) ? grn.items : [];
//     for (const item of items) {
//       const qty = Number(item?.receivedQty) || 0;
//       if (grn.status === "Approved") {
//         approvedTotal += qty;
//         if (item?.barcode) {
//           approvedReceivedByBarcode.set(item.barcode, (approvedReceivedByBarcode.get(item.barcode) || 0) + qty);
//         }
//       } else if (grn.status === "Pending") {
//         pendingTotal += qty;
//       } else {
//         otherStatusTotal += qty;
//       }
//     }
//   }

//   const currentByBarcode = new Map();
//   let currentStockTotal = 0;
//   let totalReceivedTotal = 0;

//   for (const inv of invDocs) {
//     currentStockTotal += Number(inv.currentStock) || 0;
//     totalReceivedTotal += Number(inv.totalReceived) || 0;
//     if (!inv.barcode) continue;
//     const existing = currentByBarcode.get(inv.barcode);
//     if (existing) {
//       // Duplicate inventory docs for the same barcode shouldn't exist, but merge
//       // additively and flag rather than silently picking one if they do.
//       existing.docs.push(inv);
//       existing.currentStock += Number(inv.currentStock) || 0;
//       existing.totalReceived += Number(inv.totalReceived) || 0;
//     } else {
//       currentByBarcode.set(inv.barcode, {
//         docs: [inv],
//         currentStock: Number(inv.currentStock) || 0,
//         totalReceived: Number(inv.totalReceived) || 0,
//       });
//     }
//   }

//   const allBarcodes = new Set([...approvedReceivedByBarcode.keys(), ...currentByBarcode.keys()]);
//   const rows = [];
//   for (const barcode of allBarcodes) {
//     const correctTotalReceived = approvedReceivedByBarcode.get(barcode) || 0;
//     const current = currentByBarcode.get(barcode);
//     const currentTotalReceived = current?.totalReceived || 0;
//     const currentStock = current?.currentStock || 0;
//     const delta = currentTotalReceived - correctTotalReceived;
//     const correctedCurrentStock = currentStock - delta;
//     const sample = current?.docs?.[0];
//     rows.push({
//       barcode,
//       docs: current?.docs ?? [],
//       styleNo: sample?.styleNo,
//       color: sample?.color,
//       size: sample?.size,
//       correctTotalReceived,
//       currentTotalReceived,
//       delta,
//       currentStock,
//       correctedCurrentStock,
//       duplicateDocs: (current?.docs?.length ?? 0) > 1,
//     });
//   }

//   return {
//     grnDocCount: grnDocs.length,
//     invDocCount: invDocs.length,
//     statusCounts,
//     approvedTotal,
//     pendingTotal,
//     otherStatusTotal,
//     currentStockTotal,
//     totalReceivedTotal,
//     rows,
//   };
// }
