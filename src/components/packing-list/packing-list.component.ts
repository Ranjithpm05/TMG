import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import Swal from 'sweetalert2';
import { PickList, PickListLine } from '../../models/pick-list.model';
import { PackingCarton, PackingList, PackingListLine } from '../../models/packing-list.model';
import { PickListService } from '../../services/pick-list.service';
import { PackingListService } from '../../services/packing-list.service';

type ViewMode = 'list' | 'view' | 'live-pack';

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL', '6XL', 'Free Size'];

@Component({
  selector: 'app-packing-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './packing-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PackingListComponent implements OnInit, OnDestroy {
  private pickListService = inject(PickListService);
  private packingListService = inject(PackingListService);
  private subscriptions: Subscription[] = [];

  mode = signal<ViewMode>('list');
  listTab = signal<'ready' | 'packing'>('ready');
  searchTerm = signal('');

  pickLists = signal<PickList[]>([]);
  packingLists = signal<PackingList[]>([]);

  viewPackingList = signal<PackingList | null>(null);
  viewLines = signal<PackingListLine[]>([]);
  livePackingList = signal<PackingList | null>(null);
  liveLines = signal<PackingListLine[]>([]);

  isLoading = signal(true);
  isSubmitting = signal(false);
  packFeedback = signal<'idle' | 'success' | 'error'>('idle');
  scannerMessage = signal('Scan carton box no to begin packing.');

  cartonInput = signal('');
  activeCartonNo = signal('');
  barcodeInput = signal('');
  scanQty = signal(1);

  completedPickLists = computed(() =>
    this.pickLists().filter((pickList) =>
      pickList.status === 'Completed' && (pickList.totalPickedQty ?? 0) > 0
    )
  );

  filteredReadyPickLists = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    return this.completedPickLists().filter((pickList) => {
      if (!term) return true;
      return pickList.pickListNo.toLowerCase().includes(term)
        || (pickList.salesNos ?? []).some((salesNo) => salesNo.toLowerCase().includes(term))
        || pickList.clientName.toLowerCase().includes(term);
    });
  });

  filteredPackingLists = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    return this.packingLists().filter((packingList) => {
      if (!term) return true;
      return packingList.packingListNo.toLowerCase().includes(term)
        || packingList.pickListNo.toLowerCase().includes(term)
        || (packingList.salesNos ?? []).some((salesNo) => salesNo.toLowerCase().includes(term))
        || packingList.clientName.toLowerCase().includes(term);
    });
  });

  activeCarton = computed(() => {
    const cartonNo = this.activeCartonNo().trim().toLowerCase();
    if (!cartonNo) return null;
    return this.livePackingList()?.cartons.find((carton) => carton.cartonNo.toLowerCase() === cartonNo) ?? null;
  });

  liveTotals = computed(() => {
    const packingList = this.livePackingList();
    return {
      totalRequiredQty: packingList?.totalRequiredQty ?? 0,
      totalPackedQty: packingList?.totalPackedQty ?? 0,
      lineCount: packingList?.lineCount ?? 0,
      completedLineCount: packingList?.completedLineCount ?? 0,
      cartonCount: packingList?.cartonCount ?? 0,
      partCount: packingList?.partSummaries?.length ?? 0,
    };
  });

  ngOnInit() {
    this.isLoading.set(true);
    let doneCount = 0;
    const done = () => {
      doneCount += 1;
      if (doneCount >= 2) {
        this.isLoading.set(false);
      }
    };

    this.subscriptions.push(
      this.pickListService.getPickLists().subscribe({
        next: (pickLists) => {
          this.pickLists.set(pickLists);
          done();
        },
        error: done,
      })
    );

    this.subscriptions.push(
      this.packingListService.getPackingLists().subscribe({
        next: (packingLists) => {
          this.packingLists.set(packingLists);

          const currentView = this.viewPackingList();
          if (currentView?.id) {
            const freshView = packingLists.find((packingList) => packingList.id === currentView.id);
            if (freshView) {
              this.viewPackingList.set(freshView);
            }
          }

          const currentLive = this.livePackingList();
          if (currentLive?.id) {
            const freshLive = packingLists.find((packingList) => packingList.id === currentLive.id);
            if (freshLive) {
              this.livePackingList.set(freshLive);
            }
          }

          done();
        },
        error: done,
      })
    );
  }

  ngOnDestroy() {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }

  formatDate(raw: any): string {
    if (!raw) return '-';
    try {
      const date = raw?.toDate ? raw.toDate() : new Date(raw);
      return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
      return '-';
    }
  }

  formatDateTime(raw: any): string {
    if (!raw) return '-';
    try {
      const date = raw?.toDate ? raw.toDate() : new Date(raw);
      return date.toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '-';
    }
  }

  getPackingForPickList(pickListId: string): PackingList | null {
    return this.packingLists().find((packingList) => packingList.pickListId === pickListId) ?? null;
  }

  getPartCountFromPickList(pickList: PickList): number {
    const parts = new Set(
      (pickList.items ?? [])
        .map((line) => String(line.group ?? '').trim() || 'General')
        .filter(Boolean)
    );
    return parts.size;
  }

  packingStatusBadge(status: PackingList['status'] | PickList['status']): string {
    if (status === 'Completed') return 'bg-green-100 text-green-800';
    if (status === 'Partial') return 'bg-yellow-100 text-yellow-800';
    if (status === 'Pending') return 'bg-orange-100 text-orange-700';
    return 'bg-gray-100 text-gray-600';
  }

  lineStatusBadge(line: PackingListLine): string {
    return ({
      ready: 'bg-indigo-100 text-indigo-800',
      in_progress: 'bg-blue-100 text-blue-800',
      completed: 'bg-green-100 text-green-800',
    } as Record<PackingListLine['status'], string>)[line.status];
  }

  lineStatusLabel(line: PackingListLine): string {
    return ({
      ready: 'Ready',
      in_progress: 'In Progress',
      completed: 'Completed',
    } as Record<PackingListLine['status'], string>)[line.status];
  }

  getCartonEntryCount(carton: PackingCarton): number {
    return carton.entries.length;
  }

  async generateFromPickList(pickList: PickList) {
    if (!pickList.id) return;

    const existingPackingList = await this.packingListService.getPackingListByPickListIdOnce(pickList.id);
    if (existingPackingList) {
      const result = await Swal.fire({
        icon: 'info',
        title: 'Packing List Already Generated',
        text: `${existingPackingList.packingListNo} already exists for ${pickList.pickListNo}.`,
        showCancelButton: true,
        confirmButtonText: existingPackingList.status === 'Completed' ? 'View Packing List' : 'Start Packing',
        cancelButtonText: 'Close',
        confirmButtonColor: existingPackingList.status === 'Completed' ? '#4f46e5' : '#16a34a',
      });
      if (result.isConfirmed) {
        if (existingPackingList.status === 'Completed') {
          await this.openView(existingPackingList);
        } else {
          await this.startPacking(existingPackingList);
        }
      }
      return;
    }

    await this.pickListService.ensureLegacyPickListLines(pickList);
    const lines = await this.pickListService.getPickListLinesOnce(pickList.id);
    const packableLines = lines.filter((line) => (line.pickedQty || 0) > 0 && !!line.barcode);

    if (!packableLines.length) {
      await Swal.fire({
        icon: 'warning',
        title: 'No Packable Items',
        text: 'This completed Pick List does not have any scanned barcode items to pack.',
      });
      return;
    }

    const totalQty = packableLines.reduce((sum, line) => sum + (line.pickedQty || 0), 0);
    const partCount = new Set(packableLines.map((line) => String(line.group ?? '').trim() || 'General')).size;
    const result = await Swal.fire({
      icon: 'question',
      title: 'Generate Packing List?',
      html: `<div style="text-align:left;font-size:13px"><p><strong>Pick List:</strong> ${pickList.pickListNo}</p><p><strong>Orders:</strong> ${(pickList.salesNos ?? []).join(', ')}</p><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px"><div style="background:#ecfeff;border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:#0f766e;font-weight:700;text-transform:uppercase">Part-wise Lines</div><div style="font-size:24px;font-weight:700;color:#0f766e">${packableLines.length}</div></div><div style="background:#eef2ff;border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:#4338ca;font-weight:700;text-transform:uppercase">Picked Qty</div><div style="font-size:24px;font-weight:700;color:#4338ca">${totalQty}</div></div><div style="background:#f0fdf4;border-radius:10px;padding:10px;text-align:center"><div style="font-size:11px;color:#15803d;font-weight:700;text-transform:uppercase">Parts</div><div style="font-size:24px;font-weight:700;color:#15803d">${partCount}</div></div></div><p style="margin-top:10px;color:#64748b">Packing will start after scanning a carton box number, then scanning item barcodes or entering a quantity.</p></div>`,
      showCancelButton: true,
      confirmButtonText: 'Generate Packing List',
      confirmButtonColor: '#0f766e',
    });

    if (!result.isConfirmed) return;

    try {
      const packingListId = await this.packingListService.createGeneratedPackingList({
        packingListNo: `PK-${Date.now()}`,
        pickListId: pickList.id,
        pickListNo: pickList.pickListNo,
        salesOrderIds: pickList.salesOrderIds ?? [],
        salesNos: pickList.salesNos ?? [],
        clientId: pickList.clientId,
        clientName: pickList.clientName,
        lines: packableLines,
      });

      const createdPackingList = await this.packingListService.getPackingListByIdOnce(packingListId);
      if (!createdPackingList) {
        await Swal.fire({
          icon: 'success',
          title: 'Packing List Generated',
          text: 'The Packing List was created successfully.',
          timer: 2200,
          showConfirmButton: false,
        });
        return;
      }

      this.listTab.set('packing');
      const nextStep = await Swal.fire({
        icon: 'success',
        title: 'Packing List Generated',
        text: 'You can start carton packing now or review the Packing List first.',
        showCancelButton: true,
        confirmButtonText: 'Start Packing Now',
        cancelButtonText: 'Review Packing List',
        confirmButtonColor: '#16a34a',
        cancelButtonColor: '#64748b',
      });

      if (nextStep.isConfirmed) {
        await this.startPacking(createdPackingList);
        return;
      }

      await this.openView(createdPackingList);
    } catch (error: any) {
      const message = error?.message === 'no_packable_lines'
        ? 'Packing List was not created because there are no packed barcode items available.'
        : error?.message ?? 'Unable to generate the Packing List.';
      await Swal.fire({ icon: 'error', title: 'Generation Failed', text: message });
    }
  }

  async openView(packingList: PackingList) {
    if (!packingList.id) return;
    const [freshPackingList, lines] = await Promise.all([
      this.packingListService.getPackingListByIdOnce(packingList.id),
      this.packingListService.getPackingListLinesOnce(packingList.id),
    ]);
    this.viewPackingList.set(freshPackingList ?? packingList);
    this.viewLines.set(lines);
    this.mode.set('view');
  }

  async startPacking(packingList: PackingList) {
    if (!packingList.id) return;
    const [freshPackingList, lines] = await Promise.all([
      this.packingListService.getPackingListByIdOnce(packingList.id),
      this.packingListService.getPackingListLinesOnce(packingList.id),
    ]);

    this.livePackingList.set(freshPackingList ?? packingList);
    this.liveLines.set(lines);
    this.mode.set('live-pack');
    this.packFeedback.set('idle');
    this.barcodeInput.set('');
    this.scanQty.set(1);
    this.cartonInput.set('');
    this.activeCartonNo.set('');
    this.scannerMessage.set('Scan carton box no to begin packing.');
  }

  cancel() {
    this.mode.set('list');
    this.viewPackingList.set(null);
    this.viewLines.set([]);
    this.livePackingList.set(null);
    this.liveLines.set([]);
    this.barcodeInput.set('');
    this.scanQty.set(1);
    this.cartonInput.set('');
    this.activeCartonNo.set('');
    this.packFeedback.set('idle');
    this.scannerMessage.set('Scan carton box no to begin packing.');
  }

  activateCarton() {
    const cartonNo = this.cartonInput().trim();
    if (!cartonNo) {
      this.flashPackFeedback('error', 'Scan or enter a carton box number first.');
      return;
    }

    const existingCarton = this.livePackingList()?.cartons.find((carton) => carton.cartonNo.toLowerCase() === cartonNo.toLowerCase());
    this.activeCartonNo.set(existingCarton?.cartonNo ?? cartonNo);
    this.cartonInput.set(existingCarton?.cartonNo ?? cartonNo);
    this.flashPackFeedback(
      'success',
      existingCarton
        ? `Continuing carton ${existingCarton.cartonNo}. Scan an item barcode next.`
        : `Carton ${cartonNo} is ready. Scan an item barcode next.`
    );
  }

  setActiveCarton(cartonNo: string) {
    this.activeCartonNo.set(cartonNo);
    this.cartonInput.set(cartonNo);
    this.flashPackFeedback('success', `Carton ${cartonNo} is active. Scan an item barcode next.`);
  }

  onScanQtyChange(value: any) {
    const qty = Math.max(1, Math.floor(Number(value) || 1));
    this.scanQty.set(qty);
  }

  async submitPackingScan() {
    const packingList = this.livePackingList();
    if (!packingList?.id) return;

    const cartonNo = this.activeCartonNo().trim() || this.cartonInput().trim();
    const barcode = this.barcodeInput().trim();
    const qty = Math.max(1, Math.floor(Number(this.scanQty()) || 1));

    if (!cartonNo) {
      this.flashPackFeedback('error', 'Scan carton box no before scanning items.');
      return;
    }
    if (!barcode) {
      this.flashPackFeedback('error', 'Scan or enter an item barcode.');
      return;
    }

    this.isSubmitting.set(true);
    try {
      const result = await this.packingListService.processScan(packingList.id, cartonNo, barcode, qty);

      this.activeCartonNo.set(result.carton.cartonNo);
      this.cartonInput.set(result.carton.cartonNo);
      this.barcodeInput.set('');
      this.scanQty.set(1);

      this.liveLines.update((lines) =>
        lines
          .map((line) => (line.lineId === result.line.lineId ? result.line : line))
          .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
      );

      this.livePackingList.update((current) => {
        if (!current) return current;
        return {
          ...current,
          totalPackedQty: result.totalPackedQty,
          completedLineCount: result.completedLineCount,
          cartonCount: result.cartonCount,
          status: result.status,
          partSummaries: result.partSummaries,
          cartons: this.mergeCarton(current.cartons ?? [], result.carton),
          items: this.liveLines().map((line) => (line.lineId === result.line.lineId ? result.line : line)),
        };
      });

      this.flashPackFeedback('success', `${qty} pc packed into carton ${result.carton.cartonNo}.`);

      if (result.packingListCompleted) {
        await Swal.fire({
          icon: 'success',
          title: 'Packing Completed',
          text: 'All items in this Packing List have been packed.',
          timer: 2200,
          showConfirmButton: false,
        });
      }
    } catch (error: any) {
      const message = this.mapPackError(error?.message ?? '');
      this.flashPackFeedback('error', message);
      await this.showToast('error', 'Packing Failed', message);
    } finally {
      this.isSubmitting.set(false);
    }
  }

  async printPackingList(packingList: PackingList) {
    if (!packingList.id) return;

    const [freshPackingList, lines] = await Promise.all([
      this.packingListService.getPackingListByIdOnce(packingList.id),
      this.packingListService.getPackingListLinesOnce(packingList.id),
    ]);

    const resolvedPackingList = freshPackingList ?? packingList;
    const html = this.buildPrintHtml(resolvedPackingList, lines);
    const win = window.open('', '_blank', 'width=1100,height=780');
    if (win) {
      win.document.write(html);
      win.document.close();
      setTimeout(() => win.print(), 600);
    }
  }

  private mergeCarton(cartons: PackingCarton[], updatedCarton: PackingCarton): PackingCarton[] {
    const index = cartons.findIndex((carton) => carton.cartonNo.toLowerCase() === updatedCarton.cartonNo.toLowerCase());
    if (index === -1) {
      return [...cartons, updatedCarton];
    }

    const next = [...cartons];
    next[index] = updatedCarton;
    return next;
  }

  private flashPackFeedback(type: 'success' | 'error', message: string) {
    this.packFeedback.set(type);
    this.scannerMessage.set(message);
    setTimeout(() => {
      this.packFeedback.set('idle');
      if (this.activeCartonNo()) {
        this.scannerMessage.set(`Carton ${this.activeCartonNo()} is active. Scan an item barcode next.`);
      } else {
        this.scannerMessage.set('Scan carton box no to begin packing.');
      }
    }, 1000);
  }

  private mapPackError(code: string): string {
    switch (code) {
      case 'carton_required':
        return 'Scan carton box no first.';
      case 'qty_invalid':
        return 'Enter a valid quantity.';
      case 'barcode_not_found':
        return 'Barcode not found in this Packing List.';
      case 'qty_exceeds_remaining':
        return 'Entered quantity is more than the remaining packing quantity.';
      case 'line_completed':
        return 'This item is already fully packed.';
      default:
        return 'Unable to complete packing scan. Please try again.';
    }
  }

  private async showToast(icon: 'success' | 'error' | 'info' | 'warning', title: string, text?: string) {
    await Swal.fire({
      toast: true,
      position: 'top-end',
      icon,
      title,
      text,
      timer: 1800,
      showConfirmButton: false,
      timerProgressBar: true,
    });
  }

  private buildPrintHtml(packingList: PackingList, lines: PackingListLine[]): string {
    const rankSize = (size: string) => {
      const index = SIZE_ORDER.indexOf(size);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };

    const printLines = [...lines]
      .map((line) => ({
        ...line,
        salesText: (line.salesNos ?? []).join(', '),
      }))
      .sort((left, right) => {
        const partCompare = left.partName.localeCompare(right.partName, undefined, { numeric: true });
        if (partCompare !== 0) return partCompare;
        const styleCompare = left.styleNo.localeCompare(right.styleNo, undefined, { numeric: true });
        if (styleCompare !== 0) return styleCompare;
        const colorCompare = left.color.localeCompare(right.color, undefined, { numeric: true });
        if (colorCompare !== 0) return colorCompare;
        const sizeCompare = rankSize(left.size) - rankSize(right.size);
        if (sizeCompare !== 0) return sizeCompare;
        return (left.sleeveType ?? '').localeCompare(right.sleeveType ?? '', undefined, { numeric: true });
      });

    const summary = {
      lineCount: printLines.length,
      totalRequiredQty: printLines.reduce((sum, line) => sum + line.requiredQty, 0),
      totalPackedQty: printLines.reduce((sum, line) => sum + line.packedQty, 0),
      totalRemainingQty: printLines.reduce((sum, line) => sum + line.remainingQty, 0),
      cartonCount: packingList.cartons.length,
    };

    const lineRows = printLines.map((line, index) => `
      <tr style="background:${index % 2 === 0 ? '#ffffff' : '#f8fafc'}">
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;color:#64748b">${index + 1}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;font-weight:700;color:#0f172a">${line.partName}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;font-weight:700;color:#0f172a">${line.styleNo}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;color:#475569">${line.color || '-'}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;color:#334155">${line.size}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;color:#475569">${line.sleeveType || '-'}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;font-family:'Courier New',monospace;font-size:10px;color:#334155">${line.barcode || '-'}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;color:#475569">${line.salesText || '-'}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:#4338ca">${line.requiredQty}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:#15803d">${line.packedQty}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:${line.remainingQty > 0 ? '#d97706' : '#94a3b8'}">${line.remainingQty}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;color:#475569">${line.lastCartonNo || '-'}</td>
      </tr>
    `).join('');

    const cartonRows = packingList.cartons.map((carton, index) => `
      <tr style="background:${index % 2 === 0 ? '#ffffff' : '#f8fafc'}">
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;color:#64748b">${index + 1}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;font-weight:700;color:#0f172a">${carton.cartonNo}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;color:#334155">${carton.entries.length}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;text-align:center;font-weight:700;color:#15803d">${carton.totalQty}</td>
        <td style="padding:8px 10px;border:1px solid #d7deea;color:#475569">${carton.entries.map((entry) => `${entry.styleNo}/${entry.size} x ${entry.qty}`).join(', ') || '-'}</td>
      </tr>
    `).join('');

    const statusStyle = packingList.status === 'Completed'
      ? { bg: '#d1fae5', fg: '#047857' }
      : packingList.status === 'Partial'
        ? { bg: '#fef3c7', fg: '#b45309' }
        : { bg: '#e5e7eb', fg: '#4b5563' };

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${packingList.packingListNo}</title>
          <style>
            body { font-family: Arial, sans-serif; font-size: 12px; margin: 18px; color: #0f172a; }
            h1, p { margin: 0; }
            .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 12px; }
            .meta { margin-top: 4px; color: #64748b; font-size: 11px; line-height: 1.5; }
            .badge { display: inline-block; margin-top: 8px; margin-right: 6px; padding: 4px 10px; border-radius: 999px; font-size: 10px; font-weight: 700; }
            .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 14px 0 10px; }
            .box { border: 1px solid #d7deea; background: #f8fafc; border-radius: 10px; padding: 10px 12px; }
            .label { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.04em; }
            .value { margin-top: 5px; font-size: 20px; font-weight: 700; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            .section-title { margin-top: 18px; font-size: 14px; font-weight: 700; color: #0f172a; }
            .signatures { display: flex; justify-content: space-between; gap: 24px; margin-top: 28px; }
            .signatures div { flex: 1; border-top: 1px solid #334155; padding-top: 6px; text-align: center; color: #475569; font-size: 11px; }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <h1 style="font-size:24px">${packingList.packingListNo}</h1>
              <p class="meta">Pick List: ${packingList.pickListNo}</p>
              <p class="meta">Orders: ${(packingList.salesNos ?? []).join(', ')}</p>
              <p class="meta">Client: ${packingList.clientName}</p>
              <span class="badge" style="background:${statusStyle.bg};color:${statusStyle.fg}">${packingList.status}</span>
            </div>
            <div style="text-align:right">
              <div style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase">Printed At</div>
              <div style="margin-top:4px;font-size:12px;color:#0f172a">${new Date().toLocaleString('en-IN')}</div>
            </div>
          </div>

          <div class="summary">
            <div class="box"><div class="label">Lines</div><div class="value">${summary.lineCount}</div></div>
            <div class="box"><div class="label">To Pack Qty</div><div class="value" style="color:#4338ca">${summary.totalRequiredQty}</div></div>
            <div class="box"><div class="label">Packed Qty</div><div class="value" style="color:#15803d">${summary.totalPackedQty}</div></div>
            <div class="box"><div class="label">Remaining Qty</div><div class="value" style="color:${summary.totalRemainingQty > 0 ? '#d97706' : '#94a3b8'}">${summary.totalRemainingQty}</div></div>
            <div class="box"><div class="label">Cartons</div><div class="value">${summary.cartonCount}</div></div>
          </div>

          <div class="section-title">Part-wise Packing Lines</div>
          <table>
            <thead>
              <tr>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">#</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Part</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Style No</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Color</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Size</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Sleeve</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Barcode</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Orders</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">To Pack</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Packed</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Remaining</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Last Carton</th>
              </tr>
            </thead>
            <tbody>${lineRows}</tbody>
          </table>

          <div class="section-title">Carton Summary</div>
          <table>
            <thead>
              <tr>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">#</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Carton No</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Lines</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Packed Qty</th>
                <th style="padding:9px 10px;border:1px solid #d7deea;background:#0f172a;color:#ffffff;font-size:10px;font-weight:700">Contents</th>
              </tr>
            </thead>
            <tbody>${cartonRows || '<tr><td colspan="5" style="padding:12px;border:1px solid #d7deea;text-align:center;color:#94a3b8">No cartons packed yet.</td></tr>'}</tbody>
          </table>

          <div class="signatures">
            <div>Prepared By</div>
            <div>Packed By</div>
            <div>Checked By</div>
          </div>
        </body>
      </html>
    `;
  }
}
