import { useState, type FormEvent } from 'react'
import {
  ArrowRight,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { isProblem, type ApiProblem } from './api'
import { useAuth } from './auth'

function errorText(problem: ApiProblem): string {
  if (problem.status === 429 && problem.retryAfterSeconds !== undefined) {
    return `${problem.detail} Try again in ${Math.max(1, Math.ceil(problem.retryAfterSeconds))} seconds.`
  }
  return problem.detail
}

export function BrandMark() {
  return (
    <span className="brand">
      <svg
        width="30"
        height="30"
        viewBox="0 0 30 30"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M17.8 8.7 20 6.5a5 5 0 0 1 7 7l-5 5a5 5 0 0 1-7 0M12.2 21.3 10 23.5a5 5 0 0 1-7-7l5-5a5 5 0 0 1 7 0M10.7 19.3l8.6-8.6"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
        />
      </svg>
      <span className="brand-word">
        shortly<span className="brand-period">.</span>
      </span>
    </span>
  )
}

export default function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const auth = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next')
  const returnTo = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [problem, setProblem] = useState<ApiProblem | null>(null)
  const [fieldError, setFieldError] = useState<{ email?: string; password?: string }>({})
  const [busy, setBusy] = useState(false)

  if (auth.status === 'authenticated') {
    return <Navigate to={returnTo} replace />
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors: { email?: string; password?: string } = {}
    if (!email.trim()) errors.email = 'Enter your email address.'
    if (mode === 'signup' && password.length < 10) {
      errors.password = 'Use at least 10 characters.'
    } else if (mode === 'login' && !password) {
      errors.password = 'Enter your password.'
    }
    setFieldError(errors)
    setProblem(null)
    if (Object.keys(errors).length > 0) return

    setBusy(true)
    try {
      if (mode === 'signup') {
        await auth.signup(email.trim(), password, displayName.trim())
      } else {
        await auth.login(email.trim(), password)
      }
      navigate(returnTo, { replace: true })
    } catch (error) {
      if (isProblem(error)) {
        setProblem(error.problem)
        const mapped: { email?: string; password?: string } = {}
        for (const issue of error.problem.errors) {
          if (issue.field === 'email') mapped.email = issue.message
          if (issue.field === 'password') mapped.password = issue.message
        }
        setFieldError(mapped)
      } else {
        setProblem({
          kind: 'network',
          code: 'network',
          detail: 'Something went wrong. Please try again.',
          errors: [],
        })
      }
    } finally {
      setBusy(false)
    }
  }

  const isSignup = mode === 'signup'

  return (
    <div className="auth-page">
      <aside className="auth-story">
        <Link to="/" aria-label="Shortly home" className="brand-link">
          <BrandMark />
        </Link>
        <div className="auth-story-copy">
          <span className="auth-eyebrow">A smaller link. An open web.</span>
          <h1>Links that remember where they came from.</h1>
          <p>
            Build a workspace, invite the people you work with, and see how every
            click travels. No spreadsheets, no mystery traffic.
          </p>
          <div className="auth-points">
            <div>
              <ShieldCheck size={19} strokeWidth={1.6} />
              <span>
                <strong>Roles that fit the room.</strong> Owners, admins,
                members, and viewers each see exactly what they need.
              </span>
            </div>
            <div>
              <UserRound size={19} strokeWidth={1.6} />
              <span>
                <strong>One home per person.</strong> Your personal workspace
                stays yours; invite people in when you want company.
              </span>
            </div>
          </div>
        </div>
        <span className="auth-story-foot">Thoughtfully short.</span>
      </aside>

      <main className="auth-panel">
        <div className="auth-form">
          <div className="auth-form-heading">
            <span className="auth-eyebrow">{isSignup ? 'Start here' : 'Welcome back'}</span>
            <h2>{isSignup ? 'Make room for better links.' : 'Pick up where you left off.'}</h2>
            <p>
              {isSignup
                ? 'Create an account and your personal workspace is ready instantly.'
                : 'Sign in to your workspaces, links, and analytics.'}
            </p>
          </div>

          {problem && (
            <div className="form-problem" role="alert">
              <span>{errorText(problem)}</span>
            </div>
          )}

          <form onSubmit={submit} noValidate>
            {isSignup && (
              <div>
                <label htmlFor="display-name">Your name</label>
                <div className="auth-input">
                  <UserRound size={17} aria-hidden="true" />
                  <input
                    id="display-name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Saran"
                    autoComplete="name"
                    maxLength={80}
                  />
                </div>
              </div>
            )}

            <div>
              <label htmlFor="email">Email</label>
              <div className={`auth-input ${fieldError.email ? 'invalid' : ''}`}>
                <Mail size={17} aria-hidden="true" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    setFieldError((current) => ({ ...current, email: undefined }))
                  }}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={Boolean(fieldError.email)}
                />
              </div>
              {fieldError.email && (
                <p className="field-error" role="alert">
                  {fieldError.email}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="password">Password</label>
              <div className={`auth-input ${fieldError.password ? 'invalid' : ''}`}>
                <LockKeyhole size={17} aria-hidden="true" />
                <input
                  id="password"
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    setFieldError((current) => ({ ...current, password: undefined }))
                  }}
                  placeholder={isSignup ? 'At least 10 characters' : 'Your password'}
                  autoComplete={isSignup ? 'new-password' : 'current-password'}
                  aria-invalid={Boolean(fieldError.password)}
                />
                <button
                  type="button"
                  className="icon-button reveal-button"
                  aria-label={reveal ? 'Hide password' : 'Show password'}
                  onClick={() => setReveal(!reveal)}
                >
                  {reveal ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              {fieldError.password && (
                <p className="field-error" role="alert">
                  {fieldError.password}
                </p>
              )}
            </div>

            <button type="submit" className="primary-button auth-submit" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle size={16} className="spin" />
                  {isSignup ? 'Creating workspace…' : 'Signing in…'}
                </>
              ) : (
                <>
                  {isSignup ? 'Create account' : 'Sign in'}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>

          <p className="auth-switch">
            {isSignup ? 'Already have an account?' : 'New to Shortly?'}{' '}
            <Link
              to={`${isSignup ? '/login' : '/signup'}${next ? `?next=${encodeURIComponent(next)}` : ''}`}
            >
              {isSignup ? 'Sign in' : 'Create one'}
            </Link>
          </p>
          <p className="auth-legal">
            Sessions live in a secure, http-only cookie. Passwords are hashed
            with Argon2id.
          </p>
        </div>
      </main>
    </div>
  )
}
