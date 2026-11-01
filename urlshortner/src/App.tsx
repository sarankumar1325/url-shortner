import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Flag,
  Globe2,
  Keyboard,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react'
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom'
import {
  createLink,
  deleteLink as deleteLinkRequest,
  getAnalytics,
  getLink,
  isProblem,
  listLinks,
  updateLink as updateLinkRequest,
  type Access,
  type ApiProblem,
  type CreateBody,
  type CreatedLink,
} from './api'
import { AuthProvider, useAuth } from './auth'
import AuthPage, { BrandMark } from './AuthPage'
import InvitePage from './InvitePage'
import ReportPage from './ReportPage'
import { AnalyticsTeaser } from './ClickChart'
import LinkList from './LinkList'
import Modal from './Modal'
import BulkImport from './BulkImport'
import {
  applyMetadata,
  campaignDestination,
  csvFileName,
  displayShortUrl,
  downloadTextFile,
  expiryInstant,
  fieldErrors,
  getLinkStatus,
  limitFieldErrors,
  linksCsv,
  normalizeDestination,
  parseTags,
  previewUrl,
  recordFromMetadata,
  statusClass,
  titleFor,
  validateDraft,
  validateLimits,
  visitsLabel,
  type LimitErrors,
  type LinkRecord,
} from './links'
import { shortcutFor } from './shortcuts'
import {
  EMPTY_CAMPAIGN,
  UTM_KEYS,
  UTM_LABELS,
  campaignChips,
  parseCampaign,
  readUtmRecents,
  rememberUtm,
  type CampaignFields,
} from './utm'
import CommandPalette, { type PaletteCommand } from './CommandPalette'
import { EXPLORE_ITEMS, WORKSPACE_ITEMS } from './navigation'
import { copyText, fullUrl, pasteIsForPage, urlFromPaste } from './clipboard'
import { CopyContext } from './copyContext'
import { useAliasAvailability } from './aliasAvailability'
import TopLinks from './TopLinks'
import Sidebar from './Sidebar'
import {
  readSidebarCollapsed,
  useMediaQuery,
  writeSidebarCollapsed,
} from './layout'
import './App.css'

const MembersPage = lazy(() => import('./MembersPage'))
const LinkAnalytics = lazy(() => import('./LinkAnalytics'))
const SettingsPage = lazy(() => import('./SettingsPage'))
const QrStudio = lazy(() => import('./QrStudio'))
const SystemDesign = lazy(() => import('./SystemDesign'))
const Dashboard = lazy(() => import('./Dashboard'))
const LinkQrPreview = lazy(() => import('./LinkQrPreview'))

const ROUTE_TITLES: [string, string, string][] = [
  ['/dashboard', 'Dashboard', 'Dashboard'],
  ['/links', 'Your links', 'Your links'],
  ['/qr', 'QR studio', 'QR studio'],
  ['/members', 'People', 'People'],
  ['/settings', 'Settings', 'Settings'],
  ['/system', 'System design', 'System design'],
]

/** [document title, breadcrumb] for a workspace path. */
function routeTitle(pathname: string): [string, string] {
  if (pathname === '/') return ['Your workspace', 'Overview']
  const match = ROUTE_TITLES.find(([path]) => path === pathname)
  if (match) return [match[1], match[2]]
  if (pathname.startsWith('/links/')) return ['Link details', 'Link details']
  return ['Page not found', 'Not found']
}

function PageLoading({ label }: { label: string }) {
  return (
    <div className="loading-panel" role="status" aria-busy="true">
      {label}
    </div>
  )
}

type Attempt = { key: string; body: CreateBody }

function problemText(problem: ApiProblem): string {
  if (problem.errors.some((issue) => issue.field === 'tags' && /extra inputs/i.test(issue.message))) {
    return 'Tags are not available on this server yet. Remove the tags and try again.'
  }
  if (problem.status === 429 && problem.retryAfterSeconds !== undefined) {
    return `${problem.detail} Try again in ${Math.max(1, Math.ceil(problem.retryAfterSeconds))} seconds.`
  }
  return problem.detail
}

function describeError(error: unknown): string {
  if (isProblem(error)) return problemText(error.problem)
  return 'Something went wrong. Please try again.'
}

function createFieldErrors(problem: ApiProblem): {
  destination?: string
  alias?: string
  expiresAt?: string
} {
  const mapped = fieldErrors(problem.errors)
  if (Object.keys(mapped).length > 0) return mapped
  if (problem.errors.length > 0) return {}
  if (problem.code === 'invalid_url') return { destination: problem.detail }
  if (problem.code === 'reserved_alias') return { alias: problem.detail }
  if (problem.code === 'alias_taken') {
    return { alias: 'That alias is already in use.' }
  }
  if (problem.code === 'validation_error') {
    if (/alias/i.test(problem.detail)) return { alias: problem.detail }
    if (/expir/i.test(problem.detail)) return { expiresAt: problem.detail }
    return { destination: problem.detail }
  }
  return {}
}

/** UTM values already in a destination, or null when it has none. */
function campaignFromUrl(value: string): Required<CampaignFields> | null {
  const parsed = parseCampaign(normalizeDestination(value))
  return parsed?.found ? parsed.fields : null
}

const UTM_PLACEHOLDERS: Record<(typeof UTM_KEYS)[number], string> = {
  source: 'newsletter',
  medium: 'email',
  campaign: 'spring-launch',
  term: 'running-shoes',
  content: 'header-button',
}

function BootScreen() {
  return (
    <div className="boot-screen" role="status" aria-busy="true">
      <BrandMark />
      <span className="boot-status">
        <LoaderCircle size={17} className="spin" /> Opening your workspace…
      </span>
    </div>
  )
}

