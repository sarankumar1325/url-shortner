import { useMemo, useState, type CSSProperties, type ChangeEvent } from 'react'
import {
  AlertTriangle,
  ArrowLeftRight,
  ClipboardPaste,
  Check,
  ClipboardCopy,
  Code2,
  Copy,
  Download,
  FileArchive,
  ImageUp,
  LoaderCircle,
  QrCode,
  RotateCcw,
  ShieldCheck,
  Type,
  X,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import type { QRCodeErrorCorrectionLevel } from 'qrcode'
import { displayShortUrl, previewUrl, titleFor, type LinkRecord } from './links'
import { PDF_SIZES_CM, pdfPixels, type PdfPage } from './pdf'
import {
  ASCII_CHARSETS,
  DEFAULT_DESIGN,
  FONTS,
  FORMATS,
  MAX_CENTER_TEXT,
  MODULE_STYLES,
  effectiveErrorCorrection,
  formatInfo,
  isArtistic,
  pastedContent,
  qrGeometry,
  qrSvg,
  qrText,
  qrVersion,
  scanWarnings,
  zipFileName,
  zipFiles,
  type AsciiCharset,
  type EyeStyle,
  type QrDesign,
  type QrFont,
  type QrFormat,
} from './qr'
import { canCopyImages, copyPng, exportQr, saveBlob, type PdfOptions } from './qrExport'
import { copyText, fullUrl } from './clipboard'
import { useCopy } from './copyContext'
import Select, { type SelectOption } from './Select'
import './explore.css'

const ECC_OPTIONS: SelectOption<QRCodeErrorCorrectionLevel>[] = [
  { value: 'L', label: 'L · 7% recovery', hint: 'Smallest code' },
  { value: 'M', label: 'M · 15% recovery', hint: 'Default' },
  { value: 'Q', label: 'Q · 25% recovery' },
  { value: 'H', label: 'H · 30% recovery', hint: 'Densest code' },
]

const PDF_PAGE_OPTIONS: SelectOption<PdfPage>[] = [
  { value: 'fit', label: 'Fit to code' },
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'US Letter' },
]

const PRESETS: { name: string; foreground: string; background: string }[] = [
  { name: 'Ink', foreground: '#222921', background: '#ffffff' },
  { name: 'Forest', foreground: '#1b6e66', background: '#ffffff' },
  { name: 'Ocean', foreground: '#0b4f8a', background: '#f2f7fb' },
  { name: 'Plum', foreground: '#5b2a86', background: '#faf7fd' },
  { name: 'Ember', foreground: '#a3361b', background: '#fff7f2' },
  { name: 'Sand', foreground: '#3d3428', background: '#f6f0de' },
  { name: 'Terminal', foreground: '#0f3d1f', background: '#e9f7ec' },
  { name: 'Mono', foreground: '#000000', background: '#ffffff' },
]

const MAX_LOGO_BYTES = 512 * 1024

type CenterMode = 'none' | 'text' | 'logo'
type Source = 'workspace' | 'paste'
// Style thumbnails need something to encode before anything is pasted.
const TILE_SAMPLE = 'Shortly'

function svgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; style?: CSSProperties }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? 'active' : ''}
          style={option.style}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
}) {
  // Holds the text only while it is being edited, so outside changes show through.
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div className="color-field">
      <label htmlFor={id}>{label}</label>
      <div className="color-input">
        <input
          type="color"
          aria-label={`${label} color picker`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          id={id}
          value={draft ?? value}
          maxLength={7}
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value
            setDraft(next)
            if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toLowerCase())
          }}
          onBlur={() => setDraft(null)}
        />
      </div>
    </div>
  )
}

function useQrPreviews(encoded: string, design: QrDesign, links: LinkRecord[]) {
  const previewSvg = useMemo(() => (encoded ? qrSvg(encoded, design, 320) : ''), [encoded, design])
  const count = useMemo(() => (encoded ? qrGeometry(encoded, design).count : 0), [encoded, design])
  const tiles = useMemo(() => {
    const sample = encoded || TILE_SAMPLE
    const base = { ...design, center: { kind: 'none' as const }, margin: 1 }
    return new Map(
      MODULE_STYLES.map((style) => [style.value, svgDataUrl(qrSvg(sample, { ...base, moduleStyle: style.value }, 72))]),
    )
  }, [encoded, design])
  const tooDense = useMemo(() => {
    if (!encoded) return new Set<string>()
    return new Set(
      MODULE_STYLES.filter(
        (style) => qrVersion(qrGeometry(encoded, { ...design, moduleStyle: style.value }).count) > style.maxVersion,
      ).map((style) => style.value),
    )
  }, [encoded, design])
  const thumbs = useMemo(() => {
    const base = { ...design, margin: 1 }
    return new Map(
      links.filter((item) => item.shortUrl).map((item) => [item.code, svgDataUrl(qrSvg(item.shortUrl, base, 44))]),
    )
  }, [links, design])
  return { previewSvg, count, tiles, tooDense, thumbs }
}

