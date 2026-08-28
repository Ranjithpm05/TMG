import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';

import { provideFirebaseApp, initializeApp } from '@angular/fire/app';
import { provideFirestore, getFirestore } from '@angular/fire/firestore';
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
    provideFirestore(() => getFirestore()),
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