function CreateForm({
  workspaceId,
  workspaceName,
  links,
  onCreate,
  onCopy,
  pasted,
}: {
  workspaceId: string
  workspaceName: string
  links: LinkRecord[]
  onCreate: (link: CreatedLink) => void
  onCopy: (text: string) => void
  /** A URL pasted outside any field; prefilled and ready to submit. */
  pasted?: string
}) {
  const [destination, setDestination] = useState(pasted ?? '')
  const [alias, setAlias] = useState('')
  const aliasState = useAliasAvailability(alias)
  const [expiry, setExpiry] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [campaign, setCampaign] = useState<Required<CampaignFields>>(
    () => (pasted ? campaignFromUrl(pasted) : null) ?? { ...EMPTY_CAMPAIGN },
  )
  // True while the fields mirror the URL's own utm_* values.
  const [prefilled, setPrefilled] = useState(() => Boolean(pasted && campaignFromUrl(pasted)))
  const [replaceUtm, setReplaceUtm] = useState(prefilled)
  const [campaignOpen, setCampaignOpen] = useState(prefilled)
  const [campaignError, setCampaignError] = useState<string | null>(null)
  const [recents, setRecents] = useState(() => readUtmRecents(window.localStorage, workspaceId))
  const [tagError, setTagError] = useState<string | null>(null)
  const [fallback, setFallback] = useState('')
  const [visitLimit, setVisitLimit] = useState('')
  const [limitErrors, setLimitErrors] = useState<LimitErrors>({})
  const [options, setOptions] = useState(false)
  const [errors, setErrors] = useState<ReturnType<typeof validateDraft>>({})
  const [pasteMessage, setPasteMessage] = useState(
    pasted ? 'Pasted from your clipboard. Press Enter to shorten it.' : '',
  )
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [problem, setProblem] = useState<ApiProblem | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<CreatedLink | null>(null)
  const copyButton = useRef<HTMLButtonElement>(null)
  const submitButton = useRef<HTMLButtonElement>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  const inFlight = useRef<AbortController | null>(null)

  useEffect(() => {
    if (result) copyButton.current?.focus()
  }, [result])

  useEffect(() => {
    if (pasted) submitButton.current?.focus()
  }, [pasted])

  useEffect(() => () => inFlight.current?.abort(), [])

  async function send(next: Attempt) {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setSubmitting(true)
    setProblem(null)
    try {
      const created = await createLink(
        next.body,
        next.key,
        workspaceId,
        controller.signal,
      )
      setResult(created)
      setAttempt(null)
      onCreate(created)
      if (UTM_KEYS.some((key) => campaign[key].trim()))
        setRecents(rememberUtm(window.localStorage, workspaceId, campaign))
    } catch (error) {
      if (isProblem(error) && error.problem.kind === 'cancelled') return
      if (!isProblem(error)) {
        setProblem({
          kind: 'network',
          code: 'network',
          detail: 'Something went wrong. Please try again.',
          errors: [],
        })
        return
      }
      const fieldProblems = createFieldErrors(error.problem)
      if (error.problem.errors.some((issue) => issue.field === 'tags')) {
        setOptions(true)
        setTagError(problemText(error.problem))
      }
      const limitProblems = limitFieldErrors(error.problem.errors)
      if (Object.keys(limitProblems).length > 0) {
        setLimitErrors(limitProblems)
        setOptions(true)
      }
      if (Object.keys(fieldProblems).length > 0) {
        setErrors((current) => ({ ...current, ...fieldProblems }))
        if (fieldProblems.alias || fieldProblems.expiresAt) setOptions(true)
      }
      setProblem(error.problem)
      const retryable =
        error.problem.kind === 'network' ||
        error.problem.kind === 'timeout' ||
        error.problem.status === 429 ||
        error.problem.status === 503
      setAttempt(retryable ? next : null)
    } finally {
      setSubmitting(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsedTags = parseTags(tagInput)
    const normalized = normalizeDestination(destination)
    const tracked = campaignDestination(normalized, campaign, replaceUtm)
    const problems = validateDraft(normalized, alias, expiry, links)
    if (!problems.destination && !tracked.error) {
      problems.destination = validateDraft(tracked.url, '', '', []).destination
    }
    const limits = validateLimits(fallback, visitLimit)
    const limitProblem = Object.values(limits.errors).some(Boolean)
    setErrors(problems)
    setTagError(parsedTags.error)
    setCampaignError(tracked.error)
    setLimitErrors(limits.errors)
    if (
      Object.values(problems).some(Boolean) ||
      parsedTags.error ||
      tracked.error ||
      limitProblem
    ) {
      if (problems.alias || problems.expiresAt || parsedTags.error || limitProblem)
        setOptions(true)
      if (tracked.error) setCampaignOpen(true)
      window.requestAnimationFrame(() => {
        if (problems.destination) urlInput.current?.focus()
        else if (parsedTags.error) document.getElementById('tags')?.focus()
        else if (tracked.error) document.getElementById('campaign-source')?.focus()
        else if (!problems.alias && !problems.expiresAt && limitProblem)
          document
            .getElementById(limits.errors.fallbackUrl ? 'fallback-url' : 'visit-limit')
            ?.focus()
        else
          document
            .getElementById(problems.alias ? 'custom-alias' : 'expires-at')
            ?.focus()
      })
      return
    }
    const body: CreateBody = {
      long_url: tracked.url,
      custom_alias: alias || null,
      expires_at: expiry ? expiryInstant(expiry) : null,
      tags: parsedTags.tags,
      fallback_url: limits.fallbackUrl,
      max_clicks: limits.maxClicks,
    }
    void send({ key: crypto.randomUUID(), body })
  }

  function edit() {
    setAttempt(null)
    setProblem(null)
  }

  /** Mirror utm_* values from a pasted or typed URL, unless the user typed their own. */
  function adoptCampaign(next: string) {
    const found = campaignFromUrl(next)
    if (found) {
      if (!prefilled && UTM_KEYS.some((key) => campaign[key].trim())) return
      setCampaign(found)
      setPrefilled(true)
      setReplaceUtm(true)
      setCampaignOpen(true)
    } else if (prefilled) {
      setCampaign({ ...EMPTY_CAMPAIGN })
      setPrefilled(false)
      setReplaceUtm(false)
    }
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText()
      setDestination(text)
      adoptCampaign(text)
      setPasteMessage('')
      edit()
    } catch {
      setPasteMessage(
        'Clipboard access is unavailable. Paste into the field with your keyboard.',
      )
    }
    urlInput.current?.focus()
  }

  if (result)
    return (
      <section
        className="composer panel result-panel"
        aria-labelledby="result-heading"
      >
        <div className="section-heading">
          <span className="result-label">
            <Check size={16} /> Short link ready
          </span>
          <button
            className="text-button result-new-link"
            type="button"
            aria-label="Create another link"
            onClick={() => {
              setResult(null)
              setDestination('')
              setAlias('')
              setExpiry('')
              setTagInput('')
              setFallback('')
              setVisitLimit('')
              setLimitErrors({})
              setCampaign({ ...EMPTY_CAMPAIGN })
              setPrefilled(false)
              setReplaceUtm(false)
              setCampaignError(null)
              setCampaignOpen(false)
              setTagError(null)
              setErrors({})
              setProblem(null)
              setAttempt(null)
              window.requestAnimationFrame(() => urlInput.current?.focus())
            }}
          >
            <Plus size={16} /> Create another
          </button>
        </div>
        <h2 tabIndex={-1} id="result-heading">
          A shorter way to share.
        </h2>
        <div
          className="result-address"
          data-copy-url={fullUrl(result.short_url)}
          data-copy-default=""
        >
          <input
            className="result-url"
            value={fullUrl(result.short_url)}
            readOnly
            aria-label="Short link"
            spellCheck={false}
            onClick={(event) => event.currentTarget.select()}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            ref={copyButton}
            type="button"
            className="secondary-button result-copy"
            onClick={() => onCopy(result.short_url)}
            aria-label="Copy short link"
          >
            <Copy size={16} /> Copy link
          </button>
        </div>
        <p className="result-disclaimer">
          This link is live in <strong>{workspaceName}</strong>. Anyone in this
          workspace with member access can manage it.
        </p>
        <p className="field-hint peek-hint">
          <Eye size={14} aria-hidden="true" /> Add <kbd>+</kbd> to the end of
          the link to preview its destination before visiting.
        </p>
        <details className="destination-disclosure">
          <summary>
            View destination <ChevronDown size={14} />
          </summary>
          <p>{result.long_url}</p>
        </details>
        <Link to={`/links/${result.short_code}`} className="primary-button">
          Open link details <ArrowRight size={16} />
        </Link>
      </section>
    )

  const retryable =
    problem !== null &&
    (problem.kind === 'network' ||
      problem.kind === 'timeout' ||
      problem.status === 429 ||
      problem.status === 503)

  return (
    <section className="composer panel" aria-labelledby="composer-heading">
      <div className="section-heading">
        <h2 id="composer-heading">Make something worth sharing.</h2>
        <Link2 size={20} strokeWidth={1.5} />
      </div>
      <form onSubmit={submit} noValidate>
        <label htmlFor="destination">Destination URL</label>
        <div
          className={`destination-input ${errors.destination ? 'invalid' : ''}`}
        >
          <Link2 size={18} aria-hidden="true" />
          <input
            id="destination"
            ref={urlInput}
            type="url"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="https://your-very-long-link.com/something-great"
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value)
              adoptCampaign(event.target.value)
              setPasteMessage('')
              setCampaignError(null)
              edit()
              if (errors.destination)
                setErrors({ ...errors, destination: undefined })
            }}
            aria-invalid={Boolean(errors.destination)}
            aria-describedby={
              errors.destination ? 'destination-error' : 'destination-hint'
            }
          />
          <button type="button" onClick={paste} className="paste-button">
            Paste
          </button>
        </div>
        {errors.destination ? (
          <p className="field-error" id="destination-error" role="alert">
            {errors.destination}
          </p>
        ) : (
          <p className="field-hint" id="destination-hint">
            {normalizeDestination(destination) !== destination.trim() && !validateDraft(normalizeDestination(destination), '', '', []).destination
              ? `We'll use ${normalizeDestination(destination)} (added the missing slash).`
              : 'Include http:// or https:// in the destination.'}
          </p>
        )}
        {pasteMessage && (
          <p className="field-hint" role="status">
            {pasteMessage}
          </p>
        )}
        <button
          type="button"
          className="customize-button"
          aria-expanded={campaignOpen}
          aria-controls="campaign-options"
          onClick={() => setCampaignOpen(!campaignOpen)}
        >
          <Globe2 size={15} /> Add campaign tracking
          <ChevronDown size={14} className={campaignOpen ? 'rotated' : ''} />
          <span className="meta">Optional</span>
        </button>
        {campaignOpen && (
          <div className="campaign-options" id="campaign-options">
            <p className="field-hint">
              {prefilled
                ? 'Filled in from the UTM parameters already in this URL. Edit them here.'
                : 'Add UTM parameters so your analytics tool can identify where visitors came from. Recent values are suggested as you type.'}
            </p>
            <div className="campaign-fields">
              {UTM_KEYS.map((key) => (
                <div key={key}>
                  <label htmlFor={`campaign-${key}`}>
                    {UTM_LABELS[key]}
                    {(key === 'term' || key === 'content') && <span className="meta"> (optional)</span>}
                  </label>
                  <input
                    id={`campaign-${key}`}
                    value={campaign[key]}
                    placeholder={UTM_PLACEHOLDERS[key]}
                    list={recents[key].length ? `campaign-${key}-recent` : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      setCampaign({ ...campaign, [key]: event.target.value })
                      setPrefilled(false)
                      setCampaignError(null)
                      edit()
                    }}
                  />
                  {recents[key].length > 0 && (
                    <datalist id={`campaign-${key}-recent`}>
                      {recents[key].map((value) => (
                        <option key={value} value={value} />
                      ))}
                    </datalist>
                  )}
                </div>
              ))}
            </div>
            {campaignFromUrl(destination) && (
              <label className="option-check">
                <input
                  type="checkbox"
                  checked={replaceUtm}
                  onChange={(event) => {
                    setReplaceUtm(event.target.checked)
                    setCampaignError(null)
                    edit()
                  }}
                />
                <span>
                  Replace existing
                  <small>
                    {replaceUtm
                      ? 'The UTM values already in the URL are swapped for the ones above.'
                      : 'The fields above are added, so they must not repeat a UTM parameter already in the URL.'}
                  </small>
                </span>
              </label>
            )}
            {campaignError && <p className="field-error" role="alert">{campaignError}</p>}
            {(UTM_KEYS.some((key) => campaign[key].trim()) || campaignFromUrl(destination)) &&
              !campaignDestination(normalizeDestination(destination), campaign, replaceUtm).error &&
              !validateDraft(normalizeDestination(destination), '', '', []).destination && (
                <p className="campaign-preview">
                  <strong>Destination preview</strong>
                  <span>{campaignDestination(normalizeDestination(destination), campaign, replaceUtm).url}</span>
                </p>
              )}
          </div>
        )}
        <button
          type="button"
          className="customize-button"
          aria-expanded={options}
          aria-controls="link-options"
          onClick={() => setOptions(!options)}
        >
          <SlidersHorizontal size={15} /> Customize your link{' '}
          <ChevronDown size={14} className={options ? 'rotated' : ''} />
          <span className="meta">Optional</span>
        </button>
        {options && (
          <div className="form-options" id="link-options">
            <div>
              <label htmlFor="custom-alias">Custom alias</label>
              <div className={`alias-input ${errors.alias ? 'invalid' : ''}`}>
                <span>short/</span>
                <input
                  id="custom-alias"
                  value={alias}
                  onChange={(event) => {
                    setAlias(event.target.value)
                    edit()
                    if (errors.alias) setErrors({ ...errors, alias: undefined })
                  }}
                  placeholder="your-idea"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={Boolean(errors.alias)}
                  aria-describedby="alias-hint"
                />
              </div>
              <p
                className={
                  errors.alias || aliasState.status === 'unavailable'
                    ? 'field-error'
                    : `field-hint alias-${aliasState.status}`
                }
                id="alias-hint"
                aria-live="polite"
              >
                {errors.alias ? (
                  errors.alias
                ) : aliasState.status === 'idle' ? (
                  '3–32 lowercase letters, numbers, _ or -.'
                ) : (
                  <>
                    {aliasState.status === 'checking' && (
                      <LoaderCircle size={12} className="spin" />
                    )}
                    {aliasState.status === 'available' && <Check size={12} />}
                    {aliasState.message}
                  </>
                )}
              </p>
            </div>
            <div>
              <label htmlFor="expires-at">
                Expires after <span className="meta">(UTC)</span>
              </label>
              <input
                type="date"
                id="expires-at"
                value={expiry}
                onChange={(event) => {
                  setExpiry(event.target.value)
                  edit()
                  if (errors.expiresAt)
                    setErrors({ ...errors, expiresAt: undefined })
                }}
                aria-invalid={Boolean(errors.expiresAt)}
                aria-describedby="expiry-hint"
              />
              <p
                id="expiry-hint"
                className={errors.expiresAt ? 'field-error' : 'field-hint'}
              >
                {errors.expiresAt || 'Expires at the end of the selected UTC day. Leave empty for no expiry.'}
              </p>
            </div>
            <div>
              <label htmlFor="visit-limit">
                Visit limit <span className="meta">(optional)</span>
              </label>
              <input
                id="visit-limit"
                inputMode="numeric"
                value={visitLimit}
                onChange={(event) => {
                  setVisitLimit(event.target.value)
                  edit()
                  if (limitErrors.maxClicks)
                    setLimitErrors({ ...limitErrors, maxClicks: undefined })
                }}
                placeholder="No limit"
                aria-invalid={Boolean(limitErrors.maxClicks)}
                aria-describedby="visit-limit-hint"
              />
              <p
                id="visit-limit-hint"
                className={limitErrors.maxClicks ? 'field-error' : 'field-hint'}
              >
                {limitErrors.maxClicks ||
                  'Stops after this many visits. Link previews in chat apps do not count.'}
              </p>
            </div>
            <div>
              <label htmlFor="fallback-url">
                Fallback URL <span className="meta">(optional)</span>
              </label>
              <input
                id="fallback-url"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
                value={fallback}
                onChange={(event) => {
                  setFallback(event.target.value)
                  edit()
                  if (limitErrors.fallbackUrl)
                    setLimitErrors({ ...limitErrors, fallbackUrl: undefined })
                }}
                placeholder="https://example.com/offer-ended"
                aria-invalid={Boolean(limitErrors.fallbackUrl)}
                aria-describedby="fallback-url-hint"
              />
              <p
                id="fallback-url-hint"
                className={limitErrors.fallbackUrl ? 'field-error' : 'field-hint'}
              >
                {limitErrors.fallbackUrl ||
                  'Where visitors go after the link expires or runs out of visits.'}
              </p>
            </div>
            <div className="tag-field">
              <label htmlFor="tags">
                Tags <span className="meta">(up to 5)</span>
              </label>
              <input
                id="tags"
                value={tagInput}
                onChange={(event) => {
                  setTagInput(event.target.value)
                  if (tagError) setTagError(null)
                  edit()
                }}
                placeholder="launch, campaign, docs"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={Boolean(tagError)}
                aria-describedby="tags-hint"
              />
              <p
                id="tags-hint"
                className={tagError ? 'field-error' : 'field-hint'}
              >
                {tagError ||
                  'Comma-separated. Tags help everyone filter this workspace.'}
              </p>
            </div>
          </div>
        )}
        {problem && (
          <div className="form-problem" role="alert">
            <AlertCircle size={18} />
            <div>
              <p>{problemText(problem)}</p>
              {retryable && attempt && (
                <>
                  <p className="field-hint">
                    {problem.kind === 'network' || problem.kind === 'timeout'
                      ? 'The request may or may not have completed. Retrying with the same request is safe.'
                      : 'Retry when you are ready.'}
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void send(attempt)}
                    disabled={submitting}
                  >
                    {submitting ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : null}
                    Try again
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        <div className="composer-bottom">
          <span className="privacy-note">
            <ShieldCheck size={15} /> Saved to {workspaceName}
          </span>
          <button
            ref={submitButton}
            type="submit"
            className="primary-button"
            disabled={submitting}
          >
            {submitting ? (
              <>
                <LoaderCircle size={16} className="spin" /> Creating…
              </>
            ) : (
              <>
                Shorten link <ArrowRight size={17} />
              </>
            )}
          </button>
        </div>
        <p className="preview-note">
          Links go live immediately. They stay with this workspace, not this
          browser.
        </p>
      </form>
    </section>
  )
}

function ReadOnlyCard() {
  return (
    <section className="panel read-only-panel" aria-labelledby="viewer-heading">
      <ShieldCheck size={26} strokeWidth={1.4} />
      <h2 id="viewer-heading">Read-only access</h2>
      <p>
        Your viewer role can explore links and analytics. Ask an admin for
        member access when you need to create or change links.
      </p>
    </section>
  )
}

function DetailPage({
  workspaceId,
  workspaceName,
  canEdit,
  onCopy,
  onLoaded,
  onDeleted,
  notify,
}: {
  workspaceId: string
  workspaceName: string
  canEdit: boolean
  onCopy: (value: string) => void
  onLoaded: (link: LinkRecord) => void
  onDeleted: (code: string) => void
  notify: (message: string) => void
}) {
  const { code = '' } = useParams()
  const navigate = useNavigate()
  const [link, setLink] = useState<LinkRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [analyticsLoading, setAnalyticsLoading] = useState(true)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busyActive, setBusyActive] = useState(false)
  const [busyDelete, setBusyDelete] = useState(false)
  const [busyTags, setBusyTags] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  const [fallbackInput, setFallbackInput] = useState('')
  const [limitInput, setLimitInput] = useState('')
  const [limitErrors, setLimitErrors] = useState<LimitErrors>({})
  const [busyLimits, setBusyLimits] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    if (!code) return
    const controller = new AbortController()
    let active = true
    const access: Access = { workspaceId }
    setLoading(true)
    setError('')
    setAnalyticsError(null)
    setAnalyticsLoading(true)

    async function load() {
      try {
        const metadata = await getLink(code, access, controller.signal)
        if (!active) return
        let record = recordFromMetadata(metadata)
        setLink(record)
        setTagInput(record.tags.join(', '))
        setFallbackInput(record.fallbackUrl ?? '')
        setLimitInput(record.maxClicks?.toString() ?? '')
        onLoaded(record)
        setLoading(false)
        try {
          const analytics = await getAnalytics(
            code,
            30,
            access,
            controller.signal,
          )
          if (!active) return
          record = {
            ...record,
            analytics,
            clicks30d: analytics.totals.clicks,
          }
          setLink(record)
          onLoaded(record)
        } catch (failure) {
          if (!active) return
          if (isProblem(failure) && failure.problem.kind === 'cancelled') return
          setAnalyticsError(describeError(failure))
        } finally {
          if (active) setAnalyticsLoading(false)
        }
      } catch (failure) {
        if (!active) return
        if (isProblem(failure) && failure.problem.kind === 'cancelled') return
        setError(describeError(failure))
        setLoading(false)
        setAnalyticsLoading(false)
      }
    }

    void load()
    return () => {
      active = false
      controller.abort()
    }
  }, [code, workspaceId, reloadKey, onLoaded])

  async function toggleActive() {
    if (!link) return
    setBusyActive(true)
    setActionError('')
    try {
      const metadata = await updateLinkRequest(
        link.code,
        { is_active: !link.active },
        { workspaceId },
        new AbortController().signal,
      )
      const next = applyMetadata(link, metadata)
      setLink(next)
      onLoaded(next)
      notify(next.active ? 'Link reactivated.' : 'Link paused.')
    } catch (failure) {
      setActionError(describeError(failure))
    } finally {
      setBusyActive(false)
    }
  }

  async function saveTags() {
    if (!link) return
    const parsed = parseTags(tagInput)
    if (parsed.error) {
      setTagError(parsed.error)
      return
    }
    setBusyTags(true)
    setTagError(null)
    setActionError('')
    try {
      const metadata = await updateLinkRequest(
        link.code,
        { tags: parsed.tags },
        { workspaceId },
        new AbortController().signal,
      )
      const next = applyMetadata(link, metadata)
      setLink(next)
      setTagInput(next.tags.join(', '))
      onLoaded(next)
      notify('Tags updated.')
    } catch (failure) {
      setActionError(describeError(failure))
    } finally {
      setBusyTags(false)
    }
  }

  async function saveLimits() {
    if (!link) return
    const parsed = validateLimits(fallbackInput, limitInput)
    setLimitErrors(parsed.errors)
    if (Object.values(parsed.errors).some(Boolean)) return
    setBusyLimits(true)
    setActionError('')
    try {
      const metadata = await updateLinkRequest(
        link.code,
        { fallback_url: parsed.fallbackUrl, max_clicks: parsed.maxClicks },
        { workspaceId },
        new AbortController().signal,
      )
      const next = applyMetadata(link, metadata)
      setLink(next)
      setFallbackInput(next.fallbackUrl ?? '')
      setLimitInput(next.maxClicks?.toString() ?? '')
      onLoaded(next)
      notify('Visit limit and fallback saved.')
    } catch (failure) {
      const mapped = isProblem(failure) ? limitFieldErrors(failure.problem.errors) : {}
      if (Object.keys(mapped).length > 0) setLimitErrors(mapped)
      else setActionError(describeError(failure))
    } finally {
      setBusyLimits(false)
    }
  }

  async function remove() {
    if (!link) return
    setBusyDelete(true)
    setActionError('')
    try {
      await deleteLinkRequest(
        link.code,
        { workspaceId },
        new AbortController().signal,
      )
      setConfirmDelete(false)
      onDeleted(link.code)
      navigate('/links')
    } catch (failure) {
      setActionError(describeError(failure))
    } finally {
      setBusyDelete(false)
    }
  }

  if (!link) {
    return (
      <>
        <div className="page-heading detail-heading">
          <Link className="text-link back-link" to="/links">
            <ArrowLeft size={15} /> All links
          </Link>
          <div className="section-heading">
            <h1 tabIndex={-1}>{code || 'Link details'}</h1>
          </div>
          {error ? <p>{error}</p> : <p>One link. A little more insight.</p>}
        </div>
        {loading ? (
          <div className="loading-panel" role="status" aria-busy="true">
            Loading link metadata…
          </div>
        ) : (
          <div className="panel inline-alert" role="alert">
            <AlertCircle size={19} />
            <div>
              <strong>This link could not be opened.</strong>
              <p>{error}</p>
              <button
                type="button"
                className="text-button"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </>
    )
  }

  const status = getLinkStatus(link)

  return (
    <>
      <div className="page-heading detail-heading">
        <Link className="text-link back-link" to="/links">
          <ArrowLeft size={15} /> All links
        </Link>
        <div className="section-heading">
          <h1 tabIndex={-1}>{titleFor(link.destination) || link.code}</h1>
          <span className={`status ${statusClass(status)}`}>
            <span className="status-dot" />
            {status}
          </span>
        </div>
        <p>
          {workspaceName} · one link, a little more insight.
        </p>
      </div>
      {error && (
        <div className="panel inline-alert" role="alert">
          <AlertCircle size={19} />
          <div>
            <strong>This link could not be refreshed.</strong>
            <p>{error}</p>
            <button
              type="button"
              className="text-button"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Try again
            </button>
          </div>
        </div>
      )}
      <section
        className="detail-link-panel panel"
        aria-label="Link details"
        data-copy-url={link.shortUrl ? fullUrl(link.shortUrl) : undefined}
        data-copy-default=""
      >
        <div>
          <span className="meta">
            {link.isCustomAlias ? 'Custom alias' : 'Short link'}
          </span>
          <div className="detail-address">
            <Link2 size={20} />
            <span>
              {link.shortUrl ? displayShortUrl(link.shortUrl) : link.code}
            </span>
          </div>
          <details className="destination-disclosure">
            <summary>
              View full destination <ChevronDown size={14} />
            </summary>
            <a
              href={link.destination}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link.destination} <ExternalLink size={13} />
            </a>
          </details>
          {campaignChips(link.destination).length > 0 && (
            <ul className="campaign-chips" aria-label="Campaign tracking">
              {campaignChips(link.destination).map((chip) => (
                <li key={chip.key} className="tag-chip campaign-chip">
                  <span>{chip.label}</span> {chip.value}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="detail-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => onCopy(link.shortUrl)}
            disabled={!link.shortUrl}
          >
            <Copy size={15} /> Copy link
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onCopy(previewUrl(link.shortUrl))}
            disabled={!link.shortUrl}
            title="A preview link shows the destination and safety notes before anyone visits."
          >
            <Eye size={15} /> Copy preview link
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onCopy(link.destination)}
            disabled={!link.destination}
          >
            <ExternalLink size={15} /> Copy destination
          </button>
        </div>
      </section>
      {link.shortUrl && (
        <Suspense fallback={null}>
          <LinkQrPreview code={link.code} shortUrl={link.shortUrl} notify={notify} />
        </Suspense>
      )}
      {link.analytics ? (
        <Suspense
          fallback={
            <div className="loading-panel" role="status" aria-busy="true">
              Loading analytics…
            </div>
          }
        >
          <LinkAnalytics
            link={link}
            onRefresh={() => setReloadKey((key) => key + 1)}
          />
        </Suspense>
      ) : (
        <section
          className="analytics-section"
          aria-labelledby="analytics-heading"
        >
          <div className="section-heading analytics-heading">
            <div>
              <h2 id="analytics-heading">The story behind the clicks</h2>
              <p className="meta">Workspace members can read analytics.</p>
            </div>
          </div>
          {analyticsLoading ? (
            <div className="loading-panel" role="status" aria-busy="true">
              Loading analytics…
            </div>
          ) : (
            <div className="panel analytics-empty" role="alert">
              <AlertCircle size={22} strokeWidth={1.5} />
              <p>{analyticsError ?? 'Analytics could not be loaded.'}</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                Try again
              </button>
            </div>
          )}
        </section>
      )}
      <section
        className="link-settings panel"
        aria-labelledby="settings-heading"
      >
        <div className="section-heading">
          <div>
            <h2 id="settings-heading">A little housekeeping</h2>
            <p className="meta">
              {canEdit
                ? 'Changes apply to the live link.'
                : 'Viewers can read links but cannot change them.'}
            </p>
          </div>
          <span className={`role-badge role-${canEdit ? 'member' : 'viewer'}`}>
            <ShieldCheck size={12} /> Can {canEdit ? 'manage' : 'view'}
          </span>
        </div>
        {actionError && (
          <p className="field-error" role="alert">
            {actionError}
          </p>
        )}
        <div className="setting-row">
          <div>
            <h3>Link availability</h3>
            <p>
              {status === 'Expired' || status === 'Used up'
                ? `${status === 'Expired' ? 'This link has passed its expiration date.' : 'This link has used all of its visits.'} ${link.fallbackUrl ? 'Visitors go to the fallback URL.' : 'Visitors see a page explaining that.'}`
                : link.active
                  ? 'Visitors are redirected to the destination.'
                  : 'Visitors see an unavailable response.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={link.active}
            aria-label="Link active"
            className="switch"
            disabled={!canEdit || busyActive}
            onClick={() => void toggleActive()}
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <h3>Expiration</h3>
            <p>
              {link.expiresAt
                ? `Expires ${new Date(link.expiresAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC`
                : 'No expiration set for this link.'}
            </p>
          </div>
          <span className="meta">UTC</span>
        </div>
        <div className="setting-row limits-row">
          <div>
            <h3>Visit limit and fallback</h3>
            <p>{visitsLabel(link)}</p>
            <div className="limits-editor">
              <div>
                <label htmlFor="detail-visit-limit">Visit limit</label>
                <input
                  id="detail-visit-limit"
                  inputMode="numeric"
                  value={limitInput}
                  onChange={(event) => {
                    setLimitInput(event.target.value)
                    if (limitErrors.maxClicks)
                      setLimitErrors({ ...limitErrors, maxClicks: undefined })
                  }}
                  placeholder="No limit"
                  disabled={!canEdit || busyLimits}
                  aria-invalid={Boolean(limitErrors.maxClicks)}
                  aria-describedby="detail-visit-limit-hint"
                />
                <p
                  id="detail-visit-limit-hint"
                  className={limitErrors.maxClicks ? 'field-error' : 'field-hint'}
                >
                  {limitErrors.maxClicks ||
                    'Raise it to allow more visits. Clearing it resets the count.'}
                </p>
              </div>
              <div>
                <label htmlFor="detail-fallback-url">Fallback URL</label>
                <input
                  id="detail-fallback-url"
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={fallbackInput}
                  onChange={(event) => {
                    setFallbackInput(event.target.value)
                    if (limitErrors.fallbackUrl)
                      setLimitErrors({ ...limitErrors, fallbackUrl: undefined })
                  }}
                  placeholder="https://example.com/offer-ended"
                  disabled={!canEdit || busyLimits}
                  aria-invalid={Boolean(limitErrors.fallbackUrl)}
                  aria-describedby="detail-fallback-url-hint"
                />
                <p
                  id="detail-fallback-url-hint"
                  className={limitErrors.fallbackUrl ? 'field-error' : 'field-hint'}
                >
                  {limitErrors.fallbackUrl ||
                    'Used after expiry or when the visit limit is reached.'}
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void saveLimits()}
            disabled={!canEdit || busyLimits}
          >
            {busyLimits ? <LoaderCircle size={14} className="spin" /> : null}
            Save
          </button>
        </div>
        <div className="setting-row">
          <div>
            <h3>Tags</h3>
            <p>
              {link.tags.length > 0
                ? link.tags.join(' · ')
                : 'No tags yet. Group links for faster filtering.'}
            </p>
          </div>
        </div>
        <div className="setting-row tag-row">
          <div>
            <label htmlFor="detail-tags">Edit tags</label>
            <div className="tag-editor">
              <input
                id="detail-tags"
                value={tagInput}
                onChange={(event) => {
                  setTagInput(event.target.value)
                  if (tagError) setTagError(null)
                }}
                placeholder="launch, campaign, docs"
                disabled={!canEdit || busyTags}
                aria-invalid={Boolean(tagError)}
                aria-describedby={tagError ? 'detail-tags-error' : undefined}
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() => void saveTags()}
                disabled={!canEdit || busyTags}
              >
                {busyTags ? (
                  <LoaderCircle size={14} className="spin" />
                ) : null}
                Save tags
              </button>
            </div>
            {tagError && (
              <p className="field-error" id="detail-tags-error" role="alert">
                {tagError}
              </p>
            )}
            <p className="field-hint">
              Up to 5 comma-separated tags. Everyone in this workspace can
              filter by them.
            </p>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <h3>Ownership</h3>
            <p>
              Managed by everyone with member access in{' '}
              <strong>{workspaceName}</strong>.
            </p>
          </div>
          <span className="role-badge">
            <Users size={12} /> {workspaceName}
          </span>
        </div>
        <div className="setting-row">
          <div>
            <h3>Report a problem</h3>
            <p>Flag spam, phishing, or impersonation for review.</p>
          </div>
          <Link
            className="text-button"
            to={`/report?code=${encodeURIComponent(link.code)}`}
          >
            <Flag size={14} /> Report link
          </Link>
        </div>
        {canEdit && (
          <div className="setting-row">
            <div>
              <h3>Delete this link</h3>
              <p>The short link and its analytics are removed permanently.</p>
            </div>
            <button
              type="button"
              className="danger-button"
              disabled={busyDelete}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} /> Delete link
            </button>
          </div>
        )}
      </section>
      {confirmDelete && (
        <Modal
          title="Delete this link?"
          onClose={() => setConfirmDelete(false)}
        >
          <p>
            <strong>{displayShortUrl(link.shortUrl) || link.code}</strong> will
            stop redirecting immediately. Its click history will no longer be
            available. This cannot be undone.
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirmDelete(false)}
              disabled={busyDelete}
            >
              Keep link
            </button>
            <button
              type="button"
              className="danger-button filled"
              onClick={() => void remove()}
              disabled={busyDelete}
            >
              {busyDelete ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Trash2 size={14} />
              )}
              Delete link
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

function NotFound() {
  return (
    <div className="not-found">
      <Link2 size={36} strokeWidth={1.3} />
      <h1 tabIndex={-1}>A link to nowhere.</h1>
      <p>This page doesn’t exist. Let’s get you somewhere useful.</p>
      <Link className="primary-button" to="/">
        Back to your workspace <ArrowRight size={16} />
      </Link>
    </div>
  )
}

function WorkspaceShell() {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const workspace = auth.workspace
  const role = auth.role
  const user = auth.session?.user

  const [links, setLinks] = useState<LinkRecord[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [composerVersion, setComposerVersion] = useState(0)
  const [, setDayTick] = useState(0)
  const [theme, setTheme] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  )
  const [help, setHelp] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() =>
    readSidebarCollapsed(window.localStorage),
  )
  const narrow = useMediaQuery('(max-width: 1050px)')
  const menuButton = useRef<HTMLButtonElement>(null)
  const [notice, setNotice] = useState('')
  const [manualCopy, setManualCopy] = useState<string | null>(null)
  const [pasted, setPasted] = useState<string | undefined>(undefined)
  const [importOpen, setImportOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const firstRoute = useRef(true)
  const analyticsControllers = useRef(new Map<string, AbortController>())
  const isHome = location.pathname === '/'

  const workspaceId = workspace?.id ?? ''
  const workspaceName = workspace?.name ?? ''
  const canEdit = role !== null && role !== 'viewer'

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const refreshDay = () => setDayTick((tick) => tick + 1)
    const midnight = new Date()
    midnight.setUTCHours(24, 0, 0, 0)
    const timeout = window.setTimeout(
      refreshDay,
      midnight.getTime() - Date.now(),
    )
    document.addEventListener('visibilitychange', refreshDay)
    return () => {
      window.clearTimeout(timeout)
      document.removeEventListener('visibilitychange', refreshDay)
    }
  }, [])

  useEffect(() => {
    writeSidebarCollapsed(window.localStorage, collapsed)
  }, [collapsed])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    menuButton.current?.focus()
  }, [])

  useEffect(() => {
    const [title] = routeTitle(location.pathname)
    document.title = `${title} — Shortly`
    if (firstRoute.current) {
      firstRoute.current = false
      return
    }
    document.querySelector<HTMLElement>('h1')?.focus()
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [isHome, location.pathname])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    const active = analyticsControllers.current
    return () => {
      for (const controller of active.values()) controller.abort()
    }
  }, [])

  const refreshSession = auth.refresh

  const loadLinks = useCallback(
    async (signal: AbortSignal) => {
      if (!workspaceId) return
      setListLoading(true)
      setListError('')
      try {
        const result = await listLinks(workspaceId, signal)
        if (signal.aborted) return
        setLinks(result.links.map((item) => recordFromMetadata(item)))
      } catch (failure) {
        if (isProblem(failure) && failure.problem.kind === 'cancelled') return
        if (isProblem(failure) && failure.problem.status === 401) {
          try {
            await refreshSession()
          } catch {
            setListError('Your session ended. Sign in again to continue.')
          }
          return
        }
        setListError(describeError(failure))
      } finally {
        if (!signal.aborted) setListLoading(false)
      }
    },
    [workspaceId, refreshSession],
  )

  useEffect(() => {
    const controller = new AbortController()
    setLinks([])
    void loadLinks(controller.signal)
    return () => controller.abort()
  }, [loadLinks])

  const loadAnalytics = useCallback(
    async (code: string) => {
      if (!workspaceId) return
      analyticsControllers.current.get(code)?.abort()
      const controller = new AbortController()
      analyticsControllers.current.set(code, controller)
      setLinks((current) =>
        current.map((item) =>
          item.code === code
            ? { ...item, analyticsLoading: true, analyticsError: null }
            : item,
        ),
      )
      try {
        const analytics = await getAnalytics(
          code,
          30,
          { workspaceId },
          controller.signal,
        )
        setLinks((current) =>
          current.map((item) =>
            item.code === code
              ? {
                  ...item,
                  analytics,
                  clicks30d: analytics.totals.clicks,
                  analyticsLoading: false,
                  analyticsError: null,
                }
              : item,
          ),
        )
      } catch (failure) {
        if (isProblem(failure) && failure.problem.kind === 'cancelled') return
        setLinks((current) =>
          current.map((item) =>
            item.code === code
              ? {
                  ...item,
                  analyticsLoading: false,
                  analyticsError: describeError(failure),
                }
              : item,
          ),
        )
      } finally {
        if (analyticsControllers.current.get(code) === controller)
          analyticsControllers.current.delete(code)
      }
    },
    [workspaceId],
  )

  const featured = useMemo(
    () =>
      links.reduce<LinkRecord | undefined>(
        (best, item) =>
          !best || (item.clicks30d ?? 0) > (best.clicks30d ?? 0) ? item : best,
        undefined,
      ),
    [links],
  )

  useEffect(() => {
    if (!isHome || !featured) return
    if (featured.analytics || featured.analyticsLoading || featured.analyticsError)
      return
    void loadAnalytics(featured.code)
  }, [isHome, featured, loadAnalytics])

  const handleLoaded = useCallback((record: LinkRecord) => {
    setLinks((current) => {
      if (!current.some((item) => item.code === record.code)) {
        return [record, ...current]
      }
      return current.map((item) =>
        item.code === record.code
          ? {
              ...item,
              ...record,
              analytics: record.analytics ?? item.analytics,
              clicks30d: record.clicks30d ?? item.clicks30d,
            }
          : item,
      )
    })
  }, [])

  const handleDeleted = useCallback((code: string) => {
    setLinks((current) => current.filter((item) => item.code !== code))
    setNotice('Link deleted. Redirects have stopped.')
  }, [])

  function handleBulkImported(created: CreatedLink[]) {
    const records = created.map((item) => ({
      ...recordFromMetadata(item),
      clicks30d: item.clicks_30d ?? 0,
    }))
    const codes = new Set(records.map((item) => item.code))
    setLinks((current) => [
      ...records,
      ...current.filter((item) => !codes.has(item.code)),
    ])
    setNotice(
      `${records.length} link${records.length === 1 ? '' : 's'} imported.`,
    )
  }

  function exportLinks() {
    downloadTextFile(csvFileName(), '\uFEFF' + linksCsv(links))
    setNotice('CSV export downloaded.')
  }

  const copy = useCallback(async (value: string, message = 'Copied to clipboard.') => {
    if (!value) return
    const outcome = await copyText(value)
    if (outcome === 'manual') setManualCopy(value)
    else setNotice(message)
  }, [])

  const copyLink = useCallback(
    (value: string) => copy(fullUrl(value), 'Link copied to clipboard.'),
    [copy],
  )

  function copyFocusedLink(): boolean {
    const focused = document.activeElement?.closest<HTMLElement>('[data-copy-url]')
    const hovered = Array.from(
      document.querySelectorAll<HTMLElement>('[data-copy-url]:hover'),
    ).pop()
    const fallback = document.querySelector<HTMLElement>('[data-copy-url][data-copy-default]')
    const value = (focused ?? hovered ?? fallback)?.dataset.copyUrl
    if (!value) return false
    void copyLink(value)
    return true
  }

  function newLink() {
    if (!canEdit) return
    setDrawerOpen(false)
    setPasted(undefined)
    setComposerVersion((version) => version + 1)
    if (!isHome) navigate('/')
    window.requestAnimationFrame(() =>
      document.getElementById('destination')?.focus(),
    )
  }

  function handleCreated(created: CreatedLink) {
    const record: LinkRecord = {
      ...recordFromMetadata(created),
      clicks30d: created.clicks_30d ?? 0,
    }
    setLinks((current) => [
      record,
      ...current.filter((item) => item.code !== record.code),
    ])
    setPasted(undefined)
    setNotice('Short link created and live.')
    void loadAnalytics(record.code)
  }

  function switchWorkspace(id: string) {
    if (id === workspaceId) return
    auth.selectWorkspace(id)
    setLinks([])
    setDrawerOpen(false)
    navigate('/')
  }

  async function signOut() {
    try {
      await auth.logout()
    } catch {
      // The local session is cleared even if the request fails.
    }
    navigate('/login', { replace: true })
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = shortcutFor(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          target: event.target instanceof HTMLElement ? event.target : null,
        },
        document.querySelector('dialog[open]') !== null,
      )
      if (action === null) return
      if (action === 'palette') {
        event.preventDefault()
        setDrawerOpen(false)
        setPaletteOpen(true)
      } else if (action === 'new-link') {
        if (!canEdit) return
        event.preventDefault()
        newLink()
      } else if (action === 'search') {
        const search = document.getElementById('link-search')
        if (!search) return
        event.preventDefault()
        search.focus()
      } else if (action === 'copy') {
        if (copyFocusedLink()) event.preventDefault()
      } else if (action === 'toggle-sidebar') {
        if (narrow) return
        event.preventDefault()
        setCollapsed((value) => !value)
      } else {
        event.preventDefault()
        setHelp(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (!canEdit) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!pasteIsForPage(target, document.querySelector('dialog[open]') !== null)) return
      const url = urlFromPaste(event.clipboardData?.getData('text/plain') ?? '')
      if (!url) return
      event.preventDefault()
      setDrawerOpen(false)
      setPasted(url)
      setComposerVersion((version) => version + 1)
      if (!isHome) navigate('/')
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  if (!workspace || !role || !user) {
    return (
      <div className="boot-screen">
        <BrandMark />
        <p>No workspace is available for this account.</p>
        <button type="button" className="secondary-button" onClick={() => void signOut()}>
          <LogOut size={15} /> Sign out
        </button>
      </div>
    )
  }

  const [, breadcrumb] = routeTitle(location.pathname)
  const rail = collapsed && !narrow

  const paletteCommands: PaletteCommand[] = [
    ...links.map(
      (link): PaletteCommand => ({
        id: `link:${link.code}`,
        group: 'Links',
        label: link.shortUrl ? displayShortUrl(link.shortUrl) : link.code,
        hint: titleFor(link.destination),
        keywords: [link.code, link.destination, ...link.tags],
        icon: Link2,
        run: () => navigate(`/links/${link.code}`),
      }),
    ),
    ...[...WORKSPACE_ITEMS, ...EXPLORE_ITEMS].map(
      (item): PaletteCommand => ({
        id: `page:${item.to}`,
        group: 'Pages',
        label: item.label,
        icon: item.icon,
        run: () => navigate(item.to),
      }),
    ),
    ...(canEdit
      ? [
          {
            id: 'action:new-link',
            group: 'Actions',
            label: 'Create a link',
            hint: 'N',
            keywords: ['new link', 'shorten'],
            icon: Plus,
            run: newLink,
          },
          {
            id: 'action:import',
            group: 'Actions',
            label: 'Import links from CSV',
            keywords: ['upload', 'bulk'],
            icon: Upload,
            run: () => {
              navigate('/links')
              setImportOpen(true)
            },
          },
        ] satisfies PaletteCommand[]
      : []),
    ...(links.length > 0
      ? [
          {
            id: 'action:export',
            group: 'Actions',
            label: 'Export links as CSV',
            keywords: ['download'],
            icon: Download,
            run: exportLinks,
          },
        ] satisfies PaletteCommand[]
      : []),
    {
      id: 'action:theme',
      group: 'Actions',
      label: `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`,
      keywords: ['theme', 'dark mode', 'light mode', 'appearance'],
      icon: theme === 'light' ? Moon : Sun,
      run: () => setTheme(theme === 'light' ? 'dark' : 'light'),
    },
    ...(narrow
      ? []
      : [
          {
            id: 'action:sidebar',
            group: 'Actions',
            label: collapsed ? 'Expand sidebar' : 'Collapse sidebar',
            hint: '[',
            keywords: ['toggle sidebar', 'navigation'],
            icon: collapsed ? PanelLeftOpen : PanelLeftClose,
            run: () => setCollapsed((value) => !value),
          },
        ] satisfies PaletteCommand[]),
    {
      id: 'action:help',
      group: 'Actions',
      label: 'Help and keyboard shortcuts',
      hint: '?',
      keywords: ['about', 'shortcuts'],
      icon: CircleHelp,
      run: () => setHelp(true),
    },
    {
      id: 'action:sign-out',
      group: 'Actions',
      label: 'Sign out',
      keywords: ['log out'],
      icon: LogOut,
      run: () => void signOut(),
    },
    ...(auth.session?.workspaces ?? [])
      .filter((item) => item.id !== workspaceId)
      .map(
        (item): PaletteCommand => ({
          id: `workspace:${item.id}`,
          group: 'Workspaces',
          label: item.name,
          hint: `${item.is_personal ? 'Personal · ' : ''}${item.role}`,
          keywords: ['switch workspace'],
          icon: Users,
          run: () => switchWorkspace(item.id),
        }),
      ),
  ]

  return (
    <CopyContext.Provider value={copy}>
    <div className={`workspace${rail ? ' sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Sidebar
        collapsed={collapsed}
        narrow={narrow}
        drawerOpen={narrow && drawerOpen}
        user={user}
        canEdit={canEdit}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        onCloseDrawer={closeDrawer}
        onNewLink={newLink}
        onHelp={() => setHelp(true)}
        onSignOut={() => void signOut()}
      />
      <div className="main-shell">
        <header className="workspace-header">
          <div className="mobile-brand">
            <Link to="/" aria-label="Shortly home">
              <BrandMark />
            </Link>
            <button
              ref={menuButton}
              type="button"
              className="icon-button"
              aria-label="Open navigation"
              aria-controls="workspace-sidebar"
              aria-expanded={narrow && drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <Menu size={21} />
            </button>
          </div>
          <div className="breadcrumb">
            <span>{workspaceName}</span>
            <span>/</span>
            <span>{breadcrumb}</span>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="icon-button theme-button"
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            >
              {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          <Routes>
            <Route
              path="/"
              element={
                <>
                  <div className="page-heading home-heading">
                    <h1 tabIndex={-1}>
                      {user.display_name
                        ? `Less link, ${user.display_name.split(' ')[0]}.`
                        : 'Less link. More possibility.'}
                    </h1>
                    <p>
                      Shorten, share, and see what connects in{' '}
                      {workspaceName}.
                    </p>
                  </div>
                  <div className="creation-grid">
                    {canEdit ? (
                      <CreateForm
                        key={`${workspaceId}:${composerVersion}`}
                        workspaceId={workspaceId}
                        workspaceName={workspaceName}
                        links={links}
                        onCreate={handleCreated}
                        onCopy={copyLink}
                        pasted={pasted}
                      />
                    ) : (
                      <ReadOnlyCard />
                    )}
                    <AnalyticsTeaser link={featured} />
                  </div>
                  <TopLinks workspaceId={workspaceId} />
                  {listLoading ? (
                    <div
                      className="loading-panel"
                      role="status"
                      aria-busy="true"
                    >
                      Loading links…
                    </div>
                  ) : listError ? (
                    <div className="panel inline-alert" role="alert">
                      <AlertCircle size={19} />
                      <div>
                        <strong>Links could not be loaded.</strong>
                        <p>{listError}</p>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            void loadLinks(new AbortController().signal)
                          }
                        >
                          Try again
                        </button>
                      </div>
                    </div>
                  ) : (
                    <LinkList links={links} overview onCopy={copyLink} />
                  )}
                  <div className="workspace-bottom-note">
                    <ShieldCheck size={16} />
                    <p>
                      Shared with care.
                      <span>
                        {' '}
                        Every link lives in this workspace and follows its
                        roles. Analytics are queued durably and never store IP
                        addresses.
                      </span>
                    </p>
                  </div>
                </>
              }
            />
            <Route
              path="/links"
              element={
                <>
                  <div className="page-heading">
                    <div className="section-heading">
                      <h1 tabIndex={-1}>Good links, all together.</h1>
                      {canEdit && (
                        <button
                          type="button"
                          className="primary-button"
                          onClick={newLink}
                        >
                          <Plus size={17} /> New link
                        </button>
                      )}
                    </div>
                    <p>
                      Every link in {workspaceName}, with the last 30 UTC days
                      of clicks.
                    </p>
                  </div>
                  {listLoading ? (
                    <div
                      className="loading-panel"
                      role="status"
                      aria-busy="true"
                    >
                      Loading links…
                    </div>
                  ) : listError ? (
                    <div className="panel inline-alert" role="alert">
                      <AlertCircle size={19} />
                      <div>
                        <strong>Links could not be loaded.</strong>
                        <p>{listError}</p>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            void loadLinks(new AbortController().signal)
                          }
                        >
                          Try again
                        </button>
                      </div>
                    </div>
                  ) : (
                    <LinkList
                      links={links}
                      onCopy={copyLink}
                      onExport={exportLinks}
                      onImport={canEdit ? () => setImportOpen(true) : undefined}
                    />
                  )}
                  <div className="workspace-bottom-note">
                    <Monitor size={16} />
                    <p>
                      Server-backed, workspace-wide.
                      <span>
                        {' '}
                        Links are stored in {workspaceName}, not in this
                        browser. Anyone with access sees the same list.
                      </span>
                    </p>
                  </div>
                </>
              }
            />
            <Route
              path="/links/:code"
              element={
                <DetailPage
                  key={`${workspaceId}:${location.pathname}`}
                  workspaceId={workspaceId}
                  workspaceName={workspaceName}
                  canEdit={canEdit}
                  onCopy={copyLink}
                  onLoaded={handleLoaded}
                  onDeleted={handleDeleted}
                  notify={setNotice}
                />
              }
            />
            <Route
              path="/members"
              element={
                <Suspense
                  fallback={
                    <div
                      className="loading-panel"
                      role="status"
                      aria-busy="true"
                    >
                      Loading people…
                    </div>
                  }
                >
                  <MembersPage />
                </Suspense>
              }
            />
            <Route
              path="/settings"
              element={
                <Suspense
                  fallback={
                    <div
                      className="loading-panel"
                      role="status"
                      aria-busy="true"
                    >
                      Loading settings…
                    </div>
                  }
                >
                  <SettingsPage key={workspaceId} />
                </Suspense>
              }
            />
            <Route
              path="/qr"
              element={
                <Suspense fallback={<PageLoading label="Loading QR studio…" />}>
                  <QrStudio
                    key={workspaceId}
                    links={links}
                    loading={listLoading}
                    workspaceName={workspaceName}
                    notify={setNotice}
                  />
                </Suspense>
              }
            />
            <Route
              path="/dashboard"
              element={
                <Suspense fallback={<PageLoading label="Loading dashboard…" />}>
                  <Dashboard
                    key={workspaceId}
                    workspaceId={workspaceId}
                    workspaceName={workspaceName}
                  />
                </Suspense>
              }
            />
            <Route
              path="/system"
              element={
                <Suspense
                  fallback={<PageLoading label="Loading system design…" />}
                >
                  <SystemDesign
                    key={workspaceId}
                    workspaceId={workspaceId}
                    links={links}
                    loading={listLoading}
                  />
                </Suspense>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
          <footer className="workspace-footer">
            <span>Thoughtfully short.</span>
            <div className="footer-links">
              <Link className="text-button" to="/report">
                <Flag size={12} /> Report abuse
              </Link>
              <button
                type="button"
                className="text-button"
                onClick={() => setHelp(true)}
              >
                About Shortly <ArrowUpRight size={13} />
              </button>
            </div>
          </footer>
        </main>
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
      {help && (
        <Modal
          title="Small links. Shared context."
          onClose={() => setHelp(false)}
        >
          <p>
            Shortly keeps every link inside a workspace, with roles that decide
            who can create, invite, and change things.
          </p>
          <div className="help-step">
            <Link2 size={19} />
            <div>
              <h3>Make it shorter</h3>
              <p>
                Paste a destination, choose an optional alias or expiration,
                and the whole workspace can see the result.
              </p>
            </div>
          </div>
          <div className="help-step">
            <Users size={19} />
            <div>
              <h3>Invite your people</h3>
              <p>
                Owners and admins create invite links from the People page.
                Invitations expire after seven days and can be revoked at any
                time.
              </p>
            </div>
          </div>
          <div className="help-step">
            <ShieldCheck size={19} />
            <div>
              <h3>Roles that hold</h3>
              <p>
                Viewers read. Members create and manage links. Admins also
                manage people. Owners keep final control and cannot be removed.
              </p>
            </div>
          </div>
          <div className="help-step">
            <Globe2 size={19} />
            <div>
              <h3>Private by default</h3>
              <p>
                Sessions live in a secure, http-only cookie. Clicks record a
                referrer origin, country, and device category. IP addresses and
                unique visitors are not stored.
              </p>
            </div>
          </div>
          <div className="help-step">
            <Eye size={19} />
            <div>
              <h3>Peek before you click</h3>
              <p>
                Add <kbd>+</kbd> to the end of any Shortly link to see where it
                goes, with notes on unencrypted, raw-IP, look-alike, or
                re-shortened addresses. Previews never count as clicks.
              </p>
            </div>
          </div>
          <div className="help-step">
            <Keyboard size={19} />
            <div>
              <h3>Keyboard shortcuts</h3>
              <p>
                <kbd>⌘K</kbd> or <kbd>Ctrl+K</kbd> opens the command palette
                to jump to a link, a page, an action, or another workspace.
              </p>
              <p>
                <kbd>N</kbd> new link · <kbd>/</kbd> search links ·{' '}
                <kbd>C</kbd> copy the hovered, selected, or open link ·{' '}
                <kbd>[</kbd> collapse sidebar · <kbd>?</kbd> this help
              </p>
              <p>
                <kbd>⌘V</kbd> or <kbd>Ctrl+V</kbd> anywhere outside a text box
                pastes a URL into a new short link.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={() => setHelp(false)}
          >
            Got it <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {importOpen && canEdit && (
        <BulkImport
          workspaceId={workspaceId}
          existingCodes={links.map((link) => link.code)}
          onClose={() => setImportOpen(false)}
          onImported={handleBulkImported}
        />
      )}
      {manualCopy !== null && (
        <Modal title="Copy this value" onClose={() => setManualCopy(null)}>
          <p>
            Clipboard access is unavailable. Select the value below and copy it
            with your keyboard.
          </p>
          <label htmlFor="manual-copy">Value</label>
          <input
            id="manual-copy"
            value={manualCopy}
            readOnly
            autoFocus
            onFocus={(event) => event.target.select()}
            onClick={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              document.querySelector<HTMLInputElement>('#manual-copy')?.select()
            }
          >
            Select value
          </button>
        </Modal>
      )}
    </div>
    </CopyContext.Provider>
  )
}

function ProtectedWorkspace() {
  const auth = useAuth()
  const location = useLocation()

  if (auth.status === 'loading') return <BootScreen />
  if (auth.status === 'anonymous' || !auth.session) {
    const next = `${location.pathname}${location.search}`
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }
  return <WorkspaceShell />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/report" element={<ReportPage />} />
          <Route path="/*" element={<ProtectedWorkspace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
