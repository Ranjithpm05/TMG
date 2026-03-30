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
import { InventoryService } from '../../services/inventory.service';

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
type ScannedEntry = {
  barcode:    string;
  styleNo:    string;
  resolvedAt: number;
};

type ReviewGroup = {
  styleNo:          string;
  allColors:        Design[];
  selectedColorIds: string[];
  availableSizes:   string[];
  selectedSizes:    string[];
  sizeQtys:         Record<string, string>;   
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
  status: 'Pending',
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
  private inventoryService = inject(InventoryService);

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
    const fromMs = from ? new Date(from).setHours(0,0,0,0)    : -Infinity;
    const toMs   = to   ? new Date(to).setHours(23,59,59,999) :  Infinity;
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
    const all  = [...new Set(this.designs().map(d => d.styleNo))].sort((a, b) =>
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
      if (checked) design.sizes.forEach(sz => {
        const bc = String(sz.BARCODE);
        copy[bc] = s.selectedSizes[bc] ?? { size: sz, qty: '1' };
      });
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
      return {
        ...grn, items: [...grn.items, {
          designId: design.id ?? '', styleNo: design.styleNo, color: design.color ?? '',
          group: design.group ?? '', size: size.size, sleeveType: size.sleeveType ?? undefined,
          barcode, fabricType: size.fabricType ?? '', receivedQty: qty, WSP: size.WSP, price: size.price
        }]
      };
    });
  }

  removeItem(barcode: string) {
    this.editableGrn.update(grn => ({ ...grn, items: grn.items.filter(i => i.barcode !== barcode) }));
  }

  updateItemQty(barcode: string, value: string) {
    this.editableGrn.update(grn => ({
      ...grn, items: grn.items.map(i => i.barcode === barcode
        ? { ...i, receivedQty: Math.max(0, parseInt(value, 10) || 0) } : i)
    }));
  }

  formItems         = computed(() => this.editableGrn().items ?? []);
  totalReceived     = computed(() => this.formItems().reduce((s, i) => s + (Number(i.receivedQty) || 0), 0));
  totalValue        = computed(() => this.formItems().reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0));
  viewTotalReceived = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + (Number(i.receivedQty) || 0), 0));
  viewTotalValue    = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0));

  // ═══════════════════════════════════════════════════════════════════════════════
  // BATCH SCAN FLOW
  // ═══════════════════════════════════════════════════════════════════════════════
  sessionScanned    = signal<ScannedEntry[]>([]);
  private sessionBarcodeSet = new Set<string>();
  batchReview       = signal<BatchReviewState>(EMPTY_BATCH_REVIEW);
  isSaving = signal(false);
  hasSessionScans   = computed(() => this.sessionScanned().length > 0);
  reviewGroupCount  = computed(() => this.batchReview().groups.length);

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
        selected.forEach(d => d.sizes.forEach(sz => {
            const key = sz.sleeveType ? `${sz.size}|${sz.sleeveType}` : sz.size;
            s.add(key);
        }));
        return this.sortSizeKeys([...s]);
    }

    private sortSizeKeys(keys: string[]): string[] {
        return [...keys].sort((a, b) => {
            const sa = a.split('|')[0], sb = b.split('|')[0];
            const ia = SIZE_ORDER.indexOf(sa), ib = SIZE_ORDER.indexOf(sb);
            if (ia !== -1 && ib !== -1) { if (ia !== ib) return ia - ib; return a.localeCompare(b); }
            if (ia !== -1) return -1; if (ib !== -1) return 1;
            return a.localeCompare(b, undefined, { numeric: true });
        });
    }

    sizeKeyLabel(key: string): string {
        const [size, sleeve] = key.split('|');
        return sleeve ? `${size} (${sleeve})` : size;
    }

  openBatchReview() {
    const entries = this.sessionScanned();
    if (!entries.length) return;
    const styleMap = new Map<string, ScannedEntry[]>();
    for (const e of entries) {
      if (!styleMap.has(e.styleNo)) styleMap.set(e.styleNo, []);
      styleMap.get(e.styleNo)!.push(e);
    }
    const groups: ReviewGroup[] = [];
    for (const [styleNo, ents] of styleMap) {
      const allColors = this.designs().filter(d => d.styleNo === styleNo);
      const group: ReviewGroup = {
        styleNo, allColors,
        selectedColorIds: allColors.map(d => d.id!),
        availableSizes: [], selectedSizes: [],
        sizeQtys: {},
        sourceBarcodes: ents.map(e => e.barcode)
        };
        group.availableSizes = this.buildAvailableSizes(group);
        group.selectedSizes  = [...group.availableSizes];
        group.availableSizes.forEach(s => group.sizeQtys[s] = '1');
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
    if (!this.sessionScanned().length) this.stopScan();
  }

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
       updated.selectedSizes  = updated.selectedSizes.filter(s => updated.availableSizes.includes(s));
        const sizeQtys: Record<string, string> = {};
        updated.selectedSizes.forEach(s => sizeQtys[s] = g.sizeQtys[s] ?? '1');
        updated.sizeQtys = sizeQtys;
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
        const sizeQtys: Record<string, string> = {};
        updated.selectedSizes.forEach(s => sizeQtys[s] = g.sizeQtys[s] ?? '1');
        updated.sizeQtys = sizeQtys;
        return updated;
      });
      return { ...state, groups };
    });
  }

  clearAllReviewColors(groupIdx: number) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) =>
        i !== groupIdx ? g : { ...g, selectedColorIds: [], availableSizes: [], selectedSizes: [], sizeQtys: {} }
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
        const sizeQtys = { ...g.sizeQtys };
        if (already) { delete sizeQtys[sizeName]; } else if (!sizeQtys[sizeName]) { sizeQtys[sizeName] = '1'; }
        return { ...g, selectedSizes, sizeQtys };
      });
      return { ...state, groups };
    });
  }

  selectAllReviewSizes(groupIdx: number) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) =>
        i !== groupIdx ? g : (() => {
        const sizeQtys = { ...g.sizeQtys };
        g.availableSizes.forEach(s => { if (!sizeQtys[s]) sizeQtys[s] = '1'; });
        return { ...g, selectedSizes: [...g.availableSizes], sizeQtys };
        })()
      );
      return { ...state, groups };
    });
  }

  clearAllReviewSizes(groupIdx: number) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) => i !== groupIdx ? g : { ...g, selectedSizes: [], sizeQtys: {} });
      return { ...state, groups };
    });
  }

  updateReviewSizeQty(groupIdx: number, sizeName: string, qty: string) {
  this.batchReview.update(state => {
    const groups = state.groups.map((g, i) =>
      i !== groupIdx ? g : { ...g, sizeQtys: { ...g.sizeQtys, [sizeName]: qty } }
    );
    return { ...state, groups };
  });
}

