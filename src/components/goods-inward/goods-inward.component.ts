import {
  Component, ChangeDetectionStrategy, signal, inject,
  OnInit, OnDestroy, ViewChild, ElementRef, computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Design, SizePrice } from '../../models/design.model';
import { GoodsInward, GoodsInwardItem } from '../../models/goods-inward.model';
import { DesignService } from '../../services/design.service';
import { GoodsInwardService } from '../../services/goods-inward.service';
import Swal from 'sweetalert2';

declare const jsQR: any;

type ViewMode = 'list' | 'form' | 'view';

const EMPTY_GRN: Omit<GoodsInward, 'id'> = {
  grnNo: '',
  supplierName: '',
  invoiceNo: '',
  invoiceDate: '',
  receivedDate: new Date().toISOString().split('T')[0],
  items: [],
  status: 'Draft',
  remarks: ''
};

@Component({
  selector: 'app-goods-inward',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './goods-inward.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoodsInwardComponent implements OnInit, OnDestroy {
  private designService = inject(DesignService);
  private grnService = inject(GoodsInwardService);

  @ViewChild('video') videoElement?: ElementRef<HTMLVideoElement>;
  @ViewChild('canvas') canvasElement?: ElementRef<HTMLCanvasElement>;

  // ── View State ──────────────────────────────────────────────
  mode = signal<ViewMode>('list');
  designs = signal<Design[]>([]);
  grns = signal<GoodsInward[]>([]);

  // ── Form State ───────────────────────────────────────────────
  editableGrn = signal<GoodsInward | Omit<GoodsInward, 'id'>>(EMPTY_GRN);
  isEditMode = computed(() => 'id' in this.editableGrn());
  viewGrn = signal<GoodsInward | null>(null);

  // ── Filter / Search ──────────────────────────────────────────
  searchTerm = signal('');
  filterFromDate = signal(this.currentMonthStart());
  filterToDate   = signal(this.currentMonthEnd());
  currentPage = signal(1);
  itemsPerPage = signal(10);

  filteredGrns = computed(() => {
    const term = this.searchTerm().toLowerCase();
    const from = this.filterFromDate();
    const to   = this.filterToDate();
    const fromMs = from ? new Date(from).setHours(0, 0, 0, 0)   : -Infinity;
    const toMs   = to   ? new Date(to).setHours(23, 59, 59, 999) :  Infinity;

    return this.grns().filter(g => {
      // date filter
      const raw: any = g.createdAt;
      let d: Date;
      if (raw?.toDate) d = raw.toDate();
      else if (raw instanceof Date) d = raw;
      else if (raw) d = new Date(raw);
      else d = new Date(g.receivedDate);
      const ms = d.getTime();
      if (ms < fromMs || ms > toMs) return false;

      // search
      if (!term) return true;
      return (
        g.grnNo.toLowerCase().includes(term) ||
        g.supplierName.toLowerCase().includes(term) ||
        g.invoiceNo.toLowerCase().includes(term)
      );
    });
  });

  totalPages = computed(() => Math.ceil(this.filteredGrns().length / this.itemsPerPage()));
  paginatedGrns = computed(() => {
    const start = (this.currentPage() - 1) * this.itemsPerPage();
    return this.filteredGrns().slice(start, start + this.itemsPerPage());
  });

  // ── Design Picker State ──────────────────────────────────────
  designPickerVisible = signal(false);
  designSearchTerm = signal('');
  expandedStyleNo = signal<string | null>(null);

  filteredDesignStyles = computed(() => {
    const term = this.designSearchTerm().toLowerCase();
    const all = [...new Set(this.designs().map(d => d.styleNo))].sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { numeric: true }));
    return term ? all.filter(s => s.toLowerCase().includes(term)) : all;
  });

  colorsForExpandedStyle = computed(() => {
    const s = this.expandedStyleNo();
    return s ? this.designs().filter(d => d.styleNo === s) : [];
  });

  // ── Barcode Scanner ──────────────────────────────────────────
  isScanning = signal(false);
  scanResult = signal<string | null>(null);
  scanFeedback = signal<'idle' | 'success' | 'error'>('idle');
  scannerMessage = signal('Align barcode within the frame');

  private stream: MediaStream | null = null;
  private animFrameId: number | null = null;
  private lastScanTime = 0;
  private lastTickTime = 0;
  private readonly SCAN_INTERVAL = 60;
  private readonly SCAN_DEBOUNCE = 1200;
  private enhanceCanvas: HTMLCanvasElement | null = null;
  private torchTrack: MediaStreamTrack | null = null;
  isTorchAvailable = signal(false);
  isTorchOn = signal(false);
  private torchEnabled = false;

  // ── Item being scanned/added ─────────────────────────────────
  pendingItem = signal<GoodsInwardItem | null>(null);

  // ── Computed totals ──────────────────────────────────────────
  formItems = computed(() => {
    const g = this.editableGrn();
    return g.items ?? [];
  });

  totalExpected = computed(() => this.formItems().reduce((s, i) => s + (Number(i.expectedQty) || 0), 0));
  totalReceived = computed(() => this.formItems().reduce((s, i) => s + (Number(i.receivedQty) || 0), 0));
  totalValue    = computed(() => this.formItems().reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0));

  // ── View GRN totals ───────────────────────────────────────────
  viewTotalExpected = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + (Number(i.expectedQty) || 0), 0));
  viewTotalReceived = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + (Number(i.receivedQty) || 0), 0));
  viewTotalValue    = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0));

  // ── Month helpers ─────────────────────────────────────────────
  private currentMonthStart(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }
  private currentMonthEnd(): string {
    const d = new Date();
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  }
  isCurrentMonthFilter = computed(() =>
    this.filterFromDate() === this.currentMonthStart() &&
    this.filterToDate()   === this.currentMonthEnd()
  );
  resetToCurrentMonth() { this.filterFromDate.set(this.currentMonthStart()); this.filterToDate.set(this.currentMonthEnd()); }
  clearDateFilter()     { this.filterFromDate.set(''); this.filterToDate.set(''); }

  // ── Lifecycle ─────────────────────────────────────────────────
  ngOnInit() {
    Swal.fire({ title: 'Loading data...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    let dLoaded = false, gLoaded = false;
    const tryClose = () => { if (dLoaded && gLoaded) Swal.close(); };

    this.designService.getDesigns().subscribe({
      next: d => { this.designs.set(d); dLoaded = true; tryClose(); },
      error: () => { dLoaded = true; tryClose(); }
    });
    this.grnService.getGoodsInwards().subscribe({
      next: g => { this.grns.set(g); gLoaded = true; tryClose(); },
      error: () => { gLoaded = true; tryClose(); Swal.fire('Error', 'Failed to load GRNs', 'error'); }
    });
  }

  ngOnDestroy() {
    this.stopScan();
  }

  // ── Navigation ────────────────────────────────────────────────
  showAddForm() {
    const grnNo = `GRN-${Date.now()}`;
    this.editableGrn.set({ ...JSON.parse(JSON.stringify(EMPTY_GRN)), grnNo });
    this.mode.set('form');
  }

  showEditForm(grn: GoodsInward) {
    this.editableGrn.set(JSON.parse(JSON.stringify(grn)));
    this.mode.set('form');
  }

  showViewMode(grn: GoodsInward) {
    this.viewGrn.set(grn);
    this.mode.set('view');
  }

  cancel() {
    this.mode.set('list');
    this.editableGrn.set(JSON.parse(JSON.stringify(EMPTY_GRN)));
    this.viewGrn.set(null);
    this.designPickerVisible.set(false);
    this.stopScan();
  }

  onSearch(term: string) { this.searchTerm.set(term); this.currentPage.set(1); }
  changePage(p: number) { if (p >= 1 && p <= this.totalPages()) this.currentPage.set(p); }
  onItemsPerPageChange(e: Event) {
    this.itemsPerPage.set(Number((e.target as HTMLSelectElement).value));
    this.currentPage.set(1);
  }

  // ── Design Picker ─────────────────────────────────────────────
  openDesignPicker() {
    this.designSearchTerm.set('');
    this.expandedStyleNo.set(null);
    this.designPickerVisible.set(true);
  }

  closeDesignPicker() {
    this.designPickerVisible.set(false);
    this.expandedStyleNo.set(null);
  }

  toggleExpandStyle(styleNo: string) {
    this.expandedStyleNo.update(s => s === styleNo ? null : styleNo);
  }

  addDesignSizeToGrn(design: Design, size: SizePrice) {
    this.editableGrn.update(grn => {
      const existing = grn.items.find(i => i.barcode === String(size.BARCODE));
      if (existing) {
        Swal.fire({ icon: 'info', title: 'Already Added', text: `${design.styleNo} (${size.size}) is already in the list.`, timer: 1500, showConfirmButton: false });
        return grn;
      }
      const newItem: GoodsInwardItem = {
        designId:    design.id ?? '',
        styleNo:     design.styleNo,
        color:       design.color ?? '',
        group:       design.group ?? '',
        size:        size.size,
        barcode:     String(size.BARCODE),
        fabricType:  size.fabricType ?? '',
        expectedQty: 0,
        receivedQty: 0,
        WSP:         size.WSP,
        price:       size.price
      };
      return { ...grn, items: [...grn.items, newItem] };
    });
  }

  removeItem(barcode: string) {
    this.editableGrn.update(grn => ({
      ...grn,
      items: grn.items.filter(i => i.barcode !== barcode)
    }));
  }

  updateItemQty(barcode: string, field: 'expectedQty' | 'receivedQty', value: string) {
    this.editableGrn.update(grn => ({
      ...grn,
      items: grn.items.map(i =>
        i.barcode === barcode ? { ...i, [field]: Number(value) || 0 } : i
      )
    }));
  }

  // ── Barcode Scanner ───────────────────────────────────────────
  async startScan() {
    this.isScanning.set(true);
    this.scanFeedback.set('idle');
    this.scanResult.set(null);
    this.enhanceCanvas = document.createElement('canvas');

    setTimeout(async () => {
      if (!this.videoElement || !navigator.mediaDevices?.getUserMedia) {
        Swal.fire({ icon: 'error', title: 'Error', text: 'Camera not supported.' });
        this.isScanning.set(false);
        return;
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } as any
        });
        const track = this.stream.getVideoTracks()[0];
        if (track) {
          const caps = track.getCapabilities() as any;
          if (caps.torch) { this.isTorchAvailable.set(true); this.torchTrack = track; }
        }
        this.videoElement.nativeElement.srcObject = this.stream;
        this.videoElement.nativeElement.play();
        this.animFrameId = requestAnimationFrame(() => this.tick());
      } catch {
        Swal.fire({ icon: 'error', title: 'Camera Error', text: 'Could not access camera.' });
        this.isScanning.set(false);
      }
    });
  }

  stopScan() {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.isScanning.set(false);
    this.isTorchOn.set(false);
    this.isTorchAvailable.set(false);
    this.torchEnabled = false;
    this.torchTrack = null;
    this.enhanceCanvas = null;
  }

  async toggleTorch() {
    if (!this.torchTrack) return;
    this.torchEnabled = !this.torchEnabled;
    await this.torchTrack.applyConstraints({ advanced: [{ torch: this.torchEnabled } as any] }).catch(() => {});
    this.isTorchOn.set(this.torchEnabled);
  }

  tick() {
    if (!this.isScanning()) return;
    this.animFrameId = requestAnimationFrame(() => this.tick());
    const now = Date.now();
    if (now - this.lastTickTime < this.SCAN_INTERVAL) return;
    this.lastTickTime = now;

    const video = this.videoElement?.nativeElement;
    if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) return;
    const canvas = this.canvasElement?.nativeElement;
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!ctx || !canvas) return;

    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    const scale = Math.min(1, 900 / Math.max(vw, vh));
    const fw = Math.round(vw * scale), fh = Math.round(vh * scale);
    if (canvas.width !== fw || canvas.height !== fh) { canvas.width = fw; canvas.height = fh; }
    ctx.drawImage(video, 0, 0, vw, vh, 0, 0, fw, fh);
    const imgData = ctx.getImageData(0, 0, fw, fh);
    let result = jsQR(imgData.data, fw, fh, { inversionAttempts: 'attemptBoth' });

    if (!result?.data) {
      const ec = this.enhanceCanvas!;
      const cf = 0.6, cx = vw * (1 - cf) / 2, cy = vh * (1 - cf) / 2, cw = vw * cf, ch = vh * cf;
      const eSize = 640;
      if (ec.width !== eSize || ec.height !== eSize) { ec.width = eSize; ec.height = eSize; }
      const ec2 = ec.getContext('2d', { willReadFrequently: true })!;
      ec2.drawImage(video, cx, cy, cw, ch, 0, 0, eSize, eSize);
      const raw = ec2.getImageData(0, 0, eSize, eSize);
      ec2.putImageData(this.enhanceImageData(raw), 0, 0);
      result = jsQR(ec2.getImageData(0, 0, eSize, eSize).data, eSize, eSize, { inversionAttempts: 'attemptBoth' });
    }

    if (result?.data) {
      const now2 = Date.now();
      if (now2 - this.lastScanTime < this.SCAN_DEBOUNCE) return;
      this.lastScanTime = now2;
      this.handleScanResult(result.data);
    }
  }

  private enhanceImageData(imageData: ImageData): ImageData {
    const d = new Uint8ClampedArray(imageData.data);
    let minL = 255, maxL = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum < minL) minL = lum; if (lum > maxL) maxL = lum;
    }
    const range = maxL - minL || 1, scale = 255 / range;
    for (let i = 0; i < d.length; i += 4) {
      const lum = Math.round((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - minL) * scale);
      d[i] = d[i + 1] = d[i + 2] = lum;
    }
    return new ImageData(d, imageData.width, imageData.height);
  }

  private handleScanResult(barcode: string) {
    const barcodeDetails = new Map<string, { design: Design; size: SizePrice }>();
    this.designs().forEach(d => d.sizes.forEach(s => barcodeDetails.set(String(s.BARCODE), { design: d, size: s })));

    const found = barcodeDetails.get(barcode.trim());
    if (!found) {
      this.scanFeedback.set('error');
      this.scannerMessage.set(`Barcode "${barcode}" not found in designs`);
      setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Align barcode within the frame'); }, 1500);
      return;
    }

    // Check if already in GRN
    const alreadyExists = this.editableGrn().items.some(i => i.barcode === barcode.trim());
    if (alreadyExists) {
      this.scanFeedback.set('error');
      this.scannerMessage.set(`${found.design.styleNo} (${found.size.size}) already in list`);
      setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Align barcode within the frame'); }, 1500);
      return;
    }

    this.addDesignSizeToGrn(found.design, found.size);
    this.scanFeedback.set('success');
    this.scannerMessage.set(`Added: ${found.design.styleNo} - ${found.size.size}`);
    setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Align barcode within the frame'); }, 800);
  }

  // ── Save / Delete ─────────────────────────────────────────────
  async saveGrn() {
    const grn = this.editableGrn();
    if (!grn.supplierName.trim()) {
      Swal.fire({ icon: 'warning', title: 'Validation', text: 'Please enter the supplier name.' }); return;
    }
    if (!grn.invoiceNo.trim()) {
      Swal.fire({ icon: 'warning', title: 'Validation', text: 'Please enter the invoice number.' }); return;
    }
    if (grn.items.length === 0) {
      Swal.fire({ icon: 'warning', title: 'Validation', text: 'Please add at least one item.' }); return;
    }

    // Auto-set status
    const totalExp = grn.items.reduce((s, i) => s + (Number(i.expectedQty) || 0), 0);
    const totalRec = grn.items.reduce((s, i) => s + (Number(i.receivedQty) || 0), 0);
    let status: GoodsInward['status'] = 'Draft';
    if (totalRec > 0 && totalRec < totalExp) status = 'Partially Received';
    else if (totalRec >= totalExp && totalExp > 0) status = 'Received';

    const payload: Omit<GoodsInward, 'id'> = { ...(grn as any), status };

    try {
      Swal.fire({ title: this.isEditMode() ? 'Updating GRN...' : 'Saving GRN...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      if (this.isEditMode()) {
        await this.grnService.updateGoodsInward(payload as GoodsInward);
      } else {
        await this.grnService.createGoodsInward(payload);
      }
      await Swal.fire({ icon: 'success', title: 'Saved!', text: 'GRN saved successfully.', timer: 2000, showConfirmButton: false });
      this.refreshGrns();
      this.cancel();
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Error', text: err?.message ?? 'Failed to save GRN.' });
    }
  }

  async deleteGrn(grn: GoodsInward) {
    const result = await Swal.fire({
      title: 'Are you sure?', text: `Delete GRN "${grn.grnNo}"?`, icon: 'warning',
      showCancelButton: true, confirmButtonColor: '#dc2626', cancelButtonColor: '#6b7280',
      confirmButtonText: 'Yes, delete it', cancelButtonText: 'Cancel'
    });
    if (!result.isConfirmed) return;
    try {
      Swal.fire({ title: 'Deleting...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      await this.grnService.deleteGoodsInward(grn.id!);
      await Swal.fire({ icon: 'success', title: 'Deleted!', timer: 2000, showConfirmButton: false });
      this.refreshGrns();
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Error', text: err?.message ?? 'Failed to delete GRN.' });
    }
  }

  private refreshGrns() {
    this.grnService.getGoodsInwards().subscribe({ next: g => this.grns.set(g) });
  }

  // ── Helpers ───────────────────────────────────────────────────
  getStatusClass(status: string): string {
    if (status === 'Received') return 'bg-green-100 text-green-800';
    if (status === 'Partially Received') return 'bg-yellow-100 text-yellow-800';
    return 'bg-gray-100 text-gray-600';
  }

  getGrnTotalReceived(grn: GoodsInward): number {
    return grn.items.reduce((s, i) => s + (Number(i.receivedQty) || 0), 0);
  }

  getGrnTotalValue(grn: GoodsInward): number {
    return grn.items.reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0);
  }

  formatDate(raw: any): string {
    if (!raw) return '';
    try {
      const d = raw?.toDate ? raw.toDate() : new Date(raw);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return ''; }
  }

  trackByBarcode(_: number, item: GoodsInwardItem) { return item.barcode; }
}