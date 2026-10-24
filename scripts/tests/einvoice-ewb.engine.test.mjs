// Unit tests for src/services/einvoice-ewb.engine.ts (single-click E-Invoice & E-Way Bill).
// Run: npm run test:einvoice-ewb   (Node ≥ 22.18 runs the .ts engine directly via type stripping)
//
// FakeIrp mimics the parts of Webtel/NIC + Firestore the flow relies on:
//  - one invoice doc, read fresh via loadLatest()
//  - GenIRN2 issues an IRN once per invoice and rejects a second request as a duplicate (NIC 2150)
//  - GenEWaybyIRN requires an IRN and rejects a second E-Way Bill for the same IRN
//  - per-call failure injection and call counters
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CombinedGenerationError, CombinedGenerationRunner, planCombinedGeneration, retryAsync,
  runCombinedGeneration, validateTransportDetails,
} from '../../src/services/einvoice-ewb.engine.ts';

const VALID_TRANSPORT = { distance: 120, transMode: '1', transporterId: '33AAACN1283H1ZQ', vehicleNo: 'TN37AB1234', vehicleType: 'R' };

class FakeIrp {
  constructor(invoice = {}) {
    this.doc = { id: 'inv1', invoiceNo: 'TMG/25-26/001', eInvoiceStatus: 'pending', ...invoice };
    this.calls = { einvoice: 0, ewb: 0, load: 0 };
    this.failEInvoice = null; // Error to throw from the next GenIRN2 call
    this.failEwb = null;
    this.delayMs = 0;
  }
  async loadLatest() {
    this.calls.load++;
    return structuredClone(this.doc);
  }
  async generateEInvoice(inv) {
    this.calls.einvoice++;
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failEInvoice) {
      const err = this.failEInvoice; this.failEInvoice = null;
      this.doc.eInvoiceStatus = 'failed'; this.doc.eInvoiceErrorMessage = err.message;
      throw err;
    }
    if (this.doc.irn) throw new Error('Duplicate IRN (code 2150)');
    Object.assign(this.doc, { eInvoiceStatus: 'generated', irn: `IRN-${inv.invoiceNo}` });
    return { ...inv, eInvoiceStatus: 'generated', irn: this.doc.irn };
  }
  async generateEwayBill(inv) {
    this.calls.ewb++;
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (!inv.irn || inv.eInvoiceStatus !== 'generated') throw new Error('This invoice does not have a generated E-Invoice (IRN) yet.');
    if (this.failEwb) {
      const err = this.failEwb; this.failEwb = null;
      this.doc.ewbStatus = 'failed'; this.doc.ewbErrorMessage = err.message;
      throw err;
    }
    if (this.doc.ewbStatus === 'generated') throw new Error('E-Way Bill already generated for this IRN');
    Object.assign(this.doc, { ewbStatus: 'generated', ewbNo: '381001234567' });
    return { ...inv, ewbStatus: 'generated', ewbNo: this.doc.ewbNo };
  }
  deps(transport = VALID_TRANSPORT, progress = []) {
    return {
      transport,
      loadLatest: () => this.loadLatest(),
      generateEInvoice: (i) => this.generateEInvoice(i),
      generateEwayBill: (i) => this.generateEwayBill(i),
      onProgress: (s) => progress.push(s),
    };
  }
}

// ── Successful generation ──────────────────────────────────────────────

test('generates the E-Invoice first, then the E-Way Bill from its IRN', async () => {
  const irp = new FakeIrp();
  const progress = [];
  const { status, invoice } = await runCombinedGeneration(irp.deps(VALID_TRANSPORT, progress));
  assert.equal(status.einvoice.state, 'success');
  assert.equal(status.einvoice.docNo, 'IRN-TMG/25-26/001');
  assert.equal(status.ewb.state, 'success');
  assert.equal(status.ewb.docNo, '381001234567');
  assert.equal(invoice.ewbNo, '381001234567');
  assert.deepEqual(irp.calls, { einvoice: 1, ewb: 1, load: 1 });
  // Live status: step 1 running → step 2 running → final.
  assert.deepEqual(progress.map((p) => [p.einvoice.state, p.ewb.state]), [
    ['running', 'pending'], ['success', 'running'], ['success', 'success'],
  ]);
});

