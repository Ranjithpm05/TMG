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

// ── Multi-size picker state ───────────────────────────────────────────────────
type SizePickerState = {
  isActive: boolean;
  design: Design | null;
  /** size barcode → qty string */
  selectedSizes: Record<string, { size: SizePrice; qty: string }>;
};
const EMPTY_SIZE_PICKER: SizePickerState = { isActive: false, design: null, selectedSizes: {} };

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
  private grnService    = inject(GoodsInwardService);

  @ViewChild('video')  videoElement?: ElementRef<HTMLVideoElement>;
  @ViewChild('canvas') canvasElement?: ElementRef<HTMLCanvasElement>;

  // ── View State ───────────────────────────────────────────────────────────────
  mode      = signal<ViewMode>('list');
  designs   = signal<Design[]>([]);
  grns      = signal<GoodsInward[]>([]);
  viewGrn   = signal<GoodsInward | null>(null);

  // ── Form State ───────────────────────────────────────────────────────────────
  editableGrn = signal<GoodsInward | Omit<GoodsInward, 'id'>>(EMPTY_GRN);
  isEditMode  = computed(() => 'id' in this.editableGrn());

  // ── Filters / Pagination ─────────────────────────────────────────────────────
  searchTerm    = signal('');
  filterFromDate = signal(this.currentMonthStart());
  filterToDate   = signal(this.currentMonthEnd());
  currentPage   = signal(1);
  itemsPerPage  = signal(10);

  filteredGrns = computed(() => {
    const term  = this.searchTerm().toLowerCase();
    const from  = this.filterFromDate();
    const to    = this.filterToDate();
    const fromMs = from ? new Date(from).setHours(0, 0, 0, 0)    : -Infinity;
    const toMs   = to   ? new Date(to).setHours(23, 59, 59, 999)  :  Infinity;

    return this.grns().filter(g => {
      const raw: any = g.createdAt;
      let d: Date;
      if (raw?.toDate) d = raw.toDate();
      else if (raw instanceof Date) d = raw;
      else if (raw) d = new Date(raw);
      else d = new Date(g.receivedDate);

      if (d.getTime() < fromMs || d.getTime() > toMs) return false;
      if (!term) return true;
      return (
        g.grnNo.toLowerCase().includes(term) ||
        g.supplierName.toLowerCase().includes(term) ||
        g.invoiceNo.toLowerCase().includes(term)
      );
    });
  });

  totalPages    = computed(() => Math.ceil(this.filteredGrns().length / this.itemsPerPage()));
  paginatedGrns = computed(() => {
    const start = (this.currentPage() - 1) * this.itemsPerPage();
    return this.filteredGrns().slice(start, start + this.itemsPerPage());
  });

  // ── Design Picker ─────────────────────────────────────────────────────────────
  designPickerVisible = signal(false);
  designSearchTerm    = signal('');
  expandedStyleNo     = signal<string | null>(null);

  filteredDesignStyles = computed(() => {
    const term = this.designSearchTerm().toLowerCase();
    const all  = [...new Set(this.designs().map(d => d.styleNo))].sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { numeric: true }));
    return term ? all.filter(s => s.toLowerCase().includes(term)) : all;
  });

  colorsForExpandedStyle = computed(() => {
    const s = this.expandedStyleNo();
    return s ? this.designs().filter(d => d.styleNo === s) : [];
  });

  // ── Multi-size Picker ─────────────────────────────────────────────────────────
  sizePicker = signal<SizePickerState>(EMPTY_SIZE_PICKER);

  isSizeSelected(barcode: string) {
    return barcode in this.sizePicker().selectedSizes;
  }

  isAllSizesSelected = computed(() => {
    const design = this.sizePicker().design;
    if (!design || design.sizes.length === 0) return false;
    return design.sizes.every(s => String(s.BARCODE) in this.sizePicker().selectedSizes);
  });

  isSomeSizesSelected = computed(() => {
    const design = this.sizePicker().design;
    if (!design) return false;
    const count = design.sizes.filter(s => String(s.BARCODE) in this.sizePicker().selectedSizes).length;
    return count > 0 && count < design.sizes.length;
  });

  openSizePicker(design: Design) {
    this.sizePicker.set({ isActive: true, design, selectedSizes: {} });
    this.designPickerVisible.set(false);
  }

  closeSizePicker() {
    this.sizePicker.set(EMPTY_SIZE_PICKER);
    this.designPickerVisible.set(true);
  }

  toggleSize(size: SizePrice, checked: boolean) {
    const barcode = String(size.BARCODE);
    this.sizePicker.update(s => {
      const copy = { ...s.selectedSizes };
      if (checked) { copy[barcode] = { size, qty: '1' }; }
      else         { delete copy[barcode]; }
      return { ...s, selectedSizes: copy };
    });
  }

  toggleAllSizes(checked: boolean) {
    const design = this.sizePicker().design;
    if (!design) return;
    this.sizePicker.update(s => {
      const copy: SizePickerState['selectedSizes'] = {};
      if (checked) {
        for (const sz of design.sizes) {
          const bc = String(sz.BARCODE);
          copy[bc] = s.selectedSizes[bc] ?? { size: sz, qty: '1' };
        }
      }
      return { ...s, selectedSizes: copy };
    });
  }

  updateSizeQty(barcode: string, qty: string) {
    this.sizePicker.update(s => {
      if (!(barcode in s.selectedSizes)) return s;
      const copy = { ...s.selectedSizes, [barcode]: { ...s.selectedSizes[barcode], qty } };
      return { ...s, selectedSizes: copy };
    });
  }

  canConfirmSizes = computed(() =>
    Object.keys(this.sizePicker().selectedSizes).length > 0
  );

  confirmSizeSelection() {
    const { design, selectedSizes } = this.sizePicker();
    if (!design) return;

    for (const [barcode, { size, qty }] of Object.entries(selectedSizes)) {
      const parsedQty = Math.max(0, parseInt(qty, 10) || 0);
      if (parsedQty === 0) continue;
      this._addOrUpdateItem(design, size, parsedQty);
    }
    this.sizePicker.set(EMPTY_SIZE_PICKER);
    // Re-open picker for convenience
    this.designPickerVisible.set(true);
  }

  private _addOrUpdateItem(design: Design, size: SizePrice, qty: number) {
    const barcode = String(size.BARCODE);
    this.editableGrn.update(grn => {
      const existing = grn.items.find(i => i.barcode === barcode);
      if (existing) {
        return {
          ...grn,
          items: grn.items.map(i =>
            i.barcode === barcode ? { ...i, receivedQty: i.receivedQty + qty } : i
          )
        };
      }
      const newItem: GoodsInwardItem = {
        designId:    design.id ?? '',
        styleNo:     design.styleNo,
        color:       design.color ?? '',
        group:       design.group ?? '',
        size:        size.size,
        sleeveType:  size.sleeveType ?? undefined,
        barcode,
        fabricType:  size.fabricType ?? '',
        receivedQty: qty,
        WSP:         size.WSP,
        price:       size.price
      };
      return { ...grn, items: [...grn.items, newItem] };
    });
  }

  removeItem(barcode: string) {
    this.editableGrn.update(grn => ({
      ...grn, items: grn.items.filter(i => i.barcode !== barcode)
    }));
  }

  updateItemQty(barcode: string, value: string) {
    this.editableGrn.update(grn => ({
      ...grn,
      items: grn.items.map(i =>
        i.barcode === barcode ? { ...i, receivedQty: Math.max(0, parseInt(value, 10) || 0) } : i
      )
    }));
  }

  // ── Computed totals ───────────────────────────────────────────────────────────
  formItems    = computed(() => this.editableGrn().items ?? []);
  totalReceived = computed(() => this.formItems().reduce((s, i) => s + (Number(i.receivedQty) || 0), 0));
  totalValue    = computed(() => this.formItems().reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0));

  viewTotalReceived = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + (Number(i.receivedQty) || 0), 0));
  viewTotalValue    = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0));

  // ── Date helpers ──────────────────────────────────────────────────────────────
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

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  ngOnInit() {
    Swal.fire({ title: 'Loading data...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    let dLoaded = false, gLoaded = false;
    const tryClose = () => { if (dLoaded && gLoaded) Swal.close(); };

    this.designService.getDesigns().subscribe({
      next: d  => { this.designs.set(d); dLoaded = true; tryClose(); },
      error: () => { dLoaded = true; tryClose(); }
    });
    this.grnService.getGoodsInwards().subscribe({
      next: g  => { this.grns.set(g); gLoaded = true; tryClose(); },
      error: () => { gLoaded = true; tryClose(); Swal.fire('Error', 'Failed to load GRNs', 'error'); }
    });
  }

  ngOnDestroy() { this.stopScan(); }

  // ── Navigation ────────────────────────────────────────────────────────────────
  showAddForm() {
    this.editableGrn.set({ ...JSON.parse(JSON.stringify(EMPTY_GRN)), grnNo: `GRN-${Date.now()}` });
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
    this.sizePicker.set(EMPTY_SIZE_PICKER);
    this.stopScan();
  }

  onSearch(term: string)        { this.searchTerm.set(term); this.currentPage.set(1); }
  changePage(p: number)         { if (p >= 1 && p <= this.totalPages()) this.currentPage.set(p); }
  onItemsPerPageChange(e: Event){ this.itemsPerPage.set(Number((e.target as HTMLSelectElement).value)); this.currentPage.set(1); }

  openDesignPicker()  { this.designSearchTerm.set(''); this.expandedStyleNo.set(null); this.designPickerVisible.set(true); }
  closeDesignPicker() { this.designPickerVisible.set(false); this.expandedStyleNo.set(null); }
  toggleExpandStyle(styleNo: string) { this.expandedStyleNo.update(s => s === styleNo ? null : styleNo); }

  // ═══════════════════════════════════════════════════════════════════════════════
  // BARCODE SCANNER  —  high-performance multi-pass engine
  // ═══════════════════════════════════════════════════════════════════════════════
  isScanning    = signal(false);
  scanFeedback  = signal<'idle' | 'success' | 'error'>('idle');
  scannerMessage = signal('Align barcode within the frame');
  scannedCount  = signal(0);

  private stream: MediaStream | null = null;
  private animFrameId: number | null = null;
  private lastScanTime   = 0;
  private lastTickTime   = 0;

  // Tuning knobs
  private readonly TICK_INTERVAL  = 40;   // process frame every 40 ms (~25 fps)
  private readonly SCAN_DEBOUNCE  = 700;  // ms before same barcode accepted again

  // Offscreen canvases — allocated once, reused every frame
  private fullCanvas:   HTMLCanvasElement | null = null;
  private cropCanvas:   HTMLCanvasElement | null = null;
  private cropCanvas2:  HTMLCanvasElement | null = null;

  private torchTrack: MediaStreamTrack | null = null;
  isTorchAvailable = signal(false);
  isTorchOn        = signal(false);
  private torchEnabled = false;

  async startScan() {
    this.isScanning.set(true);
    this.scanFeedback.set('idle');
    this.scannerMessage.set('Align barcode within the frame');

    // allocate offscreen canvases
    this.fullCanvas  = document.createElement('canvas');
    this.cropCanvas  = document.createElement('canvas');
    this.cropCanvas2 = document.createElement('canvas');

    setTimeout(async () => {
      if (!this.videoElement || !navigator.mediaDevices?.getUserMedia) {
        Swal.fire({ icon: 'error', title: 'Error', text: 'Camera not supported.' });
        this.isScanning.set(false);
        return;
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width:  { ideal: 3840, min: 1280 },  // request 4K → falls back gracefully
            height: { ideal: 2160, min: 720 },
          } as any
        });

        const track = this.stream.getVideoTracks()[0];
        if (track) {
          // max resolution + continuous focus/exposure
          const caps = track.getCapabilities() as any;
          const adv: any = {};
          if (caps.focusMode?.includes('continuous'))      adv.focusMode      = 'continuous';
          if (caps.exposureMode?.includes('continuous'))   adv.exposureMode   = 'continuous';
          if (caps.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode = 'continuous';
          if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] } as any).catch(() => {});

          if (caps.torch) { this.isTorchAvailable.set(true); this.torchTrack = track; }
        }

        this.videoElement.nativeElement.srcObject = this.stream;
        await this.videoElement.nativeElement.play();
        this.lastTickTime = 0;
        this.animFrameId  = requestAnimationFrame(() => this.tick());
      } catch {
        Swal.fire({ icon: 'error', title: 'Camera Error', text: 'Could not access camera.' });
        this.isScanning.set(false);
      }
    }, 50);
  }

  stopScan() {
    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = null; }
    if (this.torchEnabled && this.torchTrack) {
      this.torchTrack.applyConstraints({ advanced: [{ torch: false } as any] }).catch(() => {});
    }
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream       = null;
    this.fullCanvas   = null;
    this.cropCanvas   = null;
    this.cropCanvas2  = null;
    this.torchTrack   = null;
    this.torchEnabled = false;
    this.isScanning.set(false);
    this.isTorchOn.set(false);
    this.isTorchAvailable.set(false);
  }

  async toggleTorch() {
    if (!this.torchTrack) return;
    this.torchEnabled = !this.torchEnabled;
    await this.torchTrack.applyConstraints({ advanced: [{ torch: this.torchEnabled } as any] }).catch(() => {});
    this.isTorchOn.set(this.torchEnabled);
  }

  private tick() {
    if (!this.isScanning()) return;
    this.animFrameId = requestAnimationFrame(() => this.tick());

    const now = Date.now();
    if (now - this.lastTickTime < this.TICK_INTERVAL) return;
    this.lastTickTime = now;

    const video = this.videoElement?.nativeElement;
    if (!video || video.readyState < video.HAVE_ENOUGH_DATA) return;

    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    // ── Try passes in order; stop at first decode ─────────────────────────────
    const result = this.tryDecode(video, vw, vh);
    if (result) this.handleScanResult(result);
  }

  /** Run multiple preprocessing passes and return first decoded barcode or null */
  private tryDecode(video: HTMLVideoElement, vw: number, vh: number): string | null {
    // Pass 1 — full frame at native res (capped at 1280 wide to keep jsQR fast)
    const scale1 = Math.min(1, 1280 / Math.max(vw, 1));
    const fw = Math.round(vw * scale1), fh = Math.round(vh * scale1);
    const fc = this.fullCanvas!;
    this.resizeCanvas(fc, fw, fh);
    const fctx = fc.getContext('2d', { willReadFrequently: true })!;
    fctx.drawImage(video, 0, 0, vw, vh, 0, 0, fw, fh);
    const raw1 = fctx.getImageData(0, 0, fw, fh);
    let r = jsQR(raw1.data, fw, fh, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // Pass 2 — centre crop 60% scaled to 800 px, raw
    const cc = this.cropCanvas!;
    const crop = 0.6;
    const cx = vw * (1 - crop) / 2, cy = vh * (1 - crop) / 2;
    const cw = vw * crop,           ch = vh * crop;
    const size2 = 800;
    this.resizeCanvas(cc, size2, size2);
    const cc2d = cc.getContext('2d', { willReadFrequently: true })!;
    cc2d.drawImage(video, cx, cy, cw, ch, 0, 0, size2, size2);
    const raw2 = cc2d.getImageData(0, 0, size2, size2);
    r = jsQR(raw2.data, size2, size2, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // Pass 3 — same crop, contrast-stretched greyscale
    const stretched = this.stretchContrast(raw2);
    cc2d.putImageData(stretched, 0, 0);
    const raw3 = cc2d.getImageData(0, 0, size2, size2);
    r = jsQR(raw3.data, size2, size2, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // Pass 4 — tighter centre crop 40%, 960 px, contrast-stretched
    const cc3 = this.cropCanvas2!;
    const crop4 = 0.40;
    const cx4 = vw * (1 - crop4) / 2, cy4 = vh * (1 - crop4) / 2;
    const cw4 = vw * crop4,           ch4 = vh * crop4;
    const size4 = 960;
    this.resizeCanvas(cc3, size4, size4);
    const c4ctx = cc3.getContext('2d', { willReadFrequently: true })!;
    c4ctx.drawImage(video, cx4, cy4, cw4, ch4, 0, 0, size4, size4);
    const raw4 = c4ctx.getImageData(0, 0, size4, size4);
    const stretched4 = this.stretchContrast(raw4);
    c4ctx.putImageData(stretched4, 0, 0);
    r = jsQR(c4ctx.getImageData(0, 0, size4, size4).data, size4, size4, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // Pass 5 — adaptive threshold on centre crop 60% for dark/blurry codes
    cc2d.putImageData(raw2, 0, 0);
    const adaptiveData = this.adaptiveThreshold(raw2, 15, 10);
    r = jsQR(adaptiveData.data, size2, size2, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    return null;
  }

  private resizeCanvas(canvas: HTMLCanvasElement, w: number, h: number) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  /** Global contrast stretch (min-max normalisation → greyscale) */
  private stretchContrast(imageData: ImageData): ImageData {
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    let minL = 255, maxL = 0;
    for (let i = 0; i < src.length; i += 4) {
      const l = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
    const range = maxL - minL || 1, scale = 255 / range;
    for (let i = 0; i < src.length; i += 4) {
      const l = Math.round((0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2] - minL) * scale);
      out[i] = out[i + 1] = out[i + 2] = l;
      out[i + 3] = 255;
    }
    return new ImageData(out, imageData.width, imageData.height);
  }

  /**
   * Local adaptive thresholding — compares each pixel luminance against the
   * mean of its neighbourhood.  Handles uneven lighting much better than a
   * global threshold, so it recovers codes that are partially in shadow.
   * blockSize must be odd; c is a constant subtracted from the mean.
   */
  private adaptiveThreshold(imageData: ImageData, blockSize: number, c: number): ImageData {
    const { width, height, data } = imageData;
    const out = new Uint8ClampedArray(data.length);
    const half = Math.floor(blockSize / 2);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, count = 0;
        for (let ky = -half; ky <= half; ky++) {
          for (let kx = -half; kx <= half; kx++) {
            const nx = Math.min(width - 1,  Math.max(0, x + kx));
            const ny = Math.min(height - 1, Math.max(0, y + ky));
            const idx = (ny * width + nx) * 4;
            sum += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
            count++;
          }
        }
        const mean  = sum / count;
        const idx   = (y * width + x) * 4;
        const lum   = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        const pixel = lum < mean - c ? 0 : 255;
        out[idx] = out[idx + 1] = out[idx + 2] = pixel;
        out[idx + 3] = 255;
      }
    }
    return new ImageData(out, width, height);
  }

  private handleScanResult(barcode: string) {
    const now = Date.now();
    if (now - this.lastScanTime < this.SCAN_DEBOUNCE) return;
    this.lastScanTime = now;

    // Build barcode → { design, size } lookup
    const lookup = new Map<string, { design: Design; size: SizePrice }>();
    this.designs().forEach(d => d.sizes.forEach(s => lookup.set(String(s.BARCODE), { design: d, size: s })));

    const found = lookup.get(barcode.trim());
    if (!found) {
      this.scanFeedback.set('error');
      this.scannerMessage.set(`"${barcode}" not in designs`);
      setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Align barcode within the frame'); }, 1400);
      return;
    }

    // Direct add (scanner always adds qty 1 per scan; tap same code multiple times)
    this._addOrUpdateItem(found.design, found.size, 1);
    this.scannedCount.update(n => n + 1);
    this.scanFeedback.set('success');
    this.scannerMessage.set(`✓ ${found.design.styleNo} · ${found.size.size}`);
    setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Align barcode within the frame'); }, 600);
  }

  // ── Save / Delete ─────────────────────────────────────────────────────────────
  async saveGrn() {
    const grn = this.editableGrn();
    if (!grn.supplierName.trim()) { Swal.fire({ icon: 'warning', title: 'Validation', text: 'Please enter the supplier name.' }); return; }
    if (!grn.invoiceNo.trim())    { Swal.fire({ icon: 'warning', title: 'Validation', text: 'Please enter the invoice number.' }); return; }
    if (grn.items.length === 0)   { Swal.fire({ icon: 'warning', title: 'Validation', text: 'Please add at least one item.' }); return; }

    const hasQty = grn.items.some(i => (Number(i.receivedQty) || 0) > 0);
    const status: GoodsInward['status'] = hasQty ? 'Received' : 'Draft';
    const payload = { ...(grn as any), status } as Omit<GoodsInward, 'id'>;

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

  // ── Helpers ───────────────────────────────────────────────────────────────────
  getStatusClass(status: string): string {
    return status === 'Received' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600';
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