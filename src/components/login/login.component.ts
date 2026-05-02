import { Component, ChangeDetectionStrategy, signal, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { LoadingService } from '../../services/loading.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  private authService = inject(AuthService);
  private loadingService = inject(LoadingService);

  username = signal('admin');
  password = signal('123456');
  showPassword = signal(false);
  loginError = signal<string | null>(null);
  isLoading = computed(() => this.loadingService.isLoading());

  togglePasswordVisibility(): void {
    this.showPassword.update(value => !value);
  }

  async login(): Promise<void> {
    this.loginError.set(null);
    const username = this.username();
    const password = this.password();

    if (!username || !password) {
      this.loginError.set('Username and Password are required.');
      return;
    }

    await this.loadingService.run(async () => {
      const loggedIn = await this.authService.login(username, password);
      if (!loggedIn) {
        this.loginError.set('Invalid username or password.');
      }
    });
  }

  clear(): void {
    this.username.set('');
    this.password.set('');
    this.loginError.set(null);
  }
}
