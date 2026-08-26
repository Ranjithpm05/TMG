import { Component, ChangeDetectionStrategy, input, output, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

/** Shared pagination control (page-size select + Prev/Next) used by every report table so large date ranges don't render thousands of rows at once. */
@Component({
  selector: 'app-report-pagination',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './report-pagination.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportPaginationComponent {
  readonly total = input.required<number>();
  readonly page = input.required<number>();
  readonly pageSize = input.required<number>();
  readonly pageSizeOptions = input<number[]>([25, 50, 100]);

  readonly pageChange = output<number>();
  readonly pageSizeChange = output<number>();

  protected readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  protected readonly rangeStart = computed(() => (this.total() === 0 ? 0 : (this.page() - 1) * this.pageSize() + 1));
  protected readonly rangeEnd = computed(() => Math.min(this.total(), this.page() * this.pageSize()));

  protected onPageSizeChange(value: string): void {
    this.pageSizeChange.emit(Number(value) || 25);
  }

  protected goPrev(): void {
    if (this.page() > 1) this.pageChange.emit(this.page() - 1);
  }

  protected goNext(): void {
    if (this.page() < this.totalPages()) this.pageChange.emit(this.page() + 1);
  }
}
