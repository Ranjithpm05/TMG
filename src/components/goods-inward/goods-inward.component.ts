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
import { InventoryService } from '../../services/inventory.service';
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
  grnNo:         '',
  supplierName:  '',
  invoiceNo:     '',
  invoiceDate:   '',
  receivedDate:  new Date().toISOString().split('T')[0],
  items:         [],
  status:        'Pending',
  remarks:       ''
};

const SIZE_ORDER = ['XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL','5XL','6XL','Free Size'];

@Component({
  selector:        'app-goods-inward',
  standalone:      true,
  imports:         [CommonModule, FormsModule],
  templateUrl:     './goods-inward.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoodsInwardComponent implements OnInit, OnDestroy {

  private designService    = inject(DesignService);
  private grnService       = inject(GoodsInwardService);
  private inventoryService = inject(InventoryService);

  @ViewChild('video')  videoElement?: ElementRef<HTMLVideoElement>;
  @ViewChild('canvas') canvasElement?: ElementRef<HTMLCanvasElement>;

  // ── View State ────────────────────────────────────────────────────────────────
  mode    = signal<ViewMode>('list');
  designs = signal<Design[]>([]);
  grns    = signal<GoodsInward[]>([]);
  viewGrn = signal<GoodsInward | null>(null);

  // ── Form State ────────────────────────────────────────────────────────────────
  editableGrn = signal<GoodsInward | Omit<GoodsInward, 'id'>>(EMPTY_GRN);
  isEditMode  = computed(() => 'id' in this.editableGrn());
  isSaving    = signal(false);
  isApproving = signal(false);

  // ── Filters / Pagination ──────────────────────────────────────────────────────
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

  totalPages    = computed(() => Math.max(1, Math.ceil(this.filteredGrns().length / this.itemsPerPage())));
  paginatedGrns = computed(() => {
    const start = (this.currentPage() - 1) * this.itemsPerPage();
    return this.filteredGrns().slice(start, start + this.itemsPerPage());
  });

  viewTotalReceived = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + (Number(i.receivedQty) || 0), 0));
  viewTotalValue    = computed(() => (this.viewGrn()?.items ?? []).reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0));

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

  formItems     = computed(() => this.editableGrn().items ?? []);
  totalReceived = computed(() => this.formItems().reduce((s, i) => s + (Number(i.receivedQty) || 0), 0));
  totalValue    = computed(() => this.formItems().reduce((s, i) => s + ((Number(i.receivedQty) || 0) * (Number(i.WSP) || 0)), 0));

  // ── Date helpers ──────────────────────────────────────────────────────────────
  private currentMonthStart(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
  }
  private currentMonthEnd(): string {
    const d    = new Date();
    const last = new Date(d.getFullYear(), d.getMonth()+1, 0);
    return `${last.getFullYear()}-${String(last.getMonth()+1).padStart(2,'0')}-${String(last.getDate()).padStart(2,'0')}`;
  }

  isCurrentMonthFilter = computed(() =>
    this.filterFromDate() === this.currentMonthStart() &&
    this.filterToDate()   === this.currentMonthEnd()
  );

  resetToCurrentMonth() { this.filterFromDate.set(this.currentMonthStart()); this.filterToDate.set(this.currentMonthEnd()); }
  clearDateFilter()     { this.filterFromDate.set(''); this.filterToDate.set(''); }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  ngOnInit() {
    Swal.fire({ title: 'Loading…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
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
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Save Failed', text: err?.message ?? 'Failed to save GRN.' });
    } finally {
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

  async approveGrn(grn: GoodsInward) {
    const confirmed = await Swal.fire({
      title: 'Approve this GRN?',
      text: `${grn.grnNo} — ${grn.items.length} line(s), ${this.getGrnTotalReceived(grn)} pcs will be added to inventory.`,
      icon: 'question', showCancelButton: true,
      confirmButtonColor: '#16a34a', confirmButtonText: 'Yes, Approve'
    });
    if (!confirmed.isConfirmed) return;
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

  // ── Preview / Download ────────────────────────────────────────────────────────
  getPreviewSizes(grn: GoodsInward): string[] {
    const unique = [...new Set(grn.items.map(i => i.size))];
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
    const map = new Map<string, GoodsInwardItem[]>();
    for (const item of grn.items) {
      const key = `${item.styleNo}||${item.color}||${item.sleeveType ?? ''}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return [...map.entries()].map(([key, items]) => {
      const [styleNo, color, sleeve] = key.split('||');
      const total = items.reduce((s, i) => s + (Number(i.receivedQty) || 0), 0);
      const wsp   = items[0]?.WSP   ?? 0;
      const mrp   = items[0]?.price ?? 0;
      return { label: styleNo, subLabel: [color, sleeve].filter(Boolean).join(' · '), items, total, WSP: wsp, MRP: mrp, value: total * wsp };
    });
  }

  getQtyForSize(row: { items: GoodsInwardItem[] }, size: string): number {
    return row.items.filter(i => i.size === size).reduce((s, i) => s + (Number(i.receivedQty) || 0), 0);
  }

  downloadGrnPdf(grn: GoodsInward) {
    const sizes      = this.getPreviewSizes(grn);
    const rows       = this.getPreviewRows(grn);
    const totalQty   = rows.reduce((s, r) => s + r.total, 0);
    const totalValue = rows.reduce((s, r) => s + r.value, 0);

    const th = (t: string, center = false) =>
      `<th style="padding:7px 10px;border:1px solid #ccc;text-align:${center?'center':'left'};background:#1e293b;color:#fff">${t}</th>`;
    const td = (t: string, center = false, bold = false) =>
      `<td style="padding:6px 10px;border:1px solid #ddd;text-align:${center?'center':'left'};${bold?'font-weight:600':''}">${t}</td>`;

    const sizeHeaders = sizes.map(s => th(s, true)).join('');
    const bodyRows    = rows.map((row, i) => {
      const sizeCells = sizes.map(s => {
        const q = this.getQtyForSize(row, s);
        return td(q > 0 ? String(q) : '-', true);
      }).join('');
      return `<tr style="background:${i%2===0?'#fff':'#f8fafc'}">
        ${td(String(i+1), true)}
        <td style="padding:6px 10px;border:1px solid #ddd"><strong>${row.label}</strong>${row.subLabel?`<br><small style="color:#64748b">${row.subLabel}</small>`:''}</td>
        ${sizeCells}
        ${td(String(row.total), true, true)}
        ${td(row.WSP.toFixed(2), false)}
        ${td(row.MRP.toFixed(2), false)}
        ${td('₹'+row.value.toFixed(2), false, true)}
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><title>${grn.grnNo}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:12px;margin:24px;color:#1e293b}
      h2{margin:0;font-size:20px} p{margin:3px 0;color:#64748b;font-size:11px}
      table{border-collapse:collapse;width:100%;margin-top:16px}
      .info{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}
      .box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px}
      .lbl{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px}
      .val{font-size:13px;font-weight:600;margin-top:2px}
      .badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700}
      .pending{background:#fef3c7;color:#92400e} .approved{background:#d1fae5;color:#065f46}
      tfoot td{background:#f1f5f9;font-weight:700}
      @media print{body{margin:10px}}
    </style></head><body>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1e293b;padding-bottom:12px">
      <div><h2>${grn.grnNo}</h2><p>Goods Inward Report · Generated ${new Date().toLocaleString('en-IN')}</p></div>
      <span class="badge ${grn.status.toLowerCase()}">${grn.status}</span>
    </div>
    <div class="info">
      <div class="box"><div class="lbl">Supplier</div><div class="val">${grn.supplierName}</div></div>
      <div class="box"><div class="lbl">Invoice No</div><div class="val">${grn.invoiceNo}</div></div>
      <div class="box"><div class="lbl">Invoice Date</div><div class="val">${grn.invoiceDate||'–'}</div></div>
      <div class="box"><div class="lbl">Received Date</div><div class="val">${grn.receivedDate}</div></div>
    </div>
    <table>
      <thead><tr>
        ${th('#',true)}${th('Product')}${sizeHeaders}${th('Qty',true)}${th('Rate(Rs)')}${th('MRP(Rs)')}${th('Total(Rs)')}
      </tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot><tr>
        <td colspan="${2+sizes.length}" style="padding:8px 10px;border:1px solid #ddd;text-align:right">Total</td>
        <td style="padding:8px 10px;border:1px solid #ddd;text-align:center;font-weight:700">${totalQty}</td>
        <td style="border:1px solid #ddd" colspan="2"></td>
        <td style="padding:8px 10px;border:1px solid #ddd;text-align:left;font-weight:700">₹${totalValue.toFixed(2)}</td>
      </tr></tfoot>
    </table>
    ${grn.remarks ? `<div style="margin-top:14px;padding:8px 12px;background:#fefce8;border:1px solid #fde68a;border-radius:6px"><strong>Remarks:</strong> ${grn.remarks}</div>` : ''}
    </body></html>`;

    const win = window.open('', '_blank', 'width=1100,height=750');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 700); }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // BATCH SCAN FLOW
  // ═══════════════════════════════════════════════════════════════════════════════
  sessionScanned        = signal<ScannedEntry[]>([]);
  private sessionBarcodeSet = new Set<string>();
  batchReview           = signal<BatchReviewState>(EMPTY_BATCH_REVIEW);
  hasSessionScans       = computed(() => this.sessionScanned().length > 0);
  reviewGroupCount      = computed(() => this.batchReview().groups.length);

  private sortSizeKeys(keys: string[]): string[] {
    return [...keys].sort((a, b) => {
      const sa = a.split('|')[0], sb = b.split('|')[0];
      const ia = SIZE_ORDER.indexOf(sa), ib = SIZE_ORDER.indexOf(sb);
      if (ia !== -1 && ib !== -1) { if (ia !== ib) return ia - ib; return a.localeCompare(b); }
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
        const sizeQtys: Record<string,string> = {};
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
        const sizeQtys: Record<string,string> = {};
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
        const already       = g.selectedSizes.includes(sizeName);
        const selectedSizes = already ? g.selectedSizes.filter(s => s !== sizeName) : [...g.selectedSizes, sizeName];
        const sizeQtys      = { ...g.sizeQtys };
        if (already) { delete sizeQtys[sizeName]; } else if (!sizeQtys[sizeName]) { sizeQtys[sizeName] = '1'; }
        return { ...g, selectedSizes, sizeQtys };
      });
      return { ...state, groups };
    });
  }

  selectAllReviewSizes(groupIdx: number) {
    this.batchReview.update(state => {
      const groups = state.groups.map((g, i) => {
        if (i !== groupIdx) return g;
        const sizeQtys = { ...g.sizeQtys };
        g.availableSizes.forEach(s => { if (!sizeQtys[s]) sizeQtys[s] = '1'; });
        return { ...g, selectedSizes: [...g.availableSizes], sizeQtys };
      });
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

  incrementSizeQty(groupIdx: number, sizeName: string, current: string) {
    const next = (parseInt(current, 10) || 0) + 1;
    this.updateReviewSizeQty(groupIdx, sizeName, String(next));
  }

  decrementSizeQty(groupIdx: number, sizeName: string, current: string) {
    const next = Math.max(1, (parseInt(current, 10) || 1) - 1);
    this.updateReviewSizeQty(groupIdx, sizeName, String(next));
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
          }
        }
      }
    }
    this.closeBatchReview();
    if (skipped > 0)
      Swal.fire({ icon: 'info', title: 'Done', text: `${added} item(s) added. ${skipped} duplicate barcode(s) skipped.`, timer: 2500, showConfirmButton: false });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // BARCODE SCANNER — v4  (Worker-offloaded · BD-first · zero-alloc hot path)
  // ═══════════════════════════════════════════════════════════════════════════════
  isScanning     = signal(false);
  scanFeedback   = signal<'idle' | 'success' | 'error' | 'duplicate'>('idle');
  scannerMessage = signal('Point camera at a barcode');
  scanCount      = signal(0);
  scansPerMin    = signal(0);
  isZoomAvailable = signal(false);
  zoomLevel       = signal(1);
  isTorchAvailable = signal(false);
  isTorchOn        = signal(false);

  private stream:       MediaStream | null = null;
  private animFrameId:  number | null     = null;
  private lastScanTime  = 0;
  private lastTickTime  = 0;

  // Tuning knobs
  private readonly TICK_INTERVAL = 10;   // 100 fps budget
  private readonly SCAN_DEBOUNCE = 120;  // ms — fast accept
  private readonly DUPE_SUPPRESS = 900;  // ms — same-barcode re-alert
  private readonly BD_SKIP_MS   = 400;  // ms — skip jsQR while BD is hot
  private readonly PRIMARY_SIZE  = 512;  // px — primary crop size

  // Offscreen canvases
  private cropCanvas:  HTMLCanvasElement | null = null;
  private fullCanvas:  HTMLCanvasElement | null = null;
  private dedupCanvas: HTMLCanvasElement | null = null;

  // BarcodeDetector
  private barcodeDetector: any = null;
  private detectorBusy = false;
  private bdLastSuccess = 0;

  // Web Worker
  private scanWorker:       Worker | null = null;
  private workerBusy        = false;
  private workerUrl:        string | null = null;
  private pendingWorkerId   = 0;

  // Frame dedup
  private lastFrameHash = 0;

  // Barcode map cache
  private barcodeMapCache:   Map<string, { design: Design; size: SizePrice }> | null = null;
  private barcodeMapVersion  = 0;

  // Torch / Zoom
  private torchTrack:  MediaStreamTrack | null = null;
  private torchEnabled = false;
  private zoomTrack:   MediaStreamTrack | null = null;
  private minZoom = 1;
  private maxZoom = 8;

  // Metrics
  private scanSessionStart = 0;
  private metricsInterval: any = null;

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

  // Creates a Blob-based Web Worker that runs jsQR off the main thread
  private createWorker(): Worker | null {
    try {
      const src = `
importScripts('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
self.onmessage = function(e) {
  const { id, buf, w, h } = e.data;
  const rgba = new Uint8ClampedArray(buf);
  // Pass 1: raw
  let r = jsQR(rgba, w, h, { inversionAttempts: 'attemptBoth' });
  if (r) { self.postMessage({ id, v: r.data }); return; }
  // Pass 2: in-place contrast boost (integer math — no allocation)
  for (let i = 0; i < rgba.length; i += 4) {
    let rv = ((rgba[i]   - 128) * 1.8 + 148) | 0;
    let gv = ((rgba[i+1] - 128) * 1.8 + 148) | 0;
    let bv = ((rgba[i+2] - 128) * 1.8 + 148) | 0;
    rgba[i]   = rv < 0 ? 0 : rv > 255 ? 255 : rv;
    rgba[i+1] = gv < 0 ? 0 : gv > 255 ? 255 : gv;
    rgba[i+2] = bv < 0 ? 0 : bv > 255 ? 255 : bv;
  }
  r = jsQR(rgba, w, h, { inversionAttempts: 'attemptBoth' });
  if (r) { self.postMessage({ id, v: r.data }); return; }
  // Pass 3: BT.601 grayscale binarize (integer — no floats)
  for (let i = 0; i < rgba.length; i += 4) {
    const g = (rgba[i] * 77 + rgba[i+1] * 150 + rgba[i+2] * 29) >> 8;
    rgba[i] = rgba[i+1] = rgba[i+2] = g;
  }
  r = jsQR(rgba, w, h, { inversionAttempts: 'attemptBoth' });
  self.postMessage({ id, v: r ? r.data : null });
};`;
      const blob = new Blob([src], { type: 'text/javascript' });
      this.workerUrl  = URL.createObjectURL(blob);
      const w         = new Worker(this.workerUrl);
      w.onmessage     = (e) => {
        this.workerBusy = false;
        if (e.data.v && e.data.id === this.pendingWorkerId)
          this.handleScanResult(e.data.v);
      };
      w.onerror = () => { this.workerBusy = false; };
      return w;
    } catch { return null; }
  }

  async startScan() {
    this.isScanning.set(true);
    this.scanFeedback.set('idle');
    this.scannerMessage.set('Point camera at a barcode');
    this.scanCount.set(0);
    this.scansPerMin.set(0);
    this.scanSessionStart = Date.now();
    this.bdLastSuccess    = 0;

    // Allocate canvases once
    this.cropCanvas        = document.createElement('canvas');
    this.cropCanvas.width  = this.cropCanvas.height = this.PRIMARY_SIZE;
    this.fullCanvas        = document.createElement('canvas');
    this.dedupCanvas       = document.createElement('canvas');
    this.dedupCanvas.width = this.dedupCanvas.height = 16;

    // Create Worker
    this.scanWorker = this.createWorker();

    // Init BarcodeDetector with widest supported format list
    if ('BarcodeDetector' in window) {
      try {
        const supported: string[] = await (window as any).BarcodeDetector.getSupportedFormats?.() ??
          ['qr_code','code_128','code_39','ean_13','ean_8','data_matrix'];
        const want    = ['qr_code','code_128','code_39','ean_13','ean_8','data_matrix','itf','upc_a','upc_e'];
        const formats = want.filter((f: string) => supported.includes(f));
        this.barcodeDetector = new (window as any).BarcodeDetector({ formats: formats.length ? formats : want });
      } catch { this.barcodeDetector = null; }
    }

    this.getBarcodeMap(); // pre-warm lookup cache

    // Live metrics every 3s
    this.metricsInterval = setInterval(() => {
      const elapsed = (Date.now() - this.scanSessionStart) / 60000;
      this.scansPerMin.set(elapsed > 0 ? Math.round(this.scanCount() / elapsed) : 0);
    }, 3000);

    setTimeout(async () => {
      if (!this.videoElement || !navigator.mediaDevices?.getUserMedia) {
        Swal.fire({ icon: 'error', title: 'Error', text: 'Camera not supported on this device.' });
        this.isScanning.set(false); return;
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width:  { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720  }
          }
        });
        const video    = this.videoElement.nativeElement;
        video.srcObject = this.stream;
        await video.play();

        const track   = this.stream.getVideoTracks()[0];
        this.torchTrack = track;
        this.zoomTrack  = track;
        const caps: any = track.getCapabilities?.() ?? {};

        this.isTorchAvailable.set(!!caps.torch);

        if (caps.zoom) {
          this.isZoomAvailable.set(true);
          this.minZoom = caps.zoom.min ?? 1;
          this.maxZoom = Math.min(caps.zoom.max ?? 8, 8);
          this.zoomLevel.set(this.minZoom);
        }

        // Apply focus/exposure + framerate in one call
        const adv: any = {};
        if (caps.focusMode?.includes('continuous'))        adv.focusMode        = 'continuous';
        if (caps.exposureMode?.includes('continuous'))     adv.exposureMode     = 'continuous';
        if (caps.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode = 'continuous';
        await track.applyConstraints({
          frameRate: { ideal: 60, min: 30 },
          ...(Object.keys(adv).length ? { advanced: [adv] } : {})
        } as any).catch(() => {});

        this.tick();
      } catch {
        Swal.fire({ icon: 'error', title: 'Camera Error', text: 'Cannot access camera. Please allow camera permission.' });
        this.isScanning.set(false);
      }
    }, 50);
  }

  stopScan() {
    if (this.animFrameId)     { cancelAnimationFrame(this.animFrameId); this.animFrameId = null; }
    if (this.metricsInterval) { clearInterval(this.metricsInterval); this.metricsInterval = null; }
    if (this.torchEnabled && this.torchTrack)
      this.torchTrack.applyConstraints({ advanced: [{ torch: false } as any] }).catch(() => {});
    this.stream?.getTracks().forEach(t => t.stop());
    if (this.scanWorker) { this.scanWorker.terminate(); this.scanWorker = null; }
    if (this.workerUrl)  { URL.revokeObjectURL(this.workerUrl); this.workerUrl = null; }
    this.stream          = null;
    this.cropCanvas      = null;
    this.fullCanvas      = null;
    this.dedupCanvas     = null;
    this.torchTrack      = null;
    this.zoomTrack       = null;
    this.torchEnabled    = false;
    this.barcodeDetector = null;
    this.detectorBusy    = false;
    this.workerBusy      = false;
    this.lastFrameHash   = 0;
    this.bdLastSuccess   = 0;
    this.isScanning.set(false);
    this.isTorchOn.set(false);
    this.isTorchAvailable.set(false);
    this.isZoomAvailable.set(false);
    this.zoomLevel.set(1);
    this.scanCount.set(0);
    this.scansPerMin.set(0);
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

  async setZoom(level: number) {
    if (!this.zoomTrack || !this.isZoomAvailable()) return;
    const v = Math.max(this.minZoom, Math.min(this.maxZoom, level));
    await this.zoomTrack.applyConstraints({ advanced: [{ zoom: v } as any] }).catch(() => {});
    this.zoomLevel.set(v);
  }
  zoomIn()  { this.setZoom(Math.min(this.zoomLevel() + 0.5, this.maxZoom)); }
  zoomOut() { this.setZoom(Math.max(this.zoomLevel() - 0.5, this.minZoom)); }

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

    // ── 1. Native BarcodeDetector (GPU path — ~1ms, fires every tick) ─────────
    if (this.barcodeDetector && !this.detectorBusy) {
      this.detectorBusy = true;
      this.barcodeDetector.detect(video)
        .then((codes: any[]) => {
          this.detectorBusy = false;
          if (codes.length > 0) {
            this.bdLastSuccess = Date.now();
            this.handleScanResult(codes[0].rawValue);
          }
        })
        .catch(() => { this.detectorBusy = false; });
    }

    // ── 2. Skip jsQR while BarcodeDetector is actively succeeding ─────────────
    if (now - this.bdLastSuccess < this.BD_SKIP_MS) return;

    // ── 3. Frame dedup — skip identical frames ────────────────────────────────
    if (this.isFrameDuplicate(video, vw, vh)) return;

    // ── 4. Worker-based jsQR (non-blocking — zero main-thread cost) ───────────
    if (!this.workerBusy) {
      this.dispatchToWorker(video, vw, vh);
    } else {
      // Worker still busy — run one cheap sync pass as backup
      this.fastSyncPass(video, vw, vh);
    }
  }

  // Sends a 70% center crop to the Worker via zero-copy Transferable
  private dispatchToWorker(video: HTMLVideoElement, vw: number, vh: number) {
    if (!this.scanWorker || !this.cropCanvas) return;
    const S   = this.PRIMARY_SIZE;
    const ctx = this.cropCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, vw * 0.15, vh * 0.15, vw * 0.70, vh * 0.70, 0, 0, S, S);
    const img = ctx.getImageData(0, 0, S, S);
    const buf = img.data.buffer.slice(0); // slice = owned copy we can transfer
    this.workerBusy      = true;
    this.pendingWorkerId = Date.now();
    this.scanWorker.postMessage({ id: this.pendingWorkerId, buf, w: S, h: S }, [buf]);
  }

  // One cheap sync pass when Worker is occupied
  private fastSyncPass(video: HTMLVideoElement, vw: number, vh: number) {
    if (!this.cropCanvas) return;
    const S   = this.PRIMARY_SIZE;
    const ctx = this.cropCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, vw * 0.15, vh * 0.15, vw * 0.70, vh * 0.70, 0, 0, S, S);
    const img = ctx.getImageData(0, 0, S, S);
    const r   = jsQR(img.data, S, S, { inversionAttempts: 'dontInvert' }); // fastest flag
    if (r?.data) this.handleScanResult(r.data);
  }

  private isFrameDuplicate(video: HTMLVideoElement, vw: number, vh: number): boolean {
    if (!this.dedupCanvas) return false;
    const dct = this.dedupCanvas.getContext('2d', { willReadFrequently: true })!;
    dct.drawImage(video, vw * 0.25, vh * 0.25, vw * 0.5, vh * 0.5, 0, 0, 16, 16);
    const d = dct.getImageData(0, 0, 16, 16).data;
    let hash = 5381;
    for (let i = 0; i < d.length; i += 8) hash = ((hash * 33) ^ d[i]) >>> 0;
    if (hash === this.lastFrameHash) return true;
    this.lastFrameHash = hash;
    return false;
  }

  private handleScanResult(barcode: string) {
    const now = Date.now();
    if (now - this.lastScanTime < this.SCAN_DEBOUNCE) return;
    const bc = barcode.trim();
    if (!bc) return;

    if (this.sessionBarcodeSet.has(bc)) {
      if (now - this.lastScanTime < this.DUPE_SUPPRESS) return;
      this.lastScanTime = now;
      this.scanFeedback.set('duplicate');
      this.scannerMessage.set('↩ Already scanned');
      try { navigator.vibrate?.([30]); } catch {}
      setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Point camera at a barcode'); }, 800);
      return;
    }

    const found = this.getBarcodeMap().get(bc);
    if (!found) {
      this.lastScanTime = now;
      this.scanFeedback.set('error');
      this.scannerMessage.set(`✗ Not found: ${bc}`);
      try { navigator.vibrate?.([40, 30, 40]); } catch {}
      setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Point camera at a barcode'); }, 1100);
      return;
    }

    this.lastScanTime = now;
    this.sessionBarcodeSet.add(bc);
    this.sessionScanned.update(list => [
      ...list, { barcode: bc, styleNo: found.design.styleNo, resolvedAt: now }
    ]);
    this.scanCount.update(n => n + 1);
    this.scanFeedback.set('success');
    this.scannerMessage.set(`✓ ${found.design.styleNo} — ${found.size.size}${found.size.sleeveType ? ' · ' + found.size.sleeveType : ''}`);
    try { navigator.vibrate?.([60]); } catch {}
    setTimeout(() => { this.scanFeedback.set('idle'); this.scannerMessage.set('Point camera at a barcode'); }, 700);
  }
}