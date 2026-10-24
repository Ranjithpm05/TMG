// Framework-free orchestration for the single-click "Generate E-Invoice &
// E-Way Bill" flow (see CombinedGenerationService) — kept free of Angular /
// Firebase imports so it runs under `node --test` (scripts/tests/).
//
// Business rule driving the sequence: the E-Way Bill is generated *from* the
// e-Invoice's IRN (Webtel GenEWaybyIRN), so step 2 only ever runs once step 1
// has an IRN. A document that already exists is never regenerated — re-running
// after a partial success resumes at the step that failed.
import type { EwayBillTransportDetails } from '../models/invoice.model';

export type DocStatus = 'pending' | 'generated' | 'failed' | 'cancelled';

// The slice of Invoice this flow reads.
export interface CombinedInvoiceState {
  id?: string;
  invoiceNo: string;
  eInvoiceStatus?: DocStatus;
  irn?: string;
  ewbStatus?: DocStatus;
  ewbNo?: string;
}

export type StepState = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface StepStatus {
  state: StepState;
  message?: string;
  docNo?: string; // IRN for step 1, E-Way Bill No. for step 2
}

export interface CombinedStatus {
  einvoice: StepStatus;
  ewb: StepStatus;
}

export interface CombinedPlan {
  einvoice: 'run' | 'skip';
  ewb: 'run' | 'skip';
}

export class CombinedGenerationError extends Error {
  readonly errors: string[];

  constructor(message: string, errors: string[] = [message]) {
    super(message);
    this.name = 'CombinedGenerationError';
    this.errors = errors;
  }
}

// Decides which steps still need to run for the invoice's current state, or
// throws when the combined flow can't apply at all.
export function planCombinedGeneration(invoice: CombinedInvoiceState): CombinedPlan {
  if (invoice.eInvoiceStatus === 'cancelled') {
    throw new CombinedGenerationError('This E-Invoice has been cancelled — neither document can be generated for it.');
  }
  const einvoiceDone = invoice.eInvoiceStatus === 'generated' && !!invoice.irn;
  const ewbDone = invoice.ewbStatus === 'generated' && !!invoice.ewbNo;
  if (einvoiceDone && ewbDone) {
    throw new CombinedGenerationError('Both the E-Invoice and the E-Way Bill have already been generated for this invoice.');
  }
  return { einvoice: einvoiceDone ? 'skip' : 'run', ewb: ewbDone ? 'skip' : 'run' };
}

// GSTIN-shaped TRANSIN / transporter GSTIN (15 alphanumerics).
const TRANSPORTER_ID_RE = /^[0-9]{2}[0-9A-Z]{13}$/;
// NIC accepts regular, temporary and defence registrations — only the shape
// common to all of them is enforced here: 4–20 alphanumerics, no spaces.
const VEHICLE_NO_RE = /^[A-Z0-9]{4,20}$/;
const MAX_DISTANCE_KM = 4000;

// Checks the E-Way Bill transport details up front, before *any* API call, so
// bad transport data can never leave an IRN issued with no E-Way Bill.
export function validateTransportDetails(form: EwayBillTransportDetails): string[] {
  const errors: string[] = [];
  if (!['1', '2', '3', '4'].includes(form.transMode)) {
    errors.push('Select a transport mode.');
  }
  const distance = Number(form.distance);
  if (!Number.isInteger(distance) || distance < 0 || distance > MAX_DISTANCE_KM) {
    errors.push(`Distance must be a whole number between 0 and ${MAX_DISTANCE_KM} km (0 lets the portal calculate it from the PIN codes).`);
  }
  const transporterId = (form.transporterId || '').trim().toUpperCase();
  if (transporterId && !TRANSPORTER_ID_RE.test(transporterId)) {
    errors.push('Transporter ID / GSTIN must be a valid 15-character GSTIN or TRANSIN.');
  }
  const vehicleNo = form.transMode === '1' ? (form.vehicleNo || '').trim().toUpperCase() : '';
  if (vehicleNo && !VEHICLE_NO_RE.test(vehicleNo)) {
    errors.push('Vehicle No. must be 4–20 letters/digits without spaces (e.g. TN37AB1234).');
  }
  // Without Part-B (vehicle details) the portal needs a transporter to
  // assign the E-Way Bill to.
  if (!vehicleNo && !transporterId) {
    errors.push(form.transMode === '1'
      ? 'Enter either the Vehicle No. or the Transporter ID / GSTIN.'
      : 'Transporter ID / GSTIN is required for Rail / Air / Ship transport.');
  }
  return errors;
}

