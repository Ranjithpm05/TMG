import { Component, ChangeDetectionStrategy, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ReportsDataService } from './reports-data.service';
import { CustomerWiseReportComponent } from './customer-wise-report/customer-wise-report.component';
import { AgentWiseReportComponent } from './agent-wise-report/agent-wise-report.component';
import { ProductWiseReportComponent } from './product-wise-report/product-wise-report.component';
import { ExceedOrderReportComponent } from './exceed-order-report/exceed-order-report.component';
import { StyleWiseReportComponent } from './style-wise-report/style-wise-report.component';
import { StyleCustomerWiseReportComponent } from './style-customer-wise-report/style-customer-wise-report.component';
import { PickListReportComponent } from './pick-list-report/pick-list-report.component';

export type ReportTab = 'customer' | 'agent' | 'product' | 'exceed' | 'styleWise' | 'styleCustomerWise' | 'pickList';

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CustomerWiseReportComponent,
    AgentWiseReportComponent,
    ProductWiseReportComponent,
    ExceedOrderReportComponent,
    StyleWiseReportComponent,
    StyleCustomerWiseReportComponent,
    PickListReportComponent,
  ],
  providers: [ReportsDataService],
  templateUrl: './reports.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportsComponent {
  protected readonly data = inject(ReportsDataService);

  // Tab switching is shell-only UI state — not shared report data, so it
  // stays local rather than living on ReportsDataService.
  readonly activeReport = signal<ReportTab>('customer');

  setTab(tab: ReportTab): void {
    this.activeReport.set(tab);
  }
}
