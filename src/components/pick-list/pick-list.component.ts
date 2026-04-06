import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SalesOrder } from '../../models/sales-order.model';
import { InventoryItem } from '../../models/inventory.model';
import { PickList, PickListLine, PickListLineItem, PickListType } from '../../models/pick-list.model';
import { SalesOrderService } from '../../services/sales-order.service';
import { InventoryService } from '../../services/inventory.service';
import { PickListService } from '../../services/pick-list.service';
import { ClientService } from '../../services/client.service';
import { Client } from '../../models/client.model';
import Swal from 'sweetalert2';

type ViewMode = 'list' | 'select-type' | 'select-orders' | 'select-items' | 'pick' | 'view';

const SIZE_ORDER = ['XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL','5XL','6XL','Free Size'];

@Component({
  selector:        'app-pick-list',
  standalone:      true,
  imports:         [CommonModule, FormsModule],
  templateUrl:     './pick-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PickListComponent implements OnInit {

  private salesOrderService = inject(SalesOrderService);
  private inventoryService  = inject(InventoryService);
  private pickListService   = inject(PickListService);
  private clientService     = inject(ClientService);

  mode         = signal<ViewMode>('list');
  salesOrders  = signal<SalesOrder[]>([]);
  inventory    = signal<InventoryItem[]>([]);
  clients      = signal<Client[]>([]);
  pickLists    = signal<PickList[]>([]);
  isLoading    = signal(true);
  isConfirming = signal(false);

  listTab      = signal<'orders' | 'picklists'>('orders');
  searchTerm   = signal('');
  statusFilter = signal<'all' | 'Pending' | 'Confirmed' | 'Shipped'>('all');
  plTypeFilter = signal<'all' | 'direct' | 'combined' | 'itemwise'>('all');

  pickType         = signal<PickListType>('direct');
  selectedOrderIds = signal<Set<string>>(new Set());
  orderSearchTerm  = signal('');
  activePickLines  = signal<PickListLineItem[]>([]);
  existingPickList = signal<PickList | null>(null);
  viewPickList     = signal<PickList | null>(null);

  filteredOrders = computed(() => {
    const term = this.searchTerm().toLowerCase();
    const st   = this.statusFilter();
    return this.salesOrders().filter(o => {
      const ms = st === 'all' || o.status === st;
      const mt = !term || o.salesNo.toLowerCase().includes(term) ||
        this.getClientName(o.clientId).toLowerCase().includes(term);
      return ms && mt;
    });
  });

  filteredOrdersForSelection = computed(() => {
    const term = this.orderSearchTerm().toLowerCase();
    return this.salesOrders().filter(o =>
      o.status !== 'Shipped' &&
      (!term || o.salesNo.toLowerCase().includes(term) ||
       this.getClientName(o.clientId).toLowerCase().includes(term))
    );
  });

  filteredPickLists = computed(() => {
    const tp   = this.plTypeFilter();
    const term = this.searchTerm().toLowerCase();
    return this.pickLists().filter(pl => {
      const mt = tp === 'all' || pl.type === tp;
      const ms = !term || pl.pickListNo.toLowerCase().includes(term) ||
        (pl.salesNos ?? [(pl as any).salesNo ?? '']).some((s: string) => s.toLowerCase().includes(term)) ||
        pl.clientName.toLowerCase().includes(term);
      return mt && ms;
    });
  });

  selectedOrders = computed(() =>
    this.salesOrders().filter(o => this.selectedOrderIds().has(o.id))
  );

  totalOrderedQty = computed(() => this.activePickLines().reduce((s, l) => s + l.orderedQty, 0));
  totalPickQty    = computed(() => this.activePickLines().reduce((s, l) => s + (l.pickQty || 0), 0));
  totalBalanceQty = computed(() => this.activePickLines().reduce((s, l) => s + Math.max(0, l.balanceQty - (l.pickQty || 0)), 0));

  totalPendingQty = computed(() =>
    this.activePickLines()
      .filter(l => l.status === 'pending' || l.status === 'out_of_stock')
      .reduce((s, l) => s + l.balanceQty, 0)
  );

  pendingLineCount = computed(() =>
    this.activePickLines().filter(l => l.status === 'pending' || l.status === 'out_of_stock').length
  );

  // Allow confirm if: something to pick OR pending items to save
  hasAnyPickable = computed(() =>
    this.activePickLines().some(l => l.pickQty > 0) ||
    this.activePickLines().some(l => l.status === 'pending' || l.status === 'out_of_stock')
  );

  allFulfilled = computed(() => this.activePickLines().every(l => l.balanceQty <= 0));

  allPending = computed(() =>
    this.activePickLines().length > 0 &&
    this.activePickLines().every(l => l.status === 'pending' || l.status === 'out_of_stock')
  );

  selectedItemCount = computed(() => this.activePickLines().filter(l => l.selected).length);

  // CRITICAL: String() on sizes to handle numeric sizes stored in Firestore
  uniqueSizesForPick = computed(() => {
    const s = [...new Set(this.activePickLines().map(l => String(l.size)))];
    return s.sort((a, b) => {
      const ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  });

  pickGroups = computed(() => {
    const map = new Map<string, PickListLineItem[]>();
    for (const line of this.activePickLines()) {
      const key = `${line.styleNo}||${line.color}||${line.sleeveType ?? ''}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(line);
    }
    return [...map.entries()].map(([key, lines]) => {
      const [styleNo, color, sleeve] = key.split('||');
      return { key, styleNo, color, sleeve: sleeve || '', lines };
    });
  });

  candidateGroups = computed(() => {
    const map = new Map<string, PickListLineItem[]>();
    for (const line of this.activePickLines()) {
      const key = `${line.styleNo}||${line.color}||${String(line.size)}||${line.sleeveType ?? ''}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(line);
    }
    return [...map.entries()].map(([key, lines]) => {
      const [styleNo, color, size, sleeve] = key.split('||');
      const totalBalance = lines.reduce((s, l) => s + l.balanceQty, 0);
      const totalStock   = lines[0]?.stockAvailable ?? 0;
      const allSelected  = lines.every(l => l.selected);
      return { key, styleNo, color, size, sleeve: sleeve || '', lines, totalBalance, totalStock, allSelected };
    });
  });

  canProceed = computed(() => this.selectedOrderIds().size > 0);

  ngOnInit() {
    this.isLoading.set(true);
    let n = 0;
    const done = () => { if (++n === 4) this.isLoading.set(false); };
    this.salesOrderService.getSalesOrders().subscribe({ next: o => { this.salesOrders.set(o); done(); }, error: done });
    this.inventoryService.getInventory().subscribe({  next: i => { this.inventory.set(i);    done(); }, error: done });
    this.clientService.getClients().subscribe({       next: c => { this.clients.set(c);      done(); }, error: done });
    this.pickListService.getPickLists().subscribe({   next: p => { this.pickLists.set(p);    done(); }, error: done });
  }

  getClientName(id: string): string {
    return this.clients().find(c => c.id === id)?.clientName ?? '—';
  }

  getOrderTotalQty(o: SalesOrder): number {
    return o.items.reduce((s, i) => s + i.itemSizes.reduce((ss, sz) => ss + (Number(sz.quantity) || 0), 0), 0);
  }

  getPickedQtyForOrder(orderId: string): number {
    return this.pickLists()
      .filter(pl => (pl.salesOrderIds ?? [(pl as any).salesOrderId ?? '']).includes(orderId))
      .flatMap(pl => pl.items.filter(i => (i.salesOrderId ?? '') === orderId || !i.salesOrderId))
      .reduce((s, i) => s + (Number(i.pickedQty) || 0), 0);
  }

  getPickStatusForOrder(orderId: string): 'not_started' | 'partial' | 'completed' {
    const pls = this.pickLists().filter(pl =>
      (pl.salesOrderIds ?? [(pl as any).salesOrderId ?? '']).includes(orderId)
    );
    if (!pls.length) return 'not_started';
    const order = this.salesOrders().find(o => o.id === orderId);
    if (!order) return 'not_started';
    const total  = this.getOrderTotalQty(order);
    const picked = this.getPickedQtyForOrder(orderId);
    if (picked >= total && total > 0) return 'completed';
    // Has saved pick list (even all-pending) = partial
    return 'partial';
  }

  getPickListForOrder(orderId: string): PickList | null {
    return this.pickLists().find(pl =>
      (pl.salesOrderIds ?? [(pl as any).salesOrderId ?? '']).includes(orderId)
    ) ?? null;
  }

  getOrderPendingQty(orderId: string): number {
    return this.pickLists()
      .filter(pl => (pl.salesOrderIds ?? [(pl as any).salesOrderId ?? '']).includes(orderId))
      .flatMap(pl => pl.items.filter(i => (i.salesOrderId ?? '') === orderId))
      .reduce((s, i) => s + ((i as any).pendingQty || 0), 0);
  }

  getStockForLine(styleNo: string, color: string, size: string, sleeveType?: string): number {
    return Number(this.inventory().find(i =>
      i.styleNo === styleNo && i.color === color &&
      String(i.size) === String(size) &&
      (!sleeveType || !i.sleeveType || i.sleeveType === sleeveType)
    )?.currentStock) || 0;
  }

  getAlreadyPickedQty(orderId: string, styleNo: string, color: string, size: string, sleeveType?: string): number {
    return this.pickLists()
      .filter(pl => (pl.salesOrderIds ?? [(pl as any).salesOrderId ?? '']).includes(orderId))
      .flatMap(pl => pl.items)
      .filter(l =>
        (l.salesOrderId ?? '') === orderId && l.styleNo === styleNo &&
        l.color === color && String(l.size) === String(size) &&
        (l.sleeveType ?? '') === (sleeveType ?? '')
      )
      .reduce((s, l) => s + (Number(l.pickedQty) || 0), 0);
  }

  getLineStatus(stock: number, balance: number): PickListLineItem['status'] {
    if (balance <= 0)     return 'fulfilled';
    if (stock <= 0)       return 'pending';
    if (stock >= balance) return 'available';
    return 'partial';
  }

  statusBadge(s: PickListLineItem['status']): string {
    return ({
      available:    'bg-green-100 text-green-800',
      partial:      'bg-yellow-100 text-yellow-800',
      out_of_stock: 'bg-red-100 text-red-700',
      pending:      'bg-orange-100 text-orange-700',
      fulfilled:    'bg-blue-100 text-blue-700',
    } as any)[s] ?? '';
  }

  statusLabel(s: PickListLineItem['status']): string {
    return ({
      available:    'In Stock',
      partial:      'Partial Stock',
      out_of_stock: 'No Stock',
      pending:      'Pending',
      fulfilled:    'Fulfilled',
    } as any)[s] ?? '';
  }

  orderPickBadge(id: string): string {
    const s = this.getPickStatusForOrder(id);
    return s === 'completed' ? 'bg-green-100 text-green-800'
         : s === 'partial'   ? 'bg-yellow-100 text-yellow-800'
         : 'bg-gray-100 text-gray-600';
  }

  orderPickLabel(id: string): string {
    const s = this.getPickStatusForOrder(id);
    return s === 'completed' ? '✓ Picked' : s === 'partial' ? '◑ Partial' : '○ Not Picked';
  }

  plTypeBadge(t: PickListType): string {
    return ({ direct:'bg-indigo-100 text-indigo-800', combined:'bg-purple-100 text-purple-800', itemwise:'bg-teal-100 text-teal-800' } as any)[t] ?? '';
  }

  plTypeLabel(t: PickListType): string {
    return ({ direct:'Direct', combined:'Combined', itemwise:'Item-wise' } as any)[t] ?? '';
  }

  formatDate(raw: any): string {
    if (!raw) return '—';
    try {
      const d = raw?.toDate ? raw.toDate() : new Date(raw);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return '—'; }
  }

  // CRITICAL FIX: String() on both sides — sizes may be stored as numbers in Firestore
  getLineForSize(lines: PickListLineItem[], size: string): PickListLineItem | undefined {
    return lines.find(l => String(l.size) === String(size));
  }

  getSizeTotal(size: string): number {
    return this.activePickLines()
      .filter(l => String(l.size) === String(size))
      .reduce((s, l) => s + (l.pickQty || 0), 0);
  }

  getGroupPickTotal(lines: PickListLineItem[]): number {
    return lines.reduce((s, l) => s + (l.pickQty || 0), 0);
  }

  startNewPickList() {
    this.selectedOrderIds.set(new Set());
    this.activePickLines.set([]);
    this.existingPickList.set(null);
    this.orderSearchTerm.set('');
    this.mode.set('select-type');
  }

  selectType(type: PickListType) {
    this.pickType.set(type);
    this.mode.set('select-orders');
  }

  cancel() {
    this.mode.set('list');
    this.selectedOrderIds.set(new Set());
    this.activePickLines.set([]);
    this.existingPickList.set(null);
    this.viewPickList.set(null);
    this.orderSearchTerm.set('');
  }

  toggleOrderSelection(id: string) {
    this.selectedOrderIds.update(set => {
      const n = new Set(set);
      if (n.has(id)) { n.delete(id); } else {
        if (this.pickType() === 'direct') n.clear();
        n.add(id);
      }
      return n;
    });
  }

  isOrderSelected(id: string): boolean { return this.selectedOrderIds().has(id); }

  proceedFromOrderSelection() {
    const type   = this.pickType();
    const orders = this.selectedOrders();
    this.buildPickLines(orders);
    this.mode.set(type === 'itemwise' ? 'select-items' : 'pick');
  }

  toggleItemSelection(key: string) {
    this.activePickLines.update(lines =>
      lines.map(l => {
        const lKey = `${l.styleNo}||${l.color}||${String(l.size)}||${l.sleeveType ?? ''}`;
        return lKey === key ? { ...l, selected: !l.selected } : l;
      })
    );
  }

  selectAllItems()     { this.activePickLines.update(l => l.map(x => ({ ...x, selected: true }))); }
  clearItemSelection() { this.activePickLines.update(l => l.map(x => ({ ...x, selected: false }))); }

  proceedFromItemSelection() {
    const sel = this.activePickLines().filter(l => l.selected);
    if (!sel.length) {
      Swal.fire({ icon: 'warning', title: 'No Items Selected', text: 'Select at least one item to continue.' });
      return;
    }
    this.activePickLines.set(sel);
    this.mode.set('pick');
  }

  private buildPickLines(orders: SalesOrder[]) {
    const lines: PickListLineItem[] = [];
    for (const order of orders) {
      for (const item of order.items) {
        for (const sz of item.itemSizes) {
          const ordQty  = Number(sz.quantity) || 0;
          const sizeStr = String(sz.size); // Always String
          const picked  = this.getAlreadyPickedQty(
            order.id, item.design.styleNo, item.design.color ?? '', sizeStr, item.sleeveType
          );
          const balance = Math.max(0, ordQty - picked);
          if (balance <= 0) continue;

          const stock      = this.getStockForLine(item.design.styleNo, item.design.color ?? '', sizeStr, item.sleeveType);
          const lineStatus = this.getLineStatus(stock, balance);

          lines.push({
            salesOrderId:     order.id,
            salesNo:          order.salesNo,
            clientId:         order.clientId,
            clientName:       this.getClientName(order.clientId),
            designId:         item.design.id ?? '',
            styleNo:          item.design.styleNo,
            color:            item.design.color ?? '',
            group:            item.design.group ?? '',
            size:             sizeStr,
            sleeveType:       item.sleeveType,
            orderedQty:       ordQty,
            alreadyPickedQty: picked,
            balanceQty:       balance,
            stockAvailable:   stock,
            pickQty:          lineStatus === 'pending' ? 0 : Math.min(balance, stock),
            selected:         lineStatus !== 'pending',
            status:           lineStatus,
          });
        }
      }
    }
    this.activePickLines.set(lines);
  }

  openDirectPick(order: SalesOrder) {
    this.pickType.set('direct');
    this.selectedOrderIds.set(new Set([order.id]));
    this.buildPickLines([order]);
    this.existingPickList.set(null);
    this.mode.set('pick');
  }

  openView(pl: PickList) { this.viewPickList.set(pl); this.mode.set('view'); }

  setPickQty(line: PickListLineItem, value: string | number) {
    if (line.status === 'pending' || line.status === 'out_of_stock') return;
    const raw = typeof value === 'string' ? parseInt(value, 10) : Number(value);
    const qty = isNaN(raw) ? 0 : Math.max(0, Math.min(raw, Math.min(line.balanceQty, line.stockAvailable)));
    this.activePickLines.update(ls => ls.map(l =>
      l.salesOrderId === line.salesOrderId &&
      String(l.size) === String(line.size) &&
      l.styleNo === line.styleNo && l.color === line.color &&
      (l.sleeveType ?? '') === (line.sleeveType ?? '')
        ? { ...l, pickQty: qty } : l
    ));
  }

  incrementPickQty(line: PickListLineItem) {
    this.setPickQty(line, Math.min(line.pickQty + 1, Math.min(line.balanceQty, line.stockAvailable)));
  }

  decrementPickQty(line: PickListLineItem) {
    this.setPickQty(line, Math.max(0, line.pickQty - 1));
  }

  setAllToMax() {
    this.activePickLines.update(l => l.map(x =>
      x.status === 'pending' ? x : { ...x, pickQty: Math.min(x.balanceQty, x.stockAvailable) }
    ));
  }

  clearAll() {
    this.activePickLines.update(l => l.map(x =>
      x.status === 'pending' ? x : { ...x, pickQty: 0 }
    ));
  }

  async confirmPick() {
    const lines        = this.activePickLines();
    const pickingLines = lines.filter(l => l.pickQty > 0);
    const pendingLines = lines.filter(l => l.status === 'pending' || l.status === 'out_of_stock');

    if (!pickingLines.length && !pendingLines.length) {
      Swal.fire({ icon: 'warning', title: 'Nothing to Save', text: 'No items to pick or save.' });
      return;
    }

    const type      = this.pickType();
    const orders    = this.selectedOrders();
    const pendingQty = this.totalPendingQty();

    const res = await Swal.fire({
      title: pickingLines.length > 0 ? 'Confirm Pick List?' : 'Save Pending Pick List?',
      html: `<div style="text-align:left;font-size:13px">
        <p style="margin-bottom:10px"><strong>Type:</strong> ${this.plTypeLabel(type)} &nbsp;·&nbsp; ${orders.map(o => o.salesNo).join(', ')}</p>
        <div style="display:grid;grid-template-columns:${pickingLines.length > 0 && pendingQty > 0 ? '1fr 1fr' : '1fr'};gap:8px;margin-bottom:10px">
          ${pickingLines.length > 0 ? `<div style="background:#d1fae5;border-radius:8px;padding:8px 12px;text-align:center">
            <div style="font-size:10px;color:#065f46;font-weight:700;text-transform:uppercase">Picking Now</div>
            <div style="font-size:22px;font-weight:700;color:#16a34a">${this.totalPickQty()}</div>
            <div style="font-size:10px;color:#065f46">pcs</div>
          </div>` : ''}
          ${pendingQty > 0 ? `<div style="background:#ffedd5;border-radius:8px;padding:8px 12px;text-align:center">
            <div style="font-size:10px;color:#c2410c;font-weight:700;text-transform:uppercase">Pending (No Stock)</div>
            <div style="font-size:22px;font-weight:700;color:#ea580c">${pendingQty}</div>
            <div style="font-size:10px;color:#c2410c">pcs</div>
          </div>` : ''}
        </div>
        <p style="color:#64748b;font-size:11px">
          ${pickingLines.length > 0 ? 'Stock will be deducted for picked items. ' : ''}
          ${pendingQty > 0 ? 'Pending items saved — generate a new pick list when stock arrives.' : ''}
        </p>
      </div>`,
      icon: 'question', showCancelButton: true,
      confirmButtonColor: '#16a34a',
      confirmButtonText: pickingLines.length > 0 ? 'Yes, Confirm Pick' : 'Yes, Save Pending',
    });
    if (!res.isConfirmed) return;

    this.isConfirming.set(true);
    try {
      if (pickingLines.length > 0) {
        await this.pickListService.deductStock(
          pickingLines.map(l => ({
            styleNo: l.styleNo, color: l.color,
            size: String(l.size), sleeveType: l.sleeveType, qty: l.pickQty
          }))
        );
      }

      const mergedLines: PickListLine[] = lines.map(l => {
        const newPicked  = l.alreadyPickedQty + l.pickQty;
        const newBalance = Math.max(0, l.orderedQty - newPicked);
        return {
          salesOrderId: l.salesOrderId, salesNo: l.salesNo,
          designId: l.designId, styleNo: l.styleNo, color: l.color, group: l.group,
          size: String(l.size), sleeveType: l.sleeveType,
          orderedQty:  l.orderedQty,
          pickedQty:   newPicked,
          balanceQty:  newBalance,
          pendingQty:  l.status === 'pending' ? l.balanceQty : 0,
        } as PickListLine;
      });

      const allDone = mergedLines.every(l => l.balanceQty === 0);
      const allPend = pickingLines.length === 0 && pendingLines.length > 0;
      const plStatus: PickList['status'] = allDone ? 'Completed' : allPend ? 'Pending' : 'Partial';

      const existing = this.existingPickList();
      const primaryO = orders[0];

      if (type === 'direct' && existing) {
        await this.pickListService.updatePickList({ ...existing, status: plStatus, items: mergedLines });
      } else {
        await this.pickListService.createPickList({
          pickListNo:    `PL-${Date.now()}`, type,
          salesOrderIds: orders.map(o => o.id),
          salesNos:      orders.map(o => o.salesNo),
          clientId:      type === 'direct' ? primaryO.clientId : 'multi',
          clientName:    type === 'direct' ? this.getClientName(primaryO.clientId) : 'Multiple Clients',
          status:        plStatus, items: mergedLines,
        });
      }

      for (const order of orders) {
        const oLines = mergedLines.filter(l => l.salesOrderId === order.id);
        if (oLines.length > 0 && oLines.every(l => l.balanceQty === 0)) {
          this.salesOrderService.updateSalesOrder({ ...order, status: 'Shipped' }).subscribe();
        }
      }

      const pendingAfter = mergedLines.reduce((s, l: any) => s + (l.pendingQty || 0), 0);
      await Swal.fire({
        icon:  'success',
        title: allDone ? '✓ Pick Complete!' : allPend ? '⏳ Saved as Pending' : '✓ Pick Saved',
        html:  allDone
          ? `<p>All <strong>${this.totalPickQty()} pcs</strong> picked successfully.</p>`
          : allPend
          ? `<p><strong>${pendingAfter} pcs</strong> saved as pending. Generate a new pick list once stock arrives.</p>`
          : `<p><strong>${this.totalPickQty()} pcs</strong> picked.${pendingAfter > 0 ? `<br><span style="color:#ea580c">⚠ ${pendingAfter} pcs pending — awaiting stock.</span>` : ''}</p>`,
        timer: 3000, showConfirmButton: false,
      });
      this.cancel();
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Error', text: err?.message ?? 'Failed to confirm pick list.' });
    } finally {
      this.isConfirming.set(false);
    }
  }

  printActivePickList() {
    const orders = this.selectedOrders();
    const sizes  = this.uniqueSizesForPick();
    const map    = new Map<string, PickListLineItem[]>();
    for (const l of this.activePickLines()) {
      const key = `${l.styleNo}||${l.color}||${l.sleeveType ?? ''}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(l);
    }
    const groups = [...map.entries()].map(([key, lines]) => {
      const [styleNo, color, sleeve] = key.split('||');
      return {
        styleNo, color, sleeve: sleeve || '',
        lines: lines.map(l => ({
          size: String(l.size), orderedQty: l.orderedQty,
          pickedQty: l.pickQty, balanceQty: Math.max(0, l.balanceQty - l.pickQty)
        }))
      };
    });
    const html = this.buildPrintHtml(
      `Pick List — ${this.plTypeLabel(this.pickType())}`,
      orders.map(o => `${o.salesNo} (${this.getClientName(o.clientId)})`).join(', '),
      'Preview', this.plTypeLabel(this.pickType()),
      this.totalOrderedQty(), this.totalPickQty(), this.totalBalanceQty(), sizes, groups
    );
    const win = window.open('', '_blank', 'width=1050,height=750');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
  }

  printSavedPickList(pl: PickList) {
    const items   = pl.items;
    const sizeSet = new Set(items.map(i => String(i.size)));
    const sizes   = [...sizeSet].sort((a, b) => {
      const ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      return a.localeCompare(b, undefined, { numeric: true });
    });
    const gMap = new Map<string, PickListLine[]>();
    for (const item of items) {
      const key = `${item.styleNo}||${item.color}||${item.sleeveType ?? ''}`;
      if (!gMap.has(key)) gMap.set(key, []);
      gMap.get(key)!.push(item);
    }
    const groups = [...gMap.entries()].map(([key, lines]) => {
      const [styleNo, color, sleeve] = key.split('||');
      return {
        styleNo, color, sleeve: sleeve || '',
        lines: lines.map(l => ({
          size: String(l.size), orderedQty: l.orderedQty,
          pickedQty: l.pickedQty, balanceQty: l.balanceQty
        }))
      };
    });
    const totalOrd  = items.reduce((s, i) => s + (i.orderedQty || 0), 0);
    const totalPick = items.reduce((s, i) => s + (i.pickedQty  || 0), 0);
    const totalBal  = items.reduce((s, i) => s + (i.balanceQty || 0), 0);
    const html = this.buildPrintHtml(
      pl.pickListNo,
      `${(pl.salesNos ?? [(pl as any).salesNo ?? '']).join(', ')} · ${pl.clientName}`,
      pl.status, this.plTypeLabel(pl.type),
      totalOrd, totalPick, totalBal, sizes, groups
    );
    const win = window.open('', '_blank', 'width=1050,height=750');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
  }

  private buildPrintHtml(
    title: string, subTitle: string, status: string, type: string,
    totalOrd: number, totalPick: number, totalBal: number,
    sizes: string[],
    groups: { styleNo: string; color: string; sleeve: string;
      lines: { size: string; orderedQty: number; pickedQty: number; balanceQty: number }[] }[]
  ): string {
    const sb  = status === 'Completed' ? '#16a34a' : status === 'Pending' ? '#ea580c' : '#d97706';
    const sbg = status === 'Completed' ? '#d1fae5' : status === 'Pending' ? '#ffedd5' : '#fef3c7';
    const th  = (t: string, c = false) =>
      `<th style="padding:6px 9px;border:1px solid #ccc;text-align:${c?'center':'left'};background:#1e293b;color:#fff;font-size:11px">${t}</th>`;

    const rows = groups.map((g, i) => {
      const sc = sizes.map(sz => {
        const l = g.lines.find(x => String(x.size) === String(sz));
        if (!l) return `<td style="padding:5px 7px;border:1px solid #ddd;text-align:center;color:#ccc">—</td>`;
        return `<td style="padding:5px 7px;border:1px solid #ddd;text-align:center">
          <div style="font-size:9px;color:#94a3b8">Ord:${l.orderedQty}</div>
          <div style="font-weight:700;color:${l.pickedQty>0?'#16a34a':'#94a3b8'}">${l.pickedQty>0?l.pickedQty:'–'}</div>
          <div style="font-size:9px;color:${l.balanceQty>0?'#dc2626':'#6b7280'}">Bal:${l.balanceQty}</div>
        </td>`;
      }).join('');
      const rp = g.lines.reduce((s, l) => s + (l.pickedQty || 0), 0);
      return `<tr style="background:${i%2===0?'#fff':'#f8fafc'}">
        <td style="padding:5px 7px;border:1px solid #ddd;text-align:center;color:#64748b">${i+1}</td>
        <td style="padding:5px 7px;border:1px solid #ddd"><strong>${g.styleNo}</strong><br>
          <small style="color:#64748b">${g.color}${g.sleeve?' · '+g.sleeve:''}</small></td>
        ${sc}
        <td style="padding:5px 7px;border:1px solid #ddd;text-align:center;font-weight:700;color:#4f46e5">${rp}</td>
      </tr>`;
    }).join('');

    return `<!DOCTYPE html><html><head><title>${title}</title>
    <style>body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#1e293b}h2{margin:0}
    table{border-collapse:collapse;width:100%;margin-top:12px}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}
    .box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:6px 10px}
    .lbl{font-size:9px;color:#64748b;text-transform:uppercase}.val{font-size:13px;font-weight:600;margin-top:2px}
    tfoot td{background:#f1f5f9;font-weight:700}@media print{body{margin:8px}}</style></head><body>
    <div style="display:flex;justify-content:space-between;border-bottom:2px solid #1e293b;padding-bottom:8px">
      <div><h2>${title}</h2><p style="margin:2px 0;color:#64748b;font-size:11px">${subTitle}</p>
        <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;background:${sbg};color:${sb}">${status}</span>&nbsp;
        <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;background:#e0e7ff;color:#3730a3">${type}</span>
      </div>
      <div style="text-align:right;font-size:10px;color:#94a3b8">Printed: ${new Date().toLocaleDateString('en-IN')}</div>
    </div>
    <div class="grid">
      <div class="box"><div class="lbl">Total Ordered</div><div class="val">${totalOrd} pcs</div></div>
      <div class="box"><div class="lbl">Total Picked</div><div class="val" style="color:#16a34a">${totalPick} pcs</div></div>
      <div class="box"><div class="lbl">Balance</div><div class="val" style="color:${totalBal>0?'#dc2626':'#6b7280'}">${totalBal} pcs</div></div>
    </div>
    <table>
      <thead><tr>${th('#',true)}${th('Product')}${sizes.map(s=>th(s,true)).join('')}${th('Picked',true)}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td colspan="2" style="padding:7px 9px;border:1px solid #ddd;text-align:right">Total</td>
        ${sizes.map(sz => {
          const sp = groups.flatMap(g => g.lines).filter(l => String(l.size) === String(sz)).reduce((s, l) => s + (l.pickedQty||0), 0);
          return `<td style="padding:7px 9px;border:1px solid #ddd;text-align:center">${sp}</td>`;
        }).join('')}
        <td style="padding:7px 9px;border:1px solid #ddd;text-align:center;color:#4f46e5">${totalPick}</td>
      </tr></tfoot>
    </table>
    <div style="margin-top:24px;display:flex;justify-content:space-between;padding:0 10px">
      <div style="border-top:1px solid #333;width:150px;padding-top:5px;text-align:center;font-size:11px;color:#555">Picker</div>
      <div style="border-top:1px solid #333;width:150px;padding-top:5px;text-align:center;font-size:11px;color:#555">Verified By</div>
      <div style="border-top:1px solid #333;width:150px;padding-top:5px;text-align:center;font-size:11px;color:#555">Dispatcher</div>
    </div>
    <p style="margin-top:14px;font-size:9px;color:#94a3b8;text-align:center">
      Generated ${new Date().toLocaleString('en-IN')} · TMG Clothings</p></body></html>`;
  }
}