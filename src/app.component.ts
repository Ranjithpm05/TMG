
import { Component, ChangeDetectionStrategy, signal, inject, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ClientMasterComponent } from './components/client-master/client-master.component';
import { DesignMasterComponent } from './components/design-master/design-master.component';
import { SalesOrderComponent } from './components/sales-order/sales-order.component';
import { LoginComponent } from './components/login/login.component';
import { UserManagementComponent } from './components/user-management/user-management.component';
import { AuthService } from './services/auth.service';
import { AppScreen } from './models/user-group.model';

type View = 'sales' | 'clients' | 'designs' | 'users';

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
    UserManagementComponent
  ],
})
export class AppComponent {
  private authService = inject(AuthService);
  
  isAuthenticated = computed(() => this.authService.isAuthenticated());
  currentView = signal<View>('sales');
  isSidebarOpen = signal(false);

  constructor() {
    effect(() => {
      if (this.isAuthenticated()) {
        // After login, set the view to the first accessible screen
        if (this.canView('sales')) {
          this.setView('sales');
        } else if (this.canView('clients')) {
          this.setView('clients');
        } else if (this.canView('designs')) {
          this.setView('designs');
        } else if (this.canView('users')) {
          this.setView('users');
        } else {
          // If user has no permissions, maybe show a dedicated page or just log out.
          // For now, we just don't set a view.
        }
      }
    });
  }
  
  logout() {
    this.authService.logout();
    this.currentView.set('sales'); // Reset to default view
  }

  setView(view: View) {
    if (this.canView(view)) {
      this.currentView.set(view);
      this.isSidebarOpen.set(false); // Close sidebar on selection
    }
  }

  toggleSidebar() {
    this.isSidebarOpen.update(v => !v);
  }
  
  canView(screen: AppScreen): boolean {
    return this.authService.hasAccess(screen);
  }
}
