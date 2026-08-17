import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Transport } from '../../models/transport.model';
import { TransportService } from '../../services/transport.service';
import Swal from 'sweetalert2';

type ViewMode = 'list' | 'form';

const EMPTY_TRANSPORT: Omit<Transport, 'id'> = {
  transportName: '',
  transportAddress: '',
  gstNo: '',
  status: 'Active',
};

@Component({
  selector: 'app-transport-master',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './transport-master.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransportMasterComponent implements OnInit {
  private transportService = inject(TransportService);

  transports = signal<Transport[]>([]);
  mode = signal<ViewMode>('list');

  editableTransport = signal<Transport | Omit<Transport, 'id'>>(EMPTY_TRANSPORT);
  isEditMode = computed(() => 'id' in this.editableTransport());

  // --- Pagination and Filtering State ---
  searchTerm = signal('');
  currentPage = signal(1);
  itemsPerPage = signal(10);

  filteredTransports = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    if (!term) {
      return this.transports();
    }
    return this.transports().filter(transport =>
      this.safeLower(transport.transportName).includes(term) ||
      this.safeLower(transport.transportAddress).includes(term) ||
      this.safeLower(transport.gstNo).includes(term)
    );
  });

  private safeLower(value: any): string {
    return (value ?? '').toString().toLowerCase();
  }

  totalPages = computed(() => Math.ceil(this.filteredTransports().length / this.itemsPerPage()));

  paginatedTransports = computed(() => {
    const startIndex = (this.currentPage() - 1) * this.itemsPerPage();
    return this.filteredTransports().slice(startIndex, startIndex + this.itemsPerPage());
  });

  constructor() {
    // Clamps currentPage back into range after filtering shrinks the result
    // set — moved out of paginatedTransports() since writing to a signal from
    // inside a computed() that also reads it is a memoization-defeating
    // anti-pattern (and unsupported by Angular's computed() contract).
    effect(() => {
      const startIndex = (this.currentPage() - 1) * this.itemsPerPage();
      if (startIndex >= this.filteredTransports().length && this.currentPage() > 1) {
        this.currentPage.set(this.totalPages() || 1);
      }
    });
  }

  ngOnInit() {
    this.loadTransports();
  }

  loadTransports() {
    this.transportService.getTransports().subscribe(data => {
      this.transports.set(data);
    });
  }

  showAddForm() {
    this.editableTransport.set(JSON.parse(JSON.stringify(EMPTY_TRANSPORT)));
    this.mode.set('form');
  }

  showEditForm(transport: Transport) {
    this.editableTransport.set({ ...transport });
    this.mode.set('form');
  }

  async saveTransport() {
    const transportData = this.editableTransport();
    try {
      Swal.fire({
        title: this.isEditMode() ? 'Updating transport...' : 'Creating transport...',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
      });

      if ('id' in transportData) {
        await this.transportService.updateTransport(transportData);
        await Swal.fire({
          icon: 'success',
          title: 'Updated!',
          text: 'Transport updated successfully',
          timer: 2000,
          showConfirmButton: false
        });
      } else {
        await this.transportService.createTransport(transportData);
        await Swal.fire({
          icon: 'success',
          title: 'Created!',
          text: 'Transport created successfully',
          timer: 2000,
          showConfirmButton: false
        });
      }
      this.loadTransports();
      this.switchToListView();
    } catch (error: any) {
      Swal.fire({
        icon: 'error',
        title: 'Error',
        text: error.message
      });
    }
  }

  async deleteTransport(transport: Transport) {
    const result = await Swal.fire({
      title: 'Are you sure?',
      text: `Delete transport "${transport.transportName}"?`,
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

      await this.transportService.deleteTransport(transport.id!);

      await Swal.fire({
        icon: 'success',
        title: 'Deleted!',
        text: 'Transport deleted successfully',
        timer: 2000,
        showConfirmButton: false
      });
      this.loadTransports();
      if (this.paginatedTransports().length === 0 && this.currentPage() > 1) {
        this.currentPage.update(p => p - 1);
      }
    } catch (error) {
      console.error(error);
      Swal.fire({
        icon: 'error',
        title: 'Error',
        text: 'Failed to delete transport'
      });
    }
  }

  cancel() {
    this.switchToListView();
  }

  private switchToListView() {
    this.editableTransport.set(EMPTY_TRANSPORT);
    this.mode.set('list');
  }

  // --- Pagination and Filter Methods ---
  onSearch(term: string) {
    this.searchTerm.set(term);
    this.currentPage.set(1);
  }

  changePage(page: number) {
    if (page >= 1 && page <= this.totalPages()) {
      this.currentPage.set(page);
    }
  }

  onItemsPerPageChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.itemsPerPage.set(Number(value));
    this.currentPage.set(1);
  }
}
