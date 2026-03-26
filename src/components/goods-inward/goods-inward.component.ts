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

// ── Manual design-picker (multi-size) state ───────────────────────────────────
type SizePickerState = {
  isActive: boolean;
  design: Design | null;
  selectedSizes: Record<string, { size: SizePrice; qty: string }>;
};
const EMPTY_SIZE_PICKER: SizePickerState = { isActive: false, design: null, selectedSizes: {} };

// ── Batch-scan types ──────────────────────────────────────────────────────────
/** One scanned barcode collected during the live camera session */
type ScannedEntry = {
  barcode:   string;
  styleNo:   string;
  resolvedAt: number; // timestamp for display order
};

/** One group in the review modal – one group per unique styleNo */
type ReviewGroup = {
  styleNo:          string;
  /** All colour-variant designs available for this style */
  allColors:        Design[];
  /** IDs of colours the user has selected */
  selectedColorIds: string[];
  /** All sizes available across selected colours */
  availableSizes:   string[];
  /** Sizes the user has selected */
  selectedSizes:    string[];
  /** Single inward qty applied to every colour×size combo */
  qty:              string;
  /** Which raw barcodes triggered this group */
  sourceBarcodes:   string[];
};

type BatchReviewState = {
  isActive: boolean;
  groups:   ReviewGroup[];
};

const EMPTY_BATCH_REVIEW: BatchReviewState = { isActive: false, groups: [] };

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

