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
