import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import Swal from 'sweetalert2';
import { PackingList, PackingListLine } from '../../models/packing-list.model';
import { PackingListService } from '../../services/packing-list.service';
import { BulkFlowError, isBulkPackingComplete, validateBulkPackEntries } from '../../services/bulk-flow.engine';

// Item-wise packing for a Packing List generated from a Bulk Pick List: the
// packer enters (or scans up) a quantity per item, packs them into a carton
// in one submission, and completes packing once every picked piece is
// packed. Normal carton-scan packing stays available for the same list from
// the Packing Lists tab ("Scan Pack").
@Component({
  selector: 'app-bulk-packing',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './bulk-packing.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BulkPackingComponent implements OnInit, OnDestroy {
  private packingListService = inject(PackingListService);
  private subscriptions: Subscription[] = [];

  packingListId = input.required<string>();
  closed = output<void>();
  proceedToDC = output<string>();

  packingList = signal<PackingList | null>(null);
  lines = signal<PackingListLine[]>([]);
  cartonNo = signal('');
  barcodeInput = signal('');
  // Quantity typed (or scanned up) per line for the next "Pack into Carton".
  entryQty = signal<Record<string, number>>({});
  isSubmitting = signal(false);
  isCompleting = signal(false);

  totals = computed(() => {
    const lines = this.lines();
    const picked = lines.reduce((s, l) => s + l.requiredQty, 0);
    const packed = lines.reduce((s, l) => s + Math.min(l.packedQty, l.requiredQty), 0);
    const entered = Object.values(this.entryQty()).reduce((s, q) => s + (q || 0), 0);
    return { picked, packed, pending: picked - packed, entered };
  });

  allPacked = computed(() => isBulkPackingComplete(this.lines()));
  hasDC = computed(() => (this.packingList()?.dcGeneratedKeys ?? []).length > 0);

  ngOnInit() {
    const id = this.packingListId();
    this.subscriptions.push(
      this.packingListService.getPackingListById(id).subscribe((pl) => this.packingList.set(pl)),
      this.packingListService.getPackingListLines(id).subscribe((lines) => this.lines.set(lines)),
    );
  }

  ngOnDestroy() {
    this.subscriptions.forEach((s) => s.unsubscribe());
  }

  remainingOf(line: PackingListLine): number {
    return Math.max(0, line.requiredQty - line.packedQty);
  }

  setEntry(line: PackingListLine, value: string | number) {
    const qty = Math.max(0, Math.floor(Number(value) || 0));
    this.entryQty.update((map) => ({ ...map, [line.lineId]: qty }));
  }

  fillAllPending() {
    const map: Record<string, number> = {};
    for (const line of this.lines()) {
      const remaining = this.remainingOf(line);
      if (remaining > 0) map[line.lineId] = remaining;
    }
    this.entryQty.set(map);
  }

  clearEntries() {
    this.entryQty.set({});
  }

  // A scan adds 1 to that item's "Pack Now" quantity — never past what's
  // still left to pack for it.
  scanBarcode() {
    const barcode = this.barcodeInput().trim();
    this.barcodeInput.set('');
    if (!barcode) return;
    const entries = this.entryQty();
    const line = this.lines().find((l) => (l.barcode ?? '').trim() === barcode && (entries[l.lineId] ?? 0) < this.remainingOf(l))
      ?? this.lines().find((l) => (l.barcode ?? '').trim() === barcode);
    if (!line) {
      void this.toast('error', 'Not on this Packing List', `Barcode ${barcode} was not bulk picked for this customer.`);
      return;
    }
    const next = (entries[line.lineId] ?? 0) + 1;
    if (next > this.remainingOf(line)) {
      void this.toast('warning', 'Already fully entered', `${line.styleNo} ${line.size}: only ${this.remainingOf(line)} left to pack.`);
      return;
    }
    this.entryQty.set({ ...entries, [line.lineId]: next });
  }

  async packIntoCarton() {
    const id = this.packingListId();
    const cartonNo = this.cartonNo().trim().toUpperCase();
    if (this.isSubmitting()) return;
    if (!cartonNo) {
      await Swal.fire({ icon: 'warning', title: 'Carton Required', text: 'Enter the carton / box number these items are going into.' });
      return;
    }
    const entries = Object.entries(this.entryQty()).map(([lineId, qty]) => ({ lineId, qty }));
    try {
      // Same validation the service re-runs in its transaction — run here
      // first for an instant message without a round trip.
      validateBulkPackEntries(this.lines(), entries);
    } catch (err) {
      await Swal.fire({ icon: 'warning', title: 'Check Quantities', text: this.errorText(err) });
      return;
    }

    this.isSubmitting.set(true);
    try {
      const updated = await this.packingListService.bulkPackLines(id, cartonNo, entries);
      this.entryQty.set({});
      await this.toast('success', `Packed into ${cartonNo}`, `${updated.totalPackedQty} of ${updated.totalRequiredQty} packed`);
    } catch (err) {
      await Swal.fire({ icon: 'error', title: 'Packing Failed', text: this.errorText(err) });
    } finally {
      this.isSubmitting.set(false);
    }
  }

  // Verification step: every picked piece must be packed; stamps the
  // existing QC-verified marker, then hands over to DC generation.
  async completeBulkPacking() {
    const id = this.packingListId();
    if (this.isCompleting()) return;
    if (!this.allPacked()) {
      await Swal.fire({ icon: 'warning', title: 'Packing Incomplete', text: `${this.totals().pending} picked piece(s) are not packed yet.` });
      return;
    }
    const confirm = await Swal.fire({
      icon: 'question',
      title: 'Complete Bulk Packing?',
      html: `<p style="font-size:13px">All <strong>${this.totals().packed}</strong> picked pieces are packed in <strong>${this.packingList()?.cartonCount ?? 0}</strong> carton(s).</p>`,
      showCancelButton: true,
      confirmButtonText: 'Complete & Go to DC',
      confirmButtonColor: '#16a34a',
    });
    if (!confirm.isConfirmed) return;

    this.isCompleting.set(true);
    try {
      await this.packingListService.markQcVerified(id);
      this.proceedToDC.emit(id);
    } catch (err) {
      await Swal.fire({ icon: 'error', title: 'Could Not Complete', text: this.errorText(err) });
    } finally {
      this.isCompleting.set(false);
    }
  }

  private errorText(err: unknown): string {
    if (err instanceof BulkFlowError) return err.message;
    const code = (err as any)?.message;
    if (code === 'dc_already_generated') return 'A DC has already been generated for this Packing List.';
    return code || 'Something went wrong. Please try again.';
  }

  private toast(icon: 'success' | 'error' | 'warning', title: string, text?: string) {
    return Swal.fire({ toast: true, position: 'top-end', icon, title, text, timer: 1800, showConfirmButton: false });
  }
}
