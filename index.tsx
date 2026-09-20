import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';

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

bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
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