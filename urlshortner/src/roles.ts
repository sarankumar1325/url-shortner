import type { WorkspaceRole } from './api'

export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

export const ROLE_NOTE: Record<WorkspaceRole, string> = {
  owner: 'Full control of this workspace, its links, and its people.',
  admin: 'Manage links, members, and invitations.',
  member: 'Create and manage this workspace’s short links.',
  viewer: 'Read links and analytics without changing anything.',
}
