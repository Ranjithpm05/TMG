import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Client } from '../../models/client.model';
import { ClientService } from '../../services/client.service';
import Swal from 'sweetalert2';

const EXCEL_HEADERS = ['ClientName', 'ClientShortName', 'ClientType', 'AgentName', 'BillingAddress', 'ZipCode', 'Place', 'State', 'Country', 'ShipToAddress', 'ShipToZipCode', 'ShipToPlace', 'ShipToState', 'ShipToCountry', 'GSTNo', 'Mobile', 'ContactPerson', 'MarginPct', 'DiscountPct', 'Status'];
const REQUIRED_HEADERS = ['ClientName', 'ClientType'];
const EXPORT_HEADERS = ['ID', 'ClientName', 'ClientShortName', 'ClientCode', 'ClientType', 'AgentName', 'BillingAddress', 'ZipCode', 'Place', 'State', 'Country', 'ShipToAddress', 'ShipToZipCode', 'ShipToPlace', 'ShipToState', 'ShipToCountry', 'GSTNo', 'Mobile', 'ContactPerson', 'MarginPct', 'DiscountPct', 'Status', 'CreatedAt', 'UpdatedAt'];

type ViewMode = 'list' | 'form';

const EMPTY_CLIENT: Omit<Client, 'id' | 'clientCode'> = {
  clientName: '',
  clientShortName: '',
  clientType: 'Direct',
  billingAddress: '',
  zipCode: '',
  country: '',
  state: '',
  place: '',
  shipToAddress: '',
  shipToZipCode: '',
  shipToCountry: '',
  shipToState: '',
  shipToPlace: '',
  shipToSameAsBilling: true,
  gstNo: '',
  mobile: '',
  contactPerson: '',
  marginPct: 0,
  discountPct: 0,
  status: 'Active',
};

