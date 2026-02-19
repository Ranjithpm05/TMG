import { Injectable } from '@angular/core';
// FIX: The original imports are for Firebase v9+, but the build environment seems to expect v8/compat.
// Switched to compat imports to resolve "module has no exported member" errors.
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';


/**********************************************************************************
 * !!!!!!!!!!!!!!!!!!!!!!!!!!! IMPORTANT: READ THIS !!!!!!!!!!!!!!!!!!!!!!!!!!!
 *
 * The error message "Firebase: Error (auth/api-key-not-valid...)" means you
 * have NOT replaced the placeholder values below with your actual project
 * credentials from Firebase.
 *
 * The application WILL NOT WORK until you do this.
 *
 * --- HOW TO FIX THIS ---
 * 1. Go to your Firebase project console.
 * 2. Click the gear icon (Project settings) in the top-left.
 * 3. In the "General" tab, scroll down to "Your apps".
 * 4. Find your web app and look for the "Firebase SDK snippet".
 * 5. Select "Config" and copy the values into the `firebaseConfig` object below.
 *
 **********************************************************************************/
const firebaseConfig = {
    apiKey: "AIzaSyB8g1fUiGZv_lBPm7FGWBTQtCpo0R35Xgg",
    authDomain: "tmg-clothings.firebaseapp.com",
    projectId: "tmg-clothings",
    storageBucket: "tmg-clothings.firebasestorage.app",
    messagingSenderId: "801729913378",
    appId: "1:801729913378:web:f940bcc11c1fe21071a07b",
    measurementId: "G-LTR73S5839"
};

// Runtime check to prevent running with placeholder credentials.
/*
if (firebaseConfig.apiKey === "YOUR_API_KEY") {
  throw new Error(`
    ===================================================================================
    ERROR: FIREBASE IS NOT CONFIGURED
    ===================================================================================
    You must update the file 'src/services/firebase.service.ts' with your own
    Firebase project credentials. The application is currently using placeholder
    values, which caused this error.

    Please open that file and follow the instructions in the comments to fix this.
    The application cannot start otherwise.
    ===================================================================================
  `);
}
*/


// Helper function to initialize Firebase and handle hot-reloading
function initializeFirebase(): firebase.app.App {
  if (firebaseConfig.apiKey === "YOUR_API_KEY") {
    // If we're using mock data, don't try to initialize Firebase.
    return {} as firebase.app.App; 
  }
  // FIX: Switched to v8/compat syntax.
  if (firebase.apps.length) {
    return firebase.app();
  }
  return firebase.initializeApp(firebaseConfig);
}

// Initialize Firebase at the module level to ensure it's done only once.
const app = initializeFirebase();

// Get the auth and firestore instances, which will now be correctly associated with the app.
// FIX: Switched to v8/compat syntax.
const auth = firebaseConfig.apiKey !== "YOUR_API_KEY" ? firebase.auth() : ({} as firebase.auth.Auth);
const db = firebaseConfig.apiKey !== "YOUR_API_KEY" ? firebase.firestore() : ({} as firebase.firestore.Firestore);


@Injectable({ providedIn: 'root' })
export class FirebaseService {
  // Provide the already initialized instances to the rest of the app.
  // FIX: Updated types to match v8/compat SDK.
  app: firebase.app.App = app;
  auth: firebase.auth.Auth = auth;
  db: firebase.firestore.Firestore = db;

  constructor() {
    // The constructor is now empty as initialization is handled robustly at the module level.
  }
}
