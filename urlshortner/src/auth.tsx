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

const ACTIVE_WORKSPACE_KEY = 'shortly.workspace.v1'

type Status = 'loading' | 'authenticated' | 'anonymous'

type AuthValue = {
  status: Status
  session: Session | null
  workspace: WorkspaceSummary | null
  role: WorkspaceRole | null
  selectWorkspace: (id: string) => void
  addWorkspace: (workspace: WorkspaceSummary) => void
  updateWorkspace: (workspace: WorkspaceSummary) => void
  removeWorkspace: (id: string) => void
  createWorkspace: (name: string) => Promise<WorkspaceSummary>
  login: (email: string, password: string) => Promise<void>
  signup: (
    email: string,
    password: string,
    displayName: string,
  ) => Promise<void>
  logout: () => Promise<void>
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
  const [session, setSession] = useState<Session | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [activeId, setActiveId] = useState<string | null>(savedWorkspace)

  const applySession = useCallback((next: Session) => {
    setSession(next)
    setStatus('authenticated')
    setActiveId((current) => {
      const workspace = chooseWorkspace(next.workspaces, current)
      if (workspace) rememberWorkspace(workspace.id)
      return workspace?.id ?? null
    })
  }, [])

  const refresh = useCallback(async () => {
    const controller = new AbortController()
    try {
      applySession(await getSession(controller.signal))
    } catch (error) {
      if (isProblem(error) && error.problem.status === 401) {
        setSession(null)
        setStatus('anonymous')
        return
      }
      throw error
    }
  }, [applySession])

  useEffect(() => {
    const controller = new AbortController()
    getSession(controller.signal)
      .then(applySession)
      .catch((error: unknown) => {
        if (isProblem(error) && error.problem.kind === 'cancelled') return
        setStatus('anonymous')
      })
    return () => controller.abort()
  }, [applySession])

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

  const addWorkspace = useCallback(
    (next: WorkspaceSummary) => {
      setSession((current) => {
        if (!current) return current
        const workspaces = [
          ...current.workspaces.filter((item) => item.id !== next.id),
          next,
        ]
        return { ...current, workspaces }
      })
      setActiveId(next.id)
      rememberWorkspace(next.id)
    },
    [],
  )

  const updateWorkspace = useCallback((next: WorkspaceSummary) => {
    setSession((current) => {
      if (!current) return current
      return {
        ...current,
        workspaces: current.workspaces.map((item) =>
          item.id === next.id ? next : item,
        ),
      }
    })
  }, [])

  const removeWorkspace = useCallback(
    (id: string) => {
      if (!session) return
      const workspaces = session.workspaces.filter((item) => item.id !== id)
      setSession({ ...session, workspaces })
      setActiveId((current) => {
        if (current !== id) return current
        const next = chooseWorkspace(workspaces, null)
        if (next) rememberWorkspace(next.id)
        return next?.id ?? null
      })
    },
    [session],
  )

  const createWorkspace = useCallback(
    async (name: string) => {
      const created = await createWorkspaceRequest(
        name,
        new AbortController().signal,
      )
      addWorkspace(created)
      return created
    },
    [addWorkspace],
  )

  const login = useCallback(
    async (email: string, password: string) => {
      applySession(
        await loginRequest({ email, password }, new AbortController().signal),
      )
    },
    [applySession],
  )

  const signup = useCallback(
    async (email: string, password: string, displayName: string) => {
      applySession(
        await signupRequest(
          { email, password, display_name: displayName || undefined },
          new AbortController().signal,
        ),
      )
    },
    [applySession],
  )

  const logout = useCallback(async () => {
    try {
      await logoutRequest(new AbortController().signal)
    } finally {
      setSession(null)
      setStatus('anonymous')
      setActiveId(null)
    }
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      status,
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
      refresh,
    }),
    [
      status,
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
