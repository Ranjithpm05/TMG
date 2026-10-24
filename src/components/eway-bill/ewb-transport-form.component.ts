import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { EwayBillTransportDetails } from '../../models/invoice.model';
import { EWAY_BILL_TRANSPORT_MODES, EWAY_BILL_VEHICLE_TYPES } from '../../models/eway-bill.model';
import { Transport } from '../../models/transport.model';

// E-Way Bill transport details fields — shared by the E-Way Bill screen's
// Generate modal and the E-Invoice screen's combined "Generate E-Invoice &
// E-Way Bill" modal so both always collect exactly the same data.
@Component({
  selector: 'app-ewb-transport-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1.5">Transport Mode <span class="text-rose-500">*</span></label>
          <select [value]="form().transMode" [disabled]="disabled()"
            (change)="update('transMode', $any($any($event.target).value))"
            class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
            @for (m of transportModes; track m.code) {
              <option [value]="m.code">{{ m.label }}</option>
            }
          </select>
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1.5">Distance (km)</label>
          <input type="number" min="0" [value]="form().distance" [disabled]="disabled()"
            (input)="update('distance', +$any($event.target).value)"
            class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
        </div>
      </div>

      <div>
        <label class="block text-xs font-semibold text-slate-500 mb-1.5">Destination (from Client Master)</label>
        <input type="text" [value]="form().destination || ''" [disabled]="disabled()"
          (input)="update('destination', $any($event.target).value)"
          class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
      </div>

      <div>
        <label class="block text-xs font-semibold text-slate-500 mb-1.5">Transporter (from Transport Master)</label>
        <select [value]="selectedTransportId()" [disabled]="disabled()"
          (change)="onTransportSelected($any($event.target).value)"
          class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
          <option value="">— Enter manually below —</option>
          @for (t of transports(); track t.id) {
            <option [value]="t.id">{{ t.transportName }}</option>
          }
        </select>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1.5">Transporter ID / GSTIN</label>
          <input type="text" [value]="form().transporterId || ''" [disabled]="disabled()"
            (input)="update('transporterId', $any($event.target).value)"
            placeholder="e.g. 05AAACN1283H1ZQ"
            class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400">
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1.5">Transporter Name</label>
          <input type="text" [value]="form().transporterName || ''" [disabled]="disabled()"
            (input)="update('transporterName', $any($event.target).value)"
            class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
        </div>
      </div>
      <p class="text-[11px] text-slate-400 -mt-2">Selecting a transporter fills the fields above from Transport Master; you can still edit them for a one-off transporter.</p>

      @if (form().transMode === '1') {
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1.5">Vehicle No.</label>
          <input type="text" [value]="form().vehicleNo || ''" [disabled]="disabled()"
            (input)="update('vehicleNo', $any($event.target).value.toUpperCase())"
            placeholder="e.g. TN37AB1234"
            class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-indigo-400">
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1.5">Vehicle Type</label>
          <select [value]="form().vehicleType" [disabled]="disabled()"
            (change)="update('vehicleType', $any($any($event.target).value))"
            class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
            @for (v of vehicleTypes; track v.code) {
              <option [value]="v.code">{{ v.label }}</option>
            }
          </select>
        </div>
      </div>
      }
    </div>
  `,
})
export class EwbTransportFormComponent {
  form = model.required<EwayBillTransportDetails>();
  // Which Transport Master record (if any) is backing transporterId/Name —
  // '' means the user is entering/overriding those fields manually.
  selectedTransportId = model<string>('');
  transports = input<Transport[]>([]);
  disabled = input(false);

  readonly transportModes = EWAY_BILL_TRANSPORT_MODES;
  readonly vehicleTypes = EWAY_BILL_VEHICLE_TYPES;

  update<K extends keyof EwayBillTransportDetails>(field: K, value: EwayBillTransportDetails[K]): void {
    this.form.update((f) => ({ ...f, [field]: value }));
  }

  // Selecting a Transport Master record fills transporterId/transporterName
  // from it (gstNo doubles as the GSTIN/TRANSIN Webtel's TransId expects);
  // selecting "— Enter manually —" (empty value) leaves whatever is already
  // typed untouched rather than clearing it.
  onTransportSelected(transportId: string): void {
    this.selectedTransportId.set(transportId);
    if (!transportId) return;
    const transport = this.transports().find((t) => t.id === transportId);
    if (!transport) return;
    this.form.update((f) => ({
      ...f,
      transporterId: transport.gstNo || '',
      transporterName: transport.transportName,
    }));
  }
}
