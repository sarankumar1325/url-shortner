import { useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Flag,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  createAbuseReport,
  isProblem,
  type AbuseReason,
  type AbuseReportReceipt,
} from './api'
import { BrandMark } from './AuthPage'
import Select from './Select'
import { ABUSE_REASONS, validateReport, type ReportFieldErrors } from './links'

function errorText(error: unknown): string {
  if (isProblem(error)) {
    const problem = error.problem
    if (
      problem.status === 429 &&
      problem.retryAfterSeconds !== undefined
    ) {
      return `${problem.detail} Try again in ${Math.max(1, Math.ceil(problem.retryAfterSeconds))} seconds.`
    }
    return problem.detail
  }
  return 'Something went wrong. Please try again.'
}

export default function ReportPage() {
  const [params] = useSearchParams()
  const [shortCode, setShortCode] = useState(params.get('code') ?? '')
  const [reason, setReason] = useState<AbuseReason>('phishing')
  const [details, setDetails] = useState('')
  const [email, setEmail] = useState('')
  const [errors, setErrors] = useState<ReportFieldErrors>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<AbuseReportReceipt | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const checked = validateReport({ shortCode, details, email })
    setErrors(checked.errors)
    setProblem(null)
    if (Object.keys(checked.errors).length > 0 || !checked.code) return

    setBusy(true)
    try {
      const result = await createAbuseReport(
        {
          short_code: checked.code,
          reason,
          details: checked.details,
          reporter_email: checked.email,
        },
        new AbortController().signal,
      )
      setReceipt(result)
    } catch (error) {
      setProblem(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  function reportAnother() {
    setReceipt(null)
    setShortCode('')
    setDetails('')
    setEmail('')
    setErrors({})
    setProblem(null)
  }

  const remaining = 2000 - details.length

  return (
    <div className="public-page">
      <header className="public-header">
        <Link to="/" aria-label="Shortly home" className="brand-link">
          <BrandMark />
        </Link>
        <Link to="/" className="text-button">
          <ArrowLeft size={14} /> Back to Shortly
        </Link>
      </header>

      <main className="report-panel">
        {receipt ? (
          <section className="report-card" aria-live="polite">
            <span className="report-icon safe">
              <CheckCircle2 size={22} />
            </span>
            <span className="auth-eyebrow">Report received</span>
            <h1>Thank you for flagging it.</h1>
            <p>
              We recorded your report for{' '}
              <strong>/{receipt.short_code}</strong> and will review the
              destination. Reports that describe phishing or malware are
              reviewed first.
            </p>
            <p className="report-receipt">
              Reference <code>{receipt.id}</code>
            </p>
            <div className="report-actions">
              <button
                type="button"
                className="primary-button"
                onClick={reportAnother}
              >
                <Flag size={16} /> Report another link
              </button>
              <Link to="/" className="secondary-button">
                Back to Shortly
              </Link>
            </div>
          </section>
        ) : (
          <section className="report-card">
            <span className="report-icon">
              <Flag size={21} />
            </span>
            <span className="auth-eyebrow">Trust and safety</span>
            <h1>Report a harmful link.</h1>
            <p>
              Tell us about a Shortly link that leads to phishing, malware,
              spam, or impersonation. You do not need an account.
            </p>

            {problem && (
              <div className="form-problem" role="alert">
                <span>{problem}</span>
              </div>
            )}

            <form onSubmit={submit} noValidate className="report-form">
              <div>
                <label htmlFor="report-code">Short link or code</label>
                <div
                  className={`auth-input ${errors.shortCode ? 'invalid' : ''}`}
                >
                  <Flag size={17} aria-hidden="true" />
                  <input
                    id="report-code"
                    value={shortCode}
                    onChange={(event) => {
                      setShortCode(event.target.value)
                      setErrors((current) => ({
                        ...current,
                        shortCode: undefined,
                      }))
                    }}
                    placeholder="shortlyyy.vercel.app/abc123"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={Boolean(errors.shortCode)}
                    aria-describedby={
                      errors.shortCode ? 'report-code-error' : undefined
                    }
                  />
                </div>
                {errors.shortCode && (
                  <p className="field-error" id="report-code-error" role="alert">
                    {errors.shortCode}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="report-reason">What is wrong with it?</label>
                <Select
                  id="report-reason"
                  className="select-lg"
                  value={reason}
                  onChange={setReason}
                  options={ABUSE_REASONS}
                />
              </div>

              <div>
                <label htmlFor="report-details">
                  Details <span className="label-hint">optional</span>
                </label>
                <textarea
                  id="report-details"
                  value={details}
                  onChange={(event) => {
                    setDetails(event.target.value)
                    setErrors((current) => ({
                      ...current,
                      details: undefined,
                    }))
                  }}
                  maxLength={2000}
                  rows={4}
                  placeholder="What happens when the link opens? Any context helps."
                  aria-invalid={Boolean(errors.details)}
                  aria-describedby={
                    errors.details ? 'report-details-error' : undefined
                  }
                />
                {errors.details && (
                  <p
                    className="field-error"
                    id="report-details-error"
                    role="alert"
                  >
                    {errors.details}
                  </p>
                )}
                <p className="field-note">
                  {remaining < 200
                    ? `${remaining} characters left`
                    : 'Do not include passwords or private information.'}
                </p>
              </div>

              <div>
                <label htmlFor="report-email">
                  Your email <span className="label-hint">optional</span>
                </label>
                <div
                  className={`auth-input ${errors.email ? 'invalid' : ''}`}
                >
                  <input
                    id="report-email"
                    type="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value)
                      setErrors((current) => ({
                        ...current,
                        email: undefined,
                      }))
                    }}
                    placeholder="you@example.com"
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={Boolean(errors.email)}
                    aria-describedby={
                      errors.email ? 'report-email-error' : undefined
                    }
                  />
                </div>
                {errors.email && (
                  <p className="field-error" id="report-email-error" role="alert">
                    {errors.email}
                  </p>
                )}
              </div>

              <button
                type="submit"
                className="primary-button auth-submit"
                disabled={busy}
              >
                {busy ? (
                  <>
                    <LoaderCircle size={16} className="spin" /> Sending report…
                  </>
                ) : (
                  <>
                    Send report <Flag size={16} />
                  </>
                )}
              </button>
            </form>

            <p className="report-privacy">
              <ShieldCheck size={15} /> Reports never store your IP address. We
              keep the short code, the reason, and anything you write here.
            </p>
          </section>
        )}
      </main>

      <footer className="public-footer">
        <span>Thoughtfully short.</span>
        <Link to="/" className="text-button">
          Back to home
        </Link>
      </footer>
    </div>
  )
}
