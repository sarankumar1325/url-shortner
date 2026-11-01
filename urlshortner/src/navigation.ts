import {
  Activity,
  BarChart3,
  LayoutGrid,
  Link2,
  QrCode,
  Settings as SettingsIcon,
  Users,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean }

export const WORKSPACE_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/dashboard', label: 'Dashboard', icon: BarChart3 },
  { to: '/links', label: 'Your links', icon: Link2 },
  { to: '/qr', label: 'QR studio', icon: QrCode },
  { to: '/members', label: 'People', icon: Users },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export const EXPLORE_ITEMS: NavItem[] = [
  { to: '/system', label: 'System design', icon: Activity },
]
