import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import Swal from 'sweetalert2';

import { ReportsDataService } from '../reports-data.service';
import { LoadingService } from '../../../services/loading.service';
import { exportRowsToExcel, exportRowsToPdf, printReportRows } from '../report-export.util';
import type { OrderItem } from '../../../models/sales-order.model';

const REPORT_TITLE = 'Style No. & Customer Wise Sales Order Details';

// Matches the SIZE_ORDER convention used in pick-list/packing-list/goods-inward
// components — known apparel sizes sort by garment-size order, anything else
// (e.g. numeric waist sizes) falls back to a natural string compare.
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL', '6XL', 'Free Size'];

// One row per Design No. + Color combination — the leaf of the pivot report.
interface StyleColorRow {
  color: string;
  sleeveType: string;
  qtyBySize: Record<string, number>;
  totalQty: number;
  wsp: number;
  value: number;
}

interface StyleGroup {
  styleNo: string;
  fabricDescription: string;
  rows: StyleColorRow[];
  totalQty: number;
  value: number;
}

interface CustomerStyleGroup {
  clientName: string;
  styles: StyleGroup[];
  totalQty: number;
  value: number;
}

interface StyleCustomerWiseReport {
  sizes: string[];
  customers: CustomerStyleGroup[];
  grandTotal: { totalQty: number; value: number };
}

// Intermediate accumulator while scanning order items.
interface StyleAccumulatorEntry {
  fabricDescription: string;
  colors: Map<string, { color: string; sleeveType: string; qtyBySize: Map<string, number>; value: number }>;
}

