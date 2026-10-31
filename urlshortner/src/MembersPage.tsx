import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  ArrowRight,
  Check,
  Copy,
  Crown,
  LoaderCircle,
  Shield,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  createInvitation,
  isProblem,
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
  updateMemberRole,
  type Invitation,
  type Member,
  type WorkspaceRole,
} from './api'
import { useAuth } from './auth'

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

const ROLE_NOTE: Record<WorkspaceRole, string> = {
  owner: 'Full control, including billing and ownership.',
  admin: 'Manage links, members, and invitations.',
  member: 'Create and manage links in this workspace.',
  viewer: 'Read links and analytics without changing them.',
}

type AssignableRole = Exclude<WorkspaceRole, 'owner'>

function describe(error: unknown): string {
  if (isProblem(error)) {
    if (error.problem.status === 429 && error.problem.retryAfterSeconds) {
      return `${error.problem.detail} Try again in ${Math.ceil(error.problem.retryAfterSeconds)} seconds.`
    }
    return error.problem.detail
  }
  return 'Something went wrong. Please try again.'
}

export default function MembersPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const workspace = auth.workspace
  const role = auth.role
  const me = auth.session?.user.id
  const canAdmin = role === 'owner' || role === 'admin'

  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [inviteRole, setInviteRole] = useState<AssignableRole>('member')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [createdInvite, setCreatedInvite] = useState<Invitation | null>(null)
  const [workspaceName, setWorkspaceName] = useState('')
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!workspace) return
      setLoading(true)
      setError('')
      try {
        const people = await listMembers(workspace.id, signal)
        setMembers(people)
        if (role === 'owner' || role === 'admin') {
          setInvitations(await listInvitations(workspace.id, signal))
        } else {
          setInvitations([])
        }
      } catch (failure) {
        if (isProblem(failure) && failure.problem.kind === 'cancelled') return
        setError(describe(failure))
      } finally {
        if (!signal.aborted) setLoading(false)
      }
    },
    [workspace, role],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  function manageable(target: Member): boolean {
    if (!me || target.user_id === me) return false
    if (target.role === 'owner') return false
    if (role === 'owner') return true
    return role === 'admin' && (target.role === 'member' || target.role === 'viewer')
  }

  async function changeRole(target: Member, next: AssignableRole) {
    if (!workspace) return
    setBusyId(target.user_id)
    setError('')
    try {
      await updateMemberRole(
        workspace.id,
        target.user_id,
        next,
        new AbortController().signal,
      )
      setMembers((current) =>
        current.map((item) =>
          item.user_id === target.user_id ? { ...item, role: next } : item,
        ),
      )
      setNotice(`${target.display_name} is now a ${ROLE_LABEL[next].toLowerCase()}.`)
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setBusyId('')
    }
  }

  async function remove(target: Member) {
    if (!workspace) return
    const leaving = target.user_id === me
    if (
      !window.confirm(
        leaving
          ? `Leave ${workspace.name}?`
          : `Remove ${target.display_name} from ${workspace.name}?`,
      )
    )
      return
    setBusyId(target.user_id)
    setError('')
    try {
      await removeMember(
        workspace.id,
        target.user_id,
        new AbortController().signal,
      )
      if (leaving) {
        await auth.refresh()
        navigate('/', { replace: true })
        return
      }
      setMembers((current) =>
        current.filter((item) => item.user_id !== target.user_id),
      )
      setNotice(`${target.display_name} was removed.`)
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setBusyId('')
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!workspace) return
    setInviting(true)
    setError('')
    setCreatedInvite(null)
    try {
      const created = await createInvitation(
        workspace.id,
        {
          role: inviteRole,
          email: inviteEmail.trim() || null,
        },
        new AbortController().signal,
      )
      setCreatedInvite(created)
      setInviteEmail('')
      setInvitations((current) => [created, ...current])
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setInviting(false)
    }
  }

  async function revoke(invitation: Invitation) {
    if (!workspace) return
    setBusyId(invitation.id)
    setError('')
    try {
      await revokeInvitation(
        workspace.id,
        invitation.id,
        new AbortController().signal,
      )
      setInvitations((current) =>
        current.filter((item) => item.id !== invitation.id),
      )
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setBusyId('')
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setNotice('Invitation link copied.')
    } catch {
      window.prompt('Copy this invitation link', value)
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!workspaceName.trim()) return
    setCreating(true)
    setError('')
    try {
      await auth.createWorkspace(workspaceName.trim())
      setWorkspaceName('')
      setNotice('Workspace created.')
      navigate('/')
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setCreating(false)
    }
  }

  if (!workspace || !role) return null

  return (
    <>
      <div className="page-heading">
        <div className="section-heading">
          <h1 tabIndex={-1}>The people behind the links.</h1>
          <span className={`role-badge role-${role}`}>{ROLE_LABEL[role]}</span>
        </div>
        <p>
          {workspace.name} · invite teammates and decide who can change what.
        </p>
      </div>

      {error && (
        <div className="panel inline-alert" role="alert">
          <X size={18} />
          <div>
            <strong>That action did not go through.</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      <div className="members-layout">
        <section className="panel members-panel" aria-labelledby="members-heading">
          <div className="section-heading">
            <div>
              <h2 id="members-heading">Members</h2>
              <p className="meta">
                {members.length} {members.length === 1 ? 'person' : 'people'} in
                this workspace.
              </p>
            </div>
            <Users size={19} strokeWidth={1.5} />
          </div>
          {loading ? (
            <div className="loading-panel" role="status" aria-busy="true">
              Loading members…
            </div>
          ) : (
            <div className="member-list">
              {members.map((member) => (
                <div className="member-row" key={member.user_id}>
                  <span className="member-avatar" aria-hidden="true">
                    {member.display_name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="member-identity">
                    <strong>
                      {member.display_name}
                      {member.user_id === me && (
                        <span className="source-label">You</span>
                      )}
                    </strong>
                    <span>{member.email}</span>
                  </div>
                  {manageable(member) ? (
                    <select
                      className="role-select"
                      value={member.role}
                      aria-label={`Role for ${member.display_name}`}
                      disabled={busyId === member.user_id}
                      onChange={(event) =>
                        void changeRole(
                          member,
                          event.target.value as AssignableRole,
                        )
                      }
                    >
                      <option value="viewer">Viewer</option>
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  ) : (
                    <span className={`role-badge role-${member.role}`}>
                      {member.role === 'owner' && <Crown size={12} />}
                      {ROLE_LABEL[member.role]}
                    </span>
                  )}
                  {member.user_id === me && member.role !== 'owner' ? (
                    <button
                      type="button"
                      className="text-button member-leave"
                      disabled={busyId === member.user_id}
                      onClick={() => void remove(member)}
                    >
                      Leave
                    </button>
                  ) : manageable(member) ? (
                    <button
                      type="button"
                      className="icon-button member-remove"
                      aria-label={`Remove ${member.display_name}`}
                      disabled={busyId === member.user_id}
                      onClick={() => void remove(member)}
                    >
                      <Trash2 size={15} />
                    </button>
                  ) : (
                    <span className="member-spacer" />
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="meta members-note">
            {ROLE_NOTE[role]} Roles are enforced by the API, not just this screen.
          </p>
        </section>

        <div className="members-side">
          {canAdmin ? (
            <section className="panel invite-panel" aria-labelledby="invite-heading">
              <div className="section-heading">
                <div>
                  <h2 id="invite-heading">Invite someone</h2>
                  <p className="meta">Links expire after seven days.</p>
                </div>
                <UserPlus size={19} strokeWidth={1.5} />
              </div>
              <form onSubmit={invite}>
                <label htmlFor="invite-email">Email (optional)</label>
                <input
                  id="invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="teammate@example.com"
                  autoComplete="off"
                />
                <label htmlFor="invite-role">Role</label>
                <select
                  id="invite-role"
                  value={inviteRole}
                  onChange={(event) =>
                    setInviteRole(event.target.value as AssignableRole)
                  }
                >
                  <option value="viewer">Viewer · read only</option>
                  <option value="member">Member · manage links</option>
                  <option value="admin">Admin · manage people</option>
                </select>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={inviting}
                >
                  {inviting ? (
                    <>
                      <LoaderCircle size={15} className="spin" /> Creating…
                    </>
                  ) : (
                    <>
                      Create invite link <ArrowRight size={15} />
                    </>
                  )}
                </button>
              </form>
              {createdInvite?.token && (
                <div className="invite-result" role="status">
                  <div className="section-heading">
                    <strong>
                      <Check size={14} /> Invite ready
                    </strong>
                  </div>
                  <code>
                    {`${window.location.origin}/invite/${createdInvite.token}`}
                  </code>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      void copy(
                        `${window.location.origin}/invite/${createdInvite.token}`,
                      )
                    }
                  >
                    <Copy size={14} /> Copy link
                  </button>
                </div>
              )}
            </section>
          ) : (
            <section className="panel invite-panel">
              <div className="section-heading">
                <div>
                  <h2>Invitations</h2>
                  <p className="meta">Only admins and owners can invite.</p>
                </div>
                <Shield size={19} strokeWidth={1.5} />
              </div>
              <p className="meta">
                You can see who is here and how links are performing. Ask an
                admin if someone needs access.
              </p>
            </section>
          )}

          {canAdmin && (
            <section className="panel invite-panel" aria-labelledby="pending-heading">
              <div className="section-heading">
                <div>
                  <h2 id="pending-heading">Pending invitations</h2>
                  <p className="meta">Active links only.</p>
                </div>
              </div>
              {invitations.length === 0 ? (
                <p className="meta">No open invitations.</p>
              ) : (
                <div className="invite-list">
                  {invitations.map((invitation) => (
                    <div className="invite-row" key={invitation.id}>
                      <div>
                        <strong>{ROLE_LABEL[invitation.role]}</strong>
                        <span>
                          {invitation.invited_email ?? 'Anyone with the link'} ·
                          expires{' '}
                          {new Date(invitation.expires_at).toLocaleDateString(
                            'en-US',
                            { month: 'short', day: 'numeric', timeZone: 'UTC' },
                          )}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Revoke invitation"
                        disabled={busyId === invitation.id}
                        onClick={() => void revoke(invitation)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="panel invite-panel" aria-labelledby="new-workspace-heading">
            <div className="section-heading">
              <div>
                <h2 id="new-workspace-heading">Start another workspace</h2>
                <p className="meta">For a team, client, or side project.</p>
              </div>
            </div>
            <form onSubmit={createWorkspace}>
              <label htmlFor="workspace-name">Workspace name</label>
              <input
                id="workspace-name"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder="Acme Team"
                maxLength={80}
              />
              <button
                type="submit"
                className="secondary-button"
                disabled={creating || !workspaceName.trim()}
              >
                {creating ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Users size={15} />
                )}
                Create workspace
              </button>
            </form>
          </section>
        </div>
      </div>

      <div
        className={`toast ${notice ? 'visible' : ''}`}
        role="status"
        aria-live="polite"
      >
        {notice && (
          <>
            <Check size={16} />
            <span>{notice}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setNotice('')}
            >
              <X size={14} />
            </button>
          </>
        )}
      </div>
    </>
  )
}
