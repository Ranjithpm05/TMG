import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
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
import { Client } from '../../models/client.model';
import { BulkPickMethod, PickList, PickListClaimUser, PickListLine } from '../../models/pick-list.model';
import { PickListService } from '../../services/pick-list.service';
import { PackingListService } from '../../services/packing-list.service';
import { DesignService } from '../../services/design.service';
import { InventoryService } from '../../services/inventory.service';
import { AuthService } from '../../services/auth.service';
import { ScreenNavigationService } from '../../services/screen-navigation.service';
import { BulkFlowError, bulkPickStage, parseBulkQty } from '../../services/bulk-flow.engine';

type Step = 'customer' | 'method' | 'scan' | 'done';

// The item scanned in "Scan + Quantity" mode, waiting for its quantity.
interface PendingItem {
  barcode: string;
  styleNo: string;
  color: string;
  size: string;
  sleeveType?: string;
  group: string;
  stock: number | null;
  alreadyPicked: number;
}

// Bulk Picking — no Sales Order: pick a customer, choose a method, scan.
// Every scan is validated (Design Master barcode, live stock) and deducted
// by PickListService.processBulkScan in one transaction; this component only
// sequences the user's input and shows live progress.
@Component({
  selector: 'app-bulk-picking',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './bulk-picking.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BulkPickingComponent implements OnInit, OnDestroy {
  @ViewChild('barcodeField') barcodeField?: ElementRef<HTMLInputElement>;
  @ViewChild('qtyField') qtyField?: ElementRef<HTMLInputElement>;

  private pickListService = inject(PickListService);
  private packingListService = inject(PackingListService);
  private designService = inject(DesignService);
  private inventoryService = inject(InventoryService);
  private authService = inject(AuthService);
  private screenNavigation = inject(ScreenNavigationService);
  private liveSubscriptions: Subscription[] = [];
  // Scans run strictly one after another — a fast hardware scanner can fire
  // the next barcode before the previous transaction commits; queueing (not
  // dropping) them means no unit is lost and no two scans race each other.
  private scanQueue: Promise<void> = Promise.resolve();

  clients = input<Client[]>([]);
  resumePickListId = input<string | null>(null);
  closed = output<void>();

  step = signal<Step>('customer');
  customerSearch = signal('');
  selectedClientId = signal<string | null>(null);
  pickList = signal<PickList | null>(null);
  lines = signal<PickListLine[]>([]);
  method = signal<BulkPickMethod>('scan_all');
  barcodeInput = signal('');
  qtyInput = signal('');
  pendingItem = signal<PendingItem | null>(null);
  pendingScans = signal(0);
  lastScannedLineId = signal<string | null>(null);
  feedback = signal<{ kind: 'idle' | 'success' | 'error'; text: string }>({ kind: 'idle', text: '' });
  isBusy = signal(false);

  filteredClients = computed(() => {
    const term = this.customerSearch().trim().toLowerCase();
    return this.clients()
      .filter((c) => !!c.id && c.status !== 'Inactive')
      .filter((c) => !term || c.clientName.toLowerCase().includes(term) || (c.clientCode ?? '').toLowerCase().includes(term))
      .sort((a, b) => a.clientName.localeCompare(b.clientName));
  });

  selectedClient = computed(() => this.clients().find((c) => c.id === this.selectedClientId()) ?? null);

  // Most recently scanned first.
  scannedLines = computed(() => {
    const toMillis = (value: any) => value?.toMillis?.() ?? (typeof value === 'number' ? value : 0);
    return [...this.lines()].sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt));
  });

  lastScannedLine = computed(() => this.lines().find((l) => l.lineId === this.lastScannedLineId()) ?? null);

  totals = computed(() => {
    const lines = this.lines();
    return {
      items: lines.length,
      picked: lines.reduce((s, l) => s + l.pickedQty, 0),
      packed: lines.reduce((s, l) => s + (l.packedIntoPackingListsQty ?? 0), 0),
    };
  });

  stageLabel = computed(() => {
    const pl = this.pickList();
    if (!pl) return '';
    return ({ picking: 'Picking', ready_to_pack: 'Ready to Pack', packing: 'Sent to Packing', packed: 'Sent to Packing' } as const)[bulkPickStage(pl)];
  });

  ngOnInit() {
    const resumeId = this.resumePickListId();
    if (resumeId) void this.openPickList(resumeId);
  }

  ngOnDestroy() {
    this.stopLive();
  }

  // ─── Step 1: customer ───────────────────────────────────────────────────────

  selectClient(clientId: string) {
    this.selectedClientId.set(clientId);
  }

  async startBulkPicking() {
    const client = this.selectedClient();
    if (!client?.id || this.isBusy()) return;
    this.isBusy.set(true);
    try {
      const open = await this.pickListService.getOpenBulkPickListForClient(client.id);
      if (open?.id) {
        const resume = await Swal.fire({
          icon: 'info',
          title: 'Bulk Picking Already Open',
          html: `<p style="font-size:13px"><strong>${open.pickListNo}</strong> is still being picked for ${client.clientName} (${open.totalPickedQty ?? 0} pcs so far).</p>`,
          showCancelButton: true,
          confirmButtonText: 'Continue It',
          confirmButtonColor: '#16a34a',
        });
        if (resume.isConfirmed) await this.openPickList(open.id);
        return;
      }
      this.step.set('method');
    } finally {
      this.isBusy.set(false);
    }
  }

  // ─── Step 2: method ─────────────────────────────────────────────────────────

  async chooseMethod(method: BulkPickMethod) {
    const client = this.selectedClient();
    if (!client?.id || this.isBusy()) return;
    this.isBusy.set(true);
    try {
      const id = await this.pickListService.createBulkPickList({ clientId: client.id, clientName: client.clientName, method });
      await this.openPickList(id);
    } catch (err) {
      await Swal.fire({ icon: 'error', title: 'Could Not Start', text: this.errorText(err) });
    } finally {
      this.isBusy.set(false);
    }
  }

  // ─── Step 3: scanning ───────────────────────────────────────────────────────

  private async openPickList(id: string) {
    this.stopLive();
    const initial = await this.pickListService.getPickListByIdOnce(id);
    if (!initial) {
      await Swal.fire({ icon: 'error', title: 'Not Found', text: 'This Bulk Pick List no longer exists.' });
      this.closed.emit();
      return;
    }
    this.pickList.set(initial);
    this.method.set(initial.bulkPickMethod ?? 'scan_all');
    this.step.set(initial.finalizedAt ? 'done' : 'scan');
    this.liveSubscriptions.push(
      this.pickListService.getPickListById(id).subscribe((pl) => {
        if (!pl) return;
        this.pickList.set(pl);
        // Completed from another device — stop accepting scans here too.
        if (pl.finalizedAt && this.step() === 'scan') this.step.set('done');
      }),
      this.pickListService.getPickListLines(id).subscribe((lines) => this.lines.set(lines)),
    );
    this.focusBarcode();
  }

  setMethod(method: BulkPickMethod) {
    this.method.set(method);
    this.pendingItem.set(null);
    this.qtyInput.set('');
    this.focusBarcode();
  }

  onBarcodeEnter() {
    const barcode = this.barcodeInput().trim();
    this.barcodeInput.set('');
    if (!barcode) return;
    if (this.method() === 'scan_all') {
      this.enqueueScan(barcode, 1);
    } else {
      void this.prepareQtyEntry(barcode);
    }
  }

  // "Scan + Quantity": resolve the item and its live stock first, so the
  // user sees what they scanned (and how many are available) before typing.
  private async prepareQtyEntry(barcode: string) {
    const [designMatch, inventory] = await Promise.all([
      this.designService.findDesignSizeByBarcode(barcode),
      this.inventoryService.getInventoryByBarcodes([barcode]),
    ]);
    if (!designMatch) {
      this.flash('error', `Barcode ${barcode} is not defined in Design Master.`);
      this.focusBarcode();
      return;
    }
    const existing = this.lines().find((l) => (l.barcode ?? '').trim() === barcode);
    this.pendingItem.set({
      barcode,
      styleNo: designMatch.design.styleNo,
      color: designMatch.design.color ?? '',
      size: designMatch.sizeEntry.size,
      sleeveType: designMatch.sizeEntry.sleeveType ?? undefined,
      group: designMatch.design.group ?? '',
      stock: inventory[0] ? Number(inventory[0].currentStock) || 0 : null,
      alreadyPicked: existing?.pickedQty ?? 0,
    });
    this.qtyInput.set('');
    setTimeout(() => this.qtyField?.nativeElement.focus(), 0);
  }

  submitQty() {
    const item = this.pendingItem();
    if (!item) return;
    let qty: number;
    try {
      qty = parseBulkQty(this.qtyInput());
    } catch (err) {
      this.flash('error', this.errorText(err));
      return;
    }
    // Instant feedback from the lookup; the transaction re-checks live stock.
    if (item.stock != null && qty > item.stock) {
      this.flash('error', `Only ${item.stock} in stock — cannot pick ${qty}.`);
      return;
    }
    this.pendingItem.set(null);
    this.qtyInput.set('');
    this.enqueueScan(item.barcode, qty);
    this.focusBarcode();
  }

  cancelPendingItem() {
    this.pendingItem.set(null);
    this.qtyInput.set('');
    this.focusBarcode();
  }

  private enqueueScan(barcode: string, qty: number) {
    const pickListId = this.pickList()?.id;
    const user = this.claimUser();
    if (!pickListId || !user) return;
    this.pendingScans.update((n) => n + 1);
    this.scanQueue = this.scanQueue.then(async () => {
      try {
        const { line } = await this.pickListService.processBulkScan(pickListId, barcode, qty, user);
        this.lastScannedLineId.set(line.lineId);
        this.flash('success', `+${qty} ${line.styleNo} ${line.color} ${line.size} — ${line.pickedQty} picked`);
      } catch (err) {
        this.flash('error', `${barcode}: ${this.errorText(err)}`);
      } finally {
        this.pendingScans.update((n) => Math.max(0, n - 1));
      }
    });
  }

  async removeUnits(line: PickListLine, all: boolean) {
    const pickListId = this.pickList()?.id;
    if (!pickListId || this.isBusy()) return;
    let qty = 1;
    if (all) {
      const removable = line.pickedQty - (line.packedIntoPackingListsQty ?? 0);
      const { value, isConfirmed } = await Swal.fire({
        title: `Remove ${line.styleNo} ${line.size}`,
        input: 'number',
        inputValue: String(removable),
        inputAttributes: { min: '1', max: String(removable), step: '1' },
        text: `Picked ${line.pickedQty}. The removed quantity goes back to stock.`,
        showCancelButton: true,
        confirmButtonText: 'Remove',
        confirmButtonColor: '#dc2626',
        inputValidator: (v) => {
          try { parseBulkQty(v); } catch (err) { return this.errorText(err); }
          return Number(v) > removable ? `At most ${removable} can be removed.` : null;
        },
      });
      if (!isConfirmed) return;
      qty = Number(value);
    }
    this.isBusy.set(true);
    try {
      await this.pickListService.removeBulkUnits(pickListId, line.lineId, qty);
      this.flash('success', `Removed ${qty} × ${line.styleNo} ${line.size} — returned to stock`);
    } catch (err) {
      this.flash('error', this.errorText(err));
    } finally {
      this.isBusy.set(false);
      this.focusBarcode();
    }
  }

  async completeBulkPicking() {
    const pickList = this.pickList();
    const user = this.claimUser();
    if (!pickList?.id || !user || this.isBusy()) return;
    // Let any scans still in flight land first, so the confirmation shows
    // the real totals.
    await this.scanQueue;
    const totals = this.totals();
    if (totals.picked <= 0) {
      await Swal.fire({ icon: 'warning', title: 'Nothing Picked', text: 'Scan at least one item before completing Bulk Picking.' });
      return;
    }
    const confirm = await Swal.fire({
      icon: 'question',
      title: 'Complete Bulk Picking?',
      html: `<p style="font-size:13px"><strong>${totals.picked}</strong> pcs across <strong>${totals.items}</strong> item(s) for ${pickList.clientName}.<br>No more items can be scanned into this list afterwards.</p>`,
      showCancelButton: true,
      confirmButtonText: 'Complete Picking',
      confirmButtonColor: '#16a34a',
    });
    if (!confirm.isConfirmed) return;

    this.isBusy.set(true);
    try {
      const updated = await this.pickListService.finalizeBulkPickList(pickList.id, user);
      this.pickList.set(updated);
      this.step.set('done');
    } catch (err) {
      await Swal.fire({ icon: 'error', title: 'Could Not Complete', text: this.errorText(err) });
    } finally {
      this.isBusy.set(false);
    }
  }

  // ─── Step 4: hand off to Bulk Packing ───────────────────────────────────────

  async startBulkPacking() {
    const pickList = this.pickList();
    if (!pickList?.id || this.isBusy()) return;
    this.isBusy.set(true);
    try {
      const packingListId = await this.packingListService.createBulkPackingList(pickList.id);
      this.screenNavigation.go({ view: 'packingList', intent: 'bulk-pack', packingListId });
    } catch (err) {
      await Swal.fire({ icon: 'error', title: 'Could Not Start Packing', text: this.errorText(err) });
    } finally {
      this.isBusy.set(false);
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  private stopLive() {
    this.liveSubscriptions.forEach((s) => s.unsubscribe());
    this.liveSubscriptions = [];
  }

  private claimUser(): PickListClaimUser | null {
    const user = this.authService.currentUser();
    return user?.id ? { id: user.id, username: user.username } : null;
  }

  private focusBarcode() {
    setTimeout(() => this.barcodeField?.nativeElement.focus(), 0);
  }

  private flash(kind: 'success' | 'error', text: string) {
    this.feedback.set({ kind, text });
  }

  private errorText(err: unknown): string {
    if (err instanceof BulkFlowError) return err.message;
    return (err as any)?.message || 'Something went wrong. Please try again.';
  }
}
