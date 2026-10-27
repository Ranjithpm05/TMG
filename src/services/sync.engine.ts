/**
 * Pure sync logic behind SyncedCollectionCache — no Firebase/Angular imports,
 * so it runs under `node --test` (scripts/tests/sync.engine.test.mjs).
 *
 * Why this exists (root cause, measured 2026-10-27): a device with no local
 * copy downloaded every large collection at once in 5000-doc pages over the
 * SDK's single Listen stream (~11 MB in ~30 s). Firestore then dropped the
 * stream with RESOURCE_EXHAUSTED "Quota exceeded." — no project quota was
 * exceeded (Blaze, 1–1.8M reads/day, no quota/exceeded events); it is the
 * backend refusing that much concurrent streamed data. Every failure threw
 * away the pages already received (billed, never kept) and retried from
 * scratch forever, so a handful of stuck phones burned ~1.5M reads/day while
 * their screens never left the loading state.
 *
 * This engine instead:
 *  - downloads in small pages (default 500), one full download at a time;
 *  - persists every page as it lands, plus the cursor (last doc id), so a
 *    failure or app restart resumes after the last good page;
 *  - records an anchor (the newest updatedAt on the server) BEFORE the first
 *    page and runs one delta from it AFTER the last page, so docs created or
 *    edited while the download was running are never missed;
 *  - dedupes by id (a doc that moved between pages appears once, newest wins);
 *  - retries a failing page a bounded number of times with exponential
 *    backoff + jitter, never retries permanent errors, and gives up on
 *    resource-exhausted quickly instead of hammering the backend.
 */

// ── Error classification + bounded retry ─────────────────────────────────

export type SyncErrorClass = 'permanent' | 'transient' | 'quota';

/** Thrown by a page fetcher when the saved resume point (a doc id) was deleted — the caller restarts the download. */
export const SYNC_CURSOR_LOST = 'sync/cursor-lost';

const PERMANENT_CODES = new Set([
  'permission-denied', 'unauthenticated', 'invalid-argument', 'failed-precondition',
  'not-found', 'already-exists', 'out-of-range', 'unimplemented', 'data-loss',
  SYNC_CURSOR_LOST,
]);

export function errorCode(err: unknown): string {
  return String((err as { code?: string } | null)?.code ?? 'unknown');
}

/** permanent: retrying can't help (rules, missing index). quota: back off hard, few attempts. transient: network/server blips. */
export function classifyError(err: unknown): SyncErrorClass {
  const code = errorCode(err);
  if (code === 'resource-exhausted') return 'quota';
  if (PERMANENT_CODES.has(code)) return 'permanent';
  return 'transient';
}

export interface RetryPolicy {
  /** Total attempts (first try included) for transient errors. */
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  /** Total attempts for resource-exhausted — kept low so a refusing backend isn't hammered. */
  quotaMaxAttempts: number;
  quotaBaseMs: number;
}

export const PAGE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseMs: 1000,
  maxMs: 15_000,
  quotaMaxAttempts: 2,
  quotaBaseMs: 20_000,
};

/** Exponential backoff with "equal jitter": half fixed, half random — spreads retries from many devices apart. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** Honours a server/proxy retry hint when the error carries one (seconds or ms); null when absent. */
export function retryAfterMs(err: unknown): number | null {
  const e = err as { retryAfterMs?: unknown; retryAfter?: unknown; customData?: { retryAfter?: unknown } } | null;
  const ms = Number(e?.retryAfterMs);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(e?.retryAfter ?? e?.customData?.retryAfter);
  if (Number.isFinite(s) && s > 0) return s * 1000;
  return null;
}

export interface RetryHooks {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called before each wait — for logs/status (attempt is 1-based count of failures so far). */
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; code: string }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withBoundedRetry<R>(fn: () => Promise<R>, policy: RetryPolicy, hooks: RetryHooks = {}): Promise<R> {
  const sleep = hooks.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const kind = classifyError(err);
      if (kind === 'permanent') throw err;
      const max = kind === 'quota' ? policy.quotaMaxAttempts : policy.maxAttempts;
      if (attempt + 1 >= max) throw err;
      const base = kind === 'quota' ? policy.quotaBaseMs : policy.baseMs;
      const delayMs = retryAfterMs(err) ?? backoffDelayMs(attempt, base, Math.max(policy.maxMs, base), hooks.random);
      hooks.onRetry?.({ attempt: attempt + 1, maxAttempts: max, delayMs, code: errorCode(err) });
      await sleep(delayMs);
    }
  }
}

