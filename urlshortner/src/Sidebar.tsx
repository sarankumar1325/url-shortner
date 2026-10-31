import { useEffect, useRef } from 'react'
import {
  Activity,
  ChevronsUpDown,
  CircleHelp,
  LayoutGrid,
  Link2,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  QrCode,
  Settings as SettingsIcon,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Link, NavLink } from 'react-router-dom'
import type { WorkspaceRole } from './api'
import { BrandMark } from './AuthPage'
import { ROLE_LABEL, ROLE_NOTE } from './roles'

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean }

const WORKSPACE_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/links', label: 'Your links', icon: Link2 },
  { to: '/qr', label: 'QR studio', icon: QrCode },
  { to: '/members', label: 'People', icon: Users },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

const EXPLORE_ITEMS: NavItem[] = [
  { to: '/system', label: 'System design', icon: Activity },
]

type SidebarProps = {
  collapsed: boolean
  narrow: boolean
  drawerOpen: boolean
  workspaces: { id: string; name: string; role: WorkspaceRole }[]
  workspaceId: string
  role: WorkspaceRole
  user: { display_name: string; email: string }
  canEdit: boolean
  onToggleCollapsed: () => void
  onCloseDrawer: () => void
  onNewLink: () => void
  onSwitchWorkspace: (id: string) => void
  onHelp: () => void
  onSignOut: () => void
}

function initial(value: string) {
  return value.trim().slice(0, 1).toUpperCase() || '?'
}

export default function Sidebar({
  collapsed,
  narrow,
  drawerOpen,
  workspaces,
  workspaceId,
  role,
  user,
  canEdit,
  onToggleCollapsed,
  onCloseDrawer,
  onNewLink,
  onSwitchWorkspace,
  onHelp,
  onSignOut,
}: SidebarProps) {
  const aside = useRef<HTMLElement>(null)
  const switcher = useRef<HTMLSelectElement>(null)
  // The drawer always shows full labels; the rail only exists on wide screens.
  const rail = collapsed && !narrow
  const hidden = narrow && !drawerOpen
  const current = workspaces.find((item) => item.id === workspaceId)

  useEffect(() => {
    if (!narrow || !drawerOpen) return
    aside.current?.querySelector<HTMLElement>('a, button, select')?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCloseDrawer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [narrow, drawerOpen, onCloseDrawer])

  function closeIfDrawer() {
    if (narrow) onCloseDrawer()
  }

  function renderItems(items: NavItem[]) {
    return items.map((item) => {
      const Icon = item.icon
      return (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={closeIfDrawer}
          data-tip={rail ? item.label : undefined}
          aria-label={rail ? item.label : undefined}
        >
          <Icon size={18} strokeWidth={1.7} />
          <span className="nav-label">{item.label}</span>
        </NavLink>
      )
    })
  }

  return (
    <>
      <aside
        ref={aside}
        id="workspace-sidebar"
        className={`sidebar${rail ? ' collapsed' : ''}${narrow ? ' drawer' : ''}${drawerOpen ? ' open' : ''}`}
        aria-label="Workspace sidebar"
        inert={hidden}
      >
        <div className="sidebar-top">
          <Link
            to="/"
            aria-label="Shortly home"
            className="brand-link"
            onClick={closeIfDrawer}
          >
            <BrandMark />
          </Link>
          {narrow ? (
            <button
              type="button"
              className="icon-button sidebar-toggle"
              aria-label="Close navigation"
              onClick={onCloseDrawer}
            >
              <X size={18} />
            </button>
          ) : (
            <button
              type="button"
              className="icon-button sidebar-toggle"
              aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-controls="workspace-sidebar"
              aria-expanded={!rail}
              data-tip={rail ? 'Expand  [' : undefined}
              title={rail ? undefined : 'Collapse sidebar  ['}
              onClick={onToggleCollapsed}
            >
              {rail ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
          )}
        </div>

        {rail ? (
          <button
            type="button"
            className="workspace-chip"
            aria-label={`Workspace: ${current?.name ?? ''}. Expand to switch.`}
            data-tip={current?.name}
            onClick={() => {
              onToggleCollapsed()
              window.requestAnimationFrame(() => switcher.current?.focus())
            }}
          >
            {initial(current?.name ?? '')}
          </button>
        ) : (
          <label className="workspace-switcher">
            <span className="workspace-avatar" aria-hidden="true">
              {initial(current?.name ?? '')}
            </span>
            <span className="workspace-meta">
              <select
                ref={switcher}
                value={workspaceId}
                aria-label="Switch workspace"
                onChange={(event) => onSwitchWorkspace(event.target.value)}
              >
                {workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {ROLE_LABEL[item.role]}
                  </option>
                ))}
              </select>
              <span className="workspace-role" title={ROLE_NOTE[role]}>
                {ROLE_LABEL[role]} · {workspaces.length} workspace
                {workspaces.length === 1 ? '' : 's'}
              </span>
            </span>
            <ChevronsUpDown size={15} aria-hidden="true" />
          </label>
        )}

        {canEdit && (
          <button
            type="button"
            className="new-link-button"
            onClick={onNewLink}
            aria-label={rail ? 'Create a link' : undefined}
            data-tip={rail ? 'Create a link  N' : undefined}
          >
            <Plus size={18} />
            <span className="nav-label">Create a link</span>
            <kbd className="nav-kbd" aria-hidden="true">
              N
            </kbd>
          </button>
        )}

        <nav aria-label="Workspace navigation" className="sidebar-nav">
          <span className="nav-group-label">Workspace</span>
          {renderItems(WORKSPACE_ITEMS)}
          <span className="nav-group-label">Explore</span>
          {renderItems(EXPLORE_ITEMS)}
        </nav>

        <div className="sidebar-bottom">
          <button
            type="button"
            className="sidebar-help"
            onClick={() => {
              closeIfDrawer()
              onHelp()
            }}
            aria-label={rail ? 'Help and shortcuts' : undefined}
            data-tip={rail ? 'Help  ?' : undefined}
          >
            <CircleHelp size={17} />
            <span className="nav-label">Help and shortcuts</span>
          </button>
          <div className="account-card">
            <span className="member-avatar" aria-hidden="true">
              {initial(user.display_name || user.email)}
            </span>
            <div className="account-identity">
              <strong>{user.display_name}</strong>
              <span>{user.email}</span>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Sign out"
              data-tip={rail ? 'Sign out' : undefined}
              onClick={onSignOut}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      {narrow && drawerOpen && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={onCloseDrawer}
        />
      )}
    </>
  )
}