export default function QrStudio({
  links,
  loading,
  workspaceName,
  notify,
}: {
  links: LinkRecord[]
  loading: boolean
  workspaceName: string
  notify: (message: string) => void
}) {
  const copyValue = useCopy()
  const [params, setParams] = useSearchParams()
  const requested = params.get('code')
  const [design, setDesign] = useState<QrDesign>(DEFAULT_DESIGN)
  const [pixels, setPixels] = useState(1024)
  const [safeScan, setSafeScan] = useState(false)
  const [centerMode, setCenterMode] = useState<CenterMode>('none')
  const [centerText, setCenterText] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [logoError, setLogoError] = useState('')
  const [format, setFormat] = useState<QrFormat>('png')
  const [pdf, setPdf] = useState<PdfOptions>({ sizeCm: 5, page: 'fit', caption: true })
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkFormat, setBulkFormat] = useState<QrFormat>('png')
  const [progress, setProgress] = useState(0)
  const [source, setSource] = useState<Source>('workspace')
  const [pasteValue, setPasteValue] = useState('')

  const active = links.filter((link) => link.shortUrl)
  const link = active.find((item) => item.code === requested) ?? active[0]
  const pasteMode = source === 'paste' || !link
  const pasted = pastedContent(pasteValue)
  const target = pasteMode
    ? pasted.text
      ? { text: pasted.text, name: pasted.name, caption: pasted.caption, isLink: pasted.kind === 'url' }
      : null
    : {
        text: safeScan ? previewUrl(link.shortUrl) : link.shortUrl,
        name: link.code,
        caption: displayShortUrl(link.shortUrl),
        isLink: true,
      }
  const encoded = target?.text ?? ''
  const { previewSvg, count, tiles, tooDense, thumbs } = useQrPreviews(encoded, design, links)
  const warnings = scanWarnings(design, count)
  const version = count ? qrVersion(count) : 0
  const canPaste = typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText)
  const usesText = design.center.kind === 'text' || design.moduleStyle === 'ascii'

  function update(patch: Partial<QrDesign>) {
    setDesign((current) => ({ ...current, ...patch }))
  }

  function chooseLink(code: string) {
    setParams(code ? { code } : {}, { replace: true })
  }

  function setCenterKind(kind: CenterMode) {
    setLogoError('')
    setCenterMode(kind)
    if (kind === 'none') {
      update({ center: { kind: 'none' } })
    } else if (kind === 'text') {
      const text = centerText || 'SCAN'
      setCenterText(text)
      update({ center: { kind: 'text', text } })
    } else {
      update({ center: logoUrl ? { kind: 'logo', dataUrl: logoUrl } : { kind: 'none' } })
    }
  }

  function onLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setLogoError('Choose a PNG, JPEG, SVG, or WebP image.')
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError('Logos must be 512 KB or smaller.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      setLogoError('')
      setLogoUrl(dataUrl)
      update({ center: { kind: 'logo', dataUrl } })
    }
    reader.onerror = () => setLogoError('That image could not be read.')
    reader.readAsDataURL(file)
  }

  function exportOptions(item: LinkRecord) {
    return { pixels, pdf, code: item.code, caption: displayShortUrl(item.shortUrl) }
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        notify('The clipboard has no text to paste.')
        return
      }
      setSource('paste')
      setPasteValue(text.trim())
    } catch {
      notify('Clipboard access was blocked. Paste into the box with ⌘V or Ctrl+V.')
    }
  }

  async function download() {
    if (!target) return
    setBusy('download')
    try {
      const { name, blob } = await exportQr(format, target.text, design, {
        pixels,
        pdf,
        code: target.name,
        caption: target.caption,
      })
      saveBlob(name, blob)
      notify(`QR code downloaded as ${formatInfo(format).label}.`)
    } catch (failure) {
      notify(failure instanceof Error && failure.message.includes('not supported')
        ? `${formatInfo(format).label} export is not supported by this browser.`
        : 'The QR code could not be generated.')
    } finally {
      setBusy(null)
    }
  }

  async function copy(kind: 'image' | 'svg' | 'text' | 'link') {
    if (!encoded) return
    setBusy(`copy-${kind}`)
    try {
      if (kind !== 'image') {
        const value =
          kind === 'svg'
            ? qrSvg(encoded, design, pixels)
            : kind === 'text'
              ? qrText(encoded, design)
              : target?.isLink
                ? fullUrl(encoded)
                : encoded
        if ((await copyText(value)) === 'manual') {
          await copyValue(value)
          return
        }
      } else await copyPng(encoded, design, pixels)
      notify(
        kind === 'image'
          ? 'QR image copied. Paste it into any app.'
          : kind === 'svg'
            ? 'SVG markup copied.'
            : kind === 'text'
              ? 'QR code copied as text.'
              : target?.isLink
                ? 'Link copied.'
                : 'Text copied.',
      )
    } catch {
      notify('Clipboard access is unavailable here.')
    } finally {
      setBusy(null)
    }
  }

  async function downloadZip() {
    const chosen = active.filter((item) => selected.has(item.code))
    if (chosen.length === 0) return
    setBusy('zip')
    setProgress(0)
    try {
      const files: { name: string; data: Uint8Array }[] = []
      for (const [index, item] of chosen.entries()) {
        const target = safeScan ? previewUrl(item.shortUrl) : item.shortUrl
        const { name, blob } = await exportQr(bulkFormat, target, design, exportOptions(item))
        files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) })
        setProgress((index + 1) / chosen.length)
      }
      const zip = zipFiles(files)
      saveBlob(zipFileName(), new Blob([zip as BlobPart], { type: 'application/zip' }))
      notify(`${files.length} QR code${files.length === 1 ? '' : 's'} zipped as ${formatInfo(bulkFormat).label}.`)
    } catch {
      notify('The ZIP could not be created.')
    } finally {
      setBusy(null)
      setProgress(0)
    }
  }

  function toggle(code: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  const allSelected = active.length > 0 && active.every((item) => selected.has(item.code))
  const ecc = effectiveErrorCorrection(design)
  const forcedEcc = design.center.kind !== 'none' || isArtistic(design.moduleStyle)
  const info = formatInfo(format)

  return (
    <div className="explore-page">
      <div className="page-heading">
        <span className="eyebrow">QR studio</span>
        <h1 tabIndex={-1}>Codes that look like yours.</h1>
        <p>
          Style a QR code for any link in {workspaceName} or anything you paste, check that it
          will scan, then copy it or export it in the format you need.
        </p>
      </div>

      {loading ? (
        <div className="loading-panel" role="status" aria-busy="true">
          Loading links…
        </div>
      ) : (
        <>
          <div className="qr-studio">
            <section className="panel qr-controls" aria-label="QR code design">
              <div className="control-group">
                <span className="control-label">Content</span>
                {link && (
                  <Segmented<Source>
                    label="QR code content"
                    value={pasteMode ? 'paste' : 'workspace'}
                    options={[
                      { value: 'workspace', label: `Your links (${active.length})` },
                      { value: 'paste', label: 'Paste a link' },
                    ]}
                    onChange={setSource}
                  />
                )}
                {pasteMode ? (
                  <div className="paste-box">
                    <label htmlFor="qr-paste" className="sr-only">
                      Link or text to encode
                    </label>
                    <textarea
                      id="qr-paste"
                      value={pasteValue}
                      rows={3}
                      spellCheck={false}
                      placeholder="Paste any link or text, like https://example.com/menu"
                      aria-invalid={pasted.error ? true : undefined}
                      aria-describedby="qr-paste-help"
                      onChange={(event) => setPasteValue(event.target.value)}
                    />
                    <div className="paste-actions">
                      {canPaste && (
                        <button type="button" className="secondary-button" onClick={() => void pasteFromClipboard()}>
                          <ClipboardPaste size={15} /> Paste from clipboard
                        </button>
                      )}
                      {pasteValue && (
                        <button type="button" className="text-button" onClick={() => setPasteValue('')}>
                          <X size={13} /> Clear
                        </button>
                      )}
                    </div>
                    <p id="qr-paste-help" className={pasted.error ? 'field-error' : 'meta'} role={pasted.error ? 'alert' : undefined}>
                      {pasted.error ??
                        (pasted.normalized
                          ? `Encoded as ${pasted.text} so phones open it as a link.`
                          : !link
                            ? 'Encoded exactly as pasted. This workspace has no short links yet; links you create appear here too.'
                            : 'Encoded exactly as pasted. Scans go straight to it, so they are not counted in your analytics.')}
                    </p>
                    {pasted.kind === 'url' && version > 6 && (
                      <p className="meta">
                        Long links make dense codes that are harder to scan from a distance.{' '}
                        <Link to="/">Shorten it</Link> for a simpler code that also counts scans.
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <Select
                      id="qr-link"
                      aria-label="Link"
                      value={link.code}
                      onChange={chooseLink}
                      options={active.map((item) => ({
                        value: item.code,
                        label: displayShortUrl(item.shortUrl),
                        hint: titleFor(item.destination),
                      }))}
                    />
                    <label className="check-row">
                      <input type="checkbox" checked={safeScan} onChange={(event) => setSafeScan(event.target.checked)} />
                      <span>
                        <strong>Safe scan.</strong> Encode the Peek link so people see the destination
                        before they visit.
                      </span>
                    </label>
                  </>
                )}
              </div>

              <div className="control-group">
                <span className="control-label">Style</span>
                <div className="style-tiles" role="radiogroup" aria-label="Module style">
                  {MODULE_STYLES.map((style) => (
                    <button
                      key={style.value}
                      type="button"
                      role="radio"
                      aria-checked={design.moduleStyle === style.value}
                      className={`style-tile ${design.moduleStyle === style.value ? 'active' : ''}`}
                      title={tooDense.has(style.value) ? 'Too dense to scan reliably in this style' : undefined}
                      onClick={() => update({ moduleStyle: style.value })}
                    >
                      <img src={tiles.get(style.value)} alt="" width={72} height={72} />
                      <span>{style.label}</span>
                      {tooDense.has(style.value) ? (
                        <span className="tile-badge tile-badge-bad">Too dense</span>
                      ) : (
                        style.artistic && <span className="tile-badge">Art</span>
                      )}
                    </button>
                  ))}
                </div>
                {design.moduleStyle === 'ascii' && (
                  <div className="sub-control">
                    <span className="control-label">Characters</span>
                    <Segmented<AsciiCharset>
                      label="ASCII characters"
                      value={design.asciiCharset}
                      options={ASCII_CHARSETS}
                      onChange={(asciiCharset) => update({ asciiCharset })}
                    />
                  </div>
                )}
              </div>

              <div className="control-group">
                <span className="control-label">Corners</span>
                <Segmented<EyeStyle>
                  label="Corner style"
                  value={design.eyeStyle}
                  options={[
                    { value: 'square', label: 'Square' },
                    { value: 'rounded', label: 'Rounded' },
                    { value: 'circle', label: 'Circle' },
                  ]}
                  onChange={(eyeStyle) => update({ eyeStyle })}
                />
              </div>

              <div className="control-group">
                <span className="control-label">Colors</span>
                <div className="swatches" role="group" aria-label="Color presets">
                  {PRESETS.map((preset) => {
                    const on = design.foreground === preset.foreground && design.background === preset.background
                    return (
                      <button
                        key={preset.name}
                        type="button"
                        className={`swatch ${on ? 'active' : ''}`}
                        aria-pressed={on}
                        title={preset.name}
                        onClick={() => update({ foreground: preset.foreground, background: preset.background })}
                        style={{ background: preset.background }}
                      >
                        <span style={{ background: preset.foreground }} />
                        <span className="sr-only">{preset.name}</span>
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    className="swatch swap"
                    title="Swap foreground and background"
                    aria-label="Swap foreground and background"
                    onClick={() => update({ foreground: design.background, background: design.foreground })}
                  >
                    <ArrowLeftRight size={15} />
                  </button>
                </div>
                <div className="color-row">
                  <ColorField id="qr-fg" label="Foreground" value={design.foreground} onChange={(foreground) => update({ foreground })} />
                  <ColorField id="qr-bg" label="Background" value={design.background} onChange={(background) => update({ background })} />
                </div>
              </div>

              <div className="control-group">
                <span className="control-label">Center</span>
                <Segmented<CenterMode>
                  label="Center mark"
                  value={centerMode}
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'text', label: 'Text' },
                    { value: 'logo', label: 'Logo' },
                  ]}
                  onChange={setCenterKind}
                />
                {centerMode === 'text' && (
                  <input
                    aria-label="Center text"
                    value={centerText}
                    maxLength={MAX_CENTER_TEXT}
                    placeholder="SALE"
                    onChange={(event) => {
                      const text = event.target.value.toUpperCase()
                      setCenterText(text)
                      update({ center: text ? { kind: 'text', text } : { kind: 'none' } })
                    }}
                  />
                )}
                {centerMode === 'logo' && (
                  <label className="upload-button">
                    <ImageUp size={16} />
                    {design.center.kind === 'logo' ? 'Replace logo' : 'Upload a logo'}
                    <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="sr-only" onChange={onLogo} />
                  </label>
                )}
                {logoError && (
                  <p className="field-error" role="alert">
                    {logoError}
                  </p>
                )}
              </div>

              <div className={`control-group ${usesText ? '' : 'muted-group'}`}>
                <span className="control-label">
                  <span>
                    <Type size={13} aria-hidden="true" /> Font
                  </span>
                  {!usesText && <span className="numeric">for center text and ASCII</span>}
                </span>
                <Segmented<QrFont>
                  label="Font"
                  value={design.font}
                  options={FONTS.map((font) => ({
                    value: font.value,
                    label: font.label,
                    style: { fontFamily: font.stack, fontWeight: font.weight },
                  }))}
                  onChange={(font) => update({ font })}
                />
              </div>

              <div className="control-group two-up">
                <div>
                  <label htmlFor="qr-size" className="control-label">
                    Image size <span className="numeric">{pixels} px</span>
                  </label>
                  <input id="qr-size" type="range" min={256} max={4096} step={64} value={pixels} onChange={(event) => setPixels(Number(event.target.value))} />
                </div>
                <div>
                  <label htmlFor="qr-margin" className="control-label">
                    Quiet zone <span className="numeric">{design.margin} modules</span>
                  </label>
                  <input id="qr-margin" type="range" min={0} max={8} value={design.margin} onChange={(event) => update({ margin: Number(event.target.value) })} />
                </div>
              </div>

              <div className="control-group">
                <label htmlFor="qr-ecc" className="control-label">
                  Error correction
                </label>
                <Select
                  id="qr-ecc"
                  value={ecc}
                  disabled={forcedEcc}
                  onChange={(value) => update({ errorCorrection: value })}
                  options={ECC_OPTIONS}
                />
                {forcedEcc && (
                  <p className="meta">Raised to H because a center mark or artistic style hides part of each module.</p>
                )}
              </div>

              <button
                type="button"
                className="text-button reset-button"
                onClick={() => {
                  setDesign(DEFAULT_DESIGN)
                  setCenterMode('none')
                  setCenterText('')
                  setLogoUrl('')
                  setPixels(1024)
                }}
              >
                <RotateCcw size={13} /> Reset design
              </button>
            </section>

            <section className="panel qr-preview" aria-label="Preview and export">
              {previewSvg ? (
                <div
                  className="qr-canvas"
                  role="img"
                  aria-label={`QR code preview for ${target?.caption ?? ''}`}
                  // Inline so the preview can use the page's web fonts; the markup is generated and escaped by qrSvg.
                  dangerouslySetInnerHTML={{ __html: previewSvg }}
                />
              ) : (
                <div className="qr-canvas qr-canvas-empty">
                  <QrCode size={34} strokeWidth={1.3} aria-hidden="true" />
                  <p>Paste a link or some text to see its QR code.</p>
                </div>
              )}
              {target && (
                <p className="qr-encoded">
                  <span className="meta">Encodes</span>
                  <code title={target.text}>{pasteMode ? target.text : displayShortUrl(target.text)}</code>
                  <span className="meta numeric">
                    v{version} · {count}×{count}
                  </span>
                </p>
              )}
              {warnings.length === 0 ? (
                <p className="scan-status good">
                  <ShieldCheck size={15} /> Good contrast and quiet zone. This should scan reliably.
                </p>
              ) : (
                <ul className="scan-warnings">
                  {warnings.map((warning) => (
                    <li key={warning.message} className={warning.level}>
                      <AlertTriangle size={14} /> {warning.message}
                    </li>
                  ))}
                </ul>
              )}

              <div className="export-box">
                <span className="control-label">Export</span>
                <div className="format-grid" role="radiogroup" aria-label="Export format">
                  {FORMATS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      role="radio"
                      aria-checked={format === item.value}
                      className={format === item.value ? 'active' : ''}
                      onClick={() => setFormat(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {format === 'pdf' ? (
                  <div className="pdf-options">
                    <div className="pdf-option">
                      <span id="pdf-size-label">Printed size</span>
                      <Select
                        aria-labelledby="pdf-size-label"
                        value={String(pdf.sizeCm)}
                        onChange={(value) => setPdf({ ...pdf, sizeCm: Number(value) })}
                        options={PDF_SIZES_CM.map((size) => ({
                          value: String(size),
                          label: `${size} cm`,
                          hint: `${(size / 2.54).toFixed(1)} in`,
                        }))}
                      />
                    </div>
                    <div className="pdf-option">
                      <span id="pdf-page-label">Page</span>
                      <Select
                        aria-labelledby="pdf-page-label"
                        value={pdf.page}
                        onChange={(page) => setPdf({ ...pdf, page })}
                        options={PDF_PAGE_OPTIONS}
                      />
                    </div>
                    <label className="check-row">
                      <input type="checkbox" checked={pdf.caption} onChange={(event) => setPdf({ ...pdf, caption: event.target.checked })} />
                      <span>Print the short link under the code</span>
                    </label>
                    <p className="meta">Rendered at 600 DPI ({pdfPixels(pdf.sizeCm)} px), lossless.</p>
                  </div>
                ) : (
                  <p className="meta export-note">
                    {format === 'svg'
                      ? usesText
                        ? 'Vector, scales to any size. Text uses fonts installed where the SVG is opened.'
                        : 'Vector, scales to any size.'
                      : format === 'txt'
                        ? 'Block characters (██) for dark modules. Paste into a terminal, README, or chat.'
                        : `${pixels} × ${pixels} px${format === 'jpeg' ? ', no transparency' : ''}.`}
                  </p>
                )}
                <button type="button" className="primary-button export-button" disabled={busy !== null || !target} onClick={() => void download()}>
                  {busy === 'download' ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
                  Download {info.label}
                </button>
                <div className="copy-row">
                  {canCopyImages() && (
                    <button type="button" className="secondary-button" disabled={busy !== null || !target} onClick={() => void copy('image')}>
                      {busy === 'copy-image' ? <LoaderCircle size={15} className="spin" /> : <ClipboardCopy size={15} />}
                      Copy image
                    </button>
                  )}
                  <button type="button" className="secondary-button" disabled={busy !== null || !target} onClick={() => void copy('svg')}>
                    <Code2 size={15} /> Copy SVG
                  </button>
                  <button type="button" className="secondary-button" disabled={busy !== null || !target} onClick={() => void copy('text')}>
                    <Type size={15} /> Copy as text
                  </button>
                  <button type="button" className="secondary-button" disabled={busy !== null || !target} onClick={() => void copy('link')}>
                    <Copy size={15} /> {target && !target.isLink ? 'Copy text' : 'Copy link'}
                  </button>
                </div>
              </div>
            </section>
          </div>

          {active.length > 0 && (
            <section className="panel bulk-panel" aria-labelledby="bulk-heading">
              <div className="section-heading">
                <div>
                  <h2 id="bulk-heading">Bulk export</h2>
                  <p className="meta">Every selected link gets this design, zipped into one download.</p>
                </div>
                <div className="bulk-actions">
                  <Select
                    id="bulk-format"
                    className="select-auto"
                    aria-label="Bulk format"
                    value={bulkFormat}
                    onChange={setBulkFormat}
                    options={FORMATS}
                  />
                  <button type="button" className="primary-button" disabled={selected.size === 0 || busy !== null} onClick={() => void downloadZip()}>
                    {busy === 'zip' ? <LoaderCircle size={15} className="spin" /> : <FileArchive size={15} />}
                    {busy === 'zip' ? `Zipping ${Math.round(progress * 100)}%` : `Download ZIP (${selected.size})`}
                  </button>
                </div>
              </div>
              <label className="check-row select-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(active.map((item) => item.code)))}
                />
                <span>Select all {active.length} links</span>
              </label>
              <ul className="bulk-list">
                {active.map((item) => (
                  <li key={item.code}>
                    <label className="check-row">
                      <input type="checkbox" checked={selected.has(item.code)} onChange={() => toggle(item.code)} />
                      <img className="bulk-thumb" src={thumbs.get(item.code)} alt="" width={44} height={44} />
                      <span className="bulk-link">
                        <strong>{displayShortUrl(item.shortUrl)}</strong>
                        <span>{titleFor(item.destination)}</span>
                      </span>
                      {selected.has(item.code) && <Check size={14} className="bulk-check" aria-hidden="true" />}
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
