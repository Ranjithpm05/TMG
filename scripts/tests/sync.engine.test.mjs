// Unit tests for src/services/sync.engine.ts (resumable paged full download,
// bounded retry, merge/dedupe, limiter).
// Run: npm run test:sync   (Node ≥ 22.18 runs the .ts engine directly via type stripping)
//
// FakeCollection mimics what the engine relies on from Firestore: a stable
// sort order with startAfter(doc) cursors (orderBy createdAt desc, id desc —
// the range/list caches' order), billed reads (1 per doc returned, min 1 per
// query), updatedAt stamped on every write, and injectable failures.
// MemoryStore stands in for IndexedDB and survives "app restarts".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_RETRY_POLICY, SYNC_CURSOR_LOST, backoffDelayMs, classifyError, createLimiter, dedupeById,
  mergeChanges, retryAfterMs, runResumableFullLoad, withBoundedRetry, withTimeout,
} from '../../src/services/sync.engine.ts';

const noSleep = { sleep: async () => {}, random: () => 0.5 };
const fsError = (code, message = code) => Object.assign(new Error(message), { code });

class FakeCollection {
  constructor(n) {
    this.clock = 1_000;
    this.docs = new Map();
    this.reads = 0;
    this.requests = 0;
    this.failures = []; // fns (ctx) => error | null, checked before each page request
    this.streamedSinceDrop = 0;
    this.dropEvery = Infinity; // simulate the backend dropping the stream every N docs
    for (let i = 0; i < n; i++) this.create({ name: `item-${i}` }, 10_000 + i);
  }
  id(i) { return `d${String(i).padStart(6, '0')}`; }
  create(data, createdAt = 10_000 + this.docs.size, id = this.id(this.docs.size)) {
    this.docs.set(id, { id, ...data, createdAt, updatedAt: ++this.clock });
    return id;
  }
  update(id, patch) { this.docs.set(id, { ...this.docs.get(id), ...patch, updatedAt: ++this.clock }); }
  remove(id) { this.docs.delete(id); }
  sorted() {
    return [...this.docs.values()].sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }
  charge(n) { this.reads += Math.max(1, n); this.requests++; }
  /** Throws if an injected failure or a stream drop applies to this request; drops are billed for what was streamed. */
  gate(ctx, size) {
    for (const f of this.failures) {
      const err = f(ctx);
      if (err) { this.requests++; throw err; }
    }
    if (this.streamedSinceDrop + size > this.dropEvery) {
      const sent = this.dropEvery - this.streamedSinceDrop;
      this.reads += sent; // billed although the client never got a usable page
      this.requests++;
      this.streamedSinceDrop = 0;
      throw fsError('resource-exhausted', 'Quota exceeded.');
    }
    this.streamedSinceDrop += size;
  }

  // ── adapter functions in the shape SyncedCollectionCache passes to the engine ──
  adapter({ inRunCursor = true } = {}) {
    let lastSnap = null; // in-run cursor (no extra read); null after a "restart"
    return {
      fetchAnchor: async () => {
        this.charge(1);
        let max = null;
        for (const d of this.docs.values()) max = Math.max(max ?? 0, d.updatedAt);
        return max;
      },
      fetchPage: async (lastId, size) => {
        let after = inRunCursor && lastSnap && lastSnap.id === lastId ? lastSnap : null;
        if (lastId && !after) {
          this.charge(1); // getDoc(lastId) to rebuild the cursor after a restart
          const live = this.docs.get(lastId);
          if (!live) throw fsError(SYNC_CURSOR_LOST);
          after = { ...live };
        }
        const all = this.sorted();
        const start = after
          ? all.findIndex((d) => (d.createdAt < after.createdAt) || (d.createdAt === after.createdAt && d.id < after.id))
          : 0;
        const page = start === -1 ? [] : all.slice(start, start + size);
        this.gate({ kind: 'page', lastId }, page.length);
        this.charge(page.length);
        if (page.length) lastSnap = { ...page[page.length - 1] };
        return { items: page.map((d) => ({ ...d })), lastId: lastSnap?.id ?? lastId };
      },
      fetchChangedSince: async (anchor) => {
        const changed = [...this.docs.values()].filter((d) => d.updatedAt >= anchor).sort((a, b) => a.updatedAt - b.updatedAt);
        this.charge(changed.length);
        return {
          changes: changed.map((d) => ({ item: { ...d }, included: true })),
          maxAnchor: changed.reduce((m, d) => Math.max(m, d.updatedAt), anchor),
        };
      },
    };
  }
}

