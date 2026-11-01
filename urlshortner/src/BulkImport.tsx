import { useMemo, useRef, useState } from 'react'
import { Download, LoaderCircle, Upload } from 'lucide-react'
import {
  createLink,
  isProblem,
  type CreatedLink,
} from './api'
import { runPool, withRateLimitRetry } from './bulk'
import Modal from './Modal'
import {
  downloadTextFile,
  expiryInstant,
  parseLinkCsv,
  type ImportRow,
} from './links'

const TEMPLATE = [
  'long_url,custom_alias,expires_at,tags,fallback_url,max_clicks',
  'https://example.com/launch,,,launch,,',
  'https://example.com/docs,product-docs,2027-01-31,"docs,product",https://example.com/,500',
  '',
].join('\r\n')

/** Rows created at the same time; more would trip the create rate limit sooner. */
const CONCURRENCY = 3

function rowMessage(error: unknown): string {
  if (isProblem(error)) return error.problem.detail
  return 'This row could not be imported.'
}

export default function BulkImport({
  workspaceId,
  existingCodes,
  onClose,
  onImported,
}: {
  workspaceId: string
  existingCodes: string[]
  onClose: () => void
  onImported: (links: CreatedLink[]) => void
}) {
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<
    { line: number; ok: boolean; message: string }[]
  >([])
  const [finished, setFinished] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const parsed = useMemo(
    () => (text.trim() ? parseLinkCsv(text, existingCodes) : { rows: [], error: null }),
    [text, existingCodes],
  )
  const valid = parsed.rows.filter((row) => row.valid)
  const invalid = parsed.rows.length - valid.length

  async function run() {
    if (valid.length === 0 || running) return
    setRunning(true)
    setResults([])
    const created: CreatedLink[] = []
    const outcome: { line: number; ok: boolean; message: string }[] = []
    await runPool(valid, CONCURRENCY, async (row) => {
      // One key per row, so a retried request can never create a second link.
      const idempotencyKey = crypto.randomUUID()
      try {
        const link = await withRateLimitRetry(() =>
          createLink(
            {
              long_url: row.destination,
              custom_alias: row.alias || null,
              expires_at: row.expiresAt ? expiryInstant(row.expiresAt) : null,
              tags: row.tags,
              fallback_url: row.fallbackUrl,
              max_clicks: row.maxClicks,
            },
            idempotencyKey,
            workspaceId,
            new AbortController().signal,
          ),
        )
        created.push(link)
        outcome.push({ line: row.line, ok: true, message: link.short_code })
      } catch (error) {
        outcome.push({ line: row.line, ok: false, message: rowMessage(error) })
      }
      setResults([...outcome].sort((a, b) => a.line - b.line))
    })
    setRunning(false)
    setFinished(true)
    if (created.length > 0) onImported(created)
  }

  function loadFile(file: File | undefined) {
    if (!file) return
    setFinished(false)
    setResults([])
    void file.text().then(setText)
  }

  const failed = results.filter((item) => !item.ok)

  return (
    <Modal title="Import links from CSV" onClose={onClose} wide>
      <p>
        Add up to 50 links at a time. Every row is validated on its own, so one
        bad row never blocks the rest. Columns: <code>long_url</code>,{' '}
        <code>custom_alias</code>, <code>expires_at</code>, <code>tags</code>,{' '}
        <code>fallback_url</code>, <code>max_clicks</code>.
      </p>
      {finished ? (
        <div className="import-summary" role="status">
          <h3>
            {valid.length - failed.length} of {valid.length} imported
          </h3>
          <p className="meta">
            Existing links were not changed. Failed rows can be fixed and
            imported again.
          </p>
          {failed.length > 0 && (
            <ul className="import-errors">
              {failed.map((item) => (
                <li key={item.line}>
                  <strong>Line {item.line}</strong> {item.message}
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setFinished(false)
                setText('')
                setResults([])
              }}
            >
              Import more
            </button>
            <button type="button" className="primary-button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <label htmlFor="csv-text">CSV rows</label>
          <textarea
            id="csv-text"
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setResults([])
            }}
            rows={7}
            placeholder={TEMPLATE}
            spellCheck={false}
          />
          <div className="import-tools">
            <button
              type="button"
              className="text-button"
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={14} /> Choose a .csv file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(event) => loadFile(event.target.files?.[0])}
            />
            <button
              type="button"
              className="text-button"
              onClick={() =>
                downloadTextFile('shortly-import-template.csv', TEMPLATE)
              }
            >
              <Download size={14} /> Download template
            </button>
          </div>
          {parsed.error && (
            <p className="field-error" role="alert">
              {parsed.error}
            </p>
          )}
          {parsed.rows.length > 0 && (
            <div className="bulk-preview">
              <div className="bulk-preview-head">
                <span>
                  {valid.length} ready
                  {invalid > 0 ? ` · ${invalid} need attention` : ''}
                </span>
                <span className="meta">Checked before anything is created</span>
              </div>
              <div className="bulk-rows">
                {parsed.rows.map((row: ImportRow) => (
                  <div
                    className={`bulk-row ${row.valid ? 'valid' : 'invalid'}`}
                    key={row.line}
                  >
                    <span className="bulk-line">Line {row.line}</span>
                    <span className="bulk-destination">
                      {row.destination || '(empty)'}
                      {row.alias && <em>{row.alias}</em>}
                      {row.tags.length > 0 && (
                        <span className="tag-chip">{row.tags.join(' · ')}</span>
                      )}
                    </span>
                    <span className="bulk-status">
                      {row.valid ? 'Ready' : row.errors.join(' ')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {results.length > 0 && (
            <p className="meta import-progress" role="status">
              {results.filter((item) => item.ok).length} of {valid.length}{' '}
              imported…
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              disabled={running}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => void run()}
              disabled={running || valid.length === 0}
            >
              {running ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Upload size={15} />
              )}
              Import {valid.length} link{valid.length === 1 ? '' : 's'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
