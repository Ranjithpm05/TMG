export interface Client {
  id?: string;

  clientName: string;
  clientShortName?: string;
  clientCode?: string;

  clientType: 'Direct' | 'Agent';
  agentName?: string;

  // Bill To Address — used for Invoices.
  billingAddress?: string;
  zipCode?: string;
  place?: string;
  state?: string;
  country?: string;

  // Ship To Address — used for DCs, Box Labels, and other shipping documents.
  shipToAddress?: string;
  shipToZipCode?: string;
  shipToPlace?: string;
  shipToState?: string;
  shipToCountry?: string;
  shipToSameAsBilling?: boolean;

  // Distance (KM) from our dispatch point to this client — pre-filled as the
  // E-Way Bill Distance. 0 lets the portal calculate it from the PIN codes.
  distanceKm?: number;

  gstNo?: string;
  mobile?: string;
  contactPerson?: string;

  // Margin% reduces MRP to get the selling price (Sales Order, DC, Invoice).
  // Discount% applies only in the Invoice, after Margin.
  marginPct?: number;
  discountPct?: number;

  status: 'Active' | 'Inactive';

  createdAt?: any;
  updatedAt?: any;
}