getTotalPcsForGroup(g: ReviewGroup): number {
  return g.selectedColorIds.length *
    g.selectedSizes.reduce((sum, s) => sum + (parseInt(g.sizeQtys[s], 10) || 0), 0);
}

 canConfirmReviewGroup(g: ReviewGroup): boolean {
  return g.selectedColorIds.length > 0 &&
    g.selectedSizes.length > 0 &&
    g.selectedSizes.some(s => (parseInt(g.sizeQtys[s], 10) || 0) > 0);
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
        const selectedDesigns = g.allColors.filter(d => g.selectedColorIds.includes(d.id!));
        for (const design of selectedDesigns) {
            for (const sizeKey of g.selectedSizes) {
            const qty = Math.max(1, parseInt(g.sizeQtys[sizeKey], 10) || 1);
            const [sizeName, sleeveType] = sizeKey.split('|');
            const matchingSizes = design.sizes.filter(s =>
                s.size === sizeName && (!sleeveType || s.sleeveType === sleeveType)
            );
            for (const sizeObj of matchingSizes) {
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
            } // end matchingSizes loop
            }
      }
    }
    this.closeBatchReview();
    if (skipped > 0) Swal.fire({ icon: 'info', title: 'Done', text: `${added} item(s) added. ${skipped} duplicate barcode(s) skipped.`, timer: 2500, showConfirmButton: false });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // BARCODE SCANNER  —  ultra-performance multi-pass engine  (v2)
  // ═══════════════════════════════════════════════════════════════════════════════
  isScanning     = signal(false);
  scanFeedback   = signal<'idle' | 'success' | 'error' | 'duplicate'>('idle');
  scannerMessage = signal('Point camera at a barcode');

  private stream: MediaStream | null = null;
  private animFrameId: number | null = null;
  private lastScanTime  = 0;
  private lastTickTime  = 0;

  // Tuning knobs
  private readonly TICK_INTERVAL = 20;   // 50 fps processing budget
  private readonly SCAN_DEBOUNCE = 350;  // ms between same-barcode accepts

  // Offscreen canvases (allocated once, reused every frame)
  private fullCanvas:  HTMLCanvasElement | null = null;
  private cropCanvas:  HTMLCanvasElement | null = null;
  private cropCanvas2: HTMLCanvasElement | null = null;
  private cropCanvas3: HTMLCanvasElement | null = null;

  // Native BarcodeDetector (Chrome/Android hardware path)
  private barcodeDetector: any = null;
  private detectorBusy = false;

  // Frame dedup — tiny 16×16 sample to detect identical frames
  private lastFrameHash = 0;
  private dedupCanvas: HTMLCanvasElement | null = null;

  // Cached barcode → design lookup (rebuilt only when designs change)
  private barcodeMapCache: Map<string, { design: Design; size: SizePrice }> | null = null;
  private barcodeMapVersion = 0;

  private torchTrack: MediaStreamTrack | null = null;
  isTorchAvailable = signal(false);
  isTorchOn        = signal(false);
  private torchEnabled = false;

  private getBarcodeMap(): Map<string, { design: Design; size: SizePrice }> {
    const designs = this.designs();
    if (!this.barcodeMapCache || this.barcodeMapVersion !== designs.length) {
      const map = new Map<string, { design: Design; size: SizePrice }>();
      designs.forEach(d => d.sizes.forEach(s => map.set(String(s.BARCODE), { design: d, size: s })));
      this.barcodeMapCache   = map;
      this.barcodeMapVersion = designs.length;
    }
    return this.barcodeMapCache!;
  }

  async startScan() {
    this.isScanning.set(true);
    this.scanFeedback.set('idle');
    this.scannerMessage.set('Point camera at a barcode');

    this.fullCanvas  = document.createElement('canvas');
    this.cropCanvas  = document.createElement('canvas');
    this.cropCanvas2 = document.createElement('canvas');
    this.cropCanvas3 = document.createElement('canvas');
    this.dedupCanvas = document.createElement('canvas');
    this.dedupCanvas.width = this.dedupCanvas.height = 16;

    if ('BarcodeDetector' in window) {
      try {
        this.barcodeDetector = new (window as any).BarcodeDetector({
          formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'data_matrix']
        });
      } catch { this.barcodeDetector = null; }
    }

    this.getBarcodeMap(); // pre-warm cache

    setTimeout(async () => {
      if (!this.videoElement || !navigator.mediaDevices?.getUserMedia) {
        Swal.fire({ icon: 'error', title: 'Error', text: 'Camera not supported on this device.' });
        this.isScanning.set(false);
        return;
      }
      try {
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

        const track = this.stream.getVideoTracks()[0];
        this.torchTrack = track;
        const caps: any = track.getCapabilities?.() ?? {};
        this.isTorchAvailable.set(!!caps.torch);

        try { await track.applyConstraints({ frameRate: { ideal: 60, min: 30 } } as any); } catch { /* ignore */ }

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
    this.stream          = null;
    this.fullCanvas      = null;
    this.cropCanvas      = null;
    this.cropCanvas2     = null;
    this.cropCanvas3     = null;
    this.dedupCanvas     = null;
    this.torchTrack      = null;
    this.torchEnabled    = false;
    this.barcodeDetector = null;
    this.detectorBusy    = false;
    this.lastFrameHash   = 0;
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

    // Async native BarcodeDetector (fire-and-forget)
    if (this.barcodeDetector && !this.detectorBusy) {
      this.detectorBusy = true;
      this.barcodeDetector.detect(video)
        .then((codes: any[]) => {
          this.detectorBusy = false;
          if (codes.length > 0) this.handleScanResult(codes[0].rawValue);
        })
        .catch(() => { this.detectorBusy = false; });
    }

    // Frame dedup: skip if sensor hasn't moved
    if (this.isFrameDuplicate(video, vw, vh)) return;

    // jsQR multi-pass fallback
    const result = this.tryDecode(video, vw, vh);
    if (result) this.handleScanResult(result);
  }

  private isFrameDuplicate(video: HTMLVideoElement, vw: number, vh: number): boolean {
    const dc  = this.dedupCanvas!;
    const dct = dc.getContext('2d', { willReadFrequently: true })!;
    dct.drawImage(video, vw * 0.25, vh * 0.25, vw * 0.5, vh * 0.5, 0, 0, 16, 16);
    const { data } = dct.getImageData(0, 0, 16, 16);
    let hash = 0;
    for (let i = 0; i < data.length; i += 16) hash = ((hash * 31) + data[i]) >>> 0;
    if (hash === this.lastFrameHash) return true;
    this.lastFrameHash = hash;
    return false;
  }

  /**
   * Multi-pass decode — crop-first ordering for maximum hit rate:
   *  Pass 1-4   Centre 75% crop  (raw → boost → unsharp → SAT threshold)
   *  Pass 5-6   Full frame       (raw → boost)
   *  Pass 7-8   Centre 50% crop  (raw → SAT threshold)
   *  Pass 9     Centre 40% crop  (raw)
   */
  private tryDecode(video: HTMLVideoElement, vw: number, vh: number): string | null {
    // Passes 1-4: viewfinder area first (highest probability)
    const r75 = this.cropDecode(video, vw, vh, 0.75, 1024, this.cropCanvas!);
    if (r75) return r75;

    // Passes 5-6: full frame (distant labels)
    const scale1 = Math.min(1, 1920 / Math.max(vw, 1));
    const fw = Math.round(vw * scale1), fh = Math.round(vh * scale1);
    const fc = this.fullCanvas!;
    this.setSize(fc, fw, fh);
    const fctx = fc.getContext('2d', { willReadFrequently: true })!;
    fctx.drawImage(video, 0, 0, vw, vh, 0, 0, fw, fh);
    const imgFull = fctx.getImageData(0, 0, fw, fh);
    let r = jsQR(imgFull.data, fw, fh, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;
    const boostedFull = this.contrastBoost(imgFull, 1.5, 20);
    r = jsQR(boostedFull.data, fw, fh, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // Passes 7-8: tight 50% crop
    const r50 = this.cropDecode(video, vw, vh, 0.50, 900, this.cropCanvas2!);
    if (r50) return r50;

    // Pass 9: super-tight 40%
    const r40 = this.cropDecode(video, vw, vh, 0.40, 800, this.cropCanvas3!);
    if (r40) return r40;

    return null;
  }

  private cropDecode(
    video: HTMLVideoElement,
    vw: number, vh: number,
    ratio: number, outSize: number,
    canvas: HTMLCanvasElement
  ): string | null {
    const cx = vw * (1 - ratio) / 2, cy = vh * (1 - ratio) / 2;
    const cw = vw * ratio,           ch = vh * ratio;
    this.setSize(canvas, outSize, outSize);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, cx, cy, cw, ch, 0, 0, outSize, outSize);
    const raw = ctx.getImageData(0, 0, outSize, outSize);

    // Pass A — raw
    let r = jsQR(raw.data, outSize, outSize, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // Pass B — contrast boost
    const boosted = this.contrastBoost(raw, 1.6, 25);
    r = jsQR(boosted.data, outSize, outSize, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // Pass C — unsharp mask (recovers blurry / out-of-focus codes)
    const sharpened = this.unsharpMask(raw, 1.5, 0.08);
    r = jsQR(sharpened.data, outSize, outSize, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    // Pass D — SAT adaptive threshold (O(n) — handles shadows / uneven light)
    const thresh = this.satAdaptiveThreshold(raw, 31, 8);
    r = jsQR(thresh.data, outSize, outSize, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;

    return null;
  }

  private contrastBoost(src: ImageData, factor: number, brightness: number): ImageData {
    const d = new Uint8ClampedArray(src.data);
    for (let i = 0; i < d.length; i += 4) {
      d[i]   = Math.min(255, Math.max(0, (d[i]   - 128) * factor + 128 + brightness));
      d[i+1] = Math.min(255, Math.max(0, (d[i+1] - 128) * factor + 128 + brightness));
      d[i+2] = Math.min(255, Math.max(0, (d[i+2] - 128) * factor + 128 + brightness));
    }
    return new ImageData(d, src.width, src.height);
  }

  private unsharpMask(src: ImageData, sharpenAmount: number, threshold: number): ImageData {
    const { width, height, data } = src;
    const out  = new Uint8ClampedArray(data.length);
    const luma = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      luma[i] = 0.299 * data[p] + 0.587 * data[p+1] + 0.114 * data[p+2];
    }
    const blur = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.min(width - 1, Math.max(0, x + dx));
            const ny = Math.min(height - 1, Math.max(0, y + dy));
            sum += luma[ny * width + nx]; cnt++;
          }
        }
        blur[y * width + x] = sum / cnt;
      }
    }
    for (let i = 0; i < width * height; i++) {
      const p    = i * 4;
      const diff = luma[i] - blur[i];
      const boost = Math.abs(diff) > threshold * 255 ? sharpenAmount : 0;
      const v = Math.min(255, Math.max(0, luma[i] + diff * boost));
      out[p] = out[p+1] = out[p+2] = v; out[p+3] = 255;
    }
    return new ImageData(out, width, height);
  }

  private satAdaptiveThreshold(src: ImageData, blockSize: number, c: number): ImageData {
    const { width, height, data } = src;
    const half = Math.floor(blockSize / 2);
    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      gray[i] = 0.299 * data[p] + 0.587 * data[p+1] + 0.114 * data[p+2];
    }
    const sat = new Float64Array((width + 1) * (height + 1));
    for (let y = 1; y <= height; y++) {
      for (let x = 1; x <= width; x++) {
        sat[y * (width+1) + x] =
          gray[(y-1) * width + (x-1)]
          + sat[(y-1) * (width+1) + x]
          + sat[y * (width+1) + (x-1)]
          - sat[(y-1) * (width+1) + (x-1)];
      }
    }
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
      const r1 = Math.max(0, y - half), r2 = Math.min(height - 1, y + half) + 1;
      for (let x = 0; x < width; x++) {
        const c1  = Math.max(0, x - half), c2 = Math.min(width - 1, x + half) + 1;
        const cnt = (r2 - r1) * (c2 - c1);
        const sum = sat[r2 * (width+1) + c2] - sat[r1 * (width+1) + c2]
                  - sat[r2 * (width+1) + c1] + sat[r1 * (width+1) + c1];
        const pixel = gray[y * width + x] < (sum / cnt) - c ? 0 : 255;
        const p = (y * width + x) * 4;
        out[p] = out[p+1] = out[p+2] = pixel; out[p+3] = 255;
      }
    }
    return new ImageData(out, width, height);
  }

  private setSize(c: HTMLCanvasElement, w: number, h: number) {
    if (c.width  !== w) c.width  = w;
    if (c.height !== h) c.height = h;
  }

  private handleScanResult(barcode: string) {
    const now = Date.now();
    if (now - this.lastScanTime < this.SCAN_DEBOUNCE) return;
    const bc = barcode.trim();

    if (this.sessionBarcodeSet.has(bc)) {
      if (now - this.lastScanTime < 1500) return;
      this.lastScanTime = now;
      this.scanFeedback.set('duplicate');
      this.scannerMessage.set('↩ Already scanned');
      setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Point camera at a barcode'); }, 1000);
      return;
    }

    const found = this.getBarcodeMap().get(bc);
    if (!found) {
      this.lastScanTime = now;
      this.scanFeedback.set('error');
      this.scannerMessage.set(`Not found: ${bc}`);
      setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Point camera at a barcode'); }, 1400);
      return;
    }

    this.lastScanTime = now;
    this.sessionBarcodeSet.add(bc);
    this.sessionScanned.update(list => [
      ...list, { barcode: bc, styleNo: found.design.styleNo, resolvedAt: now }
    ]);
    this.scanFeedback.set('success');
    this.scannerMessage.set(`✓ ${found.design.styleNo} — ${found.size.size}`);
    setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Point camera at a barcode'); }, 900);
  }

  // ── Date helpers ──────────────────────────────────────────────────────────────
  private currentMonthStart(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  private currentMonthEnd(): string {
    const d    = new Date();
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  }

  isCurrentMonthFilter = computed(() =>
    this.filterFromDate() === this.currentMonthStart() &&
    this.filterToDate()   === this.currentMonthEnd()
  );

  resetToCurrentMonth() {
    this.filterFromDate.set(this.currentMonthStart());
    this.filterToDate.set(this.currentMonthEnd());
    this.currentPage.set(1);
  }

  clearDateFilter() {
    this.filterFromDate.set('');
    this.filterToDate.set('');
    this.currentPage.set(1);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  ngOnInit() {
    Swal.fire({ title: 'Loading data...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    let dLoaded = false, gLoaded = false;
    const tryClose = () => { if (dLoaded && gLoaded) Swal.close(); };
    this.designService.getDesigns().subscribe({
      next:  d  => { this.designs.set(d); dLoaded = true; tryClose(); },
      error: () => { dLoaded = true; tryClose(); Swal.fire('Error', 'Failed to load designs', 'error'); }
    });
    this.grnService.getGoodsInwards().subscribe({
      next:  g  => { this.grns.set(g); gLoaded = true; tryClose(); },
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

        const payload = { ...(grn as any), status: 'Pending' as const } as Omit<GoodsInward, 'id'>;

        this.isSaving.set(true);
        try {
            if (this.isEditMode()) await this.grnService.updateGoodsInward(payload as GoodsInward);
            else                   await this.grnService.createGoodsInward(payload);
            await Swal.fire({ icon: 'success', title: 'Submitted!', text: 'GRN saved as "Pending" — awaiting Manager approval.', timer: 2500, showConfirmButton: false });
            this.refreshGrns();
            this.cancel();
        } 
        catch (err: any) {
            Swal.fire({ icon: 'error', title: 'Save Failed', text: err?.message ?? 'Failed to save GRN.' });
        } 
        finally {
            this.isSaving.set(false);
        }
    }

  async deleteGrn(grn: GoodsInward) {
    const r = await Swal.fire({
      title: 'Delete GRN?', text: `"${grn.grnNo}" will be permanently deleted.`,
      icon: 'warning', showCancelButton: true,
      confirmButtonColor: '#dc2626', confirmButtonText: 'Yes, delete'
    });
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

  private refreshGrns() {
    this.grnService.getGoodsInwards().subscribe({ next: g => this.grns.set(g) });
  }

  // ── Display helpers ───────────────────────────────────────────────────────────
  getStatusClass(status: string): string {
    if (status === 'Approved') return 'bg-green-100 text-green-800';
    if (status === 'Pending')  return 'bg-yellow-100 text-yellow-800';
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

  isApproving = signal(false);

  async approveGrn(grn: GoodsInward) {
    const confirm = await Swal.fire({
      title: 'Approve this GRN?',
      text: `${grn.grnNo} — ${grn.items.length} line(s), ${this.getGrnTotalReceived(grn)} pcs will be added to inventory.`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#16a34a',
      confirmButtonText: 'Yes, Approve',
      cancelButtonText: 'Cancel'
    });
    if (!confirm.isConfirmed) return;

    this.isApproving.set(true);
    try {
      const approved: GoodsInward = { ...grn, status: 'Approved', approvedAt: new Date().toISOString() };
      await this.grnService.updateGoodsInward(approved);
      await this.inventoryService.upsertFromGrn(grn.items, grn.grnNo);
      this.viewGrn.set(approved);
      this.refreshGrns();
      await Swal.fire({ icon: 'success', title: 'Approved!', text: 'Inventory has been updated.', timer: 2000, showConfirmButton: false });
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Approval Failed', text: err?.message ?? 'Failed to approve GRN.' });
    } finally {
      this.isApproving.set(false);
    }
  }

  // ── Preview table helpers ────────────────────────────────────────────────────
  getPreviewStyles(grn: GoodsInward): string[] {
    return [...new Set(grn.items.map(i => i.styleNo))];
  }

  getPreviewSizes(grn: GoodsInward): string[] {
    const allSizes = grn.items.map(i => i.size);
    const unique = [...new Set(allSizes)];
    return unique.sort((a, b) => {
      const ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  }

  getPreviewRows(grn: GoodsInward): Array<{
    label: string; subLabel: string; items: GoodsInwardItem[];
    total: number; WSP: number; MRP: number; value: number;
  }> {
    const styleMap = new Map<string, GoodsInwardItem[]>();
    for (const item of grn.items) {
      const key = `${item.styleNo}||${item.color}||${item.sleeveType ?? ''}`;
      if (!styleMap.has(key)) styleMap.set(key, []);
      styleMap.get(key)!.push(item);
    }
    return [...styleMap.entries()].map(([key, items]) => {
      const [styleNo, color, sleeve] = key.split('||');
      const total = items.reduce((s, i) => s + (Number(i.receivedQty) || 0), 0);
      const wsp   = items[0]?.WSP ?? 0;
      const mrp   = items[0]?.price ?? 0;
      return { label: styleNo, subLabel: [color, sleeve].filter(Boolean).join(' · '), items, total, WSP: wsp, MRP: mrp, value: total * wsp };
    });
  }

  getQtyForSize(row: { items: GoodsInwardItem[] }, size: string): number {
    return row.items.filter(i => i.size === size).reduce((s, i) => s + (Number(i.receivedQty) || 0), 0);
  }

  downloadGrnPdf(grn: GoodsInward) {
    const sizes = this.getPreviewSizes(grn);
    const rows  = this.getPreviewRows(grn);
    const totalQty   = rows.reduce((s, r) => s + r.total, 0);
    const totalValue = rows.reduce((s, r) => s + r.value, 0);

    const sizeHeaders = sizes.map(s => `<th style="padding:6px 10px;border:1px solid #ccc;text-align:center">${s}</th>`).join('');
    const bodyRows = rows.map((row, i) => {
      const sizeCells = sizes.map(s => {
        const q = this.getQtyForSize(row, s);
        return `<td style="padding:6px 10px;border:1px solid #ccc;text-align:center">${q > 0 ? q : '-'}</td>`;
      }).join('');
      return `<tr style="background:${i%2===0?'#fff':'#f9f9f9'}">
        <td style="padding:6px 10px;border:1px solid #ccc;text-align:center">${i+1}</td>
        <td style="padding:6px 10px;border:1px solid #ccc"><strong>${row.label}</strong><br><small style="color:#666">${row.subLabel}</small></td>
        ${sizeCells}
        <td style="padding:6px 10px;border:1px solid #ccc;text-align:center"><strong>${row.total}</strong></td>
        <td style="padding:6px 10px;border:1px solid #ccc;text-align:right">${row.WSP.toFixed(2)}</td>
        <td style="padding:6px 10px;border:1px solid #ccc;text-align:right">${row.MRP.toFixed(2)}</td>
        <td style="padding:6px 10px;border:1px solid #ccc;text-align:right"><strong>${row.value.toFixed(2)}</strong></td>
      </tr>`;
    }).join('');

    const html = `
      <html><head><title>${grn.grnNo}</title>
      <style>body{font-family:Arial,sans-serif;font-size:12px;margin:20px}
      h2{color:#1e293b}table{border-collapse:collapse;width:100%}
      th{background:#1e293b;color:#fff;padding:8px 10px;border:1px solid #ccc}
      tfoot td{background:#f1f5f9;font-weight:bold}
      .info-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}
      .info-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px}
      .info-label{font-size:10px;color:#64748b;text-transform:uppercase}
      .info-value{font-size:13px;font-weight:600;color:#1e293b;margin-top:2px}
      .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600}
      .badge-pending{background:#fef3c7;color:#92400e}
      .badge-approved{background:#d1fae5;color:#065f46}
      </style></head>
      <body>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1e293b;padding-bottom:10px;margin-bottom:12px">
          <div><h2 style="margin:0">${grn.grnNo}</h2><p style="margin:2px 0;color:#64748b;font-size:11px">Goods Inward Report</p></div>
          <span class="badge badge-${grn.status.toLowerCase()}">${grn.status}</span>
        </div>
        <div class="info-grid">
          <div class="info-box"><div class="info-label">Supplier</div><div class="info-value">${grn.supplierName}</div></div>
          <div class="info-box"><div class="info-label">Invoice No</div><div class="info-value">${grn.invoiceNo}</div></div>
          <div class="info-box"><div class="info-label">Invoice Date</div><div class="info-value">${grn.invoiceDate || '–'}</div></div>
          <div class="info-box"><div class="info-label">Received Date</div><div class="info-value">${grn.receivedDate}</div></div>
        </div>
        <table>
          <thead><tr>
            <th style="width:40px">#</th>
            <th style="text-align:left">Product</th>
            ${sizeHeaders}
            <th>Qty</th><th>Rate(Rs)</th><th>MRP(Rs)</th><th>Total(Rs)</th>
          </tr></thead>
          <tbody>${bodyRows}</tbody>
          <tfoot><tr>
            <td colspan="${2 + sizes.length}" style="padding:8px 10px;border:1px solid #ccc;text-align:right">Total</td>
            <td style="padding:8px 10px;border:1px solid #ccc;text-align:center">${totalQty}</td>
            <td style="border:1px solid #ccc"></td><td style="border:1px solid #ccc"></td>
            <td style="padding:8px 10px;border:1px solid #ccc;text-align:right">₹${totalValue.toFixed(2)}</td>
          </tr></tfoot>
        </table>
        ${grn.remarks ? `<div style="margin-top:14px;padding:8px 12px;background:#fefce8;border:1px solid #fde68a;border-radius:6px"><strong>Remarks:</strong> ${grn.remarks}</div>` : ''}
        <p style="margin-top:20px;color:#94a3b8;font-size:10px;text-align:right">Generated on ${new Date().toLocaleString('en-IN')}</p>
      </body></html>`;

    const win = window.open('', '_blank', 'width=1000,height=700');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
  }
}