const SIZE_ORDER = ['XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL','5XL','6XL','Free Size'];

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
  mode    = signal<ViewMode>('list');
  designs = signal<Design[]>([]);
  grns    = signal<GoodsInward[]>([]);
  viewGrn = signal<GoodsInward | null>(null);

  // ── Form State ───────────────────────────────────────────────────────────────
  editableGrn = signal<GoodsInward | Omit<GoodsInward, 'id'>>(EMPTY_GRN);
  isEditMode  = computed(() => 'id' in this.editableGrn());

  // ── Filters / Pagination ─────────────────────────────────────────────────────
  searchTerm     = signal('');
  filterFromDate = signal(this.currentMonthStart());
  filterToDate   = signal(this.currentMonthEnd());
  currentPage    = signal(1);
  itemsPerPage   = signal(10);

  filteredGrns = computed(() => {
    const term   = this.searchTerm().toLowerCase();
    const from   = this.filterFromDate();
    const to     = this.filterToDate();
    const fromMs = from ? new Date(from).setHours(0,0,0,0)       : -Infinity;
    const toMs   = to   ? new Date(to).setHours(23,59,59,999)    :  Infinity;
    return this.grns().filter(g => {
      const raw: any = g.createdAt;
      let d: Date;
      if (raw?.toDate) d = raw.toDate();
      else if (raw instanceof Date) d = raw;
      else if (raw) d = new Date(raw);
      else d = new Date(g.receivedDate);
      if (d.getTime() < fromMs || d.getTime() > toMs) return false;
      if (!term) return true;
      return g.grnNo.toLowerCase().includes(term) ||
             g.supplierName.toLowerCase().includes(term) ||
             g.invoiceNo.toLowerCase().includes(term);
    });
  });

  totalPages    = computed(() => Math.ceil(this.filteredGrns().length / this.itemsPerPage()));
  paginatedGrns = computed(() => {
    const start = (this.currentPage() - 1) * this.itemsPerPage();
    return this.filteredGrns().slice(start, start + this.itemsPerPage());
  });

  // ── Manual Design Picker ──────────────────────────────────────────────────────
  designPickerVisible = signal(false);
  designSearchTerm    = signal('');
  expandedStyleNo     = signal<string | null>(null);
  sizePicker          = signal<SizePickerState>(EMPTY_SIZE_PICKER);

  filteredDesignStyles = computed(() => {
    const term = this.designSearchTerm().toLowerCase();
    const all  = [...new Set(this.designs().map(d => d.styleNo))].sort((a,b) =>
      String(a).localeCompare(String(b), undefined, { numeric: true }));
    return term ? all.filter(s => s.toLowerCase().includes(term)) : all;
  });
  colorsForExpandedStyle = computed(() => {
    const s = this.expandedStyleNo();
    return s ? this.designs().filter(d => d.styleNo === s) : [];
  });

  openDesignPicker()  { this.designSearchTerm.set(''); this.expandedStyleNo.set(null); this.designPickerVisible.set(true); }
  closeDesignPicker() { this.designPickerVisible.set(false); this.expandedStyleNo.set(null); }
  toggleExpandStyle(styleNo: string) { this.expandedStyleNo.update(s => s === styleNo ? null : styleNo); }

  isSizeSelected(barcode: string) { return barcode in this.sizePicker().selectedSizes; }

  isAllSizesSelected = computed(() => {
    const d = this.sizePicker().design;
    return d ? d.sizes.every(s => String(s.BARCODE) in this.sizePicker().selectedSizes) : false;
  });
  isSomeSizesSelected = computed(() => {
    const d = this.sizePicker().design;
    if (!d) return false;
    const c = d.sizes.filter(s => String(s.BARCODE) in this.sizePicker().selectedSizes).length;
    return c > 0 && c < d.sizes.length;
  });

  openSizePicker(design: Design) { this.sizePicker.set({ isActive: true, design, selectedSizes: {} }); this.designPickerVisible.set(false); }
  closeSizePicker() { this.sizePicker.set(EMPTY_SIZE_PICKER); this.designPickerVisible.set(true); }

  toggleSize(size: SizePrice, checked: boolean) {
    const bc = String(size.BARCODE);
    this.sizePicker.update(s => {
      const copy = { ...s.selectedSizes };
      if (checked) copy[bc] = { size, qty: '1' }; else delete copy[bc];
      return { ...s, selectedSizes: copy };
    });
  }
  toggleAllSizes(checked: boolean) {
    const design = this.sizePicker().design;
    if (!design) return;
    this.sizePicker.update(s => {
      const copy: SizePickerState['selectedSizes'] = {};
      if (checked) design.sizes.forEach(sz => { const bc = String(sz.BARCODE); copy[bc] = s.selectedSizes[bc] ?? { size: sz, qty: '1' }; });
      return { ...s, selectedSizes: copy };
    });
  }
  updateSizeQty(barcode: string, qty: string) {
    this.sizePicker.update(s => {
      if (!(barcode in s.selectedSizes)) return s;
      return { ...s, selectedSizes: { ...s.selectedSizes, [barcode]: { ...s.selectedSizes[barcode], qty } } };
    });
  }
  canConfirmSizes = computed(() => Object.keys(this.sizePicker().selectedSizes).length > 0);
  confirmSizeSelection() {
    const { design, selectedSizes } = this.sizePicker();
    if (!design) return;
    for (const [, { size, qty }] of Object.entries(selectedSizes)) {
      const q = Math.max(0, parseInt(qty, 10) || 0);
      if (q > 0) this._addOrUpdateItem(design, size, q);
    }
    this.sizePicker.set(EMPTY_SIZE_PICKER);
    this.designPickerVisible.set(true);
  }

  // ── GRN item helpers ──────────────────────────────────────────────────────────
  private _addOrUpdateItem(design: Design, size: SizePrice, qty: number) {
    const barcode = String(size.BARCODE);
    this.editableGrn.update(grn => {
      const existing = grn.items.find(i => i.barcode === barcode);
      if (existing) {
        return { ...grn, items: grn.items.map(i => i.barcode === barcode ? { ...i, receivedQty: i.receivedQty + qty } : i) };
      }
      return { ...grn, items: [...grn.items, {
        designId: design.id ?? '', styleNo: design.styleNo, color: design.color ?? '',
        group: design.group ?? '', size: size.size, sleeveType: size.sleeveType ?? undefined,
        barcode, fabricType: size.fabricType ?? '', receivedQty: qty, WSP: size.WSP, price: size.price
      }] };
    });
  }
  removeItem(barcode: string) {
    this.editableGrn.update(grn => ({ ...grn, items: grn.items.filter(i => i.barcode !== barcode) }));
  }
  updateItemQty(barcode: string, value: string) {
    this.editableGrn.update(grn => ({
      ...grn, items: grn.items.map(i => i.barcode === barcode ? { ...i, receivedQty: Math.max(0, parseInt(value, 10) || 0) } : i)
    }));
  }

  formItems     = computed(() => this.editableGrn().items ?? []);
  totalReceived = computed(() => this.formItems().reduce((s, i) => s + (Number(i.receivedQty) || 0), 0));
  totalValue    = computed(() => this.formItems().reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0));
  viewTotalReceived = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + (Number(i.receivedQty) || 0), 0));
  viewTotalValue    = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0));

  // ═══════════════════════════════════════════════════════════════════════════════
  // BATCH SCAN FLOW
  // ═══════════════════════════════════════════════════════════════════════════════

  /** All barcodes collected in this scan session (live camera phase) */
  sessionScanned = signal<ScannedEntry[]>([]);

  /** Set of barcodes already scanned this session (fast dedup) */
  private sessionBarcodeSet = new Set<string>();

  /** Review state shown after camera is closed */
  batchReview = signal<BatchReviewState>(EMPTY_BATCH_REVIEW);

  hasSessionScans  = computed(() => this.sessionScanned().length > 0);
  reviewGroupCount = computed(() => this.batchReview().groups.length);

  // ── Review helpers ────────────────────────────────────────────────────────────
  private sortSizes(sizes: string[]): string[] {
    return [...sizes].sort((a, b) => {
      const ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1; if (ib !== -1) return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  }

  private buildAvailableSizes(group: ReviewGroup): string[] {
    const selected = group.allColors.filter(d => group.selectedColorIds.includes(d.id!));
    const s = new Set<string>();
    selected.forEach(d => d.sizes.forEach(sz => s.add(sz.size)));
    return this.sortSizes([...s]);
  }

  openBatchReview() {
    const entries = this.sessionScanned();
    if (!entries.length) return;

    // Group by styleNo
    const styleMap = new Map<string, ScannedEntry[]>();
    for (const e of entries) {
      if (!styleMap.has(e.styleNo)) styleMap.set(e.styleNo, []);
      styleMap.get(e.styleNo)!.push(e);
    }

    const groups: ReviewGroup[] = [];
    for (const [styleNo, ents] of styleMap) {
      const allColors = this.designs().filter(d => d.styleNo === styleNo);
      const group: ReviewGroup = {
        styleNo,
        allColors,
        selectedColorIds: allColors.map(d => d.id!), // default: all colours selected
        availableSizes:   [],
        selectedSizes:    [],
        qty:              '1',
        sourceBarcodes:   ents.map(e => e.barcode)
      };
      group.availableSizes = this.buildAvailableSizes(group);
      group.selectedSizes  = [...group.availableSizes]; // default: all sizes selected
      groups.push(group);
    }

    this.stopScan();
    this.batchReview.set({ isActive: true, groups });
  }

  closeBatchReview() {
    this.batchReview.set(EMPTY_BATCH_REVIEW);
    this.sessionScanned.set([]);
    this.sessionBarcodeSet.clear();
  }

  removeScannedBarcode(barcode: string) {
    this.sessionScanned.update(list => list.filter(e => e.barcode !== barcode));
    this.sessionBarcodeSet.delete(barcode);
    // Also remove the group if it was the only source
    if (!this.sessionScanned().length) { this.stopScan(); }
  }

  // Review group mutations
  toggleReviewColor(groupIdx: number, designId: string) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) => {
        if (i !== groupIdx) return g;
        const already = g.selectedColorIds.includes(designId);
        const selectedColorIds = already
          ? g.selectedColorIds.filter(id => id !== designId)
          : [...g.selectedColorIds, designId];
        const updated = { ...g, selectedColorIds };
        updated.availableSizes = this.buildAvailableSizes(updated);
        // remove sizes that are no longer available
        updated.selectedSizes = updated.selectedSizes.filter(s => updated.availableSizes.includes(s));
        return updated;
      });
      return { ...state, groups };
    });
  }

  selectAllReviewColors(groupIdx: number) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) => {
        if (i !== groupIdx) return g;
        const updated = { ...g, selectedColorIds: g.allColors.map(d => d.id!) };
        updated.availableSizes = this.buildAvailableSizes(updated);
        updated.selectedSizes  = [...updated.availableSizes];
        return updated;
      });
      return { ...state, groups };
    });
  }

  clearAllReviewColors(groupIdx: number) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) =>
        i !== groupIdx ? g : { ...g, selectedColorIds: [], availableSizes: [], selectedSizes: [] }
      );
      return { ...state, groups };
    });
  }

  toggleReviewSize(groupIdx: number, sizeName: string) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) => {
        if (i !== groupIdx) return g;
        const already = g.selectedSizes.includes(sizeName);
        const selectedSizes = already ? g.selectedSizes.filter(s => s !== sizeName) : [...g.selectedSizes, sizeName];
        return { ...g, selectedSizes };
      });
      return { ...state, groups };
    });
  }

  selectAllReviewSizes(groupIdx: number) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) =>
        i !== groupIdx ? g : { ...g, selectedSizes: [...g.availableSizes] }
      );
      return { ...state, groups };
    });
  }

  clearAllReviewSizes(groupIdx: number) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) => i !== groupIdx ? g : { ...g, selectedSizes: [] });
      return { ...state, groups };
    });
  }

  updateReviewQty(groupIdx: number, qty: string) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) => i !== groupIdx ? g : { ...g, qty });
      return { ...state, groups };
    });
  }

  canConfirmReviewGroup(g: ReviewGroup): boolean {
    return g.selectedColorIds.length > 0 && g.selectedSizes.length > 0 && (parseInt(g.qty, 10) || 0) > 0;
  }

  canAddAllReviewGroups = computed(() =>
    this.batchReview().groups.some(g => this.canConfirmReviewGroup(g))
  );

  confirmBatchReview() {
    const { groups } = this.batchReview();
    const existingBarcodes = new Set(this.editableGrn().items.map(i => i.barcode));
    let added = 0, skipped = 0;

    for (const g of groups) {
      if (!this.canConfirmReviewGroup(g)) continue;
      const qty = Math.max(1, parseInt(g.qty, 10) || 1);
      const selectedDesigns = g.allColors.filter(d => g.selectedColorIds.includes(d.id!));

      for (const design of selectedDesigns) {
        for (const sizeName of g.selectedSizes) {
          const sizeObj = design.sizes.find(s => s.size === sizeName);
          if (!sizeObj) continue;
          const barcode = String(sizeObj.BARCODE);
          if (existingBarcodes.has(barcode)) { skipped++; continue; }
          this.editableGrn.update(grn => ({
            ...grn, items: [...grn.items, {
              designId: design.id ?? '', styleNo: design.styleNo, color: design.color ?? '',
              group: design.group ?? '', size: sizeObj.size, sleeveType: sizeObj.sleeveType ?? undefined,
              barcode, fabricType: sizeObj.fabricType ?? '', receivedQty: qty,
              WSP: sizeObj.WSP, price: sizeObj.price
            }]
          }));
          existingBarcodes.add(barcode);
          added++;
        }
      }
    }

    this.closeBatchReview();
    if (skipped > 0) Swal.fire({ icon: 'info', title: 'Done', text: `${added} item(s) added. ${skipped} duplicate barcode(s) skipped.`, timer: 2500, showConfirmButton: false });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // BARCODE SCANNER  —  ultra-performance multi-pass engine
  // ═══════════════════════════════════════════════════════════════════════════════
  isScanning     = signal(false);
  scanFeedback   = signal<'idle' | 'success' | 'error' | 'duplicate'>('idle');
  scannerMessage = signal('Point camera at a barcode');

  private stream: MediaStream | null = null;
  private animFrameId: number | null = null;
  private lastScanTime  = 0;
  private lastTickTime  = 0;

  // ── Tuning knobs (optimised for distance + speed) ─────────────────────────────
  private readonly TICK_INTERVAL = 25;   // 40 fps processing
  private readonly SCAN_DEBOUNCE = 350;  // ms between same-barcode accepts

  // ── Offscreen canvases (allocated once) ───────────────────────────────────────
  private fullCanvas:  HTMLCanvasElement | null = null;
  private cropCanvas:  HTMLCanvasElement | null = null;
  private cropCanvas2: HTMLCanvasElement | null = null;
  private cropCanvas3: HTMLCanvasElement | null = null;

  private torchTrack: MediaStreamTrack | null = null;
  isTorchAvailable = signal(false);
  isTorchOn        = signal(false);
  private torchEnabled = false;

  async startScan() {
    // Reset session only if starting fresh (not resuming)
    this.isScanning.set(true);
    this.scanFeedback.set('idle');
    this.scannerMessage.set('Point camera at a barcode');

    this.fullCanvas  = document.createElement('canvas');
    this.cropCanvas  = document.createElement('canvas');
    this.cropCanvas2 = document.createElement('canvas');
    this.cropCanvas3 = document.createElement('canvas');

    setTimeout(async () => {
      if (!this.videoElement || !navigator.mediaDevices?.getUserMedia) {
        Swal.fire({ icon: 'error', title: 'Error', text: 'Camera not supported on this device.' });
        this.isScanning.set(false);
        return;
      }
      try {
        // Request maximum resolution for long-range decode
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width:  { ideal: 3840, min: 1280 },
            height: { ideal: 2160, min: 720 },
            advanced: [{ focusMode: 'continuous' } as any]
          }
        });

        const video = this.videoElement.nativeElement;
        video.srcObject = this.stream;
        await video.play();

        // Torch detection
        const track = this.stream.getVideoTracks()[0];
        this.torchTrack = track;
        const caps: any = track.getCapabilities?.() ?? {};
        this.isTorchAvailable.set(!!caps.torch);

        // Try to set high frame rate if supported
        try {
          await track.applyConstraints({ frameRate: { ideal: 60, min: 30 } } as any);
        } catch { /* ignore */ }

        this.tick();
      } catch {
        Swal.fire({ icon: 'error', title: 'Camera Error', text: 'Cannot access camera. Please allow camera permission.' });
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
    this.cropCanvas3  = null;
    this.torchTrack   = null;
    this.torchEnabled = false;
    this.isScanning.set(false);
    this.isTorchOn.set(false);
    this.isTorchAvailable.set(false);
  }

  closeScannerWithoutReview() {
    this.stopScan();
    this.sessionScanned.set([]);
    this.sessionBarcodeSet.clear();
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

    const result = this.tryDecode(video, vw, vh);
    if (result) this.handleScanResult(result);
  }

  /**
   * Multi-pass decode engine — 6 passes ordered by speed:
   * 1. Full frame native (finds distant barcodes on high-res sensors)
   * 2. Full frame contrast-boosted
   * 3. Centre crop 75%, scaled to 1024px (detail for medium distance)
   * 4. Centre crop 75%, adaptive threshold (shadow recovery)
   * 5. Centre crop 50% (tight zoom — very close / small labels)
   * 6. Centre crop 50%, adaptive threshold
   */
  private tryDecode(video: HTMLVideoElement, vw: number, vh: number): string | null {
    // ── Pass 1: full frame, capped at 1920 wide ──────────────────────────────
    const scale1 = Math.min(1, 1920 / Math.max(vw, 1));
    const fw = Math.round(vw * scale1), fh = Math.round(vh * scale1);
    const fc = this.fullCanvas!;
    this.setSize(fc, fw, fh);
    const fctx = fc.getContext('2d', { willReadFrequently: true })!;
    fctx.drawImage(video, 0, 0, vw, vh, 0, 0, fw, fh);
    const imgFull = fctx.getImageData(0, 0, fw, fh);
    let r = jsQR(imgFull.data, fw, fh, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // ── Pass 2: full frame, contrast boosted ──────────────────────────────────
    const boosted = this.contrastBoost(imgFull, 1.5, 20);
    r = jsQR(boosted.data, fw, fh, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // ── Pass 3 & 4: centre crop 75% → 1024px ─────────────────────────────────
    const r75 = this.cropDecode(video, vw, vh, 0.75, 1024, this.cropCanvas!);
    if (r75) return r75;

    // ── Pass 5 & 6: centre crop 50% → 900px (tight zoom) ─────────────────────
    const r50 = this.cropDecode(video, vw, vh, 0.50, 900, this.cropCanvas2!);
    if (r50) return r50;

    // ── Pass 7: 40% super-tight crop (very close labels) ─────────────────────
    const r40 = this.cropDecode(video, vw, vh, 0.40, 800, this.cropCanvas3!);
    if (r40) return r40;

    return null;
  }

  /** Crop + decode with raw and adaptive-threshold passes */
  private cropDecode(video: HTMLVideoElement, vw: number, vh: number, ratio: number, outSize: number, canvas: HTMLCanvasElement): string | null {
    const cx = vw * (1 - ratio) / 2;
    const cy = vh * (1 - ratio) / 2;
    const cw = vw * ratio;
    const ch = vh * ratio;
    this.setSize(canvas, outSize, outSize);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, cx, cy, cw, ch, 0, 0, outSize, outSize);
    const raw = ctx.getImageData(0, 0, outSize, outSize);

    // Pass A — raw crop
    let r = jsQR(raw.data, outSize, outSize, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // Pass B — contrast boost
    const boosted = this.contrastBoost(raw, 1.6, 25);
    r = jsQR(boosted.data, outSize, outSize, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // Pass C — adaptive threshold (shadow / uneven light)
    const thresh = this.adaptiveThreshold(raw, 25, 8);
    r = jsQR(thresh.data, outSize, outSize, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    return null;
  }

  /** Boost contrast: multiply luminance deviation, then shift brightness */
  private contrastBoost(src: ImageData, factor: number, brightness: number): ImageData {
    const d = new Uint8ClampedArray(src.data);
    for (let i = 0; i < d.length; i += 4) {
      d[i]   = Math.min(255, Math.max(0, (d[i]   - 128) * factor + 128 + brightness));
      d[i+1] = Math.min(255, Math.max(0, (d[i+1] - 128) * factor + 128 + brightness));
      d[i+2] = Math.min(255, Math.max(0, (d[i+2] - 128) * factor + 128 + brightness));
    }
    return new ImageData(d, src.width, src.height);
  }

  /** Local adaptive threshold — recovers barcodes in shadow / uneven light */
  private adaptiveThreshold(src: ImageData, blockSize: number, c: number): ImageData {
    const { width, height, data } = src;
    const out  = new Uint8ClampedArray(data.length);
    const half = Math.floor(blockSize / 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, cnt = 0;
        for (let ky = -half; ky <= half; ky++) {
          for (let kx = -half; kx <= half; kx++) {
            const nx = Math.min(width-1,  Math.max(0, x+kx));
            const ny = Math.min(height-1, Math.max(0, y+ky));
            const i  = (ny*width+nx)*4;
            sum += 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
            cnt++;
          }
        }
        const mean  = sum / cnt;
        const idx   = (y*width+x)*4;
        const lum   = 0.299*data[idx] + 0.587*data[idx+1] + 0.114*data[idx+2];
        const pixel = lum < mean - c ? 0 : 255;
        out[idx] = out[idx+1] = out[idx+2] = pixel; out[idx+3] = 255;
      }
    }
    return new ImageData(out, width, height);
  }

  private setSize(c: HTMLCanvasElement, w: number, h: number) {
    if (c.width !== w)  c.width  = w;
    if (c.height !== h) c.height = h;
  }

  private handleScanResult(barcode: string) {
    const now = Date.now();
    if (now - this.lastScanTime < this.SCAN_DEBOUNCE) return;

    const bc = barcode.trim();

    // Already scanned this session → flash duplicate
    if (this.sessionBarcodeSet.has(bc)) {
      if (now - this.lastScanTime < 1500) return; // throttle duplicate flash
      this.lastScanTime = now;
      this.scanFeedback.set('duplicate');
      this.scannerMessage.set(`↩ Already scanned`);
      setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Point camera at a barcode'); }, 1000);
      return;
    }

    // Resolve barcode → design
    const lookup = new Map<string, { design: Design; size: SizePrice }>();
    this.designs().forEach(d => d.sizes.forEach(s => lookup.set(String(s.BARCODE), { design: d, size: s })));
    const found = lookup.get(bc);

    if (!found) {
      this.lastScanTime = now;
      this.scanFeedback.set('error');
      this.scannerMessage.set(`Not found: ${bc}`);
      setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Point camera at a barcode'); }, 1400);
      return;
    }

    this.lastScanTime = now;
    this.sessionBarcodeSet.add(bc);
    this.sessionScanned.update(list => [...list, { barcode: bc, styleNo: found.design.styleNo, resolvedAt: now }]);

    this.scanFeedback.set('success');
    this.scannerMessage.set(`✓ ${found.design.styleNo}`);
    setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Point camera at a barcode'); }, 700);
  }

  // ── Date helpers ─────────────────────────────────────────────────────────────
  private currentMonthStart(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
  }
  private currentMonthEnd(): string {
    const d = new Date();
    const last = new Date(d.getFullYear(), d.getMonth()+1, 0);
    return `${last.getFullYear()}-${String(last.getMonth()+1).padStart(2,'0')}-${String(last.getDate()).padStart(2,'0')}`;
  }
  isCurrentMonthFilter = computed(() => this.filterFromDate() === this.currentMonthStart() && this.filterToDate() === this.currentMonthEnd());
  resetToCurrentMonth() { this.filterFromDate.set(this.currentMonthStart()); this.filterToDate.set(this.currentMonthEnd()); }
  clearDateFilter()     { this.filterFromDate.set(''); this.filterToDate.set(''); }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  ngOnInit() {
    Swal.fire({ title: 'Loading data...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    let dLoaded = false, gLoaded = false;
    const tryClose = () => { if (dLoaded && gLoaded) Swal.close(); };
    this.designService.getDesigns().subscribe({ next: d => { this.designs.set(d); dLoaded = true; tryClose(); }, error: () => { dLoaded = true; tryClose(); } });
    this.grnService.getGoodsInwards().subscribe({ next: g => { this.grns.set(g); gLoaded = true; tryClose(); }, error: () => { gLoaded = true; tryClose(); Swal.fire('Error','Failed to load GRNs','error'); } });
  }
  ngOnDestroy() { this.stopScan(); }

  // ── Navigation ────────────────────────────────────────────────────────────────
  showAddForm()  { this.editableGrn.set({ ...JSON.parse(JSON.stringify(EMPTY_GRN)), grnNo: `GRN-${Date.now()}` }); this.mode.set('form'); }
  showEditForm(grn: GoodsInward) { this.editableGrn.set(JSON.parse(JSON.stringify(grn))); this.mode.set('form'); }
  showViewMode(grn: GoodsInward) { this.viewGrn.set(grn); this.mode.set('view'); }
  cancel() {
    this.mode.set('list');
    this.editableGrn.set(JSON.parse(JSON.stringify(EMPTY_GRN)));
    this.viewGrn.set(null);
    this.designPickerVisible.set(false);
    this.sizePicker.set(EMPTY_SIZE_PICKER);
    this.closeBatchReview();
    this.stopScan();
  }

  onSearch(term: string)         { this.searchTerm.set(term); this.currentPage.set(1); }
  changePage(p: number)          { if (p >= 1 && p <= this.totalPages()) this.currentPage.set(p); }
  onItemsPerPageChange(e: Event) { this.itemsPerPage.set(Number((e.target as HTMLSelectElement).value)); this.currentPage.set(1); }

  // ── Save / Delete ─────────────────────────────────────────────────────────────
  async saveGrn() {
    const grn = this.editableGrn();
    if (!grn.supplierName.trim()) { Swal.fire({ icon: 'warning', title: 'Validation', text: 'Please enter the supplier name.' }); return; }
    if (!grn.invoiceNo.trim())    { Swal.fire({ icon: 'warning', title: 'Validation', text: 'Please enter the invoice number.' }); return; }
    if (grn.items.length === 0)   { Swal.fire({ icon: 'warning', title: 'Validation', text: 'Please add at least one item.' }); return; }

    const hasQty    = grn.items.some(i => (Number(i.receivedQty)||0) > 0);
    const status: GoodsInward['status'] = hasQty ? 'Received' : 'Draft';
    const payload   = { ...(grn as any), status } as Omit<GoodsInward,'id'>;

    try {
      Swal.fire({ title: this.isEditMode() ? 'Updating GRN…' : 'Saving GRN…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      if (this.isEditMode()) await this.grnService.updateGoodsInward(payload as GoodsInward);
      else                   await this.grnService.createGoodsInward(payload);
      await Swal.fire({ icon: 'success', title: 'Saved!', timer: 2000, showConfirmButton: false });
      this.refreshGrns();
      this.cancel();
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Error', text: err?.message ?? 'Failed to save GRN.' });
    }
  }

  async deleteGrn(grn: GoodsInward) {
    const r = await Swal.fire({ title: 'Delete GRN?', text: `"${grn.grnNo}" will be permanently deleted.`, icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626', confirmButtonText: 'Yes, delete' });
    if (!r.isConfirmed) return;
    try {
      Swal.fire({ title: 'Deleting…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      await this.grnService.deleteGoodsInward(grn.id!);
      await Swal.fire({ icon: 'success', title: 'Deleted', timer: 1500, showConfirmButton: false });
      this.refreshGrns();
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Error', text: err?.message ?? 'Failed to delete GRN.' });
    }
  }

  private refreshGrns() { this.grnService.getGoodsInwards().subscribe({ next: g => this.grns.set(g) }); }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  getStatusClass(status: string): string {
    return status === 'Received' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600';
  }
  getGrnTotalReceived(grn: GoodsInward): number { return grn.items.reduce((s,i) => s+(Number(i.receivedQty)||0),0); }
  getGrnTotalValue(grn: GoodsInward):    number { return grn.items.reduce((s,i) => s+((Number(i.receivedQty)||0)*(Number(i.WSP)||0)),0); }
  formatDate(raw: any): string {
    if (!raw) return '';
    try { const d = raw?.toDate ? raw.toDate() : new Date(raw); return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); } catch { return ''; }
  }
}