/**
 * Rejects with deadline-exceeded (a transient, retried error) when `promise`
 * hasn't settled in time. Mobile networks and an offline SDK can leave a
 * request pending indefinitely — without this, a screen waits forever.
 */
export function withTimeout<R>(promise: Promise<R>, ms: number): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`no response within ${Math.round(ms / 1000)}s`), { code: 'deadline-exceeded' })), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── Concurrency limiter ──────────────────────────────────────────────────

/** Runs at most `concurrency` tasks at once, FIFO. Used so only one full download streams at a time. */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= concurrency) return;
    const start = queue.shift();
    if (start) { active++; start(); }
  };
  return function run<R>(task: () => Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      queue.push(() => {
        task().then(resolve, reject).finally(() => { active--; next(); });
      });
      next();
    });
  };
}

// ── Merge helpers ────────────────────────────────────────────────────────

export interface Change<T> {
  item: T;
  /** False when the doc no longer belongs in this list (left the date range / filter) — it is removed. */
  included: boolean;
}

/** Applies changes on top of `base` by id: included → upsert (newest wins), excluded → remove. Order is not preserved; callers re-sort. */
export function mergeChanges<T>(base: T[], changes: Change<T>[], getId: (item: T) => string): T[] {
  const byId = new Map(base.map((x) => [getId(x), x] as const));
  for (const { item, included } of changes) {
    if (included) byId.set(getId(item), item);
    else byId.delete(getId(item));
  }
  return [...byId.values()];
}

/** Concatenates pages, keeping the LAST occurrence of each id (a doc can land in two pages if it moved while paging). */
export function dedupeById<T>(items: T[], getId: (item: T) => string): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const id = getId(item);
    byId.delete(id);
    byId.set(id, item);
  }
  return [...byId.values()];
}

// ── Resumable full download ──────────────────────────────────────────────

export const FULL_LOAD_PROGRESS_VERSION = 1;

export interface FullLoadProgress<A> {
  version: number;
  /** Newest updatedAt on the server when this download started (null: no doc has updatedAt). */
  anchor: A | null;
  /** Id of the last doc of the last persisted page — the resume point. */
  lastId: string | null;
  pages: number;
  docs: number;
  startedAt: number;
  /** Signature of the query (constraints) — progress from a different query is never resumed. */
  querySig: string;
}

export interface FullLoadStore<T, A> {
  readProgress(): Promise<FullLoadProgress<A> | null>;
  writeProgress(progress: FullLoadProgress<A>): Promise<void>;
  writePage(index: number, items: T[]): Promise<void>;
  /** All `count` pages in order, or null if any is missing/corrupt (then the download restarts). */
  readPages(count: number): Promise<T[][] | null>;
  clear(): Promise<void>;
}

export interface PageFetchResult<T> {
  items: T[];
  /** Id of the last doc in the page (the next page starts after it). */
  lastId: string | null;
}

export interface FullLoadLog {
  key: string;
  event: 'start' | 'resume' | 'page' | 'retry' | 'catch-up' | 'done' | 'restart';
  page?: number;
  pageSize?: number;
  docs?: number;
  totalDocs?: number;
  cursor?: string | null;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  code?: string;
  reason?: string;
}

export interface FullLoadDeps<T, A> {
  key: string;
  querySig: string;
  pageSize: number;
  getId: (item: T) => string;
  /** Newest updatedAt on the server right now (1 read), or null when no doc has one. */
  fetchAnchor: () => Promise<A | null>;
  /** One page after `lastId` (null = from the start) — `pageSize` docs max. */
  fetchPage: (lastId: string | null, pageSize: number) => Promise<PageFetchResult<T>>;
  /** Every doc with updatedAt >= anchor, plus whether it belongs in the list; and the newest updatedAt seen. */
  fetchChangedSince: (anchor: A) => Promise<{ changes: Change<T>[]; maxAnchor: A | null }>;
  store: FullLoadStore<T, A>;
  retryPolicy?: RetryPolicy;
  retryHooks?: Omit<RetryHooks, 'onRetry'>;
  /** Progress older than this is discarded and the download restarts. */
  maxProgressAgeMs?: number;
  /** Per-request timeout (page, anchor); the catch-up, which may span pages, gets 4×. Unset = no timeout. */
  requestTimeoutMs?: number;
  now?: () => number;
  log?: (entry: FullLoadLog) => void;
  onProgress?: (info: { pages: number; docs: number }) => void;
  /** Persists the finished list; awaited BEFORE the saved pages are dropped, so a crash in between can't lose the download. */
  commit?: (items: T[], cursor: A | null) => Promise<void>;
}