class MemoryStore {
  constructor() { this.meta = null; this.pages = new Map(); this.writes = 0; }
  async readProgress() { return this.meta ? structuredClone(this.meta) : null; }
  async writeProgress(p) { this.meta = structuredClone(p); this.writes++; }
  async writePage(i, items) { this.pages.set(i, structuredClone(items)); this.writes++; }
  async readPages(count) {
    const out = [];
    for (let i = 0; i < count; i++) { if (!this.pages.has(i)) return null; out.push(structuredClone(this.pages.get(i))); }
    return out;
  }
  async clear() { this.meta = null; this.pages.clear(); }
}

function deps(coll, store, overrides = {}) {
  const logs = [];
  return {
    logs,
    run: () => runResumableFullLoad({
      key: 'test',
      querySig: 'v1:test',
      pageSize: 500,
      getId: (x) => x.id,
      store,
      retryHooks: noSleep,
      log: (e) => logs.push(e),
      ...coll.adapter(overrides.adapter),
      ...overrides,
    }),
  };
}

function assertExact(items, coll) {
  const ids = items.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate records');
  assert.deepEqual([...ids].sort(), [...coll.docs.keys()].sort(), 'exactly the server collection');
  for (const item of items) assert.deepEqual(item, coll.docs.get(item.id), `latest version of ${item.id}`);
}

// ── Fresh install / large collection ─────────────────────────────────────

test('fresh device: 11k docs arrive in 500-doc pages, exact copy, reads ≈ collection size', async () => {
  const coll = new FakeCollection(11_000);
  const store = new MemoryStore();
  const { run, logs } = deps(coll, store);
  const res = await run();
  assertExact(res.items, coll);
  assert.equal(res.pagesFetched, 23); // 22 full pages + 1 short
  assert.equal(res.pagesResumed, 0);
  // 1 anchor + 11000 docs + 1 empty-ish final page (min 1) ... + catch-up (anchor doc itself)
  assert.ok(coll.reads <= 11_000 + 3, `reads ${coll.reads}`);
  assert.equal(store.meta, null, 'progress cleared after success');
  assert.ok(logs.filter((l) => l.event === 'page').every((l) => l.pageSize === 500));
});

test('small collection (< 1 page) finishes in one page', async () => {
  const coll = new FakeCollection(120);
  const res = await deps(coll, new MemoryStore()).run();
  assertExact(res.items, coll);
  assert.equal(res.pagesFetched, 1);
});

test('empty collection: no anchor, empty result, no crash', async () => {
  const coll = new FakeCollection(0);
  const res = await deps(coll, new MemoryStore()).run();
  assert.deepEqual(res.items, []);
  assert.equal(res.cursor, null);
});

// ── Network interruption / retries ───────────────────────────────────────

test('temporary network interruption: page retried with backoff, no page downloaded twice', async () => {
  const coll = new FakeCollection(3_000);
  let failuresLeft = 2;
  coll.failures.push((ctx) => (ctx.kind === 'page' && ctx.lastId && failuresLeft-- > 0 ? fsError('unavailable') : null));
  const { run, logs } = deps(coll, new MemoryStore());
  const res = await run();
  assertExact(res.items, coll);
  const retries = logs.filter((l) => l.event === 'retry');
  assert.equal(retries.length, 2);
  assert.ok(retries.every((r) => r.code === 'unavailable' && r.delayMs > 0));
  assert.ok(coll.reads <= 3_000 + 3, `failed attempts must not re-bill completed pages (reads ${coll.reads})`);
});

