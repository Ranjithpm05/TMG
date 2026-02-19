export interface Client {
  id?: string;

  clientName: string;
  clientShortName?: string;
  clientCode?: string;

  clientType: 'Direct' | 'Agent';
  agentName?: string;

  billingAddress?: string;
  zipCode?: string;
  place?: string;
  state?: string;
  country?: string;

  gstNo?: string;
  mobile?: string;
  contactPerson?: string;

  status: 'Active' | 'Inactive';

  createdAt?: any;
  updatedAt?: any;
}
