// // Uses the Firestore REST API directly instead of the JS SDK — the SDK's
// // streaming transport gets stuck on this network (likely a proxy/security
// // tool that breaks long-lived HTTP connections), but plain request/response
// // HTTPS works fine. firestore.rules on this project allows open read/write,
// // so no auth token is needed.
// const PROJECT_ID = "tmg-clothings";
// const API_KEY = "AIzaSyB8g1fUiGZv_lBPm7FGWBTQtCpo0R35Xgg";
// const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// // This network resets sustained connections intermittently (ECONNRESET), so
// // retry transient failures with backoff instead of failing the whole run.
// async function fetchWithRetry(url, options, retries = 5) {
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

// async function listAllSalesOrders() {
//   const docs = [];
//   let pageToken;

//   do {
//     const url = new URL(`${BASE_URL}/salesOrders`);
//     url.searchParams.set("pageSize", "300");
//     url.searchParams.set("key", API_KEY);
//     if (pageToken) url.searchParams.set("pageToken", pageToken);

//     const res = await fetchWithRetry(url);
//     if (!res.ok) throw new Error(`List failed: ${res.status} ${await res.text()}`);
//     const data = await res.json();

//     docs.push(...(data.documents ?? []));
//     pageToken = data.nextPageToken;
//     console.log(`  ...page fetched, ${docs.length} document(s) so far`);
//   } while (pageToken);

//   return docs;
// }

// async function patchCreatedAt(docName, seconds, nanos) {
//   const url = new URL(`https://firestore.googleapis.com/v1/${docName}`);
//   url.searchParams.set("updateMask.fieldPaths", "createdAt");
//   url.searchParams.set("key", API_KEY);

//   const isoTimestamp = new Date(seconds * 1000 + nanos / 1e6).toISOString();

//   const res = await fetchWithRetry(url, {
//     method: "PATCH",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({
//       fields: {
//         createdAt: { timestampValue: isoTimestamp },
//       },
//     }),
//   });

//   if (!res.ok) throw new Error(`Patch failed for ${docName}: ${res.status} ${await res.text()}`);
// }

// async function fixCreatedAt() {
//   console.log("Starting migration...");
//   const docs = await listAllSalesOrders();
//   console.log(`Found ${docs.length} document(s) in salesOrders collection.`);

//   let count = 0;

//   for (const doc of docs) {
//     const createdAt = doc.fields?.createdAt;
//     const mapValue = createdAt?.mapValue?.fields;

//     // Corrupted docs store createdAt as a plain map ({seconds, nanoseconds, type})
//     // instead of a real Firestore timestampValue.
//     if (
//       mapValue &&
//       mapValue.seconds !== undefined &&
//       mapValue.nanoseconds !== undefined &&
//       mapValue.type?.stringValue === "firestore/timestamp/1.0"
//     ) {
//       const seconds = Number(mapValue.seconds.integerValue ?? mapValue.seconds.doubleValue);
//       const nanos = Number(mapValue.nanoseconds.integerValue ?? mapValue.nanoseconds.doubleValue ?? 0);

//       await patchCreatedAt(doc.name, seconds, nanos);
//       count++;
//       console.log(`Fixed: ${doc.name.split("/").pop()}`);
//     }
//   }

//   console.log(`${count} document(s) updated.`);
// }

// fixCreatedAt().catch((err) => {
//   console.error("Migration failed:", err);
//   process.exit(1);
// });
