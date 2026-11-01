import { useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Copy,
  Download,
  Link2,
  LoaderCircle,
  Lock,
  Pause,
  Play,
  Route,
  Search,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import type { BulkAction } from './api'
import { selectionState, toggleAllVisible, toggleCode, visibleSelection } from './bulk'
import { fullUrl } from './clipboard'
import {
  displayShortUrl,
  getLinkStatus,
  isExpiringSoon,
  linkClicks,
  number,
  parseTags,
  sortLinks,
  statusClass,
  titleFor,
  type LinkRecord,
  type LinkSort,
} from './links'
import Modal from './Modal'
import { ruleSummary } from './smartRules'

const FILTERS = ['All links', 'Active', 'Paused', 'Expired', 'Used up'] as const

export type BulkControls = {
  canEdit: boolean
  /** Resolves true once the action is applied, false if it failed. */
  run: (action: BulkAction, codes: string[], tags?: string[]) => Promise<boolean>
  exportSelected: (codes: string[]) => void
}

type TagMode = 'add_tags' | 'remove_tags'

export default function LinkList({
  links,
  onCopy,
  overview = false,
  onExport,
  onImport,
  bulk,
}: {
  links: LinkRecord[]
  onCopy: (value: string) => void
  overview?: boolean
  onExport?: () => void
  onImport?: () => void
  bulk?: BulkControls
}) {
  const [search, setSearchValue] = useState('')
  const [filter, setFilterValue] = useState<(typeof FILTERS)[number]>('All links')
  const [tag, setTagValue] = useState<string | null>(null)
  const [sort, setSort] = useState<LinkSort>('newest')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState<BulkAction | null>(null)
  const [tagMode, setTagMode] = useState<TagMode | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Changing what is shown clears the selection, so an action never reaches
  // links the person can no longer see.
  const setSearch = (value: string) => {
    setSearchValue(value)
    setSelected(new Set())
  }
  const setFilter = (value: (typeof FILTERS)[number]) => {
    setFilterValue(value)
    setSelected(new Set())
  }
  const setTag = (value: string | null) => {
    setTagValue(value)
    setSelected(new Set())
  }
  const tags = Array.from(new Set(links.flatMap((link) => link.tags))).sort()
  const filtered = links.filter((link) => {
    const matchesSearch = `${titleFor(link.destination)} ${link.code} ${link.destination} ${link.tags.join(' ')}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
    const matchesTag = tag === null || link.tags.includes(tag)
    return (
      matchesSearch &&
      matchesTag &&
      (filter === 'All links' || getLinkStatus(link) === filter)
    )
  })
  const sorted = sortLinks(filtered, sort)
  const visible = overview ? sorted.slice(0, 4) : sorted
  const selectable = Boolean(bulk) && !overview
  const visibleCodes = visible.map((link) => link.code)
  const chosen = selectable ? visibleSelection(selected, visibleCodes) : []
  const allState = selectionState(selected, visibleCodes)
  const chosenTags = Array.from(
    new Set(visible.filter((link) => chosen.includes(link.code)).flatMap((link) => link.tags)),
  ).sort()

  async function act(action: BulkAction, tags?: string[]) {
    if (!bulk || busy || chosen.length === 0) return
    setBusy(action)
    const done = await bulk.run(action, chosen, tags)
    setBusy(null)
    if (done) {
      setSelected(new Set())
      setTagMode(null)
      setTagInput('')
      setConfirmDelete(false)
    }
  }

  function submitTags(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!tagMode) return
    const parsed = parseTags(tagInput)
    const error = parsed.error ?? (parsed.tags.length === 0 ? 'Enter at least one tag.' : null)
    setTagError(error)
    if (!error) void act(tagMode, parsed.tags)
  }

  function openTags(mode: TagMode) {
    setTagMode(tagMode === mode ? null : mode)
    setTagInput('')
    setTagError(null)
  }

  const spinner = (action: BulkAction, icon: ReactNode) =>
    busy === action ? <LoaderCircle size={14} className="spin" /> : icon

  return (
    <section className="links-section" aria-labelledby="links-heading">
      <div className="section-heading links-heading">
        <div className="heading-with-count">
          <h2 id="links-heading">
            {overview ? 'Your links, at a glance' : 'All your links'}
          </h2>
          <span className="count-label">{links.length}</span>
        </div>
        {overview ? (
          <Link className="text-link" to="/links">
            View all <ArrowRight size={15} />
          </Link>
        ) : (
          <span className="meta">Links in this workspace</span>
        )}
      </div>
      <div className="list-toolbar">
        <div className="list-filters" role="group" aria-label="Filter links">
          {FILTERS.map((name) => (
            <button
              type="button"
              key={name}
              onClick={() => setFilter(name)}
              aria-pressed={filter === name}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="list-actions">
          {onImport && (
            <button type="button" className="secondary-button" onClick={onImport}>
              <Upload size={15} /> Import
            </button>
          )}
          {onExport && (
            <button
              type="button"
              className="secondary-button"
              onClick={onExport}
              disabled={links.length === 0}
            >
              <Download size={15} /> Export
            </button>
          )}
          <div className="search-field">
            <Search size={16} aria-hidden="true" />
            <label className="sr-only" htmlFor="link-search">
              Search links
            </label>
            <input
              id="link-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search links…"
            />
          </div>
          {!overview && (
            <div className="sort-field">
              <label htmlFor="link-sort">Sort</label>
              <select id="link-sort" value={sort} onChange={(event) => setSort(event.target.value as LinkSort)}>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="clicks">Most clicks · 30d</option>
                <option value="expiry">Expiring first</option>
              </select>
            </div>
          )}
        </div>
      </div>
      {!overview && tags.length > 0 && (
        <div className="tag-filters" role="group" aria-label="Filter by tag">
          <button
            type="button"
            aria-pressed={tag === null}
            onClick={() => setTag(null)}
          >
            All tags
          </button>
          {tags.map((name) => (
            <button
              type="button"
              key={name}
              aria-pressed={tag === name}
              onClick={() => setTag(tag === name ? null : name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div className="link-table" role="table" aria-label="Your links">
        <div className="link-table-head link-grid" role="row">
          <span role="columnheader" className={selectable ? 'select-header' : undefined}>
            {selectable && (
              <input
                type="checkbox"
                className="row-check"
                aria-label="Select all visible links"
                checked={allState === 'all'}
                disabled={visible.length === 0}
                ref={(element) => {
                  if (element) element.indeterminate = allState === 'some'
                }}
                onChange={() => setSelected(toggleAllVisible(selected, visibleCodes))}
              />
            )}
            Link
          </span>
          <span role="columnheader">Status</span>
          <span role="columnheader" className="numeric">
            Clicks · 30d
          </span>
          <span role="columnheader" className="date-column">
            Created
          </span>
          <span role="columnheader" className="sr-only">
            Actions
          </span>
        </div>
        {visible.map((link) => {
          const status = getLinkStatus(link)
          const total = linkClicks(link)
          const subtitle = titleFor(link.destination)
          return (
            <div
              className={`link-row link-grid${selectable && selected.has(link.code) ? ' selected' : ''}`}
              role="row"
              key={link.code}
              data-copy-url={link.shortUrl ? fullUrl(link.shortUrl) : undefined}
            >
              <div className="link-identity" role="cell">
                {selectable ? (
                  <input
                    type="checkbox"
                    className="row-check"
                    aria-label={`Select ${link.code}`}
                    checked={selected.has(link.code)}
                    onChange={() => setSelected(toggleCode(selected, link.code))}
                  />
                ) : (
                  <Link2 size={18} aria-hidden="true" strokeWidth={1.5} />
                )}
                <div>
                  <Link to={`/links/${link.code}`} className="short-link">
                    {link.shortUrl
                      ? displayShortUrl(link.shortUrl)
                      : link.code}
                  </Link>
                  <span className="link-subline">
                    {link.loading ? 'Loading…' : subtitle || 'No destination'}
                    {link.tags.slice(0, 2).map((name) => (
                      <span className="tag-chip" key={name}>
                        {name}
                      </span>
                    ))}
                    {link.tags.length > 2 && (
                      <span className="tag-chip">+{link.tags.length - 2}</span>
                    )}
                    {link.redirectRules.length > 0 && (
                      <span
                        className="tag-chip icon-chip"
                        title={link.redirectRules.map(ruleSummary).join('\n')}
                      >
                        <Route size={10} aria-hidden="true" /> Smart
                      </span>
                    )}
                    {link.hasPassword && (
                      <span className="tag-chip icon-chip" title="Visitors need a password">
                        <Lock size={10} aria-hidden="true" /> Password
                      </span>
                    )}
                    {isExpiringSoon(link) && link.expiresAt && (
                      <span className="expiry-cue" title={`Expires ${new Date(link.expiresAt).toUTCString()}`}>
                        Expires {new Date(link.expiresAt).toLocaleString('en-US', {
                          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
                        })}
                      </span>
                    )}
                    {link.error && (
                      <span className="source-label source-error">
                        Unavailable
                      </span>
                    )}
                  </span>
                </div>
              </div>
              <div className="status-cell" role="cell">
                {link.loading ? (
                  <span className="status status-loading">
                    <span className="status-dot" />
                    Loading
                  </span>
                ) : (
                  <span className={`status ${statusClass(status)}`}>
                    <span className="status-dot" />
                    {status}
                  </span>
                )}
              </div>
              <span role="cell" className="clicks-cell numeric">
                <span className="mobile-label">Clicks </span>
                {total === null
                  ? '—'
                  : link.analyticsLoading
                    ? '…'
                    : number.format(total)}
              </span>
              <span role="cell" className="date-column">
                {link.createdAt
                  ? new Date(link.createdAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      timeZone: 'UTC',
                    })
                  : '—'}
                <span className="mobile-label"> UTC</span>
              </span>
              <div role="cell" className="row-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Copy short link for ${link.code}`}
                  disabled={!link.shortUrl}
                  onClick={() => onCopy(link.shortUrl)}
                >
                  <Copy size={16} />
                </button>
                <Link
                  className="icon-button"
                  aria-label={`View ${link.code}`}
                  to={`/links/${link.code}`}
                >
                  <ArrowUpRight size={18} />
                </Link>
              </div>
            </div>
          )
        })}
        {visible.length === 0 && (
          <div className="empty-list">
            <Search size={22} strokeWidth={1.5} />
            <h3>
              {search
                ? 'No matching links'
                : filter !== 'All links'
                  ? `No ${filter.toLowerCase()} links`
                  : tag !== null
                    ? `No links tagged “${tag}”`
                    : 'Your first link starts here.'}
            </h3>
            <p>
              {search
                ? 'Try another destination, short code or tag.'
                : filter !== 'All links'
                  ? 'Try another filter or create a new link.'
                  : tag !== null
                    ? 'Remove the tag filter to see every link.'
                    : 'Shorten a destination and it will appear in this list.'}
            </p>
            {search || filter !== 'All links' || tag !== null ? (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSearch('')
                  setFilter('All links')
                  setTag(null)
                }}
              >
                Clear filters <X size={14} />
              </button>
            ) : (
              <Link className="text-link" to="/">
                Create a link <ArrowRight size={14} />
              </Link>
            )}
          </div>
        )}
      </div>
      <div className="list-caption">
        <span>
          Showing {visible.length} of {filtered.length} matching links
          <span className="caption-divider">·</span>Dates in UTC
        </span>
        <span>Click counts cover the last 30 UTC days.</span>
      </div>
      {bulk && chosen.length > 0 && (
        <div className="bulk-bar" role="region" aria-label="Actions for selected links">
          <div className="bulk-bar-row">
            <strong className="bulk-count" aria-live="polite">
              {chosen.length} selected
            </strong>
            {bulk.canEdit && (
              <>
                <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void act('pause')}>
                  {spinner('pause', <Pause size={14} />)} Pause
                </button>
                <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void act('resume')}>
                  {spinner('resume', <Play size={14} />)} Resume
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  aria-expanded={tagMode === 'add_tags'}
                  disabled={busy !== null}
                  onClick={() => openTags('add_tags')}
                >
                  {spinner('add_tags', <Tag size={14} />)} Add tag
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  aria-expanded={tagMode === 'remove_tags'}
                  disabled={busy !== null || chosenTags.length === 0}
                  onClick={() => openTags('remove_tags')}
                >
                  {spinner('remove_tags', <X size={14} />)} Remove tag
                </button>
              </>
            )}
            <button type="button" className="secondary-button" onClick={() => bulk.exportSelected(chosen)}>
              <Download size={14} /> Export selected
            </button>
            {bulk.canEdit && (
              <button type="button" className="danger-button" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} /> Delete
              </button>
            )}
            <button
              type="button"
              className="icon-button bulk-clear"
              aria-label="Clear selection"
              onClick={() => {
                setSelected(new Set())
                setTagMode(null)
              }}
            >
              <X size={16} />
            </button>
          </div>
          {tagMode && (
            <form className="bulk-tag-form" onSubmit={submitTags} noValidate>
              <label htmlFor="bulk-tags">
                {tagMode === 'add_tags' ? 'Tags to add' : 'Tags to remove'}
              </label>
              <input
                id="bulk-tags"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                list={tagMode === 'remove_tags' ? 'bulk-tag-options' : 'bulk-all-tags'}
                placeholder="launch, spring"
                aria-describedby="bulk-tags-hint"
                aria-invalid={tagError ? true : undefined}
                autoFocus
              />
              <datalist id="bulk-tag-options">
                {chosenTags.map((name) => (
                  <option value={name} key={name} />
                ))}
              </datalist>
              <datalist id="bulk-all-tags">
                {tags.map((name) => (
                  <option value={name} key={name} />
                ))}
              </datalist>
              <button type="submit" className="primary-button" disabled={busy !== null}>
                {tagMode === 'add_tags' ? 'Add' : 'Remove'}
              </button>
              <p id="bulk-tags-hint" className={tagError ? 'field-error' : 'field-hint'} role={tagError ? 'alert' : undefined}>
                {tagError ??
                  (tagMode === 'add_tags'
                    ? 'Separate tags with commas. Links keep at most 5 tags.'
                    : `On the selected links: ${chosenTags.join(', ')}`)}
              </p>
            </form>
          )}
        </div>
      )}
      {confirmDelete && (
        <Modal
          title={`Delete ${chosen.length} link${chosen.length === 1 ? '' : 's'}?`}
          onClose={() => setConfirmDelete(false)}
        >
          <p>
            Redirects stop right away and the short codes are never reused.
            This cannot be undone.
          </p>
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="danger-button filled"
              disabled={busy !== null}
              onClick={() => void act('delete')}
            >
              {spinner('delete', <Trash2 size={14} />)}
              Delete {chosen.length} link{chosen.length === 1 ? '' : 's'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
