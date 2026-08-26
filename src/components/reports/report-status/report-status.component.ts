import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Scoped (non-blocking) loading/error state for one report's table area.
 * Deliberately NOT the app-wide LoadingService modal — filters and tab
 * navigation must stay usable while a report's own data is still fetching.
 * Renders nothing when neither loading nor error is set; the parent gates
 * its real table with the same two flags.
 */
@Component({
  selector: 'app-report-status',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './report-status.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportStatusComponent {
  readonly loading = input<boolean>(false);
  readonly error = input<string | null>(null);
  readonly label = input<string>('Report');
  readonly retry = output<void>();
}
