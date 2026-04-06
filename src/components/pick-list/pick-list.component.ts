import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SalesOrder } from '../../models/sales-order.model';
import { InventoryItem } from '../../models/inventory.model';
import { PickList, PickListLine, PickListLineItem } from '../../models/pick-list.model';
import { SalesOrderService } from '../../services/sales-order.service';
import { InventoryService } from '../../services/inventory.service';
import { PickListService } from '../../services/pick-list.service';
import { ClientService } from '../../services/client.service';
import { Client } from '../../models/client.model';
import Swal from 'sweetalert2';

type ViewMode = 'list' | 'pick';

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

  // ── Data ─────────────────────────────────────────────────────────────────────
  mode         = signal<ViewMode>('list');
  salesOrders  = signal<SalesOrder[]>([]);
  inventory    = signal<InventoryItem[]>([]);
  clients      = signal<Client[]>([]);
  pickLists    = signal<PickList[]>([]);
  isLoading    = signal(true);
  isConfirming = signal(false);

  // ── Filters ───────────────────────────────────────────────────────────────────
  searchTerm   = signal('');
  statusFilter = signal<'all' | 'Pending' | 'Confirmed' | 'Shipped'>('all');

  // ── Active pick session ───────────────────────────────────────────────────────
  activeOrder      = signal<SalesOrder | null>(null);
  activePickLines  = signal<PickListLineItem[]>([]);
  existingPickList = signal<PickList | null>(null);

  // ── Computed ──────────────────────────────────────────────────────────────────
  filteredOrders = computed(() => {
    const term   = this.searchTerm().toLowerCase();
    const status = this.statusFilter();
    return this.salesOrders().filter(o => {
      const matchStatus = status === 'all' || o.status === status;
      const matchTerm   = !term ||
        o.salesNo.toLowerCase().includes(term) ||
        this.getClientName(o.clientId).toLowerCase().includes(term);
      return matchStatus && matchTerm;
    });
  });

  totalOrderedQty = computed(() =>
    this.activePickLines().reduce((s, l) => s + l.orderedQty, 0)
  );
  totalPickQty = computed(() =>
    this.activePickLines().reduce((s, l) => s + (l.pickQty || 0), 0)
  );
  totalBalanceQty = computed(() =>
    this.activePickLines().reduce((s, l) => s + Math.max(0, l.balanceQty - (l.pickQty || 0)), 0)
  );
  hasAnyPickable = computed(() =>
    this.activePickLines().some(l => l.pickQty > 0)
  );
  allFulfilled = computed(() =>
    this.activePickLines().every(l => l.balanceQty <= 0)
  );

  uniqueSizesForPick = computed(() => {
    const sizes = [...new Set(this.activePickLines().map(l => l.size))];
    return sizes.sort((a, b) => {
      const ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  });

  // Groups pick lines by styleNo + color + sleeveType for matrix table
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

  ngOnInit() {
    this.isLoading.set(true);
    let loaded = 0;
    const tryDone = () => { if (++loaded === 4) this.isLoading.set(false); };
    this.salesOrderService.getSalesOrders().subscribe({ next: o => { this.salesOrders.set(o); tryDone(); }, error: tryDone });
    this.inventoryService.getInventory().subscribe({  next: i => { this.inventory.set(i);    tryDone(); }, error: tryDone });
    this.clientService.getClients().subscribe({       next: c => { this.clients.set(c);      tryDone(); }, error: tryDone });
    this.pickListService.getPickLists().subscribe({   next: p => { this.pickLists.set(p);    tryDone(); }, error: tryDone });
  }

  // ── Display helpers ───────────────────────────────────────────────────────────
  getClientName(clientId: string): string {
    return this.clients().find(c => c.id === clientId)?.clientName ?? '—';
  }

  getOrderTotalQty(order: SalesOrder): number {
    return order.items.reduce((s, i) =>
      s + i.itemSizes.reduce((ss, sz) => ss + (Number(sz.quantity) || 0), 0), 0);
  }

  getPickedQtyForOrder(orderId: string): number {
    const pl = this.pickLists().find(p => p.salesOrderId === orderId);
    return pl ? pl.items.reduce((s, i) => s + (Number(i.pickedQty) || 0), 0) : 0;
  }

  getPickStatusForOrder(orderId: string): 'not_started' | 'partial' | 'completed' {
    const pl = this.pickLists().find(p => p.salesOrderId === orderId);
    if (!pl) return 'not_started';
    return pl.status === 'Completed' ? 'completed' : 'partial';
  }

  getStockForLine(styleNo: string, color: string, size: string, sleeveType?: string): number {
    const item = this.inventory().find(i =>
      i.styleNo === styleNo &&
      i.color   === color   &&
      i.size    === size    &&
      (!sleeveType || !i.sleeveType || i.sleeveType === sleeveType)
    );
    return Number(item?.currentStock) || 0;
  }

  getLineStatus(stock: number, balance: number): PickListLineItem['status'] {
    if (balance <= 0)     return 'fulfilled';
    if (stock <= 0)       return 'out_of_stock';
    if (stock >= balance) return 'available';
    return 'partial';
  }

  statusBadge(status: PickListLineItem['status']): string {
    switch (status) {
      case 'available':    return 'bg-green-100 text-green-800';
      case 'partial':      return 'bg-yellow-100 text-yellow-800';
      case 'out_of_stock': return 'bg-red-100 text-red-700';
      case 'fulfilled':    return 'bg-blue-100 text-blue-700';
    }
  }

  statusLabel(status: PickListLineItem['status']): string {
    switch (status) {
      case 'available':    return 'In Stock';
      case 'partial':      return 'Partial';
      case 'out_of_stock': return 'No Stock';
      case 'fulfilled':    return 'Done';
    }
  }

  orderPickBadge(orderId: string): string {
    const s = this.getPickStatusForOrder(orderId);
    if (s === 'completed') return 'bg-green-100 text-green-800';
    if (s === 'partial')   return 'bg-yellow-100 text-yellow-800';
    return 'bg-gray-100 text-gray-600';
  }

  orderPickLabel(orderId: string): string {
    const s = this.getPickStatusForOrder(orderId);
    if (s === 'completed') return '✓ Picked';
    if (s === 'partial')   return '◑ Partial';
    return '○ Not Picked';
  }

  formatDate(raw: any): string {
    if (!raw) return '—';
    try {
      const d = raw?.toDate ? raw.toDate() : new Date(raw);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return '—'; }
  }

  // ── Matrix table helpers ──────────────────────────────────────────────────────
  getLineForSize(lines: PickListLineItem[], size: string): PickListLineItem | undefined {
    return lines.find(l => l.size === size);
  }

  getSizeTotal(size: string): number {
    return this.activePickLines()
      .filter(l => l.size === size)
      .reduce((s, l) => s + (l.pickQty || 0), 0);
  }

  getGroupPickTotal(lines: PickListLineItem[]): number {
    return lines.reduce((s, l) => s + (l.pickQty || 0), 0);
  }

  // ── Pick session ──────────────────────────────────────────────────────────────
  async openPickList(order: SalesOrder) {
    this.activeOrder.set(order);
    const existing = await this.pickListService.getPickListBySalesOrder(order.id);
    this.existingPickList.set(existing);

    const lines: PickListLineItem[] = [];
    for (const item of order.items) {
      for (const sz of item.itemSizes) {
        const orderedQty = Number(sz.quantity) || 0;
        const alreadyPicked = existing
          ? (existing.items.find(l =>
              l.styleNo === item.design.styleNo &&
              l.color   === (item.design.color ?? '') &&
              l.size    === sz.size &&
              (l.sleeveType ?? '') === (item.sleeveType ?? '')
            )?.pickedQty ?? 0)
          : 0;
        const balance = Math.max(0, orderedQty - alreadyPicked);
        const stock   = this.getStockForLine(
          item.design.styleNo, item.design.color ?? '', sz.size, item.sleeveType
        );
        const status  = this.getLineStatus(stock, balance);
        const defaultPick = balance > 0 ? Math.min(balance, stock) : 0;

        lines.push({
          designId:         item.design.id ?? '',
          styleNo:          item.design.styleNo,
          color:            item.design.color ?? '',
          group:            item.design.group ?? '',
          size:             sz.size,
          sleeveType:       item.sleeveType,
          orderedQty,
          alreadyPickedQty: alreadyPicked,
          balanceQty:       balance,
          stockAvailable:   stock,
          pickQty:          defaultPick,
          status,
        });
      }
    }
    this.activePickLines.set(lines);
    this.mode.set('pick');
  }

  setPickQty(line: PickListLineItem, value: string | number) {
    const raw = typeof value === 'string' ? parseInt(value, 10) : Number(value);
    const qty = isNaN(raw) ? 0 : Math.max(0, Math.min(raw, Math.min(line.balanceQty, line.stockAvailable)));
    this.activePickLines.update(lines => lines.map(l =>
      l.styleNo === line.styleNo && l.color === line.color &&
      l.size === line.size && (l.sleeveType ?? '') === (line.sleeveType ?? '')
        ? { ...l, pickQty: qty } : l
    ));
  }

  incrementPickQty(line: PickListLineItem) {
    const max = Math.min(line.balanceQty, line.stockAvailable);
    this.setPickQty(line, Math.min(line.pickQty + 1, max));
  }

  decrementPickQty(line: PickListLineItem) {
    this.setPickQty(line, Math.max(0, line.pickQty - 1));
  }

  setAllToMax() {
    this.activePickLines.update(lines =>
      lines.map(l => ({ ...l, pickQty: Math.min(l.balanceQty, l.stockAvailable) }))
    );
  }

  clearAll() {
    this.activePickLines.update(lines => lines.map(l => ({ ...l, pickQty: 0 })));
  }

  cancel() {
    this.mode.set('list');
    this.activeOrder.set(null);
    this.activePickLines.set([]);
    this.existingPickList.set(null);
  }

  // ── Confirm pick ──────────────────────────────────────────────────────────────
  async confirmPick() {
    const order = this.activeOrder();
    const lines = this.activePickLines();
    if (!order) return;

    const pickingLines = lines.filter(l => l.pickQty > 0);
    if (!pickingLines.length) {
      Swal.fire({ icon: 'warning', title: 'Nothing to Pick', text: 'Set a pick quantity for at least one item.' });
      return;
    }

    const res = await Swal.fire({
      title:             'Confirm Pick List?',
      html:              `<p>Picking <strong>${this.totalPickQty()} pcs</strong> for <strong>${order.salesNo}</strong>.</p><p class="text-sm text-gray-500 mt-1">Inventory stock will be reduced.</p>`,
      icon:              'question',
      showCancelButton:  true,
      confirmButtonColor:'#16a34a',
      confirmButtonText: 'Yes, Confirm Pick',
    });
    if (!res.isConfirmed) return;

    this.isConfirming.set(true);
    try {
      // 1. Deduct from inventory
      await this.pickListService.deductStock(
        pickingLines.map(l => ({
          styleNo: l.styleNo, color: l.color, size: l.size,
          sleeveType: l.sleeveType, qty: l.pickQty
        }))
      );

      // 2. Build merged PickList lines
      const existing     = this.existingPickList();
      const mergedLines: PickListLine[] = lines.map(l => ({
        designId:   l.designId,
        styleNo:    l.styleNo,
        color:      l.color,
        group:      l.group,
        size:       l.size,
        sleeveType: l.sleeveType,
        orderedQty: l.orderedQty,
        pickedQty:  l.alreadyPickedQty + l.pickQty,
        balanceQty: Math.max(0, l.orderedQty - (l.alreadyPickedQty + l.pickQty)),
      }));

      const allDone    = mergedLines.every(l => l.balanceQty === 0);
      const plStatus: PickList['status'] = allDone ? 'Completed' : 'Partial';

      if (existing) {
        await this.pickListService.updatePickList({ ...existing, status: plStatus, items: mergedLines });
      } else {
        await this.pickListService.createPickList({
          pickListNo:   `PL-${Date.now()}`,
          salesOrderId: order.id,
          salesNo:      order.salesNo,
          clientId:     order.clientId,
          clientName:   this.getClientName(order.clientId),
          status:       plStatus,
          items:        mergedLines,
        });
      }

      // 3. Update SalesOrder status if fully picked
      if (allDone) {
        this.salesOrderService.updateSalesOrder({ ...order, status: 'Shipped' }).subscribe();
      }

      await Swal.fire({
        icon:  'success',
        title: allDone ? '✓ Fully Picked!' : '✓ Pick Saved',
        text:  allDone
          ? `All ${this.totalPickQty()} pcs picked. Order marked as Shipped.`
          : `${this.totalPickQty()} pcs picked. ${this.totalBalanceQty()} pcs balance.`,
        timer: 2500, showConfirmButton: false,
      });
      this.cancel();
    } catch (err: any) {
      Swal.fire({ icon: 'error', title: 'Error', text: err?.message ?? 'Failed to confirm pick list.' });
    } finally {
      this.isConfirming.set(false);
    }
  }

  // ── Print pick list ───────────────────────────────────────────────────────────
  printPickList() {
    const order  = this.activeOrder();
    const groups = this.pickGroups();
    const sizes  = this.uniqueSizesForPick();
    if (!order) return;

    const th = (t: string, c = false) =>
      `<th style="padding:7px 10px;border:1px solid #ccc;text-align:${c?'center':'left'};background:#1e293b;color:#fff;font-size:11px">${t}</th>`;

    const rowsHtml = groups.map((g, idx) => {
      const sizeCells = sizes.map(sz => {
        const l = g.lines.find(x => x.size === sz);
        if (!l) return `<td style="padding:6px 8px;border:1px solid #ddd;text-align:center;color:#ccc">—</td>`;
        const pick = l.pickQty > 0 ? `<strong>${l.pickQty}</strong>` : '–';
        const bal  = Math.max(0, l.balanceQty - l.pickQty);
        return `<td style="padding:6px 8px;border:1px solid #ddd;text-align:center">
          ${pick}<br><small style="color:#64748b;font-size:9px">bal:${bal}</small>
        </td>`;
      }).join('');
      const totalPick = g.lines.reduce((s, l) => s + l.pickQty, 0);
      return `<tr style="background:${idx%2===0?'#fff':'#f8fafc'}">
        <td style="padding:6px 8px;border:1px solid #ddd;text-align:center">${idx+1}</td>
        <td style="padding:6px 8px;border:1px solid #ddd">
          <strong>${g.styleNo}</strong><br>
          <small style="color:#64748b">${g.color}${g.sleeve?' · '+g.sleeve:''}</small>
        </td>
        ${sizeCells}
        <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;font-weight:700">${totalPick}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><title>Pick List - ${order.salesNo}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#1e293b}
      h2{margin:0} table{border-collapse:collapse;width:100%;margin-top:12px}
      .info{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}
      .box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:6px 10px}
      .lbl{font-size:9px;color:#64748b;text-transform:uppercase}
      .val{font-size:13px;font-weight:600;margin-top:1px}
      @media print{body{margin:8px}}
    </style></head><body>
    <div style="display:flex;justify-content:space-between;border-bottom:2px solid #1e293b;padding-bottom:8px">
      <div><h2>Pick List</h2><p style="margin:2px 0;color:#64748b;font-size:11px">${order.salesNo} · ${this.getClientName(order.clientId)}</p></div>
      <div style="text-align:right;font-size:11px;color:#64748b">
        <div>Date: ${new Date().toLocaleDateString('en-IN')}</div>
        <div>Delivery: ${order.deliveryDate}</div>
      </div>
    </div>
    <div class="info">
      <div class="box"><div class="lbl">Total Ordered</div><div class="val">${this.totalOrderedQty()} pcs</div></div>
      <div class="box"><div class="lbl">Picking Now</div><div class="val">${this.totalPickQty()} pcs</div></div>
      <div class="box"><div class="lbl">Balance After</div><div class="val">${this.totalBalanceQty()} pcs</div></div>
    </div>
    <table>
      <thead><tr>${th('#',true)}${th('Product')}${sizes.map(s=>th(s,true)).join('')}${th('Pick Qty',true)}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div style="margin-top:24px;display:flex;justify-content:space-between;padding:0 10px">
      <div style="border-top:1px solid #333;width:180px;padding-top:5px;text-align:center;font-size:11px;color:#555">Picker Signature</div>
      <div style="border-top:1px solid #333;width:180px;padding-top:5px;text-align:center;font-size:11px;color:#555">Verified By</div>
    </div>
    <p style="margin-top:16px;font-size:10px;color:#94a3b8;text-align:right">
      Generated ${new Date().toLocaleString('en-IN')} · TMG Clothings
    </p>
    </body></html>`;

    const win = window.open('', '_blank', 'width=1050,height=750');
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 600); }
  }
}