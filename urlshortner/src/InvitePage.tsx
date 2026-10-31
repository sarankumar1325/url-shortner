import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Check,
  LoaderCircle,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  acceptInvitation,
  isProblem,
  previewInvitation,
  type InvitationPreview,
} from './api'
import { useAuth } from './auth'
import { BrandMark } from './AuthPage'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

export default function InvitePage() {
  const { token = '' } = useParams()
  const auth = useAuth()
  const navigate = useNavigate()
  const [preview, setPreview] = useState<InvitationPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    previewInvitation(token, controller.signal)
      .then(setPreview)
      .catch((failure: unknown) => {
        if (isProblem(failure) && failure.problem.kind === 'cancelled') return
        setError(
          isProblem(failure)
            ? failure.problem.detail
            : 'This invitation could not be loaded.',
        )
      })
    return () => controller.abort()
  }, [token])

  async function join() {
    setBusy(true)
    setError('')
    try {
      const workspace = await acceptInvitation(
        token,
        new AbortController().signal,
      )
      auth.addWorkspace(workspace)
      setAccepted(true)
      window.setTimeout(() => navigate('/', { replace: true }), 700)
    } catch (failure) {
      if (isProblem(failure) && failure.problem.status === 401) {
        navigate(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)
        return
      }
      setError(
        isProblem(failure)
          ? failure.problem.detail
          : 'The invitation could not be accepted.',
      )
    } finally {
      setBusy(false)
    }
  }

  const next = encodeURIComponent(`/invite/${token}`)

  return (
    <div className="auth-page invite-page">
      <aside className="auth-story">
        <Link to="/" aria-label="Shortly home" className="brand-link">
          <BrandMark />
        </Link>
        <div className="auth-story-copy">
          <span className="auth-eyebrow">An invitation</span>
          <h1>Good links are better shared.</h1>
          <p>
            A workspace keeps every short link, every click, and everyone who
            needs to see them in one calm place.
          </p>
        </div>
        <span className="auth-story-foot">Thoughtfully short.</span>
      </aside>

      <main className="auth-panel">
        <div className="auth-form invite-card">
          {error && !preview ? (
            <>
              <div className="invite-icon error">
                <X size={24} />
              </div>
              <h2>This invitation has closed.</h2>
              <p>{error}</p>
              <Link className="primary-button" to="/login">
                Go to sign in <ArrowRight size={16} />
              </Link>
            </>
          ) : !preview ? (
            <div className="loading-panel" role="status" aria-busy="true">
              <LoaderCircle size={18} className="spin" /> Loading invitation…
            </div>
          ) : accepted ? (
            <>
              <div className="invite-icon success">
                <Check size={24} />
              </div>
              <h2>You’re in.</h2>
              <p>
                Opening <strong>{preview.workspace_name}</strong> now.
              </p>
            </>
          ) : (
            <>
              <div className="invite-icon">
                <UserPlus size={24} />
              </div>
              <span className="auth-eyebrow">
                {preview.invited_by
                  ? `${preview.invited_by} invited you`
                  : 'You were invited'}
              </span>
              <h2>Join {preview.workspace_name}</h2>
              <p>
                You’ll join as a{' '}
                <strong>{ROLE_LABEL[preview.role] ?? preview.role}</strong>.
                {preview.invited_email && (
                  <>
                    {' '}
                    This invitation was addressed to {preview.invited_email}.
                  </>
                )}
              </p>
              <div className="invite-facts">
                <span>
                  <ShieldCheck size={15} />
                  {ROLE_LABEL[preview.role] ?? preview.role} access
                </span>
                <span>
                  Expires{' '}
                  {new Date(preview.expires_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC',
                  })}
                </span>
              </div>
              {error && (
                <p className="field-error" role="alert">
                  {error}
                </p>
              )}
              {auth.status === 'authenticated' ? (
                <button
                  type="button"
                  className="primary-button auth-submit"
                  disabled={busy}
                  onClick={() => void join()}
                >
                  {busy ? (
                    <>
                      <LoaderCircle size={16} className="spin" /> Joining…
                    </>
                  ) : (
                    <>
                      Join workspace <ArrowRight size={17} />
                    </>
                  )}
                </button>
              ) : auth.status === 'loading' ? (
                <div className="loading-panel" role="status" aria-busy="true">
                  Checking your session…
                </div>
              ) : (
                <div className="invite-actions">
                  <Link
                    className="primary-button"
                    to={`/signup?next=${next}`}
                  >
                    Create an account <ArrowRight size={16} />
                  </Link>
                  <Link className="secondary-button" to={`/login?next=${next}`}>
                    I already have one
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
