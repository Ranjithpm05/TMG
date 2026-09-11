import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ReportsDataService } from '../reports-data.service';

/**
 * The same date/customer/agent/product/status filter bar every report screen
 * uses — factored out so each standalone report screen (each with its own
 * top-level nav entry) renders an identical filter bar without duplicating
 * the markup. Reads/writes whichever ReportsDataService instance is nearest
 * in the injector tree, so each screen's own `providers: [ReportsDataService,
 * ...]` still gives it its own independent filter state.
 */
@Component({
  selector: 'app-report-filter-bar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './report-filter-bar.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportFilterBarComponent {
  protected readonly data = inject(ReportsDataService);
}
