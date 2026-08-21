import { EwayBillTransportDetails } from './invoice.model';

export type { EwayBillTransportDetails };

export type EwayBillStatus = 'pending' | 'generated' | 'failed' | 'cancelled';

// Appendix-4 (E-Way Bill sandbox doc): Mode of transportation.
export const EWAY_BILL_TRANSPORT_MODES: { code: '1' | '2' | '3' | '4'; label: string }[] = [
  { code: '1', label: 'Road' },
  { code: '2', label: 'Rail' },
  { code: '3', label: 'Air' },
  { code: '4', label: 'Ship' },
];

export const EWAY_BILL_VEHICLE_TYPES: { code: 'R' | 'O'; label: string }[] = [
  { code: 'R', label: 'Regular' },
  { code: 'O', label: 'Over Dimensional Cargo (ODC)' },
];

// Appendix-7 (E-Way Bill sandbox doc): Cancel EWAYBILL reason codes.
export const EWAY_BILL_CANCEL_REASONS: { code: string; label: string }[] = [
  { code: '1', label: 'Duplicate' },
  { code: '2', label: 'Order Cancelled' },
  { code: '3', label: 'Data Entry Mistake' },
  { code: '4', label: 'Others' },
];

export interface EwayBillGenerateResult {
  ewbNo: string;
  ewbDate: string;
  ewbValidTill: string;
}
