import { signal } from '@angular/core';
import { onLog } from 'firebase/app';

/**
 * Tracks whether Firestore is currently refusing requests, and decides which
 * failures are worth retrying automatically.
 *
 * When Firestore returns RESOURCE_EXHAUSTED ("Quota exceeded") the SDK only
 * logs it and reconnects on its own at a 60 s maximum backoff — the app is
 * never told. Reads are therefore retried in the background by the read
 * wrappers (firestore-reads.ts) and the list caches (SyncedCollectionCache,
 * PersistentCollectionCache), which keep showing the copy saved on this device
 * meanwhile and fill the screen in by themselves once Firestore answers again.
 * Nothing here is shown to users; the login screen uses the state only to
 * word its error honestly.
 */

export type FirestoreConnectionState = 'ok' | 'quota-exceeded' | 'offline';

const state = signal<FirestoreConnectionState>('ok');
export const firestoreHealth = state.asReadonly();

/** Errors that clear up by themselves (quota window, network, server overload) — retried instead of surfaced. */
const TRANSIENT_CODES = new Set(['resource-exhausted', 'unavailable', 'deadline-exceeded']);

export function isTransientFirestoreError(err: unknown): boolean {
  return TRANSIENT_CODES.has((err as { code?: string })?.code ?? '');
}

/** Background retry schedule for list loads: 5 s, 10 s, 20 s, 40 s, then every 60 s until Firestore answers. */
export function backgroundRetryDelayMs(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** attempt);
}

export function noteFirestoreError(err: unknown): void {
  const code = (err as { code?: string })?.code;
  if (code === 'resource-exhausted') enterQuotaExceeded();
  else if (code === 'unavailable' && state() === 'ok') state.set('offline');
}

export function noteFirestoreSuccess(): void {
  if (state() === 'ok') return;
  console.info('[firestore] reachable again — pending loads are filling in');
  state.set('ok');
}

function enterQuotaExceeded(): void {
  if (state() === 'quota-exceeded') return;
  state.set('quota-exceeded');
  console.warn('[firestore] Quota exceeded (resource-exhausted) — Firestore is refusing reads. Screens keep the data saved on this device and reload automatically once Firestore answers again.');
}

// Stream-level failures (listens, and getDocs which the full SDK serves over
// the same listen stream) are only ever logged by the SDK, never thrown —
// the log line is the one reliable signal. The SDK's own console output is
// left untouched; this handler runs in addition to it.
onLog(
  ({ message }) => {
    if (/resource-exhausted|quota exceeded/i.test(message)) enterQuotaExceeded();
  },
  { level: 'warn' }
);
