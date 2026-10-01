import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InventoryItem } from '../../models/inventory.model';
import { InventoryService } from '../../services/inventory.service';
import { LoadingService } from '../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows, type ExportMeta, type ExportRowOpts } from '../reports/report-export.util';
import Swal from 'sweetalert2';

const EXPORT_TITLE = 'Inventory';
const EXPORT_HEADERS = ['Style No', 'Color', 'Sleeve', 'Size', 'Barcode', 'Received', 'Stock', 'WSP', 'Stock Value', 'Last GRN'];
const EXPORT_ROW_OPTS: ExportRowOpts = { isGrandTotalRow: (row) => row[0] === 'Grand Total' };

@Component({
  selector: 'app-inventory',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './inventory.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InventoryComponent implements OnInit {
  private inventoryService = inject(InventoryService);
  private loadingService = inject(LoadingService);

  inventory   = signal<InventoryItem[]>([]);
  isLoading = signal(true);
  searchTerm  = signal('');
  currentPage = signal(1);
  itemsPerPage = signal(20);

  filteredInventory = computed(() => {
    const term = this.searchTerm().toLowerCase();
    const items = this.inventory();
    if (!term) return items;
    return items.filter(i =>
      i.styleNo.toLowerCase().includes(term) ||
      i.color.toLowerCase().includes(term) ||
      i.barcode.toLowerCase().includes(term) ||
      i.size.toLowerCase().includes(term)
    );
  });

  totalPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredInventory().length / this.itemsPerPage()))
  );

  paginatedInventory = computed(() => {
    const start = (this.currentPage() - 1) * this.itemsPerPage();
    return this.filteredInventory().slice(start, start + this.itemsPerPage());
  });

  totalStock = computed(() =>
    this.filteredInventory().reduce((s, i) => s + (Number(i.currentStock) || 0), 0)
  );

  totalValue = computed(() =>
    this.filteredInventory().reduce((s, i) => s + ((Number(i.currentStock) || 0) * (Number(i.WSP) || 0)), 0)
  );

    ngOnInit() {
    this.isLoading.set(true);
        this.inventoryService.getInventory().subscribe({
            next:  items => { this.inventory.set(items); this.isLoading.set(false); },
            error: ()    => { this.isLoading.set(false); }
        });
    }

  onSearch(term: string) { this.searchTerm.set(term); this.currentPage.set(1); }
  changePage(p: number)  { if (p >= 1 && p <= this.totalPages()) this.currentPage.set(p); }

  // Exports cover every row matching the current search, not just the visible page.
  async exportExcel(): Promise<void> {
    await this.runExport((rows) => exportRowsToExcel(rows, EXPORT_TITLE, this.filterSummary(), this.exportMeta()));
  }

  async exportPdf(): Promise<void> {
    await this.runExport((rows) => exportRowsToPdf(rows, EXPORT_TITLE, this.filterSummary(), EXPORT_ROW_OPTS, this.exportMeta()));
  }

  async printInventory(): Promise<void> {
    await this.runExport((rows) => printReportRows(rows, EXPORT_TITLE, this.filterSummary(), EXPORT_ROW_OPTS, this.exportMeta()));
  }

  private async runExport(fn: (rows: any[][]) => void | Promise<void>): Promise<void> {
    if (this.filteredInventory().length === 0) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There are no inventory items to export.' });
      return;
    }
    const rows = this.buildExportRows();
    await this.loadingService.run(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await fn(rows);
    });
  }

  private buildExportRows(): any[][] {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const body = this.filteredInventory().map(i => {
      const stock = Number(i.currentStock) || 0;
      const wsp = Number(i.WSP) || 0;
      return [
        i.styleNo ?? '', i.color ?? '', i.sleeveType ?? '', i.size ?? '', i.barcode ?? '',
        Number(i.totalReceived) || 0, stock, round2(wsp), round2(stock * wsp), i.lastGrnNo || '',
      ];
    });
    const totalReceived = this.filteredInventory().reduce((s, i) => s + (Number(i.totalReceived) || 0), 0);
    const totalRow = ['Grand Total', '', '', '', '', totalReceived, this.totalStock(), '', round2(this.totalValue()), ''];
    return [EXPORT_HEADERS, ...body, totalRow];
  }

  private filterSummary(): string {
    const term = this.searchTerm().trim();
    return term ? `Search: "${term}"` : 'All items';
  }

  private exportMeta(): ExportMeta {
    return {
      generatedAt: new Date(),
      summary: {
        'Items': this.filteredInventory().length,
        'Total Stock': this.totalStock(),
        'Stock Value (WSP)': this.totalValue().toFixed(2),
      },
    };
  }
}