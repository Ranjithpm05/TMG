import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/** Shared summary-card strip (Total Order/Dispatched/Extra/Pending) shown atop every report tab, fed by that tab's own grand total. */
@Component({
  selector: 'app-report-summary-cards',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './report-summary-cards.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportSummaryCardsComponent {
  readonly orderQty = input.required<number>();
  readonly dispatchedQty = input.required<number>();
  readonly extraQty = input.required<number>();
  readonly pendingQty = input.required<number>();
  /** Pick List Wise only — shows a 5th card for Total Picked Qty. */
  readonly pickedQty = input<number | null>(null);
}
