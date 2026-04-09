import { Component, ChangeDetectionStrategy, signal, inject, computed, effect, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ClientMasterComponent } from './components/client-master/client-master.component';
import { DesignMasterComponent } from './components/design-master/design-master.component';
import { SalesOrderComponent } from './components/sales-order/sales-order.component';
import { LoginComponent } from './components/login/login.component';
import { UserManagementComponent } from './components/user-management/user-management.component';
import { GoodsInwardComponent } from './components/goods-inward/goods-inward.component';
import { AuthService } from './services/auth.service';
import { AppScreen } from './models/user-group.model';
import { InventoryComponent } from './components/inventory/inventory.component';
import { PickListComponent } from './components/pick-list/pick-list.component';

type View = 'sales' | 'clients' | 'designs' | 'users' | 'goodsInward' | 'inventory' | 'pickList';
type ViewHistoryState = { view: View };

const VIEW_STORAGE_KEY = 'gom.activeView';
const VIEW_SEQUENCE: View[] = ['sales', 'clients', 'designs', 'goodsInward', 'users', 'inventory', 'pickList'];

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
  ],
})
export class AppComponent {
  private authService = inject(AuthService);

  isAuthenticated = computed(() => this.authService.isAuthenticated());
  currentView = signal<View>('sales');
  isSidebarOpen = signal(false);

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
      if (this.canView(activeView)) {
        return;
      }

      const fallbackView = this.resolveAccessibleView(activeView);
      if (fallbackView) {
        this.applyView(fallbackView, 'replace');
      }
    });
  }

  logout() {
    void this.authService.logout();
  }

  setView(view: View) {
    if (!this.canView(view)) {
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
    if (preferredView && this.canView(preferredView)) {
      return preferredView;
    }

    for (const view of VIEW_SEQUENCE) {
      if (this.canView(view)) {
        return view;
      }
    }

    return null;
  }

  private resetToLoggedOutState(): void {
    this.currentView.set('sales');
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
