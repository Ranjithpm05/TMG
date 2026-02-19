import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Client } from '../../models/client.model';
import { ClientService } from '../../services/client.service';
import Swal from 'sweetalert2';

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
  gstNo: '',
  mobile: '',
  contactPerson: '',
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
    const term = this.searchTerm().toLowerCase();
    if (!term) {
      return this.clients();
    }
    return this.clients().filter(client =>
      client.clientName.toLowerCase().includes(term) ||
      client.clientCode.toLowerCase().includes(term) ||
      client.contactPerson.toLowerCase().includes(term) ||
      (client.agentName && client.agentName.toLowerCase().includes(term))
    );
  });

  totalPages = computed(() => Math.ceil(this.filteredClients().length / this.itemsPerPage()));

  paginatedClients = computed(() => {
    const startIndex = (this.currentPage() - 1) * this.itemsPerPage();
    // Ensure currentPage is not out of bounds after filtering
    if (startIndex >= this.filteredClients().length && this.currentPage() > 1) {
      this.currentPage.set(this.totalPages() || 1);
    }
    const newStartIndex = (this.currentPage() - 1) * this.itemsPerPage();
    return this.filteredClients().slice(newStartIndex, newStartIndex + this.itemsPerPage());
  });
  
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
