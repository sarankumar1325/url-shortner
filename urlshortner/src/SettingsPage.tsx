import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from 'react'
import {
  AlertCircle,
  Check,
  Crown,
  LoaderCircle,
  MonitorSmartphone,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  changePassword,
  deleteAccount,
  deleteWorkspace,
  isProblem,
  listMembers,
  listSessions,
  renameWorkspace,
  revokeOtherSessions,
  revokeSession,
  transferOwnership,
  type ActiveSession,
  type Member,
  type ValidationIssue,
  type WorkspaceRole,
} from './api'
import { useAuth } from './auth'

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

function describe(error: unknown): string {
  if (isProblem(error)) {
    if (error.problem.status === 429 && error.problem.retryAfterSeconds) {
      return `${error.problem.detail} Try again in ${Math.ceil(error.problem.retryAfterSeconds)} seconds.`
    }
    return error.problem.detail
  }
  return 'Something went wrong. Please try again.'
}

function fieldMessage(error: unknown, field: string): string | null {
  if (!isProblem(error)) return null
  return error.problem.errors.find((issue) => issue.field === field)?.message ?? null
}

type Blocker = { id: string; name: string; message: string }

/** The shared workspaces the server says must be handed off first. */
function blockersFrom(errors: readonly ValidationIssue[]): Blocker[] {
  return errors.flatMap((issue) => {
    const extra = issue as ValidationIssue & { workspace_id?: unknown; name?: unknown }
    if (typeof extra.workspace_id !== 'string') return []
    return [
      {
        id: extra.workspace_id,
        name: typeof extra.name === 'string' ? extra.name : 'A shared workspace',
        message: issue.message,
      },
    ]
  })
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  })
}

