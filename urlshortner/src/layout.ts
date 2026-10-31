import { useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', notify)
      return () => list.removeEventListener('change', notify)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

const SIDEBAR_KEY = 'shortly:sidebar'

export function readSidebarCollapsed(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(SIDEBAR_KEY) === 'collapsed'
  } catch {
    return false
  }
}

export function writeSidebarCollapsed(
  storage: Pick<Storage, 'setItem'> | null,
  collapsed: boolean,
): void {
  try {
    storage?.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded')
  } catch {
    // Private browsing can refuse storage; the preference just won't persist.
  }
}
