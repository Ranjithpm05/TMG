import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InventoryItem } from '../../models/inventory.model';
import { InventoryService } from '../../services/inventory.service';

@Component({
  selector: 'app-inventory',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './inventory.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InventoryComponent implements OnInit {
  private inventoryService = inject(InventoryService);

  inventory   = signal<InventoryItem[]>([]);
  searchTerm  = signal('');
  currentPage = signal(1);
  itemsPerPage = signal(20);

  filteredInventory = computed(() => {
    const term = this.searchTerm().toLowerCase();
    const items = this.inventory();
    if (!term) return items;
    return items.filter(i =>
      i.styleNo.toLowerCase().includes(term) ||
      i.color.toLowerCase().includes(term) ||
      i.barcode.toLowerCase().includes(term) ||
      i.size.toLowerCase().includes(term)
    );
  });

  totalPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredInventory().length / this.itemsPerPage()))
  );

  paginatedInventory = computed(() => {
    const start = (this.currentPage() - 1) * this.itemsPerPage();
    return this.filteredInventory().slice(start, start + this.itemsPerPage());
  });

  totalStock = computed(() =>
    this.filteredInventory().reduce((s, i) => s + (Number(i.currentStock) || 0), 0)
  );

  totalValue = computed(() =>
    this.filteredInventory().reduce((s, i) => s + ((Number(i.currentStock) || 0) * (Number(i.WSP) || 0)), 0)
  );

  ngOnInit() {
    this.inventoryService.getInventory().subscribe(items => this.inventory.set(items));
  }

  onSearch(term: string) { this.searchTerm.set(term); this.currentPage.set(1); }
  changePage(p: number)  { if (p >= 1 && p <= this.totalPages()) this.currentPage.set(p); }
}