test('a request that never answers times out (deadline-exceeded) and is retried — no infinite wait', async () => {
  const coll = new FakeCollection(1_200);
  const a = coll.adapter();
  let hangs = 1;
  const { run, logs } = deps(coll, new MemoryStore(), {
    requestTimeoutMs: 20,
    fetchPage: (lastId, size) => (lastId && hangs-- > 0 ? new Promise(() => {}) : a.fetchPage(lastId, size)),
  });
  const res = await run();
  assertExact(res.items, coll);
  assert.deepEqual(logs.filter((l) => l.event === 'retry').map((l) => l.code), ['deadline-exceeded']);
});

test('permission-denied: never retried, surfaces immediately', async () => {
  const coll = new FakeCollection(1_000);
  let pageAttempts = 0;
  coll.failures.push(() => { pageAttempts++; return fsError('permission-denied'); });
  await assert.rejects(deps(coll, new MemoryStore()).run(), { code: 'permission-denied' });
  assert.equal(pageAttempts, 1, 'exactly one page request');
});

test('quota error that persists: bounded attempts, then fails — pages kept for resume', async () => {
  const coll = new FakeCollection(5_000);
  const store = new MemoryStore();
  let quota = true;
  coll.failures.push((ctx) => (quota && ctx.kind === 'page' && ctx.lastId && store.meta?.pages >= 4 ? fsError('resource-exhausted', 'Quota exceeded.') : null));
  const first = deps(coll, store);
  await assert.rejects(first.run(), { code: 'resource-exhausted' });
  const retries = first.logs.filter((l) => l.event === 'retry');
  assert.equal(retries.length, PAGE_RETRY_POLICY.quotaMaxAttempts - 1, 'quota errors get few attempts');
  assert.ok(retries[0].delayMs >= PAGE_RETRY_POLICY.quotaBaseMs / 2, 'quota backoff is long');
  assert.equal(store.meta.pages, 4, '4 pages saved before the failure');

  // Recovery (Retry button / reconnect): resumes after page 4, downloads nothing twice.
  quota = false;
  const readsBefore = coll.reads;
  const second = deps(coll, store);
  const res = await second.run();
  assertExact(res.items, coll);
  assert.equal(res.pagesResumed, 4);
  const resumedReads = coll.reads - readsBefore;
  assert.ok(resumedReads <= 3_000 + 3, `only the remaining 3000 docs (+cursor/catch-up) are read, got ${resumedReads}`);
});

// ── App restart ──────────────────────────────────────────────────────────

test('app restart mid-download: resumes from the last saved page (+1 read to rebuild the cursor)', async () => {
  const coll = new FakeCollection(6_000);
  const store = new MemoryStore();
  let killed = false;
  coll.failures.push((ctx) => (!killed && store.meta?.pages === 7 ? (killed = true, fsError('permission-denied', 'simulated app kill')) : null));
  await assert.rejects(deps(coll, store).run());
  assert.equal(store.meta.pages, 7);

  const readsBefore = coll.reads;
  const res = await deps(coll, store).run(); // fresh adapter = no in-memory cursor
  assertExact(res.items, coll);
  assert.equal(res.pagesResumed, 7);
  const reads = coll.reads - readsBefore;
  // 6000 - 3500 = 2500 remaining docs, +1 getDoc for the cursor, + catch-up
  assert.ok(reads <= 2_500 + 3, `reads after restart ${reads}`);
});

test('saved progress for a different query or too old is discarded', async () => {
  const coll = new FakeCollection(1_200);
  const store = new MemoryStore();
  store.meta = { version: 1, anchor: 1, lastId: 'd000005', pages: 1, docs: 500, startedAt: Date.now(), querySig: 'v0:other' };
  store.pages.set(0, [{ id: 'bogus' }]);
  const { run, logs } = deps(coll, store);
  const res = await run();
  assertExact(res.items, coll);
  assert.ok(logs.some((l) => l.event === 'restart'));

  store.meta = { version: 1, anchor: 1, lastId: 'd000005', pages: 1, docs: 500, startedAt: Date.now() - 2 * 864e5, querySig: 'v1:test' };
  store.pages.set(0, [{ id: 'bogus' }]);
  const again = await deps(coll, store).run();
  assertExact(again.items, coll);
});

