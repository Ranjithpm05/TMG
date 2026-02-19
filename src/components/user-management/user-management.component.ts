import { Component, ChangeDetectionStrategy, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { User } from '../../models/user.model';
import { UserGroup, AppScreen, ALL_SCREENS } from '../../models/user-group.model';
import { UserService } from '../../services/user.service';
import { UserGroupService } from '../../services/user-group.service';
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
    this.editableUser.set({ ...user });
    this.userFormVisible.set(true);
  }

    async saveUser() {
        const userData = this.editableUser();
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


    // --- User Group Management Logic ---
    loadUserGroups() {
        this.userGroupService.getGroups().subscribe(g => this.userGroups.set(g));
    }

    showAddGroupForm() {
        this.editableGroup.set(JSON.parse(JSON.stringify(EMPTY_GROUP)));
        this.groupFormVisible.set(true);
    }

    showEditGroupForm(group: UserGroup) {
        this.editableGroup.set(JSON.parse(JSON.stringify(group))); // Deep copy
        this.groupFormVisible.set(true);
    }

    async saveGroup() 
    {
        const groupData = this.editableGroup();
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
        this.editableGroup.update(group => {
        const newPermissions = { ...group.permissions };
        newPermissions[screenId] = !newPermissions[screenId];
        return { ...group, permissions: newPermissions };
        });
    }

    isGroupInUse(groupId: string): boolean {
        return this.users().some(u => u.userGroupId === groupId);
    }
}