export default function SettingsPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const user = auth.session?.user
  const workspace = auth.workspace
  const role = auth.role
  const canAdmin = role === 'owner' || role === 'admin'
  const isOwner = role === 'owner'
  const shared = workspace !== null && !workspace.is_personal

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordNotice, setPasswordNotice] = useState('')

  const [sessions, setSessions] = useState<ActiveSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionsError, setSessionsError] = useState('')
  const [sessionBusy, setSessionBusy] = useState('')
  const [sessionsNotice, setSessionsNotice] = useState('')

  const [members, setMembers] = useState<Member[]>([])
  const [membersError, setMembersError] = useState('')
  const [targetId, setTargetId] = useState('')
  const [pendingTransfer, setPendingTransfer] = useState<Member | null>(null)
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferError, setTransferError] = useState('')
  const [transferNotice, setTransferNotice] = useState('')

  const [workspaceName, setWorkspaceName] = useState(workspace?.name ?? '')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [renameNotice, setRenameNotice] = useState('')

  const [confirmName, setConfirmName] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const [accountPassword, setAccountPassword] = useState('')
  const [accountEmail, setAccountEmail] = useState('')
  const [accountBusy, setAccountBusy] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [accountBlockers, setAccountBlockers] = useState<Blocker[]>([])

  const loadSessions = useCallback(async (signal: AbortSignal) => {
    setSessionsLoading(true)
    setSessionsError('')
    try {
      const active = await listSessions(signal)
      if (!signal.aborted) setSessions(active)
    } catch (failure) {
      if (isProblem(failure) && failure.problem.kind === 'cancelled') return
      if (!signal.aborted) setSessionsError(describe(failure))
    } finally {
      if (!signal.aborted) setSessionsLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadSessions(controller.signal)
    return () => controller.abort()
  }, [loadSessions])

  useEffect(() => {
    if (!workspace || !isOwner || !shared) return
    const controller = new AbortController()
    setMembersError('')
    listMembers(workspace.id, controller.signal)
      .then((people) => {
        if (!controller.signal.aborted) setMembers(people)
      })
      .catch((failure: unknown) => {
        if (isProblem(failure) && failure.problem.kind === 'cancelled') return
        if (!controller.signal.aborted) setMembersError(describe(failure))
      })
    return () => controller.abort()
  }, [workspace, isOwner, shared])

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPasswordError('')
    setPasswordNotice('')
    if (newPassword.length < 10) {
      setPasswordError('Use at least 10 characters for the new password.')
      return
    }
    if (newPassword.length > 128) {
      setPasswordError('Use at most 128 characters for the new password.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('The new passwords do not match.')
      return
    }
    if (newPassword === currentPassword) {
      setPasswordError('Choose a password different from the current one.')
      return
    }
    setPasswordBusy(true)
    try {
      await changePassword(
        {
          current_password: currentPassword,
          new_password: newPassword,
        },
        new AbortController().signal,
      )
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordNotice('Password updated. Your other sessions were signed out.')
      void loadSessions(new AbortController().signal)
    } catch (failure) {
      setPasswordError(
        fieldMessage(failure, 'current_password') ??
          fieldMessage(failure, 'new_password') ??
          describe(failure),
      )
    } finally {
      setPasswordBusy(false)
    }
  }

  async function removeSession(session: ActiveSession) {
    if (session.current) return
    if (
      !window.confirm(
        `Sign out the session that started ${formatDate(session.created_at)} UTC?`,
      )
    )
      return
    setSessionBusy(session.id)
    setSessionsError('')
    try {
      await revokeSession(session.id, new AbortController().signal)
      setSessions((items) => items.filter((item) => item.id !== session.id))
      setSessionsNotice('Session signed out.')
    } catch (failure) {
      setSessionsError(describe(failure))
    } finally {
      setSessionBusy('')
    }
  }

  async function removeOtherSessions() {
    const others = sessions.filter((item) => !item.current).length
    if (
      !window.confirm(
        `Sign out ${others} other ${others === 1 ? 'session' : 'sessions'}? Those browsers will need to sign in again.`,
      )
    )
      return
    setSessionBusy('others')
    setSessionsError('')
    try {
      const result = await revokeOtherSessions(new AbortController().signal)
      setSessions((items) => items.filter((item) => item.current))
      setSessionsNotice(
        result.revoked === 0
          ? 'No other sessions were active.'
          : `${result.revoked} ${result.revoked === 1 ? 'session' : 'sessions'} signed out.`,
      )
    } catch (failure) {
      setSessionsError(describe(failure))
    } finally {
      setSessionBusy('')
    }
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!workspace) return
    const name = workspaceName.trim()
    setRenameError('')
    setRenameNotice('')
    if (!name) {
      setRenameError('Workspace names cannot be empty.')
      return
    }
    if (name === workspace.name) return
    setRenameBusy(true)
    try {
      const updated = await renameWorkspace(
        workspace.id,
        name,
        new AbortController().signal,
      )
      auth.updateWorkspace(updated)
      setRenameNotice('Workspace renamed.')
    } catch (failure) {
      setRenameError(describe(failure))
    } finally {
      setRenameBusy(false)
    }
  }

  async function confirmTransfer() {
    if (!workspace || !pendingTransfer) return
    setTransferBusy(true)
    setTransferError('')
    setTransferNotice('')
    try {
      await transferOwnership(
        workspace.id,
        pendingTransfer.user_id,
        new AbortController().signal,
      )
      auth.updateWorkspace({ ...workspace, role: 'admin' })
      setMembers((items) =>
        items.map((item) =>
          item.user_id === pendingTransfer.user_id
            ? { ...item, role: 'owner' }
            : item.user_id === user?.id
              ? { ...item, role: 'admin' }
              : item,
        ),
      )
      setTransferNotice(
        `${pendingTransfer.display_name} now owns this workspace. You are an admin.`,
      )
      setPendingTransfer(null)
      setTargetId('')
    } catch (failure) {
      setTransferError(describe(failure))
    } finally {
      setTransferBusy(false)
    }
  }

  async function submitDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!workspace) return
    setDeleteError('')
    if (confirmName.trim() !== workspace.name) {
      setDeleteError('Type the workspace name exactly to confirm.')
      return
    }
    setDeleteBusy(true)
    try {
      await deleteWorkspace(
        workspace.id,
        confirmName.trim(),
        new AbortController().signal,
      )
      auth.removeWorkspace(workspace.id)
      navigate('/', { replace: true })
    } catch (failure) {
      setDeleteError(describe(failure))
      setDeleteBusy(false)
    }
  }

  async function submitDeleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!user) return
    setAccountError('')
    if (accountEmail.toLowerCase() !== user.email.toLowerCase()) {
      setAccountError('Type your email address exactly to confirm.')
      return
    }
    setAccountBusy(true)
    try {
      await deleteAccount(
        { password: accountPassword, confirm_email: accountEmail },
        new AbortController().signal,
      )
      auth.forget('Your account was deleted.')
      navigate('/login', { replace: true })
    } catch (failure) {
      setAccountBusy(false)
      if (isProblem(failure) && failure.problem.code === 'owns_shared_workspaces') {
        setAccountBlockers(blockersFrom(failure.problem.errors))
        setAccountError(failure.problem.detail)
        return
      }
      setAccountError(
        isProblem(failure) && failure.problem.code === 'invalid_password'
          ? 'That password is not correct.'
          : describe(failure),
      )
    }
  }

  if (!workspace || !role || !user) return null

  const transferable = members.filter(
    (member) => member.user_id !== user.id && member.role !== 'owner',
  )
  const otherSessions = sessions.filter((item) => !item.current).length

  return (
    <>
      <div className="page-heading">
        <div className="section-heading">
          <h1 tabIndex={-1}>Your account. Your workspace.</h1>
          <span className={`role-badge role-${role}`}>
            {ROLE_LABEL[role]}
          </span>
        </div>
        <p>Change how you sign in, review active sessions, and manage this workspace.</p>
      </div>

      <div className="settings-layout">
        <div className="settings-column">
          <section className="panel settings-panel" aria-labelledby="account-heading">
            <div className="section-heading">
              <div>
                <h2 id="account-heading">Account</h2>
                <p className="meta">Your identity across every workspace.</p>
              </div>
              <UserRound size={19} strokeWidth={1.5} />
            </div>
            <div className="account-summary">
              <span className="member-avatar" aria-hidden="true">
                {(user.display_name || user.email).slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{user.display_name}</strong>
                <span>{user.email}</span>
              </div>
            </div>
            <p className="meta settings-note">
              Member since{' '}
              {new Date(user.created_at).toLocaleDateString('en-US', {
                month: 'long',
                year: 'numeric',
                timeZone: 'UTC',
              })}
              .
            </p>
          </section>

          <section className="panel settings-panel" aria-labelledby="password-heading">
            <div className="section-heading">
              <div>
                <h2 id="password-heading">Password</h2>
                <p className="meta">
                  Changing it signs out every other browser.
                </p>
              </div>
              <ShieldCheck size={19} strokeWidth={1.5} />
            </div>
            <form className="settings-form" onSubmit={submitPassword} noValidate>
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={user.email}
                readOnly
                hidden
              />
              <label htmlFor="current-password">Current password</label>
              <input
                id="current-password"
                name="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => {
                  setCurrentPassword(event.target.value)
                  setPasswordError('')
                  setPasswordNotice('')
                }}
                required
              />
              <label htmlFor="new-password">New password</label>
              <input
                id="new-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value)
                  setPasswordError('')
                  setPasswordNotice('')
                }}
                minLength={10}
                maxLength={128}
                required
              />
              <p className="field-hint">At least 10 characters. Longer is better.</p>
              <label htmlFor="confirm-password">Confirm new password</label>
              <input
                id="confirm-password"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value)
                  setPasswordError('')
                  setPasswordNotice('')
                }}
                minLength={10}
                maxLength={128}
                required
              />
              {passwordError && (
                <p className="field-error" role="alert">
                  {passwordError}
                </p>
              )}
              {passwordNotice && (
                <p className="field-success" role="status">
                  <Check size={14} /> {passwordNotice}
                </p>
              )}
              <button
                type="submit"
                className="primary-button"
                disabled={passwordBusy}
              >
                {passwordBusy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <ShieldCheck size={15} />
                )}
                Update password
              </button>
            </form>
          </section>

          <section className="panel settings-panel" aria-labelledby="sessions-heading">
            <div className="section-heading">
              <div>
                <h2 id="sessions-heading">Active sessions</h2>
                <p className="meta">
                  Browsers signed in as {user.email}.
                </p>
              </div>
              <MonitorSmartphone size={19} strokeWidth={1.5} />
            </div>
            {sessionsError && (
              <div className="inline-alert settings-alert" role="alert">
                <AlertCircle size={18} />
                <div>
                  <strong>Sessions could not be loaded.</strong>
                  <p>{sessionsError}</p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      void loadSessions(new AbortController().signal)
                    }
                  >
                    Try again
                  </button>
                </div>
              </div>
            )}
            {sessionsLoading ? (
              <div className="loading-panel" role="status" aria-busy="true">
                Loading sessions…
              </div>
            ) : (
              <div className="session-list">
                {sessions.map((session) => (
                  <div className="session-row" key={session.id}>
                    <div>
                      <strong>
                        {session.current ? 'This browser' : 'Another browser'}
                        {session.current && (
                          <span className="source-label">Current</span>
                        )}
                      </strong>
                      <span>
                        Started {formatDate(session.created_at)} UTC · expires{' '}
                        {formatDate(session.expires_at)} UTC
                      </span>
                    </div>
                    {session.current ? (
                      <span className="meta session-current-note">
                        <Check size={13} /> Active
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="text-button session-revoke"
                        disabled={sessionBusy === session.id}
                        onClick={() => void removeSession(session)}
                      >
                        {sessionBusy === session.id ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <X size={14} />
                        )}
                        Sign out
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {sessionsNotice && (
              <p className="field-success" role="status">
                <Check size={14} /> {sessionsNotice}
              </p>
            )}
            <div className="settings-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={otherSessions === 0 || sessionBusy === 'others'}
                onClick={() => void removeOtherSessions()}
              >
                {sessionBusy === 'others' ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <X size={14} />
                )}
                Sign out other sessions{otherSessions ? ` (${otherSessions})` : ''}
              </button>
            </div>
          </section>

          <section
            className="panel settings-panel danger-panel"
            aria-labelledby="delete-account-heading"
          >
            <div className="section-heading">
              <div>
                <h2 id="delete-account-heading">Delete account</h2>
                <p className="meta">
                  Removes your sign-in, your personal workspace, and workspaces
                  where you are the only member.
                </p>
              </div>
              <Trash2 size={19} strokeWidth={1.5} />
            </div>
            <p className="meta danger-copy">
              Their links stop working and their short codes are never reused.
              Links you made in other people's workspaces stay there. This
              cannot be undone.
            </p>
            {accountBlockers.length > 0 && (
              <div className="confirm-block" role="alert">
                <p>
                  Transfer ownership or delete these shared workspaces first:
                </p>
                <ul className="blocker-list">
                  {accountBlockers.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          auth.selectWorkspace(item.id)
                          window.scrollTo({ top: 0 })
                        }}
                      >
                        {item.name}
                      </button>{' '}
                      <span className="meta">{item.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <form className="settings-form" onSubmit={submitDeleteAccount} noValidate>
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={user.email}
                readOnly
                hidden
              />
              <label htmlFor="delete-account-password">Current password</label>
              <input
                id="delete-account-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={accountPassword}
                onChange={(event) => {
                  setAccountPassword(event.target.value)
                  setAccountError('')
                }}
                disabled={accountBusy}
              />
              <label htmlFor="delete-account-email">
                Type <strong>{user.email}</strong> to confirm
              </label>
              <input
                id="delete-account-email"
                name="confirm-email"
                type="email"
                value={accountEmail}
                onChange={(event) => {
                  setAccountEmail(event.target.value.trim())
                  setAccountError('')
                }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={accountBusy}
              />
              {accountError && (
                <p className="field-error" role="alert">
                  {accountError}
                </p>
              )}
              <button
                type="submit"
                className="danger-button"
                disabled={
                  accountBusy ||
                  !accountPassword ||
                  accountEmail.toLowerCase() !== user.email.toLowerCase()
                }
              >
                {accountBusy ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Trash2 size={14} />
                )}
                Delete my account
              </button>
            </form>
          </section>
        </div>

        <div className="settings-column">
          <section className="panel settings-panel" aria-labelledby="workspace-settings-heading">
            <div className="section-heading">
              <div>
                <h2 id="workspace-settings-heading">Workspace</h2>
                <p className="meta">
                  {workspace.is_personal
                    ? 'Your personal space for links.'
                    : 'Shared settings for everyone in this workspace.'}
                </p>
              </div>
              {workspace.is_personal ? (
                <UserRound size={19} strokeWidth={1.5} />
              ) : (
                <Users size={19} strokeWidth={1.5} />
              )}
            </div>
            <form className="settings-form" onSubmit={submitRename} noValidate>
              <label htmlFor="workspace-name">Name</label>
              <input
                id="workspace-name"
                value={workspaceName}
                maxLength={80}
                onChange={(event) => {
                  setWorkspaceName(event.target.value)
                  setRenameError('')
                  setRenameNotice('')
                }}
                disabled={!canAdmin}
              />
              <p className="field-hint">
                {canAdmin
                  ? 'Admins and owners can rename this workspace.'
                  : 'Only admins and owners can rename this workspace.'}
              </p>
              {renameError && (
                <p className="field-error" role="alert">
                  {renameError}
                </p>
              )}
              {renameNotice && (
                <p className="field-success" role="status">
                  <Check size={14} /> {renameNotice}
                </p>
              )}
              {canAdmin && (
                <button
                  type="submit"
                  className="secondary-button"
                  disabled={
                    renameBusy ||
                    !workspaceName.trim() ||
                    workspaceName.trim() === workspace.name
                  }
                >
                  {renameBusy ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Check size={14} />
                  )}
                  Save name
                </button>
              )}
            </form>
          </section>

          {shared && isOwner && (
            <section className="panel settings-panel" aria-labelledby="transfer-heading">
              <div className="section-heading">
                <div>
                  <h2 id="transfer-heading">Ownership</h2>
                  <p className="meta">Hand the workspace to another member.</p>
                </div>
                <Crown size={19} strokeWidth={1.5} />
              </div>
              {membersError ? (
                <p className="field-error" role="alert">
                  {membersError}
                </p>
              ) : (
                <>
                  <label htmlFor="transfer-target">New owner</label>
                  <select
                    id="transfer-target"
                    value={targetId}
                    onChange={(event) => {
                      setTargetId(event.target.value)
                      setPendingTransfer(null)
                      setTransferError('')
                      setTransferNotice('')
                    }}
                    disabled={transferBusy || transferable.length === 0}
                  >
                    <option value="">
                      {transferable.length === 0
                        ? 'Invite someone first'
                        : 'Choose a member'}
                    </option>
                    {transferable.map((member) => (
                      <option key={member.user_id} value={member.user_id}>
                        {member.display_name} · {ROLE_LABEL[member.role]}
                      </option>
                    ))}
                  </select>
                  {transferError && (
                    <p className="field-error" role="alert">
                      {transferError}
                    </p>
                  )}
                  {transferNotice && (
                    <p className="field-success" role="status">
                      <Check size={14} /> {transferNotice}
                    </p>
                  )}
                  {pendingTransfer ? (
                    <div className="confirm-block" role="alert">
                      <p>
                        Make <strong>{pendingTransfer.display_name}</strong> the
                        owner? You will become an admin and lose owner-only
                        controls.
                      </p>
                      <div className="confirm-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={transferBusy}
                          onClick={() => setPendingTransfer(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="danger-button filled"
                          disabled={transferBusy}
                          onClick={() => void confirmTransfer()}
                        >
                          {transferBusy ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : (
                            <Crown size={14} />
                          )}
                          Transfer ownership
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!targetId || transferBusy}
                      onClick={() => {
                        const member = members.find(
                          (item) => item.user_id === targetId,
                        )
                        if (member) setPendingTransfer(member)
                      }}
                    >
                      <Crown size={14} /> Transfer ownership
                    </button>
                  )}
                </>
              )}
            </section>
          )}

          {shared && isOwner && (
            <section
              className="panel settings-panel danger-panel"
              aria-labelledby="delete-workspace-heading"
            >
              <div className="section-heading">
                <div>
                  <h2 id="delete-workspace-heading">Delete workspace</h2>
                  <p className="meta">
                    Removes every link, click history, invitation, and member.
                  </p>
                </div>
                <Trash2 size={19} strokeWidth={1.5} />
              </div>
              <p className="meta danger-copy">
                This cannot be undone. Your personal workspace and other
                workspaces are not affected.
              </p>
              <form className="settings-form" onSubmit={submitDelete} noValidate>
                <label htmlFor="confirm-workspace-name">
                  Type <strong>{workspace.name}</strong> to confirm
                </label>
                <input
                  id="confirm-workspace-name"
                  value={confirmName}
                  onChange={(event) => {
                    setConfirmName(event.target.value)
                    setDeleteError('')
                  }}
                  autoComplete="off"
                  disabled={deleteBusy}
                />
                {deleteError && (
                  <p className="field-error" role="alert">
                    {deleteError}
                  </p>
                )}
                <button
                  type="submit"
                  className="danger-button"
                  disabled={
                    deleteBusy || confirmName.trim() !== workspace.name
                  }
                >
                  {deleteBusy ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  Delete this workspace
                </button>
              </form>
            </section>
          )}

          {!canAdmin && (
            <section className="panel settings-panel" aria-labelledby="workspace-access-heading">
              <div className="section-heading">
                <div>
                  <h2 id="workspace-access-heading">Workspace access</h2>
                  <p className="meta">Your role is managed by an owner or admin.</p>
                </div>
                <ShieldCheck size={19} strokeWidth={1.5} />
              </div>
              <p className="meta">
                You can view links and analytics. Ask an admin for member access
                when you need to create or change links.
              </p>
            </section>
          )}
        </div>
      </div>
    </>
  )
}
