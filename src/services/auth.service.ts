import { Injectable, signal, inject } from '@angular/core';
import { User } from '../models/user.model';
import { UserGroup, AppScreen } from '../models/user-group.model';
import { UserService } from './user.service';
import { UserGroupService } from './user-group.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private userService = inject(UserService);
  private userGroupService = inject(UserGroupService);

  currentUser = signal<User | null>(null);
  currentUserGroup = signal<UserGroup | null>(null);
  isAuthenticated = signal<boolean>(false);

  constructor() {
    // constructor is empty as we are not listening to firebase auth state anymore
  }
  
  private clearAuthState() {
    this.currentUser.set(null);
    this.currentUserGroup.set(null);
    this.isAuthenticated.set(false);
  }

  async login(username: string, passwordHash: string): Promise<boolean> {
    try {
        const user = await this.userService.getUserByUsername(username);
        if (user && user.status === 'Active') 
        {
            const isValidPassword = await this.userService.validatePassword(user.id, passwordHash)
            if (isValidPassword) {
                const group = await this.userGroupService.getUserGroupById(user.userGroupId)
                this.currentUser.set(user);
                this.currentUserGroup.set(group ?? null);
                this.isAuthenticated.set(true);
                return true;
            }
        }
        this.clearAuthState();
        return false;
    } 
    catch (error) {
      this.clearAuthState();
      return false;
    }
  }

  async logout(): Promise<void> {
    this.clearAuthState();
    return Promise.resolve();
  }

  hasAccess(screen: AppScreen): boolean {
    if (!this.isAuthenticated() || !this.currentUserGroup()) {
      return false;
    }
    return this.currentUserGroup()?.permissions[screen] ?? false;
  }
}