export interface CombinedDeps<T extends CombinedInvoiceState> {
  transport: EwayBillTransportDetails;
  // Fresh read of the invoice — another tab/user may have generated either
  // document since this screen loaded.
  loadLatest(): Promise<T>;
  generateEInvoice(invoice: T): Promise<T>;
  generateEwayBill(invoice: T): Promise<T>;
  onProgress?(status: CombinedStatus): void;
}

export interface CombinedOutcome<T> {
  status: CombinedStatus;
  invoice: T;
}

const errorMessage = (err: unknown, fallback: string): string =>
  (err as { message?: string })?.message || fallback;

// Validation / plan errors throw CombinedGenerationError (nothing was sent);
// step failures resolve with that step marked 'failed' so the caller can show
// exactly which document failed and which one (if any) succeeded.
export async function runCombinedGeneration<T extends CombinedInvoiceState>(deps: CombinedDeps<T>): Promise<CombinedOutcome<T>> {
  const status: CombinedStatus = { einvoice: { state: 'pending' }, ewb: { state: 'pending' } };
  const emit = () => deps.onProgress?.({ einvoice: { ...status.einvoice }, ewb: { ...status.ewb } });

  let invoice = await deps.loadLatest();
  const plan = planCombinedGeneration(invoice);
  if (plan.ewb === 'run') {
    const errors = validateTransportDetails(deps.transport);
    if (errors.length) throw new CombinedGenerationError('E-Way Bill transport details are incomplete.', errors);
  }

  if (plan.einvoice === 'skip') {
    status.einvoice = { state: 'skipped', message: 'Already generated — existing IRN reused.', docNo: invoice.irn };
  } else {
    status.einvoice = { state: 'running' };
    emit();
    try {
      invoice = await deps.generateEInvoice(invoice);
      status.einvoice = { state: 'success', message: 'E-Invoice generated.', docNo: invoice.irn };
    } catch (err) {
      status.einvoice = { state: 'failed', message: errorMessage(err, 'E-Invoice generation failed.') };
      status.ewb = { state: 'skipped', message: 'Not attempted — the E-Invoice (IRN) must be generated first.' };
      emit();
      return { status, invoice };
    }
  }

  if (plan.ewb === 'skip') {
    status.ewb = { state: 'skipped', message: 'Already generated.', docNo: invoice.ewbNo };
  } else {
    status.ewb = { state: 'running' };
    emit();
    try {
      invoice = await deps.generateEwayBill(invoice);
      status.ewb = { state: 'success', message: 'E-Way Bill generated.', docNo: invoice.ewbNo };
    } catch (err) {
      status.ewb = { state: 'failed', message: errorMessage(err, 'E-Way Bill generation failed.') };
    }
  }
  emit();
  return { status, invoice };
}

// Rejects a second run for an invoice whose run is still in flight — repeated
// clicks, or reopening the screen mid-request, never fire a duplicate API call.
export class CombinedGenerationRunner {
  private inFlight = new Set<string>();

  isRunning(invoiceId: string): boolean {
    return this.inFlight.has(invoiceId);
  }

  async run<T extends CombinedInvoiceState>(invoiceId: string, deps: CombinedDeps<T>): Promise<CombinedOutcome<T>> {
    if (this.inFlight.has(invoiceId)) {
      throw new CombinedGenerationError('Generation is already in progress for this invoice — please wait for it to finish.');
    }
    this.inFlight.add(invoiceId);
    try {
      return await runCombinedGeneration(deps);
    } finally {
      this.inFlight.delete(invoiceId);
    }
  }
}

// Retries an idempotent operation (a Firestore write of an already-issued
// IRN / E-Way Bill) — never the Webtel calls themselves, which aren't
// idempotent and are rejected by NIC as duplicates on a second attempt.
export async function retryAsync<R>(fn: () => Promise<R>, attempts = 3, delayMs = 500): Promise<R> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}