test('retries a previously failed E-Invoice (status failed is retryable)', async () => {
  const irp = new FakeIrp({ eInvoiceStatus: 'failed', eInvoiceErrorMessage: 'old error' });
  const { status } = await runCombinedGeneration(irp.deps());
  assert.equal(status.einvoice.state, 'success');
  assert.equal(status.ewb.state, 'success');
});

// ── Validation failures: nothing is sent ──────────────────────────────

test('invalid transport details abort before any API call', async () => {
  const irp = new FakeIrp();
  await assert.rejects(
    runCombinedGeneration(irp.deps({ distance: -5, transMode: '1', transporterId: 'BAD', vehicleNo: 'TN 37' })),
    (err) => {
      assert.ok(err instanceof CombinedGenerationError);
      assert.equal(err.errors.length, 3);
      return true;
    }
  );
  assert.equal(irp.calls.einvoice, 0);
  assert.equal(irp.calls.ewb, 0);
  assert.equal(irp.doc.irn, undefined, 'no IRN must be issued when E-Way Bill data is invalid');
});

test('validateTransportDetails rules', () => {
  assert.deepEqual(validateTransportDetails(VALID_TRANSPORT), []);
  assert.deepEqual(validateTransportDetails({ distance: 0, transMode: '1', vehicleNo: 'TN37AB1234' }), [], '0 km = portal auto-calculates');
  assert.deepEqual(validateTransportDetails({ distance: 10, transMode: '3', transporterId: '33AAACN1283H1ZQ' }), []);
  assert.equal(validateTransportDetails({ distance: 4001, transMode: '1', vehicleNo: 'TN37AB1234' }).length, 1);
  assert.equal(validateTransportDetails({ distance: 12.5, transMode: '1', vehicleNo: 'TN37AB1234' }).length, 1);
  assert.match(validateTransportDetails({ distance: 10, transMode: '9', transporterId: '33AAACN1283H1ZQ' }).join(), /transport mode/);
  assert.match(validateTransportDetails({ distance: 10, transMode: '1' })[0], /Vehicle No\. or the Transporter ID/);
  assert.match(validateTransportDetails({ distance: 10, transMode: '2' })[0], /required for Rail/);
  // A vehicle no. typed before switching away from Road doesn't satisfy Part-B.
  assert.equal(validateTransportDetails({ distance: 10, transMode: '2', vehicleNo: 'TN37AB1234' }).length, 1);
  assert.deepEqual(validateTransportDetails({ distance: 10, transMode: '1', transporterId: '33aaacn1283h1zq' }), [], 'lowercase is normalized');
});

test('cancelled E-Invoice and already-complete invoices are rejected', async () => {
  assert.throws(() => planCombinedGeneration({ invoiceNo: 'X', eInvoiceStatus: 'cancelled', irn: 'I' }), /cancelled/);
  assert.throws(
    () => planCombinedGeneration({ invoiceNo: 'X', eInvoiceStatus: 'generated', irn: 'I', ewbStatus: 'generated', ewbNo: '1' }),
    /already been generated/
  );
  const irp = new FakeIrp({ eInvoiceStatus: 'generated', irn: 'I', ewbStatus: 'generated', ewbNo: '1' });
  await assert.rejects(runCombinedGeneration(irp.deps()), CombinedGenerationError);
  assert.deepEqual([irp.calls.einvoice, irp.calls.ewb], [0, 0]);
});

// ── API failures ──────────────────────────────────────────────────────

test('E-Invoice API failure: step 1 failed with reason, E-Way Bill not attempted', async () => {
  const irp = new FakeIrp();
  irp.failEInvoice = new Error('Invalid buyer GSTIN (code 2265)');
  const { status } = await runCombinedGeneration(irp.deps());
  assert.equal(status.einvoice.state, 'failed');
  assert.equal(status.einvoice.message, 'Invalid buyer GSTIN (code 2265)');
  assert.equal(status.ewb.state, 'skipped');
  assert.match(status.ewb.message, /must be generated first/);
  assert.equal(irp.calls.ewb, 0);
});