@Component({
  selector: 'app-client-master',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './client-master.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClientMasterComponent implements OnInit {
  private clientService = inject(ClientService);

  clients = signal<Client[]>([]);
  mode = signal<ViewMode>('list');
  
  editableClient = signal<Client | Omit<Client, 'id' | 'clientCode'>>(EMPTY_CLIENT);
  isEditMode = computed(() => 'id' in this.editableClient());
  
  
  // --- Pagination and Filtering State ---
  searchTerm = signal('');
  currentPage = signal(1);
  itemsPerPage = signal(10);
  
  filteredClients = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    if (!term) {
      return this.clients();
    }
    return this.clients().filter(client =>
      this.safeLower(client.clientName).includes(term) ||
      this.safeLower(client.clientCode).includes(term) ||
      this.safeLower(client.clientShortName).includes(term) ||
      this.safeLower(client.contactPerson).includes(term) ||
      this.safeLower(client.agentName).includes(term) ||
      this.safeLower(client.mobile).includes(term) ||
      this.safeLower(client.gstNo).includes(term) ||
      this.safeLower(client.place).includes(term) ||
      this.safeLower(client.state).includes(term)
    );
  });

  private safeLower(value: any): string {
    return (value ?? '').toString().toLowerCase();
  }

  totalPages = computed(() => Math.ceil(this.filteredClients().length / this.itemsPerPage()));

  paginatedClients = computed(() => {
    const startIndex = (this.currentPage() - 1) * this.itemsPerPage();
    return this.filteredClients().slice(startIndex, startIndex + this.itemsPerPage());
  });

  constructor() {
    // Clamps currentPage back into range after filtering shrinks the result
    // set — moved out of paginatedClients() since writing to a signal from
    // inside a computed() that also reads it is a memoization-defeating
    // anti-pattern (and unsupported by Angular's computed() contract).
    effect(() => {
      const startIndex = (this.currentPage() - 1) * this.itemsPerPage();
      if (startIndex >= this.filteredClients().length && this.currentPage() > 1) {
        this.currentPage.set(this.totalPages() || 1);
      }
    });
  }

  ngOnInit() {
    this.loadClients();
  }

  loadClients() {
    //  this.clientService.getClients().subscribe(data => this.clients.set(data));
    this.clientService.getClients().subscribe(data => {
        this.clients.set(data);
    });
  }

  showAddForm() {
    this.editableClient.set(JSON.parse(JSON.stringify(EMPTY_CLIENT)));
    this.mode.set('form');
  }

  showEditForm(client: Client) {
    this.editableClient.set({ ...client }); // Create a copy to avoid mutating the original object in the list
    this.mode.set('form');
  }

  async saveClient() {
    let clientData = this.editableClient();
    if (clientData.shipToSameAsBilling) {
      clientData = {
        ...clientData,
        shipToAddress: clientData.billingAddress,
        shipToZipCode: clientData.zipCode,
        shipToPlace: clientData.place,
        shipToState: clientData.state,
        shipToCountry: clientData.country,
      };
    }
    try
    {
        Swal.fire({
            title: this.isEditMode() ? 'Updating client...' : 'Creating client...',
            allowOutsideClick: false,
            didOpen: () => Swal.showLoading()
        });

        if ('id' in clientData) {
            await this.clientService.updateClient(clientData);
            await Swal.fire({
                icon: 'success',
                title: 'Updated!',
                text: 'Client updated successfully',
                timer: 2000,
                showConfirmButton: false
            });
            this.loadClients();
            this.switchToListView()
        } 
        else {
            await this.clientService.createClient(clientData)

            await Swal.fire({
                icon: 'success',
                title: 'Created!',
                text: 'Client created successfully',
                timer: 2000,
                showConfirmButton: false
            });

            this.loadClients();
            this.switchToListView()
          
        }
    }
    catch (error) {
        Swal.fire({
        icon: 'error',
        title: 'Error',
        text: error.message
        });
    }
  }

    async deleteClient(client: Client) 
    {
        const result = await Swal.fire({
            title: 'Are you sure?',
            text: `Delete client "${client.clientName}"?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#dc2626',
            cancelButtonColor: '#6b7280',
            confirmButtonText: 'Yes, delete it',
            cancelButtonText: 'Cancel'
        });

        if (!result.isConfirmed) return;

        try {
            Swal.fire({
                title: 'Deleting...',
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            });

            await this.clientService.deleteClient(client.id);

            await Swal.fire({
                icon: 'success',
                title: 'Deleted!',
                text: 'Client deleted successfully',
                timer: 2000,
                showConfirmButton: false
            });
            this.loadClients()
            // After deletion, if the current page becomes empty, go to the previous page.
            if (this.paginatedClients().length === 0 && this.currentPage() > 1) {
                this.currentPage.update(p => p - 1);
            }
        } catch (error) {
            console.error(error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to delete client'
            });
        }
    }

  cancel() {
    this.switchToListView();
  }
  
  private switchToListView() {
    this.editableClient.set(EMPTY_CLIENT);
    this.mode.set('list');
  }

  // --- Excel Import / Export ---

  async downloadSampleExcel() {
    try {
      const XLSX = await import('xlsx');
      const rows = [
        EXCEL_HEADERS,
        ['Acme Garments', 'Acme', 'Direct', '', '123 Market Street', '400001', 'Mumbai', 'Maharashtra', 'India', '123 Market Street', '400001', 'Mumbai', 'Maharashtra', 'India', '27AAAAA0000A1Z5', '9876543210', 'John Doe', '10', '5', 'Active'],
        ['Best Traders', 'Best', 'Agent', 'Agent Rahul', '45 MG Road', '560001', 'Bengaluru', 'Karnataka', 'India', '78 Warehouse Lane', '560002', 'Bengaluru', 'Karnataka', 'India', '29BBBBB1111B1Z6', '9123456780', 'Jane Smith', '12', '0', 'Active'],
      ];
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = EXCEL_HEADERS.map(() => ({ wch: 18 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Clients');
      XLSX.writeFile(wb, 'Client_Import_Template.xlsx');
    } catch {
      Swal.fire({ icon: 'error', title: 'Download Failed', text: 'Could not generate sample file.' });
    }
  }

  async exportClientsToExcel() {
    const clients = this.clients();
    if (clients.length === 0) {
      Swal.fire({ icon: 'info', title: 'No Data', text: 'There are no clients to export.' });
      return;
    }

    try {
      const XLSX = await import('xlsx');
      const rows: any[][] = [EXPORT_HEADERS];

      for (const client of clients) {
        rows.push([
          client.id ?? '',
          client.clientName ?? '',
          client.clientShortName ?? '',
          client.clientCode ?? '',
          client.clientType ?? '',
          client.agentName ?? '',
          client.billingAddress ?? '',
          client.zipCode ?? '',
          client.place ?? '',
          client.state ?? '',
          client.country ?? '',
          client.shipToAddress ?? '',
          client.shipToZipCode ?? '',
          client.shipToPlace ?? '',
          client.shipToState ?? '',
          client.shipToCountry ?? '',
          client.gstNo ?? '',
          client.mobile ?? '',
          client.contactPerson ?? '',
          client.marginPct ?? 0,
          client.discountPct ?? 0,
          client.status ?? '',
          this.formatTimestamp(client.createdAt),
          this.formatTimestamp(client.updatedAt),
        ]);
      }

      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = EXPORT_HEADERS.map(() => ({ wch: 18 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Clients');
      const timestamp = this.formatTimestamp(null, true);
      XLSX.writeFile(wb, `Client_Master_Export_${timestamp}.xlsx`);
    } catch (err) {
      console.error(err);
      Swal.fire({ icon: 'error', title: 'Export Failed', text: 'Could not generate the export file.' });
    }
  }

  private formatTimestamp(value: any, forFilename = false): string {
    let date: Date | null = null;
    if (forFilename) {
      date = new Date();
    } else if (value?.toDate) {
      date = value.toDate();
    } else if (value?.seconds != null) {
      date = new Date(value.seconds * 1000);
    } else if (value) {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) date = parsed;
    }

    if (!date) return '';

    const pad = (n: number) => String(n).padStart(2, '0');
    const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    if (forFilename) {
      return `${datePart}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    }
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      Swal.fire({ icon: 'error', title: 'Invalid File', text: 'Please upload a valid Excel file (.xlsx or .xls).' });
      input.value = '';
      return;
    }

    Swal.fire({ title: 'Reading file…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rawData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      Swal.close();

      if (rawData.length < 2) {
        Swal.fire({ icon: 'error', title: 'Empty File', text: 'The Excel file has no data rows.' });
        return;
      }

      const { clients, errors } = this.parseExcelData(rawData);

      if (errors.length > 0 && clients.length === 0) {
        await Swal.fire({
          icon: 'error',
          title: 'Validation Failed',
          html: `<div class="text-left"><p class="font-semibold mb-2">All rows have errors:</p><ul class="list-disc pl-4 space-y-1 text-sm max-h-60 overflow-y-auto">${errors.map(e => `<li>${e}</li>`).join('')}</ul></div>`,
        });
        return;
      }

      const errorSection = errors.length > 0
        ? `<div class="mt-3 text-left border-t pt-3"><p class="text-yellow-700 font-semibold text-sm">${errors.length} row(s) skipped:</p><ul class="list-disc pl-4 space-y-1 text-xs text-yellow-600 max-h-32 overflow-y-auto mt-1">${errors.map(e => `<li>${e}</li>`).join('')}</ul></div>`
        : '';

      const result = await Swal.fire({
        icon: 'info',
        title: 'Import Preview',
        html: `<div class="text-center"><p class="text-lg font-semibold text-green-700">${clients.length} client(s) ready to import</p>${errorSection}</div>`,
        showCancelButton: true,
        confirmButtonText: 'Import Now',
        cancelButtonText: 'Cancel',
        confirmButtonColor: '#4f46e5',
        cancelButtonColor: '#6b7280',
      });

      if (result.isConfirmed) {
        await this.processImport(clients);
      }
    } catch (err: any) {
      Swal.close();
      Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to read the Excel file. ' + (err?.message ?? '') });
    } finally {
      input.value = '';
    }
  }

  private parseExcelData(rawData: any[][]): { clients: Omit<Client, 'id'>[], errors: string[] } {
    const errors: string[] = [];
    const result: Omit<Client, 'id'>[] = [];

    const headerRow = rawData[0].map((h: any) => String(h).trim());
    const headerLower = headerRow.map(h => h.toLowerCase());
    const col = (name: string) => headerLower.indexOf(name.toLowerCase());

    const missingHeaders = REQUIRED_HEADERS.filter(h => col(h) === -1);
    if (missingHeaders.length > 0) {
      errors.push(`Missing required columns: ${missingHeaders.join(', ')}. Please use the sample template.`);
      return { clients: [], errors };
    }

    const iName = col('ClientName'), iShortName = col('ClientShortName');
    const iType = col('ClientType'), iAgent = col('AgentName'), iAddress = col('BillingAddress');
    const iZip = col('ZipCode'), iPlace = col('Place'), iState = col('State'), iCountry = col('Country');
    const iShipAddress = col('ShipToAddress'), iShipZip = col('ShipToZipCode'), iShipPlace = col('ShipToPlace'), iShipState = col('ShipToState'), iShipCountry = col('ShipToCountry');
    const iGst = col('GSTNo'), iMobile = col('Mobile'), iContact = col('ContactPerson'), iStatus = col('Status');
    const iMargin = col('MarginPct'), iDiscount = col('DiscountPct');

    // Track names already seen (existing clients + rows already processed in this file) to reject duplicates.
    const existingNames = new Set(this.clients().map(c => this.safeLower(c.clientName).trim()));
    const existingGst = new Set(this.clients().map(c => this.safeLower(c.gstNo).trim()).filter(Boolean));
    const seenNamesInFile = new Set<string>();
    const seenGstInFile = new Set<string>();

    for (let i = 1; i < rawData.length; i++) {
      const row = rawData[i];
      const rowNum = i + 1;

      if (row.every((cell: any) => String(cell ?? '').trim() === '')) continue;

      const clientName = String(row[iName] ?? '').trim();
      const typeRaw = String(row[iType] ?? '').trim();

      if (!clientName) { errors.push(`Row ${rowNum}: ClientName is required.`); continue; }

      const typeLower = typeRaw.toLowerCase();
      let clientType: 'Direct' | 'Agent';
      if (typeLower === 'direct') clientType = 'Direct';
      else if (typeLower === 'agent') clientType = 'Agent';
      else { errors.push(`Row ${rowNum}: ClientType must be 'Direct' or 'Agent' (got '${typeRaw}').`); continue; }

      const nameKey = clientName.toLowerCase();
      if (existingNames.has(nameKey) || seenNamesInFile.has(nameKey)) {
        errors.push(`Row ${rowNum}: Duplicate client name "${clientName}" — skipped.`);
        continue;
      }

      const gstNo = iGst >= 0 ? String(row[iGst] ?? '').trim() : '';
      const gstKey = gstNo.toLowerCase();
      if (gstKey && (existingGst.has(gstKey) || seenGstInFile.has(gstKey))) {
        errors.push(`Row ${rowNum}: Duplicate GST No "${gstNo}" — skipped.`);
        continue;
      }

      const statusRaw = iStatus >= 0 ? String(row[iStatus] ?? '').trim() : '';
      let status: 'Active' | 'Inactive' = 'Active';
      if (statusRaw) {
        const statusLower = statusRaw.toLowerCase();
        if (statusLower === 'active') status = 'Active';
        else if (statusLower === 'inactive') status = 'Inactive';
        else { errors.push(`Row ${rowNum}: Status must be 'Active' or 'Inactive' (got '${statusRaw}').`); continue; }
      }

      seenNamesInFile.add(nameKey);
      if (gstKey) seenGstInFile.add(gstKey);

      const billingAddress = iAddress >= 0 ? String(row[iAddress] ?? '').trim() : '';
      const zipCode = iZip >= 0 ? String(row[iZip] ?? '').trim() : '';
      const place = iPlace >= 0 ? String(row[iPlace] ?? '').trim() : '';
      const state = iState >= 0 ? String(row[iState] ?? '').trim() : '';
      const country = iCountry >= 0 ? String(row[iCountry] ?? '').trim() : '';
      // Ship To columns are optional in the import file — fall back to Bill To when absent/blank.
      const shipToAddress = (iShipAddress >= 0 ? String(row[iShipAddress] ?? '').trim() : '') || billingAddress;
      const shipToZipCode = (iShipZip >= 0 ? String(row[iShipZip] ?? '').trim() : '') || zipCode;
      const shipToPlace = (iShipPlace >= 0 ? String(row[iShipPlace] ?? '').trim() : '') || place;
      const shipToState = (iShipState >= 0 ? String(row[iShipState] ?? '').trim() : '') || state;
      const shipToCountry = (iShipCountry >= 0 ? String(row[iShipCountry] ?? '').trim() : '') || country;

      result.push({
        clientName,
        clientShortName: iShortName >= 0 ? String(row[iShortName] ?? '').trim() : '',
        clientType,
        agentName: iAgent >= 0 ? String(row[iAgent] ?? '').trim() : '',
        billingAddress,
        zipCode,
        place,
        state,
        country,
        shipToAddress,
        shipToZipCode,
        shipToPlace,
        shipToState,
        shipToCountry,
        shipToSameAsBilling: iShipAddress < 0,
        gstNo,
        mobile: iMobile >= 0 ? String(row[iMobile] ?? '').trim() : '',
        contactPerson: iContact >= 0 ? String(row[iContact] ?? '').trim() : '',
        marginPct: iMargin >= 0 ? Number(row[iMargin]) || 0 : 0,
        discountPct: iDiscount >= 0 ? Number(row[iDiscount]) || 0 : 0,
        status,
      } as Omit<Client, 'id' | 'clientCode'>);
    }

    return { clients: result, errors };
  }

  private async processImport(clients: Omit<Client, 'id'>[]) {
    Swal.fire({
      title: `Importing ${clients.length} client(s)…`,
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    let successCount = 0;
    const failedItems: { clientName: string; reason: string }[] = [];

    for (const client of clients) {
      try {
        await this.clientService.createClient(client as Omit<Client, 'id' | 'clientCode'>);
        successCount++;
      } catch (err: any) {
        failedItems.push({ clientName: client.clientName, reason: err?.message ?? 'Unknown error' });
      }
    }

    if (failedItems.length === 0) {
      await Swal.fire({
        icon: 'success', title: 'Import Complete!',
        text: `${successCount} client(s) imported successfully.`,
        timer: 3000, showConfirmButton: false,
      });
    } else {
      const failRows = failedItems
        .map(f => `<li><strong>${f.clientName}</strong>: ${f.reason}</li>`)
        .join('');
      await Swal.fire({
        icon: 'warning',
        title: 'Import Partially Complete',
        html: `<p>${successCount} imported successfully.</p>
               <p class="mt-2 font-semibold text-red-600">${failedItems.length} failed:</p>
               <ul class="list-disc pl-4 text-left text-sm max-h-40 overflow-y-auto mt-1">${failRows}</ul>`,
      });
    }
    this.loadClients();
  }

  // --- Pagination and Filter Methods ---
  onSearch(term: string) {
    this.searchTerm.set(term);
    this.currentPage.set(1); // Reset to first page on new search
  }

  changePage(page: number) {
    if (page >= 1 && page <= this.totalPages()) {
      this.currentPage.set(page);
    }
  }

  onItemsPerPageChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.itemsPerPage.set(Number(value));
    this.currentPage.set(1); // Reset to first page
  }
}
