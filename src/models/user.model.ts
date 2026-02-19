export interface User {
  id: string; // Firebase Auth UID
  username: string;
  email: string;
  passwordHash: string;
  status: 'Active' | 'Inactive';
  userGroupId: string;
}
