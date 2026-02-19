import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Design, SizePrice } from '../../models/design.model';
import { DesignService } from '../../services/design.service';
import Swal from 'sweetalert2';

type ViewMode = 'list' | 'form';

const EMPTY_DESIGN: Omit<Design, 'id'> = {
  styleNo: '',
  color: '',
  sizes: [{ size: 'M', price: 0, WSP: 0, BARCODE: '', sleeveType: null, fabricType: ''}],
  group: ''
};

@Component({
  selector: 'app-design-master',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './design-master.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DesignMasterComponent implements OnInit {
    private designService = inject(DesignService);

    designs = signal<Design[]>([]);
    mode = signal<ViewMode>('list');
    editableDesign = signal<Design | Omit<Design, 'id'>>(EMPTY_DESIGN);
    isEditMode = computed(() => 'id' in this.editableDesign());

    // --- Pagination and Filtering State ---
    searchTerm = signal('');
    currentPage = signal(1);
    itemsPerPage = signal(10);

    filteredDesigns = computed(() => {
        const term = this.searchTerm().toLowerCase();
        if (!term) {
            return this.designs();
        }
        return this.designs().filter(design =>
            this.safeLower(design.styleNo).includes(term) ||
            this.safeLower(design.color).includes(term) ||
            this.safeLower(design.group).includes(term)
        );
    });

    private safeLower(value: any): string {
        return (value ?? '').toString().toLowerCase();
    }

    totalPages = computed(() => Math.ceil(this.filteredDesigns().length / this.itemsPerPage()));

    paginatedDesigns = computed(() => {
        const startIndex = (this.currentPage() - 1) * this.itemsPerPage();
        // Ensure currentPage is not out of bounds after filtering
        if (startIndex >= this.filteredDesigns().length && this.currentPage() > 1) {
        this.currentPage.set(this.totalPages() || 1);
        }
        const newStartIndex = (this.currentPage() - 1) * this.itemsPerPage();
        return this.filteredDesigns().slice(newStartIndex, newStartIndex + this.itemsPerPage());
    });

    ngOnInit() {
        this.loadDesigns();
    }

    loadDesigns() {
        Swal.fire({
            title: 'Loading Design...',
            allowOutsideClick: false,
            didOpen: () => Swal.showLoading()
        });

        this.designService.getDesigns().subscribe({
            next: (data) => {
                this.designs.set(data);
                Swal.close()
            },
            error: (err) => {
                Swal.close()
                Swal.fire('Error', 'Failed to load designs', 'error');
            }
        });
        
    }

    showAddForm() {
        this.editableDesign.set(JSON.parse(JSON.stringify(EMPTY_DESIGN))); // Deep copy
        this.mode.set('form');
    }

    showEditForm(design: Design) {
        this.editableDesign.set(JSON.parse(JSON.stringify(design))); // Deep copy to isolate form state
        this.mode.set('form');
    }

    async saveDesign() 
    {
        const designData = this.editableDesign();
        try
        {
            Swal.fire({
                title: this.isEditMode() ? 'Updating Design...' : 'Creating Design...',
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            })

            if (this.isEditMode()) 
            {
                await this.designService.updateDesign(designData as Design)
                await Swal.fire({
                    icon: 'success',
                    title: 'Updated!',
                    text: 'Design updated successfully',
                    timer: 2000,
                    showConfirmButton: false
                });
                this.loadDesigns();
                this.switchToListView();
            } 
            else 
            {
                await this.designService.createDesign(designData);
                await Swal.fire({
                    icon: 'success',
                    title: 'Created!',
                    text: 'Design created successfully',
                    timer: 2000,
                    showConfirmButton: false
                });
                this.loadDesigns();
                this.switchToListView();
                
            }
        }
        catch (error) 
        {
            Swal.fire({
            icon: 'error',
            title: 'Error',
            text: error.message
            });
        }
    }

    async deleteDesign(design: Design) {
        const result = await Swal.fire({
            title: 'Are you sure?',
            text: `Delete Design No "${design.styleNo}"?`,
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

            await this.designService.deleteDesign(design.id);

            await Swal.fire({
                icon: 'success',
                title: 'Deleted!',
                text: 'Client deleted successfully',
                timer: 2000,
                showConfirmButton: false
            });
            this.loadDesigns()
            if (this.paginatedDesigns().length === 0 && this.currentPage() > 1) {
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
        this.editableDesign.set(EMPTY_DESIGN);
        this.mode.set('list');
    }

    addSize() {
        this.editableDesign.update(design => {
        const firstFabricType = design.sizes[0]?.fabricType || '';
        const newSizes: SizePrice[] = [...design.sizes, { size: '', price: 0, WSP: 0, BARCODE: '', sleeveType: 'Full', fabricType: firstFabricType }];
        return { ...design, sizes: newSizes };
        });
    }

    removeSize(index: number) {
        this.editableDesign.update(design => {
            if (design.sizes.length <= 1) {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: 'A design must have at least one size.'
                });
                return design;
            };
            const newSizes = design.sizes.filter((_, i) => i !== index);
            return { ...design, sizes: newSizes };
        });
    }

    trackByIndex(index: number) {
        return index;
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