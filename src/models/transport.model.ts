export interface Transport {
  id?: string;

  transportName: string;
  transportAddress?: string;
  gstNo?: string;

  status: 'Active' | 'Inactive';

  createdAt?: any;
  updatedAt?: any;
}
