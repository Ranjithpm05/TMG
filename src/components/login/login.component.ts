import { Component, ChangeDetectionStrategy, signal, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { LoadingService } from '../../services/loading.service';
import { firestoreHealth } from '../../services/firestore-health';

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

  username = signal('');
  password = signal('');
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
        // A refused/unreachable user lookup also returns false — don't blame the password for it.
        const db = firestoreHealth();
        this.loginError.set(
          db === 'quota-exceeded' ? 'Cannot sign in right now: the database limit has been reached. Please try again later.'
          : db === 'offline' ? 'Cannot reach the database. Check the connection and try again.'
          : 'Invalid username or password.'
        );
      }
    });
  }

  clear(): void {
    this.username.set('');
    this.password.set('');
    this.loginError.set(null);
  }
}
