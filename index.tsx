import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { ErrorHandler, provideZonelessChangeDetection } from '@angular/core';

import { provideFirebaseApp, initializeApp, getApp } from '@angular/fire/app';
import { provideFirestore, initializeFirestore } from '@angular/fire/firestore';
import { provideStorage, getStorage } from '@angular/fire/storage';
import { provideFunctions, getFunctions, connectFunctionsEmulator } from '@angular/fire/functions';

import { AppComponent } from './src/app.component';

//const useFunctionsEmulator = location.hostname === 'localhost' || location.hostname === '127.0.0.1';


const firebaseConfig = {
    apiKey: "AIzaSyB8g1fUiGZv_lBPm7FGWBTQtCpo0R35Xgg",
    authDomain: "tmg-clothings.firebaseapp.com",
    projectId: "tmg-clothings",
    storageBucket: "tmg-clothings.firebasestorage.app",
    messagingSenderId: "801729913378",
    appId: "1:801729913378:web:f940bcc11c1fe21071a07b",
    measurementId: "G-LTR73S5839"
};

// Every screen is an `@defer` block that lazy-loads a hashed chunk-XXXX.js,
// and each deploy deletes the previous build's chunks from Hosting. Mobile
// browsers rarely load the page fresh — they resume suspended tabs and
// home-screen shortcuts with the OLD main bundle still in memory, which then
// requests chunk names that no longer exist. With no `@error` block Angular
// just reports NG0750 and leaves the `@loading` spinner up forever ("only
// loading, no data"). Reload once to pick up the current index.html/build;
// the timestamp guard stops a reload loop if the chunk is genuinely missing.
const CHUNK_RELOAD_KEY = 'tmg:chunk-reload-at';
const CHUNK_RELOAD_GUARD_MS = 30_000;

function isChunkLoadError(error: unknown): boolean {
  const err = error as { code?: number; message?: string } | null;
  if (err?.code === -750) return true; // NG0750: @defer dependency loading failed
  return /NG0750|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i
    .test(String(err?.message ?? error ?? ''));
}

class ChunkReloadErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    if (isChunkLoadError(error)) {
      let lastReloadAt = 0;
      try { lastReloadAt = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0; } catch { /* storage unavailable */ }
      if (Date.now() - lastReloadAt > CHUNK_RELOAD_GUARD_MS) {
        try { sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now())); } catch { /* storage unavailable */ }
        console.warn('[app] a screen failed to load (stale build after a deploy) — reloading to get the latest version');
        location.reload();
        return;
      }
    }
    super.handleError(error);
  }
}

bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    { provide: ErrorHandler, useClass: ChunkReloadErrorHandler },
    provideHttpClient(),
    provideFirebaseApp(() => initializeApp(firebaseConfig)),
    // Every read on this screen was taking ~48s regardless of collection size
    // (190 vs 1262 vs 1218 vs 1001 docs all finished within ~1s of each
    // other) — the hallmark of the SDK's transport auto-detection (already
    // the default, and it can't be combined with forceLongPolling) stalling
    // while probing for streaming support before falling back to
    // long-polling, on a network/proxy/antivirus that silently swallows the
    // streaming attempt instead of failing it fast. Forcing long-polling
    // skips that probe-and-timeout entirely.
    provideFirestore(() => initializeFirestore(getApp(), {
      experimentalForceLongPolling: true,
    })),
    provideStorage(() => getStorage()),
    provideFunctions(() => getFunctions()),
    // provideFunctions(() => {
    //   const functions = getFunctions();
    //   if (useFunctionsEmulator) {
    //     connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    //   }
    //   return functions;
    // }),
  ],
}).catch(err => console.error(err));