@Component({
  selector: 'app-style-customer-wise-report',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './style-customer-wise-report.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StyleCustomerWiseReportComponent {
  private readonly data = inject(ReportsDataService);
  protected readonly loadingService = inject(LoadingService);

  protected readonly report = computed<StyleCustomerWiseReport>(() => this.buildStyleCustomerWiseReport());

  protected filterSummary(): string {
    return this.data.filterSummary();
  }

  async exportExcel(): Promise<void> {
    const rows = this.buildExportRows();
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to export for the current filters.' });
      return;
    }

    await this.loadingService.run(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await exportRowsToExcel(rows, REPORT_TITLE);
    });
  }

  async exportPdf(): Promise<void> {
    const rows = this.buildExportRows();
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to export for the current filters.' });
      return;
    }

    await this.loadingService.run(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await exportRowsToPdf(rows, REPORT_TITLE, this.data.filterSummary());
    });
  }

  async printReport(): Promise<void> {
    const rows = this.buildExportRows();
    if (rows.length <= 1) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There is no data to print for the current filters.' });
      return;
    }

    await this.loadingService.run(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      printReportRows(rows, REPORT_TITLE, this.data.filterSummary());
    });
  }

  private buildExportRows(): any[][] {
    const report = this.report();
    const header = ['#', 'Customer Name', 'Fabric Description', 'Design No', 'Color', 'Sleeve Type', ...report.sizes, 'Total Qty', 'WSP', 'Value'];
    const blankSizes = report.sizes.map(() => '');
    const body: any[][] = [];
    let counter = 0;

    for (const customer of report.customers) {
      for (const style of customer.styles) {
        for (const row of style.rows) {
          counter += 1;
          body.push([
            counter, customer.clientName, style.fabricDescription, style.styleNo, row.color, row.sleeveType,
            ...report.sizes.map((s) => row.qtyBySize[s] ?? 0),
            row.totalQty, this.round2(row.wsp), this.round2(row.value),
          ]);
        }
      }
      body.push(['', `Customer Total: ${customer.clientName}`, '', '', '', '', ...blankSizes, customer.totalQty, '', this.round2(customer.value)]);
    }

    body.push(['', 'Grand Total', '', '', '', '', ...blankSizes, report.grandTotal.totalQty, '', this.round2(report.grandTotal.value)]);
    return [header, ...body];
  }

  private buildStyleCustomerWiseReport(): StyleCustomerWiseReport {
    const clientById = this.data.clientById();
    const customerMap = new Map<string, Map<string, StyleAccumulatorEntry>>();
    const sizeSet = new Set<string>();

    for (const order of this.data.filteredOrders()) {
      const clientName = this.data.toText(clientById.get(order.clientId)?.clientName) || 'Unknown Client';
      let styleMap = customerMap.get(clientName);
      if (!styleMap) { styleMap = new Map(); customerMap.set(clientName, styleMap); }

      for (const item of order.items ?? []) {
        this.accumulateOrderItem(item, styleMap, sizeSet);
      }
    }

    const sizes = this.sortSizes([...sizeSet]);
    const customers: CustomerStyleGroup[] = [...customerMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([clientName, styleMap]) => {
        const styles = this.buildStyleGroups(styleMap, sizes);
        return {
          clientName,
          styles,
          totalQty: styles.reduce((s, st) => s + st.totalQty, 0),
          value: styles.reduce((s, st) => s + st.value, 0),
        };
      });

    const grandTotal = {
      totalQty: customers.reduce((s, c) => s + c.totalQty, 0),
      value: customers.reduce((s, c) => s + c.value, 0),
    };

    return { sizes, customers, grandTotal };
  }

  /** Folds one order item's per-size quantities into the styleNo -> color accumulator. */
  private accumulateOrderItem(item: OrderItem, styleMap: Map<string, StyleAccumulatorEntry>, sizeSet: Set<string>): void {
    if (!this.data.matchesItemFilters(item)) return;
    const styleNo = this.data.toText(item.design?.styleNo) || 'Unknown';
    const color = this.data.toText(item.design?.color) || 'Unspecified';
    const sleeveType = this.data.toText(item.sleeveType) || '-';
    // Same convention as the Sales Order "Enter Quantities by Fabric Description" grouping.
    const fabricDescription = this.data.toText(item.design?.sizes?.[0]?.fabricType) || 'Uncategorized';

    let style = styleMap.get(styleNo);
    if (!style) { style = { fabricDescription, colors: new Map() }; styleMap.set(styleNo, style); }
    const colorKey = `${color}||${sleeveType}`;
    let colorEntry = style.colors.get(colorKey);
    if (!colorEntry) { colorEntry = { color, sleeveType, qtyBySize: new Map(), value: 0 }; style.colors.set(colorKey, colorEntry); }

    for (const size of item.itemSizes ?? []) {
      const qty = Number(size.quantity) || 0;
      if (qty <= 0) continue;
      const sizeLabel = this.data.toText(size.size);
      sizeSet.add(sizeLabel);
      colorEntry.qtyBySize.set(sizeLabel, (colorEntry.qtyBySize.get(sizeLabel) ?? 0) + qty);
      colorEntry.value += qty * (Number(size.WSP) || 0);
    }
  }

  private buildStyleGroups(styleMap: Map<string, StyleAccumulatorEntry>, sizes: string[]): StyleGroup[] {
    return [...styleMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([styleNo, style]) => {
        const rows: StyleColorRow[] = [...style.colors.values()]
          .sort((a, b) => a.color.localeCompare(b.color) || a.sleeveType.localeCompare(b.sleeveType))
          .map((entry) => {
            const qtyBySize = Object.fromEntries(entry.qtyBySize);
            const totalQty = sizes.reduce((s, size) => s + (qtyBySize[size] ?? 0), 0);
            const value = this.round2(entry.value);
            const wsp = totalQty > 0 ? this.round2(entry.value / totalQty) : 0;
            return { color: entry.color, sleeveType: entry.sleeveType, qtyBySize, totalQty, wsp, value };
          });
        return {
          styleNo,
          fabricDescription: style.fabricDescription,
          rows,
          totalQty: rows.reduce((s, r) => s + r.totalQty, 0),
          value: rows.reduce((s, r) => s + r.value, 0),
        };
      });
  }

  private sortSizes(sizes: string[]): string[] {
    return [...sizes].sort((a, b) => {
      const aIndex = SIZE_ORDER.indexOf(a);
      const bIndex = SIZE_ORDER.indexOf(b);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