export interface FullLoadResult<T, A> {
  items: T[];
  /** Delta cursor for the next sync: the newest updatedAt known to be fully included. */
  cursor: A | null;
  pagesFetched: number;
  pagesResumed: number;
  docsFetched: number;
  catchUpDocs: number;
}

export async function runResumableFullLoad<T, A>(deps: FullLoadDeps<T, A>): Promise<FullLoadResult<T, A>> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const policy = deps.retryPolicy ?? PAGE_RETRY_POLICY;
  const maxAge = deps.maxProgressAgeMs ?? 24 * 60 * 60 * 1000;
  const timed = <R>(fn: () => Promise<R>, factor = 1) => () =>
    (deps.requestTimeoutMs ? withTimeout(fn(), deps.requestTimeoutMs * factor) : fn());
  const retry = <R>(fn: () => Promise<R>, page: number, timeoutFactor = 1) =>
    withBoundedRetry(timed(fn, timeoutFactor), policy, {
      ...deps.retryHooks,
      onRetry: (r) => log({ key: deps.key, event: 'retry', page, attempt: r.attempt, maxAttempts: r.maxAttempts, delayMs: r.delayMs, code: r.code }),
    });

  // 1. Resume persisted progress when it is for this exact query and recent.
  let progress = await deps.store.readProgress().catch(() => null);
  let pages: T[][] = [];
  if (progress) {
    const usable = progress.version === FULL_LOAD_PROGRESS_VERSION
      && progress.querySig === deps.querySig
      && now() - progress.startedAt < maxAge
      && progress.pages > 0
      && progress.lastId !== null;
    const restored = usable ? await deps.store.readPages(progress.pages).catch(() => null) : null;
    if (restored) {
      pages = restored;
      log({ key: deps.key, event: 'resume', page: progress.pages, totalDocs: progress.docs, cursor: tail(progress.lastId) });
    } else {
      log({ key: deps.key, event: 'restart', reason: usable ? 'saved pages missing' : 'saved progress stale or for another query' });
      await deps.store.clear().catch(() => {});
      progress = null;
    }
  }
  const pagesResumed = pages.length;

  // 2. Fresh start: anchor first, so every write after this moment is caught by the catch-up delta.
  if (!progress) {
    const anchor = await retry(() => deps.fetchAnchor(), 0);
    progress = { version: FULL_LOAD_PROGRESS_VERSION, anchor, lastId: null, pages: 0, docs: 0, startedAt: now(), querySig: deps.querySig };
    await deps.store.writeProgress(progress).catch(() => {});
    log({ key: deps.key, event: 'start', pageSize: deps.pageSize });
  }

  // 3. Page loop — each page persisted before the next is requested.
  let pagesFetched = 0;
  let docsFetched = 0;
  for (;;) {
    const pageNo = progress.pages + 1;
    const result = await retry(() => deps.fetchPage(progress!.lastId, deps.pageSize), pageNo);
    pagesFetched++;
    docsFetched += result.items.length;
    if (result.items.length > 0) {
      pages.push(result.items);
      await deps.store.writePage(progress.pages, result.items).catch(() => {});
      progress = { ...progress, pages: progress.pages + 1, docs: progress.docs + result.items.length, lastId: result.lastId };
      await deps.store.writeProgress(progress).catch(() => {});
      deps.onProgress?.({ pages: progress.pages, docs: progress.docs });
    }
    log({ key: deps.key, event: 'page', page: pageNo, pageSize: deps.pageSize, docs: result.items.length, totalDocs: progress.docs, cursor: tail(progress.lastId) });
    if (result.items.length < deps.pageSize) break;
  }

  // 4. Catch-up: everything written since the anchor (created/edited mid-download).
  let items = dedupeById(pages.flat(), deps.getId);
  let cursor = progress.anchor;
  let catchUpDocs = 0;
  if (progress.anchor !== null) {
    const anchor = progress.anchor;
    const { changes, maxAnchor } = await retry(() => deps.fetchChangedSince(anchor), progress.pages + 1, 4);
    catchUpDocs = changes.length;
    items = mergeChanges(items, changes, deps.getId);
    if (maxAnchor !== null) cursor = maxAnchor;
    log({ key: deps.key, event: 'catch-up', docs: changes.length });
  }

  await deps.commit?.(items, cursor);
  await deps.store.clear().catch(() => {});
  log({ key: deps.key, event: 'done', totalDocs: items.length, page: progress.pages });
  return { items, cursor, pagesFetched, pagesResumed, docsFetched, catchUpDocs };
}

/** Last 6 chars of a doc id — enough to correlate logs, no business data. */
function tail(id: string | null | undefined): string | null {
  return id ? `…${id.slice(-6)}` : null;
}
