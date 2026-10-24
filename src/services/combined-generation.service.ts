import { Injectable, inject } from '@angular/core';
import { Invoice, EwayBillTransportDetails } from '../models/invoice.model';
import { CompanySettings } from '../models/einvoice.model';
import { InvoiceService } from './invoice.service';
import { EInvoiceService } from './einvoice.service';
import { EwayBillService } from './eway-bill.service';
import { CombinedGenerationRunner, CombinedOutcome, CombinedStatus } from './einvoice-ewb.engine';

// Single-click E-Invoice → E-Way Bill generation. Sequencing, validation,
// resume-after-partial-success and the in-flight guard live in
// einvoice-ewb.engine.ts; each step is the exact workflow its own screen uses
// (EInvoiceService.generateAndSave / EwayBillService.generateForInvoice), so
// API payloads, Firestore writes and status fields are identical either way.
@Injectable({ providedIn: 'root' })
export class CombinedGenerationService {
  private invoiceService = inject(InvoiceService);
  private einvoiceService = inject(EInvoiceService);
  private ewayBillService = inject(EwayBillService);
  // Root-scoped so the guard survives the E-Invoice screen being destroyed
  // and recreated while a run is still in flight.
  private runner = new CombinedGenerationRunner();

  isRunning(invoiceId: string): boolean {
    return this.runner.isRunning(invoiceId);
  }

  run(
    invoiceId: string,
    settings: CompanySettings,
    transport: EwayBillTransportDetails,
    onProgress?: (status: CombinedStatus) => void
  ): Promise<CombinedOutcome<Invoice>> {
    // Validated and sent in the same normalized form.
    transport = {
      ...transport,
      transporterId: (transport.transporterId || '').trim().toUpperCase(),
      transporterName: (transport.transporterName || '').trim(),
      vehicleNo: transport.transMode === '1' ? (transport.vehicleNo || '').trim().toUpperCase() : '',
    };
    return this.runner.run(invoiceId, {
      transport,
      loadLatest: async () => {
        const latest = await this.invoiceService.getInvoiceByIdOnce(invoiceId);
        if (!latest) throw new Error('This invoice no longer exists.');
        return latest;
      },
      generateEInvoice: (invoice) => this.einvoiceService.generateAndSave(invoice, settings),
      generateEwayBill: (invoice) => this.ewayBillService.generateForInvoice(invoice, transport, settings),
      onProgress,
    });
  }
}
