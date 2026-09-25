/**
 * TEMPORARY Firestore read diagnostics (added 2026-09-25 for the
 * resource-exhausted investigation). Counts the document reads Firestore
 * bills, per screen and per query, so the screens/queries that still read
 * the most can be identified from a real session instead of guessed.
 *
 * Every read goes through firestore-reads.ts, which reports here. To remove:
 * delete this file, its imports in firestore-reads.ts and
 * synced-collection-cache.util.ts, and the setMeterPage() effect in
 * app.component.ts.
 *
 * In the browser DevTools console:
 *   tmgReads.report()  — reads per screen + query this session, heaviest first
 *   tmgReads.pages()   — reads per screen this session
 *   tmgReads.today()   — reads per screen + query today, across reloads (this browser only)
 *   tmgReads.listeners() — realtime listeners open right now
 *   tmgReads.reset()   — clear this session's counters
 * Every read is also logged at console.debug ("Verbose" level) as [reads] …,
 * and any single call that reads LARGE_READ_THRESHOLD+ documents logs a warning.
 *
 * Billing rules used for the estimate: a query costs max(1, docs returned);
 * a document get costs 1; count() costs 1 per 1000 matched docs (min 1); a
 * listener costs its initial result set, then 1 per changed doc.
 */

export type ReadKind = 'getDocs' | 'getDoc' | 'count' | 'listen' | 'tx.get' | 'cache-sync';

interface Entry {
  page: string;
  kind: ReadKind;
  label: string;
  calls: number;
  reads: number;
  errors: number;
  totalMs: number;
  maxDocs: number;
}

const LARGE_READ_THRESHOLD = 500;
const DAY_KEY_PREFIX = 'tmg:reads:';

const entries = new Map<string, Entry>();
const openListeners = new Map<string, number>();
let currentPage = 'boot';
let sessionTotal = 0;

let dayTotals: Record<string, { calls: number; reads: number }> = loadDayTotals();
let dayWriteTimer: ReturnType<typeof setTimeout> | null = null;

export function setMeterPage(page: string): void {
  if (page === currentPage) return;
  const leaving = pageTotal(currentPage);
  if (leaving > 0) console.info(`[reads] left "${currentPage}" — ${leaving} reads on that screen so far this session (session total ${sessionTotal})`);
  currentPage = page;
}

export function recordRead(kind: ReadKind, label: string, reads: number, ms: number, docs = reads): void {
  const entry = entryFor(kind, label);
  entry.calls += 1;
  entry.reads += reads;
  entry.totalMs += ms;
  entry.maxDocs = Math.max(entry.maxDocs, docs);
  sessionTotal += reads;
  bumpDay(kind, label, reads);

  console.debug(`[reads] ${currentPage} · ${kind} ${label} → ${reads} read${reads === 1 ? '' : 's'}${ms ? ` in ${Math.round(ms)}ms` : ''} (session ${sessionTotal})`);
  if (docs >= LARGE_READ_THRESHOLD) {
    console.warn(`[reads] LARGE READ on "${currentPage}": ${kind} ${label} returned ${docs} docs`);
  }
}

export function recordReadError(kind: ReadKind, label: string, err: unknown): void {
  entryFor(kind, label).errors += 1;
  const code = (err as { code?: string })?.code ?? 'unknown';
  console.debug(`[reads] ${currentPage} · ${kind} ${label} FAILED (${code})`);
}

/** Why a SyncedCollectionCache did a full reload instead of a cheap delta — the expensive path worth knowing about. */
export function recordCacheSync(storageKey: string, mode: 'full' | 'delta', detail: string): void {
  const entry = entryFor('cache-sync', `${storageKey} ${mode}`);
  entry.calls += 1;
  const line = `[reads] cache "${storageKey}" ${mode === 'full' ? 'FULL reload' : 'delta sync'} — ${detail}`;
  if (mode === 'full') console.info(line);
  else console.debug(line);
}

export function listenerOpened(label: string): void {
  openListeners.set(label, (openListeners.get(label) ?? 0) + 1);
}

export function listenerClosed(label: string): void {
  const next = (openListeners.get(label) ?? 1) - 1;
  if (next <= 0) openListeners.delete(label);
  else openListeners.set(label, next);
}

function entryFor(kind: ReadKind, label: string): Entry {
  const key = `${currentPage}|${kind}|${label}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = { page: currentPage, kind, label, calls: 0, reads: 0, errors: 0, totalMs: 0, maxDocs: 0 };
    entries.set(key, entry);
  }
  return entry;
}

function pageTotal(page: string): number {
  let total = 0;
  for (const e of entries.values()) if (e.page === page) total += e.reads;
  return total;
}

function todayKey(): string {
  const d = new Date();
  return `${DAY_KEY_PREFIX}${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadDayTotals(): Record<string, { calls: number; reads: number }> {
  try {
    const key = todayKey();
    // Keep only today's tally — this is a debugging aid, not an archive.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(DAY_KEY_PREFIX) && k !== key) localStorage.removeItem(k);
    }
    return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function bumpDay(kind: ReadKind, label: string, reads: number): void {
  const key = `${currentPage}|${kind}|${label}`;
  const row = dayTotals[key] ?? (dayTotals[key] = { calls: 0, reads: 0 });
  row.calls += 1;
  row.reads += reads;
  if (dayWriteTimer !== null) return;
  dayWriteTimer = setTimeout(() => {
    dayWriteTimer = null;
    try {
      localStorage.setItem(todayKey(), JSON.stringify(dayTotals));
    } catch {
      // Storage full/unavailable — the in-memory session counters still work.
    }
  }, 3000);
}

const api = {
  report(): void {
    const rows = [...entries.values()]
      .filter((e) => e.kind !== 'cache-sync')
      .sort((a, b) => b.reads - a.reads)
      .map((e) => ({
        screen: e.page,
        kind: e.kind,
        query: e.label,
        calls: e.calls,
        reads: e.reads,
        'max docs/call': e.maxDocs,
        'avg ms': e.calls ? Math.round(e.totalMs / e.calls) : 0,
        errors: e.errors,
      }));
    console.info(`[reads] session total: ${sessionTotal} billed reads`);
    console.table(rows);
    const fullReloads = [...entries.values()].filter((e) => e.kind === 'cache-sync' && e.label.endsWith(' full'));
    if (fullReloads.length) {
      console.info('[reads] cache full reloads this session (each one re-downloads a whole collection or range):');
      console.table(fullReloads.map((e) => ({ screen: e.page, cache: e.label.replace(/ full$/, ''), times: e.calls })));
    }
  },
  pages(): void {
    const totals = new Map<string, number>();
    for (const e of entries.values()) totals.set(e.page, (totals.get(e.page) ?? 0) + e.reads);
    console.table([...totals].sort((a, b) => b[1] - a[1]).map(([screen, reads]) => ({ screen, reads })));
  },
  today(): void {
    const rows = Object.entries(dayTotals)
      .map(([key, v]) => {
        const [screen, kind, ...rest] = key.split('|');
        return { screen, kind, query: rest.join('|'), calls: v.calls, reads: v.reads };
      })
      .sort((a, b) => b.reads - a.reads);
    console.info(`[reads] today in this browser: ${rows.reduce((sum, r) => sum + r.reads, 0)} billed reads`);
    console.table(rows);
  },
  listeners(): void {
    console.table([...openListeners].map(([query, open]) => ({ query, open })));
  },
  reset(): void {
    entries.clear();
    sessionTotal = 0;
  },
};

try {
  (globalThis as unknown as { tmgReads: typeof api }).tmgReads = api;
} catch {
  // Non-browser context — nothing to expose.
}