test('partial success: E-Invoice kept, E-Way Bill failure reported', async () => {
  const irp = new FakeIrp();
  irp.failEwb = new Error('Distance exceeds limit (code 702)');
  const { status } = await runCombinedGeneration(irp.deps());
  assert.equal(status.einvoice.state, 'success');
  assert.equal(status.ewb.state, 'failed');
  assert.equal(status.ewb.message, 'Distance exceeds limit (code 702)');
  assert.equal(irp.doc.eInvoiceStatus, 'generated');
  assert.equal(irp.doc.ewbStatus, 'failed');
});

test('retry after partial success reuses the IRN and only generates the E-Way Bill', async () => {
  const irp = new FakeIrp();
  irp.failEwb = new Error('Portal timeout');
  await runCombinedGeneration(irp.deps());
  const { status } = await runCombinedGeneration(irp.deps());
  assert.equal(status.einvoice.state, 'skipped');
  assert.equal(status.einvoice.docNo, 'IRN-TMG/25-26/001');
  assert.equal(status.ewb.state, 'success');
  assert.equal(irp.calls.einvoice, 1, 'E-Invoice must not be regenerated');
  assert.equal(irp.calls.ewb, 2);
});

test('state changed elsewhere (another tab generated the E-Invoice) is picked up from the fresh read', async () => {
  const irp = new FakeIrp({ eInvoiceStatus: 'generated', irn: 'IRN-OTHER-TAB' });
  const { status } = await runCombinedGeneration(irp.deps());
  assert.equal(status.einvoice.state, 'skipped');
  assert.equal(irp.calls.einvoice, 0);
  assert.equal(status.ewb.state, 'success');
});

test('unexpected error without a message still yields a readable failure', async () => {
  const irp = new FakeIrp();
  irp.failEInvoice = {};
  const { status } = await runCombinedGeneration(irp.deps());
  assert.equal(status.einvoice.message, 'E-Invoice generation failed.');
});

// ── Repeated clicks / duplicate prevention ────────────────────────────

test('repeated clicks while a run is in flight never fire duplicate API calls', async () => {
  const irp = new FakeIrp();
  irp.delayMs = 20;
  const runner = new CombinedGenerationRunner();
  const first = runner.run('inv1', irp.deps());
  assert.equal(runner.isRunning('inv1'), true);
  const clicks = await Promise.allSettled([runner.run('inv1', irp.deps()), runner.run('inv1', irp.deps())]);
  for (const c of clicks) {
    assert.equal(c.status, 'rejected');
    assert.match(c.reason.message, /already in progress/);
  }
  const { status } = await first;
  assert.equal(status.ewb.state, 'success');
  assert.deepEqual([irp.calls.einvoice, irp.calls.ewb], [1, 1]);
  assert.equal(runner.isRunning('inv1'), false);
  // Clicking again after completion is rejected by the plan — no API call.
  await assert.rejects(runner.run('inv1', irp.deps()), /already been generated/);
  assert.deepEqual([irp.calls.einvoice, irp.calls.ewb], [1, 1]);
});

test('the in-flight guard is released after a failure so the user can retry', async () => {
  const irp = new FakeIrp();
  const runner = new CombinedGenerationRunner();
  await assert.rejects(runner.run('inv1', irp.deps({ distance: 10, transMode: '1' })), CombinedGenerationError);
  assert.equal(runner.isRunning('inv1'), false);
  const { status } = await runner.run('inv1', irp.deps());
  assert.equal(status.ewb.state, 'success');
});

test('different invoices can run concurrently', async () => {
  const a = new FakeIrp(); const b = new FakeIrp({ id: 'inv2', invoiceNo: 'TMG/25-26/002' });
  a.delayMs = b.delayMs = 10;
  const runner = new CombinedGenerationRunner();
  const [ra, rb] = await Promise.all([runner.run('inv1', a.deps()), runner.run('inv2', b.deps())]);
  assert.equal(ra.status.ewb.state, 'success');
  assert.equal(rb.status.ewb.state, 'success');
});

// ── retryAsync (Firestore save of an already-issued document) ─────────

test('retryAsync retries transient failures and rethrows the last error', async () => {
  let n = 0;
  assert.equal(await retryAsync(async () => { if (++n < 3) throw new Error('unavailable'); return 'saved'; }, 3, 1), 'saved');
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(retryAsync(async () => { n++; throw new Error(`fail ${n}`); }, 2, 1), /fail 2/);
  assert.equal(n, 2);
});
