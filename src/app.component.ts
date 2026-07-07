import { Component, ChangeDetectionStrategy, signal, inject, computed, effect, untracked, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ClientMasterComponent } from './components/client-master/client-master.component';
import { DesignMasterComponent } from './components/design-master/design-master.component';
import { SalesOrderComponent } from './components/sales-order/sales-order.component';
import { LoginComponent } from './components/login/login.component';
import { UserManagementComponent } from './components/user-management/user-management.component';
import { GoodsInwardComponent } from './components/goods-inward/goods-inward.component';
import { AuthService } from './services/auth.service';
import { LoadingService } from './services/loading.service';
import { AppScreen } from './models/user-group.model';
import { InventoryComponent } from './components/inventory/inventory.component';
import { PickListComponent } from './components/pick-list/pick-list.component';
import { PackingListComponent } from './components/packing-list/packing-list.component';
import { DashboardComponent } from './components/dashboard/dashboard.component';
import { EInvoiceComponent } from './components/einvoice/einvoice.component';
import { ReportsComponent } from './components/reports/reports.component';

type View = 'dashboard' | 'sales' | 'clients' | 'designs' | 'users' | 'goodsInward' | 'inventory' | 'pickList' | 'packingList' | 'einvoice' | 'reports';
type ViewHistoryState = { view: View };

interface NavItem {
  view: View;
  label: string;
  screen: AppScreen | null;
  iconPaths: string[];
}

interface NavGroup {
  id: string;
  label: string;
  iconPaths: string[];
  items: NavItem[];
}

