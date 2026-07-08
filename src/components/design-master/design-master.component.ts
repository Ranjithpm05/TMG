import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Design, SizePrice } from '../../models/design.model';
import { DesignService } from '../../services/design.service';
import Swal from 'sweetalert2';

const EXCEL_HEADERS = ['StyleNo', 'Color', 'Group', 'Size', 'MRP', 'WSP', 'Barcode', 'SleeveType', 'FabricDescription'];
const REQUIRED_HEADERS = ['StyleNo', 'Size', 'MRP', 'WSP', 'Barcode'];
const EXPORT_HEADERS = ['ID', 'StyleNo', 'Color', 'Group', 'Size', 'MRP', 'WSP', 'Barcode', 'SleeveType', 'FabricDescription', 'CreatedAt', 'UpdatedAt'];

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

    // --- Excel Import / Export ---

    async downloadSampleExcel() {
        try {
            const XLSX = await import('xlsx');
            const rows = [
                EXCEL_HEADERS,
                ['STYLE001', 'Red', 'CASUAL SHIRTS', 'S', 500, 350, '1234567890128', 'Full', 'CASUALSHIRT CHECKS FS'],
                ['STYLE001', 'Red', 'CASUAL SHIRTS', 'M', 500, 350, '1234567890135', 'Full', 'CASUALSHIRT CHECKS FS'],
                ['STYLE001', 'Red', 'CASUAL SHIRTS', 'L', 500, 350, '1234567890142', 'Half', 'CASUALSHIRT CHECKS FS'],
                ['STYLE002', 'Blue', 'Jeans', '32', 1200, 900, '9876543210987', '', 'DENIM JEANS SLIM FIT'],
                ['STYLE002', 'Blue', 'Jeans', '34', 1200, 900, '9876543210994', '', 'DENIM JEANS SLIM FIT'],
            ];
            const ws = XLSX.utils.aoa_to_sheet(rows);
            ws['!cols'] = [
                { wch: 15 }, { wch: 12 }, { wch: 18 }, { wch: 8 },
                { wch: 10 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 30 },
            ];
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Designs');
            XLSX.writeFile(wb, 'Design_Import_Template.xlsx');
        } catch {
            Swal.fire({ icon: 'error', title: 'Download Failed', text: 'Could not generate sample file.' });
        }
    }

    async exportDesignsToExcel() {
        const designs = this.designs();
        if (designs.length === 0) {
            Swal.fire({ icon: 'info', title: 'No Data', text: 'There are no designs to export.' });
            return;
        }

        try {
            const XLSX = await import('xlsx');
            const rows: any[][] = [EXPORT_HEADERS];

            for (const design of designs) {
                const sizes = design.sizes?.length ? design.sizes : [{} as SizePrice];
                for (const size of sizes) {
                    rows.push([
                        design.id ?? '',
                        design.styleNo ?? '',
                        design.color ?? '',
                        design.group ?? '',
                        size.size ?? '',
                        size.price ?? '',
                        size.WSP ?? '',
                        size.BARCODE ?? '',
                        size.sleeveType ?? '',
                        size.fabricType ?? '',
                        this.formatTimestamp(design.createdAt),
                        this.formatTimestamp(design.updatedAt),
                    ]);
                }
            }

            const ws = XLSX.utils.aoa_to_sheet(rows);
            ws['!cols'] = [
                { wch: 22 }, { wch: 15 }, { wch: 12 }, { wch: 18 }, { wch: 8 },
                { wch: 10 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 30 },
                { wch: 20 }, { wch: 20 },
            ];
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Designs');
            const timestamp = this.formatTimestamp(null, true);
            XLSX.writeFile(wb, `Design_Master_Export_${timestamp}.xlsx`);
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

            const { designs, errors } = this.parseExcelData(rawData);

            if (errors.length > 0 && designs.length === 0) {
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
            const totalSizes = designs.reduce((acc, d) => acc + d.sizes.length, 0);

            const result = await Swal.fire({
                icon: 'info',
                title: 'Import Preview',
                html: `<div class="text-center"><p class="text-lg font-semibold text-green-700">${designs.length} design(s) ready to import</p><p class="text-sm text-gray-500 mt-1">${totalSizes} total size variation(s)</p>${errorSection}</div>`,
                showCancelButton: true,
                confirmButtonText: 'Import Now',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#4f46e5',
                cancelButtonColor: '#6b7280',
            });

            if (result.isConfirmed) {
                await this.processImport(designs);
            }
        } catch (err: any) {
            Swal.close();
            Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to read the Excel file. ' + (err?.message ?? '') });
        }
    }

    private parseExcelData(rawData: any[][]): { designs: Omit<Design, 'id'>[], errors: string[] } {
        const errors: string[] = [];
        const designMap = new Map<string, Omit<Design, 'id'>>();

        // Case-insensitive header matching so minor capitalisation differences don't block import
        const headerRow = rawData[0].map((h: any) => String(h).trim());
        const headerLower = headerRow.map(h => h.toLowerCase());
        const col = (name: string) => headerLower.indexOf(name.toLowerCase());

        const missingHeaders = REQUIRED_HEADERS.filter(h => col(h) === -1);
        if (missingHeaders.length > 0) {
            errors.push(`Missing required columns: ${missingHeaders.join(', ')}. Please use the sample template.`);
            return { designs: [], errors };
        }

        const iStyleNo = col('StyleNo'), iColor = col('Color'), iGroup = col('Group');
        const iSize = col('Size'), iMRP = col('MRP'), iWSP = col('WSP');
        const iBarcode = col('Barcode'), iSleeve = col('SleeveType'), iFabric = col('FabricDescription');

        for (let i = 1; i < rawData.length; i++) {
            const row = rawData[i];
            const rowNum = i + 1;

            // Skip rows where every cell is empty or whitespace
            if (row.every((cell: any) => String(cell ?? '').trim() === '')) continue;

            const styleNo = String(row[iStyleNo] ?? '').trim();
            const size = String(row[iSize] ?? '').trim();
            // Barcodes can be numeric in Excel; convert without precision loss for ≤15-digit numbers
            const barcode = String(row[iBarcode] ?? '').trim();
            const mrpRaw = row[iMRP];
            const wspRaw = row[iWSP];

            if (!styleNo) { errors.push(`Row ${rowNum}: StyleNo is required.`); continue; }
            if (!size)    { errors.push(`Row ${rowNum}: Size is required.`);    continue; }
            if (!barcode) { errors.push(`Row ${rowNum}: Barcode is required.`); continue; }

            const mrp = parseFloat(String(mrpRaw ?? ''));
            const wsp = parseFloat(String(wspRaw ?? ''));
            if (mrpRaw === '' || mrpRaw == null || isNaN(mrp)) { errors.push(`Row ${rowNum}: MRP must be a valid number.`); continue; }
            if (wspRaw === '' || wspRaw == null || isNaN(wsp)) { errors.push(`Row ${rowNum}: WSP must be a valid number.`); continue; }
            if (mrp < 0) { errors.push(`Row ${rowNum}: MRP cannot be negative.`); continue; }
            if (wsp < 0) { errors.push(`Row ${rowNum}: WSP cannot be negative.`); continue; }

            // Normalise SleeveType — accept any casing of Full / Half
            const sleeveRaw = iSleeve >= 0 ? String(row[iSleeve] ?? '').trim() : '';
            let sleeveType: string | null = null;
            if (sleeveRaw) {
                const lower = sleeveRaw.toLowerCase();
                if (lower === 'full')       sleeveType = 'Full';
                else if (lower === 'half')  sleeveType = 'Half';
                else {
                    errors.push(`Row ${rowNum}: SleeveType must be 'Full' or 'Half' (got '${sleeveRaw}').`);
                    continue;
                }
            }
            // null (not undefined) — Firestore rejects undefined field values

            const sizeObj: SizePrice = {
                size, price: mrp, WSP: wsp, BARCODE: barcode,
                sleeveType,
                fabricType: iFabric >= 0 ? String(row[iFabric] ?? '').trim() : '',
            };

            const color = iColor >= 0 ? String(row[iColor] ?? '').trim() : '';
            const group = iGroup >= 0 ? String(row[iGroup] ?? '').trim() : '';
            // Group by StyleNo + Color (+ Group) so distinct colors of the same style
            // become separate design records instead of collapsing into one.
            const designKey = `${styleNo}|${color}|${group}`;

            if (designMap.has(designKey)) {
                designMap.get(designKey)!.sizes.push(sizeObj);
            } else {
                designMap.set(designKey, {
                    styleNo,
                    color,
                    group,
                    sizes: [sizeObj],
                });
            }
        }

        return { designs: Array.from(designMap.values()), errors };
    }

    private async processImport(designs: Omit<Design, 'id'>[]) {
        Swal.fire({
            title: `Importing ${designs.length} design(s)…`,
            allowOutsideClick: false,
            didOpen: () => Swal.showLoading()
        });

        let successCount = 0;
        const failedItems: { styleNo: string; reason: string }[] = [];

        for (const design of designs) {
            try {
                await this.designService.createDesign(design);
                successCount++;
            } catch (err: any) {
                failedItems.push({ styleNo: design.styleNo, reason: err?.message ?? 'Unknown error' });
            }
        }

        if (failedItems.length === 0) {
            await Swal.fire({
                icon: 'success', title: 'Import Complete!',
                text: `${successCount} design(s) imported successfully.`,
                timer: 3000, showConfirmButton: false,
            });
        } else {
            const failRows = failedItems
                .map(f => `<li><strong>${f.styleNo}</strong>: ${f.reason}</li>`)
                .join('');
            await Swal.fire({
                icon: 'warning',
                title: 'Import Partially Complete',
                html: `<p>${successCount} imported successfully.</p>
                       <p class="mt-2 font-semibold text-red-600">${failedItems.length} failed:</p>
                       <ul class="list-disc pl-4 text-left text-sm max-h-40 overflow-y-auto mt-1">${failRows}</ul>`,
            });
        }
        this.loadDesigns();
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