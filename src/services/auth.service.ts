import { Injectable, computed, signal, inject } from '@angular/core';
import { User } from '../models/user.model';
import { UserGroup, AppScreen } from '../models/user-group.model';
import { UserService } from './user.service';
import { UserGroupService } from './user-group.service';

type StoredSessionUser = Omit<User, 'passwordHash'>;

interface StoredAuthSession {
  user: StoredSessionUser;
  userGroup: UserGroup | null;
  expiresAt: number;
}

const SESSION_STORAGE_KEY = 'gom.auth.session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class AuthService {
  private userService = inject(UserService);
  private userGroupService = inject(UserGroupService);
  private sessionTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private now = signal(Date.now());

  currentUser = signal<User | null>(null);
  currentUserGroup = signal<UserGroup | null>(null);
  isAuthenticated = signal<boolean>(false);
  sessionExpiresAt = signal<number | null>(null);
  sessionRemainingMs = computed(() => {
    const expiresAt = this.sessionExpiresAt();
    if (!expiresAt) {
      return 0;
    }
    return Math.max(expiresAt - this.now(), 0);
  });

  constructor() {
    this.restoreSession();
  }
  
  private clearAuthState() {
    this.stopSessionTimer();
    this.currentUser.set(null);
    this.currentUserGroup.set(null);
    this.isAuthenticated.set(false);
    this.sessionExpiresAt.set(null);
    this.now.set(Date.now());
  }

  async login(username: string, passwordHash: string): Promise<boolean> {
    try {
        const user = await this.userService.getUserByUsername(username);
        if (user && user.status === 'Active')
        {
            // user.passwordHash is already in hand from the lookup above — comparing it
            // directly avoids an extra getUserById() round trip on every login attempt.
            const isValidPassword = user.passwordHash === passwordHash;
            if (isValidPassword) {
                const group = await this.userGroupService.getUserGroupById(user.userGroupId);
                const expiresAt = Date.now() + SESSION_DURATION_MS;
                this.currentUser.set(user);
                this.currentUserGroup.set(group ?? null);
                this.sessionExpiresAt.set(expiresAt);
                this.isAuthenticated.set(true);
                this.persistSession(user, group ?? null, expiresAt);
                this.startSessionTimer();
                return true;
            }
        }
        this.clearAuthState();
        this.clearStoredSession();
        return false;
    } 
    catch (error) {
      this.clearAuthState();
      this.clearStoredSession();
      return false;
    }
  }

  async logout(): Promise<void> {
    this.clearStoredSession();
    this.clearAuthState();
    return Promise.resolve();
  }

  hasAccess(screen: AppScreen): boolean {
    if (!this.isAuthenticated() || !this.currentUserGroup()) {
      return false;
    }

    if (screen === 'packingList') {
      return this.currentUserGroup()?.permissions.packingList
        ?? this.currentUserGroup()?.permissions.pickList
        ?? false;
    }

    return this.currentUserGroup()?.permissions[screen] ?? false;
  }

  private restoreSession(): void {
    const storedSession = this.readStoredSession();
    if (!storedSession) {
      return;
    }

    if (storedSession.expiresAt <= Date.now()) {
      this.clearStoredSession();
      return;
    }

    this.currentUser.set({
      ...storedSession.user,
      passwordHash: '',
    });
    this.currentUserGroup.set(storedSession.userGroup);
    this.sessionExpiresAt.set(storedSession.expiresAt);
    this.isAuthenticated.set(true);
    this.startSessionTimer();
  }

  private startSessionTimer(): void {
    this.stopSessionTimer();
    this.now.set(Date.now());

    this.sessionTimer = globalThis.setInterval(() => {
      const currentTime = Date.now();
      this.now.set(currentTime);

      const expiresAt = this.sessionExpiresAt();
      if (expiresAt && currentTime >= expiresAt) {
        void this.logout();
      }
    }, 1000);
  }

  private stopSessionTimer(): void {
    if (this.sessionTimer !== null) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  private persistSession(user: User, userGroup: UserGroup | null, expiresAt: number): void {
    const storage = this.getStorage();
    if (!storage) {
      return;
    }

    const { passwordHash: _passwordHash, ...userWithoutPassword } = user;
    const storedSession: StoredAuthSession = {
      user: userWithoutPassword,
      userGroup,
      expiresAt,
    };

    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(storedSession));
  }

  private readStoredSession(): StoredAuthSession | null {
    const storage = this.getStorage();
    if (!storage) {
      return null;
    }

    try {
      const rawSession = storage.getItem(SESSION_STORAGE_KEY);
      if (!rawSession) {
        return null;
      }

      const parsedSession = JSON.parse(rawSession) as Partial<StoredAuthSession>;
      if (
        !parsedSession ||
        typeof parsedSession.expiresAt !== 'number' ||
        !parsedSession.user ||
        typeof parsedSession.user.id !== 'string' ||
        typeof parsedSession.user.username !== 'string' ||
        typeof parsedSession.user.email !== 'string' ||
        typeof parsedSession.user.status !== 'string' ||
        typeof parsedSession.user.userGroupId !== 'string'
      ) {
        this.clearStoredSession();
        return null;
      }

      return {
        user: parsedSession.user as StoredSessionUser,
        userGroup: parsedSession.userGroup ?? null,
        expiresAt: parsedSession.expiresAt,
      };
    } catch {
      this.clearStoredSession();
      return null;
    }
  }

  private clearStoredSession(): void {
    this.getStorage()?.removeItem(SESSION_STORAGE_KEY);
  }

  private getStorage(): Storage | null {
    if (typeof window === 'undefined' || !window.sessionStorage) {
      return null;
    }

    return window.sessionStorage;
  }
}
