import { Component, ChangeDetectionStrategy, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  private authService = inject(AuthService);

  username = signal('admin');
  password = signal('123456');
  showPassword = signal(false);
  loginError = signal<string | null>(null);

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

    try {
      const loggedIn = await this.authService.login(username, password);
      if (!loggedIn) {
        this.loginError.set('Invalid username or password.');
      }
      // On successful login, the AuthService's isAuthenticated signal will trigger the view change in app.component
    } catch (error) {
      this.loginError.set('An unexpected error occurred during login.');
      console.error(error);
    }
  }

  clear(): void {
    this.username.set('');
    this.password.set('');
    this.loginError.set(null);
  }
}
