import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  createWorkspace as createWorkspaceRequest,
  getSession,
  isProblem,
  login as loginRequest,
  logout as logoutRequest,
  signup as signupRequest,
  type Session,
  type WorkspaceRole,
  type WorkspaceSummary,
} from './api'
import {
  browserStorage,
  clearCachedSession,
  initialAuthState,
  settleSession,
  writeCachedSession,
  type AuthState,
  type AuthStatus,
} from './sessionCache'

const ACTIVE_WORKSPACE_KEY = 'shortly.workspace.v1'

type AuthValue = {
  status: AuthStatus
  /** False while the shell is drawn from the cached summary. */
  verified: boolean
  session: Session | null
  workspace: WorkspaceSummary | null
  role: WorkspaceRole | null
  selectWorkspace: (id: string) => void
  addWorkspace: (workspace: WorkspaceSummary) => void
  updateWorkspace: (workspace: WorkspaceSummary) => void
  removeWorkspace: (id: string) => void
  createWorkspace: (name: string) => Promise<WorkspaceSummary>
  login: (email: string, password: string, remember: boolean) => Promise<void>
  signup: (
    email: string,
    password: string,
    displayName: string,
    remember: boolean,
  ) => Promise<void>
  logout: () => Promise<void>
  /** Drops the local session without calling the API (after account deletion). */
  forget: (notice?: string) => void
  /** Shown once on the sign-in page after forget(notice). */
  notice: string | null
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

function savedWorkspace(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY)
  } catch {
    return null
  }
}

function rememberWorkspace(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, id)
  } catch {
    // A blocked localStorage only costs the remembered selection.
  }
}

function chooseWorkspace(
  workspaces: WorkspaceSummary[],
  preferred: string | null,
): WorkspaceSummary | null {
  return (
    workspaces.find((item) => item.id === preferred) ??
    workspaces.find((item) => item.is_personal) ??
    workspaces[0] ??
    null
  )
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => initialAuthState(browserStorage()))
  const [activeId, setActiveId] = useState<string | null>(() =>
    state.session
      ? (chooseWorkspace(state.session.workspaces, savedWorkspace())?.id ?? null)
      : savedWorkspace(),
  )
  const { session, status, verified } = state
  const [notice, setNotice] = useState<string | null>(null)

  const pickWorkspace = useCallback((next: Session) => {
    setActiveId((current) => {
      const workspace = chooseWorkspace(next.workspaces, current)
      if (workspace) rememberWorkspace(workspace.id)
      return workspace?.id ?? null
    })
  }, [])

  const applySession = useCallback(
    (next: Session) => {
      setState((current) => settleSession(browserStorage(), current, { kind: 'ok', session: next }))
      setNotice(null)
      pickWorkspace(next)
    },
    [pickWorkspace],
  )

  const signedOut = useCallback(() => {
    setState((current) => settleSession(browserStorage(), current, { kind: 'unauthorized' }))
    setActiveId(null)
  }, [])

  // Keeps the cached summary in step with local edits (rename, new workspace).
  useEffect(() => {
    if (status === 'authenticated' && session) writeCachedSession(browserStorage(), session)
  }, [status, session])

  const refresh = useCallback(async () => {
    const controller = new AbortController()
    try {
      applySession(await getSession(controller.signal))
    } catch (error) {
      if (isProblem(error) && error.problem.status === 401) {
        signedOut()
        return
      }
      throw error
    }
  }, [applySession, signedOut])

  useEffect(() => {
    const controller = new AbortController()
    getSession(controller.signal)
      .then(applySession)
      .catch((error: unknown) => {
        if (isProblem(error) && error.problem.kind === 'cancelled') return
        if (isProblem(error) && error.problem.status === 401) {
          signedOut()
          return
        }
        setState((current) => settleSession(browserStorage(), current, { kind: 'failed' }))
      })
    return () => controller.abort()
  }, [applySession, signedOut])

  const workspace = useMemo(
    () => session?.workspaces.find((item) => item.id === activeId) ?? null,
    [session, activeId],
  )

  const selectWorkspace = useCallback(
    (id: string) => {
      if (!session?.workspaces.some((item) => item.id === id)) return
      setActiveId(id)
      rememberWorkspace(id)
    },
    [session],
  )

  const updateSession = useCallback((update: (current: Session) => Session) => {
    setState((current) =>
      current.session ? { ...current, session: update(current.session) } : current,
    )
  }, [])

  const addWorkspace = useCallback(
    (next: WorkspaceSummary) => {
      updateSession((current) => ({
        ...current,
        workspaces: [...current.workspaces.filter((item) => item.id !== next.id), next],
      }))
      setActiveId(next.id)
      rememberWorkspace(next.id)
    },
    [updateSession],
  )

  const updateWorkspace = useCallback(
    (next: WorkspaceSummary) => {
      updateSession((current) => ({
        ...current,
        workspaces: current.workspaces.map((item) => (item.id === next.id ? next : item)),
      }))
    },
    [updateSession],
  )

  const removeWorkspace = useCallback(
    (id: string) => {
      if (!session) return
      const workspaces = session.workspaces.filter((item) => item.id !== id)
      updateSession((current) => ({ ...current, workspaces }))
      setActiveId((current) => {
        if (current !== id) return current
        const next = chooseWorkspace(workspaces, null)
        if (next) rememberWorkspace(next.id)
        return next?.id ?? null
      })
    },
    [session, updateSession],
  )

  const createWorkspace = useCallback(
    async (name: string) => {
      const created = await createWorkspaceRequest(name, new AbortController().signal)
      addWorkspace(created)
      return created
    },
    [addWorkspace],
  )

  const login = useCallback(
    async (email: string, password: string, remember: boolean) => {
      applySession(
        await loginRequest({ email, password, remember }, new AbortController().signal),
      )
    },
    [applySession],
  )

  const signup = useCallback(
    async (email: string, password: string, displayName: string, remember: boolean) => {
      applySession(
        await signupRequest(
          { email, password, display_name: displayName || undefined, remember },
          new AbortController().signal,
        ),
      )
    },
    [applySession],
  )

  const forget = useCallback((message?: string) => {
    setNotice(message ?? null)
    clearCachedSession(browserStorage())
    setState({ status: 'anonymous', session: null, verified: false })
    setActiveId(null)
  }, [])

  const logout = useCallback(async () => {
    try {
      await logoutRequest(new AbortController().signal)
    } finally {
      forget()
    }
  }, [forget])

  const value = useMemo<AuthValue>(
    () => ({
      status,
      verified,
      session,
      workspace,
      role: workspace?.role ?? null,
      selectWorkspace,
      addWorkspace,
      updateWorkspace,
      removeWorkspace,
      createWorkspace,
      login,
      signup,
      logout,
      forget,
      notice,
      refresh,
    }),
    [
      status,
      verified,
      session,
      workspace,
      selectWorkspace,
      addWorkspace,
      updateWorkspace,
      removeWorkspace,
      createWorkspace,
      login,
      signup,
      logout,
      forget,
      notice,
      refresh,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
