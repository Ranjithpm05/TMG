import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { User } from '../../models/user.model';
import { UserGroup, AppScreen, ALL_SCREENS } from '../../models/user-group.model';
import { UserService } from '../../services/user.service';
import { UserGroupService } from '../../services/user-group.service';
import { AuthService } from '../../services/auth.service';
import Swal from 'sweetalert2';

type ActiveTab = 'users' | 'groups';
const EMPTY_USER: Omit<User, 'id'> = {username: '', email: '', passwordHash: '', status: 'Active', userGroupId: '' };
const EMPTY_GROUP: Omit<UserGroup, 'id'> = { name: '', permissions: {} };

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './user-management.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserManagementComponent implements OnInit {
  private userService = inject(UserService);
  private userGroupService = inject(UserGroupService);
  private authService = inject(AuthService);

  activeTab = signal<ActiveTab>('users');

  // Users State
  users = signal<User[]>([]);
  userFormVisible = signal(false);
  editableUser = signal<User | Omit<User, 'id'>>(EMPTY_USER);
  isUserEditMode = computed(() => 'id' in this.editableUser());

  // Groups State
  userGroups = signal<UserGroup[]>([]);
  groupFormVisible = signal(false);
  editableGroup = signal<UserGroup | Omit<UserGroup, 'id'>>(EMPTY_GROUP);
  isGroupEditMode = computed(() => 'id' in this.editableGroup());

  // For template access
  readonly allScreens = ALL_SCREENS;

  // --- Super Admin RBAC ---
  // NOTE: this app has no Firebase Auth and firestore.rules is fully open
  // (`allow read, write: if true`). Every check below is application-layer only,
  // consistent with how all other permissions in this app are enforced (see
  // AuthService.hasAccess / AppComponent.canView) — it stops accidental misuse
  // from the UI, not a determined attacker calling Firestore directly.
  readonly superAdminGroupIds = computed(() =>
    new Set(this.userGroups().filter(g => g.isSuperAdmin).map(g => g.id))
  );
  // Whether a Super Admin *user* exists yet — deliberately not "does the group exist",
  // since the Super Admin group can be created by a bootstrap admin before anyone is
  // assigned to it. Gating on the group alone would lock everyone out of ever assigning
  // that first Super Admin user once the (empty) group exists.
  readonly hasAnySuperAdminUser = computed(() => this.users().some(u => this.isUserSuperAdmin(u)));
  readonly isCurrentUserSuperAdmin = computed(() => this.authService.currentUserGroup()?.isSuperAdmin === true);
  // One-time bootstrap allowance: before any Super Admin user exists, any admin may
  // create the Super Admin group and/or assign the first user to it. Once a Super
  // Admin user exists, only a real Super Admin may manage Super Admin groups/accounts.
  readonly canManageSuperAdmins = computed(() => this.isCurrentUserSuperAdmin() || !this.hasAnySuperAdminUser());
  readonly selectableGroupsForUserForm = computed(() => {
    const groups = this.userGroups();
    return this.canManageSuperAdmins() ? groups : groups.filter(g => !g.isSuperAdmin);
  });

  isUserSuperAdmin(user: User): boolean {
    return this.superAdminGroupIds().has(user.userGroupId);
  }

  isProtectedGroup(group: UserGroup): boolean {
    return group.isSuperAdmin === true;
  }

  private assertCanManageUser(user: User): boolean {
    if (this.isUserSuperAdmin(user) && !this.canManageSuperAdmins()) {
      Swal.fire({
        icon: 'error',
        title: 'Not Allowed',
        text: 'Only Super Admin users can manage Super Admin accounts.'
      });
      return false;
    }
    return true;
  }

  ngOnInit() {
    this.loadUsers();
    this.loadUserGroups();
  }

  // --- General ---
  setTab(tab: ActiveTab) {
    this.activeTab.set(tab);
    this.cancelForms();
  }

  private cancelForms() {
    this.userFormVisible.set(false);
    this.groupFormVisible.set(false);
    this.editableUser.set(EMPTY_USER);
    this.editableGroup.set(EMPTY_GROUP);
  }

  // --- User Management Logic ---
  loadUsers() {
    this.userService.getUsers().subscribe(u => this.users.set(u));
  }
  
  getGroupName(groupId: string): string {
    return this.userGroups().find(g => g.id === groupId)?.name ?? 'N/A';
  }

  showAddUserForm() {
    this.editableUser.set({ ...EMPTY_USER });
    this.userFormVisible.set(true);
  }

  showEditUserForm(user: User) {
    if (!this.assertCanManageUser(user)) return;
    this.editableUser.set({ ...user });
    this.userFormVisible.set(true);
  }

    async saveUser() {
        const userData = this.editableUser();
        if (this.isUserEditMode() && !this.assertCanManageUser(userData as User)) return;
        if (this.superAdminGroupIds().has(userData.userGroupId) && !this.canManageSuperAdmins()) {
            Swal.fire({
                icon: 'error',
                title: 'Not Allowed',
                text: 'Only Super Admin users can assign the Super Admin group.'
            });
            return;
        }
        try
        {
            Swal.fire({
                title: this.isUserEditMode() ? 'Updating User...' : 'Creating User...',
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            });
            if (this.isUserEditMode()) {
                await this.userService.updateUser(userData as User)
                await Swal.fire({
                    icon: 'success',
                    title: 'Updated!',
                    text: 'User updated successfully',
                    timer: 2000,
                    showConfirmButton: false
                });
                this.onUserSaveSuccess()
            } 
            else 
            {
                const { id, ...newUser } = userData as User;
                await this.userService.createUser(newUser)
                await Swal.fire({
                    icon: 'success',
                    title: 'Created!',
                    text: 'User created successfully',
                    timer: 2000,
                    showConfirmButton: false
                });
                this.onUserSaveSuccess()
            }
        }
        catch (error) {
            Swal.fire({
            icon: 'error',
            title: 'Error',
            text: error.message
            });
        }
        
    }
  
    private onUserSaveSuccess() {
        this.loadUsers();
        this.cancelForms();
    }

    async deleteUser(user: User)
    {
        if (!this.assertCanManageUser(user)) return;

        if (this.isUserSuperAdmin(user) && this.users().filter(u => this.isUserSuperAdmin(u)).length <= 1) {
            Swal.fire({
                icon: 'error',
                title: 'Not Allowed',
                text: 'Cannot delete the last Super Admin account.'
            });
            return;
        }

        const result = await Swal.fire({
            title: 'Are you sure?',
            text: `Delete user "${user.username}"?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#dc2626',
            cancelButtonColor: '#6b7280',
            confirmButtonText: 'Yes, delete it',
            cancelButtonText: 'Cancel'
        });

        if (!result.isConfirmed) return;

        try {
            Swal.fire({
                title: 'Deleting...',
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            });

            await this.userService.deleteUser(user.id);

            await Swal.fire({
                icon: 'success',
                title: 'Deleted!',
                text: 'User deleted successfully',
                timer: 2000,
                showConfirmButton: false
            });
            this.loadUsers()

        } catch (error) {
            console.error(error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to delete User'
            });
        }
    }

    async resetPassword(user: User) {
        if (!this.assertCanManageUser(user)) return;

        const { value: formValues } = await Swal.fire({
            title: `Reset Password`,
            html:
                `<p class="swal2-html-container" style="margin-bottom:1em;">Set a new password for "${user.username}"</p>` +
                '<input id="swal-new-password" type="password" class="swal2-input" placeholder="New password (min 6 characters)" minlength="6">' +
                '<input id="swal-confirm-password" type="password" class="swal2-input" placeholder="Confirm password" minlength="6">',
            focusConfirm: false,
            showCancelButton: true,
            confirmButtonText: 'Reset Password',
            preConfirm: () => {
                const newPassword = (document.getElementById('swal-new-password') as HTMLInputElement)?.value ?? '';
                const confirmPassword = (document.getElementById('swal-confirm-password') as HTMLInputElement)?.value ?? '';

                if (newPassword.length < 6) {
                    Swal.showValidationMessage('Password must be at least 6 characters');
                    return;
                }
                if (newPassword !== confirmPassword) {
                    Swal.showValidationMessage('Passwords do not match');
                    return;
                }
                return { newPassword };
            }
        });

        if (!formValues) return;

        try {
            Swal.fire({
                title: 'Resetting Password...',
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            });

            await this.userService.resetPassword(user.id, formValues.newPassword);

            await Swal.fire({
                icon: 'success',
                title: 'Password Reset',
                text: `Password updated for "${user.username}"`,
                timer: 2000,
                showConfirmButton: false
            });
        } catch (error) {
            console.error(error);
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'Failed to reset password'
            });
        }
    }


    // --- User Group Management Logic ---
    loadUserGroups() {
        this.userGroupService.getGroups().subscribe(g => this.userGroups.set(g));
    }

    showAddGroupForm() {
        this.editableGroup.set(JSON.parse(JSON.stringify(EMPTY_GROUP)));
        this.groupFormVisible.set(true);
    }

    showEditGroupForm(group: UserGroup) {
        if (this.isProtectedGroup(group) && !this.canManageSuperAdmins()) {
            Swal.fire({
                icon: 'error',
                title: 'Not Allowed',
                text: 'Only Super Admin users can edit the Super Admin role.'
            });
            return;
        }
        this.editableGroup.set(JSON.parse(JSON.stringify(group))); // Deep copy
        this.groupFormVisible.set(true);
    }

    async saveGroup()
    {
        const groupData = this.editableGroup();
        if (groupData.isSuperAdmin && !this.canManageSuperAdmins()) {
            Swal.fire({
                icon: 'error',
                title: 'Not Allowed',
                text: 'Only Super Admin users can create or edit the Super Admin role.'
            });
            return;
        }
        try
        {
            Swal.fire({
                title: this.isGroupEditMode() ? 'Updating User Group...' : 'Creating User Group...',
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            });
             
            if (this.isGroupEditMode()) 
            {
                await this.userGroupService.updateGroup(groupData as UserGroup)
                await Swal.fire({
                    icon: 'success',
                    title: 'Updated!',
                    text: 'User Group updated successfully',
                    timer: 2000,
                    showConfirmButton: false
                });
                this.onGroupSaveSuccess()
            } 
            else
            {
                const { id, ...newGroup } = groupData as UserGroup;
                await this.userGroupService.createGroup(newGroup)
                await Swal.fire({
                    icon: 'success',
                    title: 'Created!',
                    text: 'User Group created successfully',
                    timer: 2000,
                    showConfirmButton: false
                });
                this.onGroupSaveSuccess()
            }
        }
        catch (error) 
        {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.message
            });
        }
    }

  private onGroupSaveSuccess() {
    this.loadUserGroups();
    this.cancelForms();
  }

    async deleteGroup(group: UserGroup)
    {
        if (this.isProtectedGroup(group)) {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: 'The Super Admin role is protected and cannot be deleted.'
            });
            return;
        }

        if (this.isGroupInUse(group.id)) {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: `Cannot delete "${group.name}" because it is currently assigned to one or more users.`
            });
            return;
        }
        

        const result = await Swal.fire({
            title: 'Are you sure?',
            text: `Delete group ${group.name}?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#dc2626',
            cancelButtonColor: '#6b7280',
            confirmButtonText: 'Yes, delete it',
            cancelButtonText: 'Cancel'
        });

        if (!result.isConfirmed) return;

        try {
            Swal.fire({
                title: 'Deleting...',
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            });

            await this.userGroupService.deleteGroup(group.id);

            await Swal.fire({
                icon: 'success',
                title: 'Deleted!',
                text: 'User Group deleted successfully',
                timer: 2000,
                showConfirmButton: false
            });
            this.loadUserGroups()

        } catch (error) {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: error.message
            });
        }
    }

    togglePermission(screenId: AppScreen) {
        if (this.editableGroup().isSuperAdmin) return; // permissions are locked to "all" for the Super Admin role
        this.editableGroup.update(group => {
        const newPermissions = { ...group.permissions };
        newPermissions[screenId] = !newPermissions[screenId];
        return { ...group, permissions: newPermissions };
        });
    }

    toggleSuperAdmin() {
        this.editableGroup.update(group => {
            const isSuperAdmin = !group.isSuperAdmin;
            const permissions = isSuperAdmin
                ? Object.fromEntries(this.allScreens.map(s => [s.id, true])) as Partial<Record<AppScreen, boolean>>
                : group.permissions;
            return { ...group, isSuperAdmin, permissions };
        });
    }

    isGroupInUse(groupId: string): boolean {
        return this.users().some(u => u.userGroupId === groupId);
    }
}
