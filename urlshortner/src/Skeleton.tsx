/**
 * A placeholder shaped like the content that is loading. The label is read
 * to screen readers; the shapes are hidden from them.
 */
export default function Skeleton({
  label,
  variant = 'list',
  rows = 4,
  bare = false,
}: {
  label: string
  /** list: rows of links or people; chart: analytics; block: a page or panel. */
  variant?: 'list' | 'chart' | 'block'
  rows?: number
  /** Drop the panel background for use inside an existing panel. */
  bare?: boolean
}) {
  return (
    <div
      className={`skeleton-panel${bare ? ' bare' : ''}`}
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      {variant === 'chart' ? (
        <div className="skeleton-chart-body" aria-hidden="true">
          <div className="skeleton-metrics">
            <span className="skeleton-block" />
            <span className="skeleton-block" />
            <span className="skeleton-block" />
          </div>
          <span className="skeleton-block skeleton-plot" />
        </div>
      ) : variant === 'block' ? (
        <div className="skeleton-block-body" aria-hidden="true">
          <span className="skeleton-block" />
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </div>
      ) : (
        Array.from({ length: rows }, (_, index) => (
          <div key={index} className="skeleton-row" aria-hidden="true">
            <span className="skeleton-block skeleton-avatar" />
            <span className="skeleton-lines">
              <span className="skeleton-block" />
              <span className="skeleton-block" />
            </span>
            <span className="skeleton-block skeleton-chip" />
          </div>
        ))
      )}
    </div>
  )
}
