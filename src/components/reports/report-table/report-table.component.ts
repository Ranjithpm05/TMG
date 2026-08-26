import { Component, ChangeDetectionStrategy, input, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';

import type { AggregatedRow, QtyTotals } from '../report-calc.service';
import { ReportPaginationComponent } from '../report-pagination/report-pagination.component';

/**
 * Shared expandable Order/Dispatched/Extra/Pending table used by Customer
 * Wise, Agent Wise and Product Wise Reports — the three tabs whose row shape
 * is identical (one label column [+ optional secondary/count columns] plus
 * the 4 qty columns, with optional recursive drill-down via
 * AggregatedRow.children). Style No. Wise / Style No. & Customer Wise keep
 * their own bespoke pivot-by-size templates instead of this component.
 */
@Component({
  selector: 'app-report-table',
  standalone: true,
  imports: [CommonModule, ReportPaginationComponent],
  templateUrl: './report-table.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportTableComponent {
  readonly rows = input.required<AggregatedRow[]>();
  readonly grandTotal = input.required<QtyTotals>();
  readonly labelHeader = input<string>('Name');
  readonly secondaryHeader = input<string | null>(null);
  readonly secondaryFn = input<((row: AggregatedRow) => string) | null>(null);
  /** e.g. Agent Wise's "Customer Count" column, sourced from row.children.length. */
  readonly countHeader = input<string | null>(null);
  readonly countFn = input<((row: AggregatedRow) => number) | null>(null);
  /** Trailing right-aligned column for a value not carried on AggregatedRow itself (e.g. Product Wise's Order Value). */
  readonly valueHeader = input<string | null>(null);
  readonly valueFn = input<((row: AggregatedRow) => number) | null>(null);
  readonly valueGrandTotal = input<number | null>(null);
  readonly expandable = input<boolean>(true);
  readonly emptyMessage = input<string>('No data matches the current filters.');

  private readonly expandedPaths = signal<Set<string>>(new Set());

  // Pagination applies to the top-level rows only — an expanded row's
  // children are always shown in full (not separately paginated), keeping
  // drill-down behavior simple while still capping how many top-level rows
  // render at once for a wide date range.
  protected readonly pageSize = signal(25);
  protected readonly currentPage = signal(1);

  protected readonly totalPages = computed(() => Math.max(1, Math.ceil(this.rows().length / this.pageSize())));

  protected readonly pagedRows = computed(() => {
    const size = this.pageSize();
    const page = Math.min(this.currentPage(), this.totalPages());
    const start = (page - 1) * size;
    return this.rows().slice(start, start + size);
  });

  protected readonly startIndex = computed(() => (Math.min(this.currentPage(), this.totalPages()) - 1) * this.pageSize());

  // Reset to page 1 whenever the underlying row set changes (new filters) so
  // a stale page number never renders an empty table.
  private readonly resetPageOnRowsChange = effect(() => {
    this.rows();
    this.currentPage.set(1);
  });

  protected setPage(page: number): void {
    this.currentPage.set(page);
  }

  protected setPageSize(size: number): void {
    this.pageSize.set(size);
    this.currentPage.set(1);
  }

  protected isExpanded(path: string): boolean {
    return this.expandedPaths().has(path);
  }

  protected toggle(path: string): void {
    const next = new Set(this.expandedPaths());
    if (next.has(path)) next.delete(path); else next.add(path);
    this.expandedPaths.set(next);
  }

  protected hasChildren(row: AggregatedRow): boolean {
    return this.expandable() && !!row.children?.length;
  }

  protected columnCount(): number {
    return 2 + (this.secondaryHeader() ? 1 : 0) + (this.countHeader() ? 1 : 0) + (this.valueHeader() ? 1 : 0) + 4;
  }
}
