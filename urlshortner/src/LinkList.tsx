import { useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Copy,
  Download,
  Link2,
  Search,
  Upload,
  X,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { fullUrl } from './clipboard'
import {
  displayShortUrl,
  getLinkStatus,
  isExpiringSoon,
  linkClicks,
  number,
  sortLinks,
  statusClass,
  titleFor,
  type LinkRecord,
  type LinkSort,
} from './links'

const FILTERS = ['All links', 'Active', 'Paused', 'Expired', 'Used up'] as const

export default function LinkList({
  links,
  onCopy,
  overview = false,
  onExport,
  onImport,
}: {
  links: LinkRecord[]
  onCopy: (value: string) => void
  overview?: boolean
  onExport?: () => void
  onImport?: () => void
}) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All links')
  const [tag, setTag] = useState<string | null>(null)
  const [sort, setSort] = useState<LinkSort>('newest')
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
          <span role="columnheader">Link</span>
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
              className="link-row link-grid"
              role="row"
              key={link.code}
              data-copy-url={link.shortUrl ? fullUrl(link.shortUrl) : undefined}
            >
              <div className="link-identity" role="cell">
                <Link2 size={18} aria-hidden="true" strokeWidth={1.5} />
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
    </section>
  )
}