test('missing saved page → restart rather than an incomplete list', async () => {
  const coll = new FakeCollection(1_200);
  const store = new MemoryStore();
  store.meta = { version: 1, anchor: 1, lastId: coll.id(700), pages: 2, docs: 1000, startedAt: Date.now(), querySig: 'v1:test' };
  store.pages.set(0, coll.sorted().slice(0, 500)); // page 1 missing
  const res = await deps(coll, store).run();
  assertExact(res.items, coll);
  assert.equal(res.pagesResumed, 0);
});

test('resume point deleted on the server → cursor-lost (permanent) so the caller restarts', async () => {
  const coll = new FakeCollection(1_500);
  const store = new MemoryStore();
  let stop = true;
  coll.failures.push(() => (stop && store.meta?.pages === 1 ? fsError('permission-denied', 'kill') : null));
  await assert.rejects(deps(coll, store).run());
  stop = false;
  coll.remove(store.meta.lastId);
  await assert.rejects(deps(coll, store).run(), { code: SYNC_CURSOR_LOST });
  assert.equal(classifyError(fsError(SYNC_CURSOR_LOST)), 'permanent');
  // Caller (SyncedCollectionCache.fullLoad) clears progress and runs again:
  await store.clear();
  const res = await deps(coll, store).run();
  assertExact(res.items, coll);
});

// ── Data changing during the download ────────────────────────────────────

test('records created, edited and re-sorted while downloading are all present exactly once', async () => {
  const coll = new FakeCollection(4_000);
  const store = new MemoryStore();
  let page = 0;
  const firstDownloadedId = coll.sorted()[0].id; // newest doc → page 1
  const willMoveId = coll.sorted()[3_900].id;    // last page
  coll.failures.push((ctx) => {
    if (ctx.kind !== 'page') return null;
    page++;
    if (page === 3) {
      coll.create({ name: 'new-old-createdAt' }, 9_000, 'zz-backdated'); // sorts at the very end → picked up by paging
      coll.create({ name: 'new-newest' }, 99_999, 'zz-newest');          // sorts before the cursor → only the catch-up sees it
      coll.update(firstDownloadedId, { name: 'edited after download' }); // already downloaded → catch-up must refresh it
      coll.update(willMoveId, { createdAt: 99_998 });                    // moves ahead of the cursor → would be skipped by paging
    }
    return null;
  });
  const res = await deps(coll, store).run();
  assertExact(res.items, coll);
  assert.equal(res.items.find((x) => x.id === firstDownloadedId).name, 'edited after download');
  assert.ok(res.catchUpDocs >= 4);
});

test('a doc that lands in two pages is kept once (newest copy)', () => {
  const merged = dedupeById([{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'a', v: 2 }], (x) => x.id);
  assert.deepEqual(merged, [{ id: 'b', v: 1 }, { id: 'a', v: 2 }]);
});

test('mergeChanges: upserts included, removes excluded (left the date range)', () => {
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  const out = mergeChanges(base, [
    { item: { id: 'a', v: 2 }, included: true },
    { item: { id: 'b', v: 2 }, included: false },
    { item: { id: 'c', v: 1 }, included: true },
  ], (x) => x.id);
  assert.deepEqual(out.sort((x, y) => x.id.localeCompare(y.id)), [{ id: 'a', v: 2 }, { id: 'c', v: 1 }]);
});

// ── Retry policy ─────────────────────────────────────────────────────────

test('classifyError: permanent vs transient vs quota', () => {
  for (const c of ['permission-denied', 'unauthenticated', 'failed-precondition', 'invalid-argument', 'not-found']) assert.equal(classifyError(fsError(c)), 'permanent', c);
  for (const c of ['unavailable', 'deadline-exceeded', 'aborted', 'internal']) assert.equal(classifyError(fsError(c)), 'transient', c);
  assert.equal(classifyError(fsError('resource-exhausted')), 'quota');
  assert.equal(classifyError(new TypeError('Failed to fetch')), 'transient');
});