const VIEW_STORAGE_KEY = 'gom.activeView';
const VIEW_SEQUENCE: View[] = ['dashboard', 'sales', 'clients', 'designs', 'goodsInward', 'users', 'inventory', 'pickList', 'packingList', 'einvoice', 'reports'];

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    iconPaths: ['M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-10h8V3h-8v8z'],
    items: [
      { view: 'dashboard', label: 'Dashboard', screen: null, iconPaths: ['M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-10h8V3h-8v8z'] },
      { view: 'reports', label: 'Reports', screen: 'reports', iconPaths: ['M11 3.055A9 9 0 1020.945 13H11V3.055z', 'M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z'] },
    ],
  },
  {
    id: 'sales',
    label: 'Sales & Clients',
    iconPaths: ['M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2'],
    items: [
      { view: 'sales', label: 'Sales Order', screen: 'sales', iconPaths: ['M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2'] },
      { view: 'clients', label: 'Client Master', screen: 'clients', iconPaths: ['M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.653-.084-1.28-.24-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.653.084-1.28.24-1.857m10.514-6.32a4 4 0 10-5.028 0m5.028 0a4 4 0 11-5.028 0M7 11a4 4 0 100-8 4 4 0 000 8z'] },
    ],
  },
  {
    id: 'catalog',
    label: 'Catalog',
    iconPaths: ['M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01'],
    items: [
      { view: 'designs', label: 'Design Master', screen: 'designs', iconPaths: ['M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01'] },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory & Fulfilment',
    iconPaths: ['M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4'],
    items: [
      { view: 'goodsInward', label: 'Goods Inward', screen: 'goodsInward', iconPaths: ['M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4'] },
      { view: 'inventory', label: 'Inventory', screen: 'inventory', iconPaths: ['M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4'] },
      { view: 'pickList', label: 'Pick List', screen: 'pickList', iconPaths: ['M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4'] },
      { view: 'packingList', label: 'Packing List', screen: 'packingList', iconPaths: ['M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M8 9l8 4'] },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    iconPaths: ['M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'],
    items: [
      { view: 'einvoice', label: 'E-Invoice', screen: 'einvoice', iconPaths: ['M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'] },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    iconPaths: [
      'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
      'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    ],
    items: [
      { view: 'users', label: 'User Management', screen: 'users', iconPaths: ['M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.653-.084-1.28-.24-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.653.084-1.28.24-1.857m10.514-6.32a4 4 0 10-5.028 0m5.028 0a4 4 0 11-5.028 0M7 11a4 4 0 100-8 4 4 0 000 8z'] },
    ],
  },
];

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [
    CommonModule,
    ClientMasterComponent,
    DesignMasterComponent,
    SalesOrderComponent,
    LoginComponent,
    UserManagementComponent,
    GoodsInwardComponent,
    InventoryComponent,
    PickListComponent,
    PackingListComponent,
    DashboardComponent,
    EInvoiceComponent,
    ReportsComponent,
  ],
})
export class AppComponent {
  private authService = inject(AuthService);
  protected loadingService = inject(LoadingService);

  isAuthenticated = computed(() => this.authService.isAuthenticated());
  currentView = signal<View>('dashboard');
  isSidebarOpen = signal(false);

  private readonly expandedGroups = signal<Set<string>>(new Set(NAV_GROUPS.map((g) => g.id)));

  readonly visibleGroups = computed(() =>
    NAV_GROUPS
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => !item.screen || this.canView(item.screen)),
      }))
      .filter((group) => group.items.length > 0)
  );

  constructor() {
    const savedView = this.readStoredView();
    if (savedView) {
      this.currentView.set(savedView);
    }

    effect(() => {
      if (this.isAuthenticated()) {
        const resolvedView = this.resolveAccessibleView(this.currentView());
        if (resolvedView) {
          this.applyView(resolvedView, 'replace');
        }
        return;
      }

      this.resetToLoggedOutState();
    });

    effect(() => {
      if (!this.isAuthenticated()) {
        return;
      }

      const activeView = this.currentView();
      if (this.canAccessView(activeView)) {
        return;
      }

      const fallbackView = this.resolveAccessibleView(activeView);
      if (fallbackView) {
        this.applyView(fallbackView, 'replace');
      }
    });

    // Keep the section containing the active screen expanded so users always see where they are.
    effect(() => {
      const view = this.currentView();
      const groupId = NAV_GROUPS.find((g) => g.items.some((i) => i.view === view))?.id;
      if (!groupId) return;

      const alreadyExpanded = untracked(() => this.expandedGroups().has(groupId));
      if (!alreadyExpanded) {
        this.expandedGroups.update((set) => new Set(set).add(groupId));
      }
    });
  }

  toggleGroup(groupId: string): void {
    this.expandedGroups.update((set) => {
      const next = new Set(set);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  isGroupExpanded(groupId: string): boolean {
    return this.expandedGroups().has(groupId);
  }

  isGroupActive(group: NavGroup): boolean {
    return group.items.some((item) => item.view === this.currentView());
  }

  logout() {
    void this.authService.logout();
  }

  setView(view: View) {
    if (!this.canAccessView(view)) {
      return;
    }

    this.isSidebarOpen.set(false);
    if (this.currentView() === view) {
      this.applyView(view, 'replace');
      return;
    }

    this.applyView(view, 'push');
  }

  toggleSidebar() {
    this.isSidebarOpen.update(v => !v);
  }

  canView(screen: AppScreen): boolean {
    return this.authService.hasAccess(screen);
  }

  canAccessView(view: View): boolean {
    return view === 'dashboard' ? this.isAuthenticated() : this.canView(view);
  }

  @HostListener('window:popstate', ['$event'])
  handlePopState(event: PopStateEvent): void {
    this.isSidebarOpen.set(false);

    if (!this.isAuthenticated()) {
      this.resetToLoggedOutState();
      return;
    }

    const historyView = this.extractViewFromState(event.state);
    const targetView = this.resolveAccessibleView(historyView ?? this.currentView());
    if (!targetView) {
      return;
    }

    if (!historyView || historyView !== targetView) {
      this.applyView(targetView, 'replace');
      return;
    }

    this.currentView.set(targetView);
    this.persistView(targetView);
  }

  private applyView(view: View, historyMode: 'push' | 'replace'): void {
    if (!this.isAuthenticated()) {
      this.resetToLoggedOutState();
      return;
    }

    this.currentView.set(view);
    this.persistView(view);

    if (historyMode === 'push') {
      this.writeHistoryState(view, 'push');
      return;
    }

    this.writeHistoryState(view, 'replace');
  }

  private resolveAccessibleView(preferredView: View | null): View | null {
    if (preferredView && this.canAccessView(preferredView)) {
      return preferredView;
    }

    for (const view of VIEW_SEQUENCE) {
      if (this.canAccessView(view)) {
        return view;
      }
    }

    return null;
  }

  private resetToLoggedOutState(): void {
    this.currentView.set('dashboard');
    this.isSidebarOpen.set(false);
    this.clearStoredView();
    this.clearHistoryState();
  }

  private writeHistoryState(view: View, mode: 'push' | 'replace'): void {
    if (typeof window === 'undefined') {
      return;
    }

    const state: ViewHistoryState = { view };
    if (mode === 'push') {
      window.history.pushState(state, '', window.location.href);
      return;
    }

    window.history.replaceState(state, '', window.location.href);
  }

  private clearHistoryState(): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.history.replaceState(null, '', window.location.href);
  }

  private extractViewFromState(state: unknown): View | null {
    if (!state || typeof state !== 'object' || !('view' in state)) {
      return null;
    }

    const { view } = state as Partial<ViewHistoryState>;
    return typeof view === 'string' && VIEW_SEQUENCE.includes(view as View) ? (view as View) : null;
  }

  private persistView(view: View): void {
    this.getStorage()?.setItem(VIEW_STORAGE_KEY, view);
  }

  private readStoredView(): View | null {
    const storedView = this.getStorage()?.getItem(VIEW_STORAGE_KEY);
    return typeof storedView === 'string' && VIEW_SEQUENCE.includes(storedView as View) ? (storedView as View) : null;
  }

  private clearStoredView(): void {
    this.getStorage()?.removeItem(VIEW_STORAGE_KEY);
  }

  private getStorage(): Storage | null {
    if (typeof window === 'undefined' || !window.sessionStorage) {
      return null;
    }

    return window.sessionStorage;
  }
}