test('backoff: exponential, capped, jittered within [ceiling/2, ceiling]', () => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ceiling = Math.min(15_000, 1000 * 2 ** attempt);
    assert.equal(backoffDelayMs(attempt, 1000, 15_000, () => 0), ceiling / 2);
    assert.equal(backoffDelayMs(attempt, 1000, 15_000, () => 1), ceiling);
  }
});

test('retry-after hints are honoured when present', async () => {
  assert.equal(retryAfterMs({ retryAfter: 7 }), 7000);
  assert.equal(retryAfterMs({ customData: { retryAfter: '3' } }), 3000);
  assert.equal(retryAfterMs({ retryAfterMs: 1500 }), 1500);
  assert.equal(retryAfterMs(fsError('unavailable')), null);
  const waits = [];
  let calls = 0;
  await withBoundedRetry(async () => { if (calls++ === 0) throw Object.assign(fsError('unavailable'), { retryAfter: 9 }); return 1; },
    PAGE_RETRY_POLICY, { sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [9000]);
});

test('withTimeout: settles normally when fast, deadline-exceeded when not', async () => {
  assert.equal(await withTimeout(Promise.resolve(5), 50), 5);
  await assert.rejects(withTimeout(new Promise(() => {}), 10), { code: 'deadline-exceeded' });
  await assert.rejects(withTimeout(Promise.reject(fsError('unavailable')), 50), { code: 'unavailable' });
});

test('transient errors stop after maxAttempts (no infinite loop)', async () => {
  let calls = 0;
  await assert.rejects(withBoundedRetry(async () => { calls++; throw fsError('unavailable'); }, PAGE_RETRY_POLICY, noSleep), { code: 'unavailable' });
  assert.equal(calls, PAGE_RETRY_POLICY.maxAttempts);
});

// ── Concurrency ──────────────────────────────────────────────────────────

test('limiter: only one full download runs at a time, in order', async () => {
  const run = createLimiter(1);
  let active = 0;
  let maxActive = 0;
  const order = [];
  const task = (name) => run(async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    order.push(name);
    active--;
    return name;
  });
  const results = await Promise.all(['inventory', 'designs', 'invoices'].map(task));
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['inventory', 'designs', 'invoices']);
  assert.deepEqual(results, ['inventory', 'designs', 'invoices']);
});

// ── Before/after: the production failure mode ────────────────────────────

/** The pre-fix algorithm: 5000-doc pages, nothing kept on failure, background retry forever. */
async function oldFullLoad(coll, maxCycles) {
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const a = coll.adapter();
    const items = [];
    let lastId = null;
    try {
      for (;;) {
        const page = await a.fetchPage(lastId, 5000);
        items.push(...page.items);
        lastId = page.lastId;
        if (page.items.length < 5000) return { done: true, cycles: cycle };
      }
    } catch {
      // thrown away — next cycle starts from scratch
    }
  }
  return { done: false, cycles: maxCycles };
}

test('BEFORE vs AFTER: stream dropped every ~8000 docs (as observed: ~11 MB then RESOURCE_EXHAUSTED)', async () => {
  const N = 11_000;
  const before = new FakeCollection(N);
  before.dropEvery = 8_000;
  const oldRes = await oldFullLoad(before, 24); // old schedule reaches 60 s spacing → ~24 cycles in ~25 min
  const after = new FakeCollection(N);
  after.dropEvery = 8_000;
  const store = new MemoryStore();
  let runs = 0;
  let res;
  for (; runs < 10 && !res; runs++) {
    try { res = await deps(after, store).run(); } catch (err) { assert.equal(err.code, 'resource-exhausted'); }
  }
  console.log(`  before: done=${oldRes.done} after ${oldRes.cycles} cycles, ${before.reads} reads billed, ${before.requests} requests`);
  console.log(`  after:  done=${!!res} after ${runs} runs, ${after.reads} reads billed, ${after.requests} requests`);
  assert.equal(oldRes.done, false, 'old algorithm never finishes');
  assert.ok(before.reads >= 24 * 8_000);
  assert.ok(res, 'new algorithm finishes');
  assertExact(res.items, after);
  assert.ok(after.reads < N * 1.15, `new reads ${after.reads} stay close to the collection size`);
});
