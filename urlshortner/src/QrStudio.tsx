import { useState, type ChangeEvent } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileArchive,
  ImageUp,
  LoaderCircle,
  QrCode,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import type { QRCodeErrorCorrectionLevel } from 'qrcode'
import {
  displayShortUrl,
  previewUrl,
  qrFileName,
  titleFor,
  type LinkRecord,
} from './links'
import {
  DEFAULT_DESIGN,
  MAX_CENTER_TEXT,
  centerFontSize,
  effectiveErrorCorrection,
  qrGeometry,
  qrSvg,
  qrSvgFileName,
  scanWarnings,
  zipFileName,
  zipFiles,
  type EyeStyle,
  type ModuleStyle,
  type QrDesign,
} from './qr'
import './explore.css'

const PRESETS: { name: string; foreground: string; background: string }[] = [
  { name: 'Ink', foreground: '#222921', background: '#ffffff' },
  { name: 'Forest', foreground: '#1b6e66', background: '#ffffff' },
  { name: 'Ocean', foreground: '#0b4f8a', background: '#f2f7fb' },
  { name: 'Plum', foreground: '#5b2a86', background: '#faf7fd' },
  { name: 'Ember', foreground: '#a3361b', background: '#fff7f2' },
  { name: 'Sand', foreground: '#3d3428', background: '#f6f0de' },
]

const MAX_LOGO_BYTES = 512 * 1024

type Format = 'png' | 'svg'
type CenterMode = 'none' | 'text' | 'logo'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image failed to load'))
    image.src = src
  })
}

async function renderPng(text: string, design: QrDesign, pixels: number): Promise<Blob> {
  const { extent, path, center } = qrGeometry(text, design)
  const canvas = document.createElement('canvas')
  canvas.width = pixels
  canvas.height = pixels
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas unavailable')
  const scale = pixels / extent
  context.scale(scale, scale)
  context.fillStyle = design.background
  context.fillRect(0, 0, extent, extent)
  context.fillStyle = design.foreground
  context.fill(new Path2D(path), 'evenodd')
  if (center) {
    const pad = 0.35
    context.fillStyle = design.background
    context.beginPath()
    context.roundRect(
      center.x + pad,
      center.y + pad,
      center.size - pad * 2,
      center.size - pad * 2,
      center.size * 0.18,
    )
    context.fill()
    if (design.center.kind === 'text') {
      const label = design.center.text.slice(0, MAX_CENTER_TEXT)
      context.fillStyle = design.foreground
      context.font = `700 ${centerFontSize(center.size, label)}px Inter, Helvetica, Arial, sans-serif`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(label, center.x + center.size / 2, center.y + center.size / 2)
    } else if (design.center.kind === 'logo') {
      const image = await loadImage(design.center.dataUrl)
      const box = center.size * 0.68
      const ratio = Math.min(box / image.width, box / image.height)
      const width = image.width * ratio
      const height = image.height * ratio
      context.drawImage(
        image,
        center.x + (center.size - width) / 2,
        center.y + (center.size - height) / 2,
        width,
        height,
      )
    }
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('png failed'))),
      'image/png',
    ),
  )
}

function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
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
  const [params, setParams] = useSearchParams()
  const requested = params.get('code')
  const [design, setDesign] = useState<QrDesign>(DEFAULT_DESIGN)
  const [pixels, setPixels] = useState(1024)
  const [safeScan, setSafeScan] = useState(false)
  const [centerMode, setCenterMode] = useState<CenterMode>('none')
  const [centerText, setCenterText] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [logoError, setLogoError] = useState('')
  const [busy, setBusy] = useState<'png' | 'svg' | 'zip' | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkFormat, setBulkFormat] = useState<Format>('png')
  const [progress, setProgress] = useState(0)

  const active = links.filter((link) => link.shortUrl)
  const link = active.find((item) => item.code === requested) ?? active[0]
  const encoded = link ? (safeScan ? previewUrl(link.shortUrl) : link.shortUrl) : ''
  const warnings = scanWarnings(design)
  const svg = encoded ? qrSvg(encoded, design, 320) : ''
  const preview = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : ''

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

  async function download(format: Format) {
    if (!link || !encoded) return
    setBusy(format)
    try {
      if (format === 'svg') {
        saveBlob(
          qrSvgFileName(link.code),
          new Blob([qrSvg(encoded, design, pixels)], { type: 'image/svg+xml' }),
        )
      } else {
        saveBlob(qrFileName(link.code), await renderPng(encoded, design, pixels))
      }
      notify(`QR code downloaded as ${format.toUpperCase()}.`)
    } catch {
      notify('The QR code could not be generated.')
    } finally {
      setBusy(null)
    }
  }

  async function copySvg() {
    if (!encoded) return
    try {
      await navigator.clipboard.writeText(qrSvg(encoded, design, pixels))
      notify('SVG markup copied.')
    } catch {
      notify('Clipboard access is unavailable.')
    }
  }

  async function downloadZip() {
    const chosen = active.filter((item) => selected.has(item.code))
    if (chosen.length === 0) return
    setBusy('zip')
    setProgress(0)
    try {
      const encoder = new TextEncoder()
      const files: { name: string; data: Uint8Array }[] = []
      for (const [index, item] of chosen.entries()) {
        const target = safeScan ? previewUrl(item.shortUrl) : item.shortUrl
        if (bulkFormat === 'svg') {
          files.push({
            name: qrSvgFileName(item.code),
            data: encoder.encode(qrSvg(target, design, pixels)),
          })
        } else {
          const blob = await renderPng(target, design, pixels)
          files.push({
            name: qrFileName(item.code),
            data: new Uint8Array(await blob.arrayBuffer()),
          })
        }
        setProgress((index + 1) / chosen.length)
      }
      const zip = zipFiles(files)
      saveBlob(
        zipFileName(),
        new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }),
      )
      notify(`${files.length} QR code${files.length === 1 ? '' : 's'} zipped.`)
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

  return (
    <div className="explore-page">
      <div className="page-heading">
        <span className="eyebrow">QR studio</span>
        <h1 tabIndex={-1}>Codes that look like yours.</h1>
        <p>
          Style a QR code for any link in {workspaceName}, check that it will
          scan, and export one or all of them.
        </p>
      </div>

      {loading ? (
        <div className="loading-panel" role="status" aria-busy="true">
          Loading links…
        </div>
      ) : !link ? (
        <div className="panel empty-catalog">
          <QrCode size={28} strokeWidth={1.4} />
          <p>Create a link first, then come back to design its QR code.</p>
          <Link className="primary-button" to="/">
            Create a link
          </Link>
        </div>
      ) : (
        <>
          <div className="qr-studio">
            <section className="panel qr-controls" aria-label="QR code design">
              <div className="control-group">
                <label htmlFor="qr-link">Link</label>
                <select
                  id="qr-link"
                  value={link.code}
                  onChange={(event) => chooseLink(event.target.value)}
                >
                  {active.map((item) => (
                    <option key={item.code} value={item.code}>
                      {displayShortUrl(item.shortUrl)} → {titleFor(item.destination)}
                    </option>
                  ))}
                </select>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={safeScan}
                    onChange={(event) => setSafeScan(event.target.checked)}
                  />
                  <span>
                    <strong>Safe scan.</strong> Encode the Peek link so people
                    see the destination before they visit.
                  </span>
                </label>
              </div>

              <div className="control-group">
                <span className="control-label">Colors</span>
                <div className="swatches" role="group" aria-label="Color presets">
                  {PRESETS.map((preset) => {
                    const on =
                      design.foreground === preset.foreground &&
                      design.background === preset.background
                    return (
                      <button
                        key={preset.name}
                        type="button"
                        className={`swatch ${on ? 'active' : ''}`}
                        aria-pressed={on}
                        title={preset.name}
                        onClick={() =>
                          update({
                            foreground: preset.foreground,
                            background: preset.background,
                          })
                        }
                        style={{ background: preset.background }}
                      >
                        <span style={{ background: preset.foreground }} />
                        <span className="sr-only">{preset.name}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="color-row">
                  <ColorField
                    id="qr-fg"
                    label="Foreground"
                    value={design.foreground}
                    onChange={(foreground) => update({ foreground })}
                  />
                  <ColorField
                    id="qr-bg"
                    label="Background"
                    value={design.background}
                    onChange={(background) => update({ background })}
                  />
                </div>
              </div>

              <div className="control-group two-up">
                <div>
                  <span className="control-label">Modules</span>
                  <Segmented<ModuleStyle>
                    label="Module style"
                    value={design.moduleStyle}
                    options={[
                      { value: 'square', label: 'Square' },
                      { value: 'rounded', label: 'Rounded' },
                      { value: 'dots', label: 'Dots' },
                    ]}
                    onChange={(moduleStyle) => update({ moduleStyle })}
                  />
                </div>
                <div>
                  <span className="control-label">Corners</span>
                  <Segmented<EyeStyle>
                    label="Corner style"
                    value={design.eyeStyle}
                    options={[
                      { value: 'square', label: 'Square' },
                      { value: 'rounded', label: 'Rounded' },
                    ]}
                    onChange={(eyeStyle) => update({ eyeStyle })}
                  />
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
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/svg+xml,image/webp"
                      className="sr-only"
                      onChange={onLogo}
                    />
                  </label>
                )}
                {logoError && (
                  <p className="field-error" role="alert">
                    {logoError}
                  </p>
                )}
                {centerMode !== 'none' && (
                  <p className="meta">
                    Error correction is raised to H so the code still scans with
                    the center covered.
                  </p>
                )}
              </div>

              <div className="control-group two-up">
                <div>
                  <label htmlFor="qr-size" className="control-label">
                    Export size <span className="numeric">{pixels} px</span>
                  </label>
                  <input
                    id="qr-size"
                    type="range"
                    min={256}
                    max={2048}
                    step={64}
                    value={pixels}
                    onChange={(event) => setPixels(Number(event.target.value))}
                  />
                </div>
                <div>
                  <label htmlFor="qr-margin" className="control-label">
                    Quiet zone{' '}
                    <span className="numeric">{design.margin} modules</span>
                  </label>
                  <input
                    id="qr-margin"
                    type="range"
                    min={0}
                    max={8}
                    value={design.margin}
                    onChange={(event) => update({ margin: Number(event.target.value) })}
                  />
                </div>
              </div>

              <div className="control-group">
                <label htmlFor="qr-ecc" className="control-label">
                  Error correction
                </label>
                <select
                  id="qr-ecc"
                  value={ecc}
                  disabled={design.center.kind !== 'none'}
                  onChange={(event) =>
                    update({
                      errorCorrection: event.target.value as QRCodeErrorCorrectionLevel,
                    })
                  }
                >
                  <option value="L">L · 7% recovery, smallest code</option>
                  <option value="M">M · 15% recovery (default)</option>
                  <option value="Q">Q · 25% recovery</option>
                  <option value="H">H · 30% recovery, densest code</option>
                </select>
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

            <section className="panel qr-preview" aria-label="Preview">
              <div className="qr-canvas">
                {preview && (
                  <img
                    src={preview}
                    width={320}
                    height={320}
                    alt={`QR code for ${displayShortUrl(encoded)}`}
                  />
                )}
              </div>
              <p className="qr-encoded">
                <span className="meta">Encodes</span>
                <code>{displayShortUrl(encoded)}</code>
              </p>
              {warnings.length === 0 ? (
                <p className="scan-status good">
                  <ShieldCheck size={15} /> Good contrast and quiet zone. This
                  should scan reliably.
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
              <div className="qr-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy !== null}
                  onClick={() => void download('png')}
                >
                  {busy === 'png' ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Download size={15} />
                  )}
                  PNG
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy !== null}
                  onClick={() => void download('svg')}
                >
                  <Download size={15} /> SVG
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void copySvg()}
                >
                  <Copy size={15} /> Copy SVG
                </button>
              </div>
            </section>
          </div>

          <section className="panel bulk-panel" aria-labelledby="bulk-heading">
            <div className="section-heading">
              <div>
                <h2 id="bulk-heading">Bulk export</h2>
                <p className="meta">
                  Every selected link gets this design, zipped into one
                  download.
                </p>
              </div>
              <div className="bulk-actions">
                <Segmented<Format>
                  label="Bulk format"
                  value={bulkFormat}
                  options={[
                    { value: 'png', label: 'PNG' },
                    { value: 'svg', label: 'SVG' },
                  ]}
                  onChange={setBulkFormat}
                />
                <button
                  type="button"
                  className="primary-button"
                  disabled={selected.size === 0 || busy !== null}
                  onClick={() => void downloadZip()}
                >
                  {busy === 'zip' ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <FileArchive size={15} />
                  )}
                  {busy === 'zip'
                    ? `Zipping ${Math.round(progress * 100)}%`
                    : `Download ZIP (${selected.size})`}
                </button>
              </div>
            </div>
            <label className="check-row select-all">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() =>
                  setSelected(
                    allSelected ? new Set() : new Set(active.map((item) => item.code)),
                  )
                }
              />
              <span>Select all {active.length} links</span>
            </label>
            <ul className="bulk-list">
              {active.map((item) => (
                <li key={item.code}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={selected.has(item.code)}
                      onChange={() => toggle(item.code)}
                    />
                    <span className="bulk-link">
                      <strong>{displayShortUrl(item.shortUrl)}</strong>
                      <span>{titleFor(item.destination)}</span>
                    </span>
                    {selected.has(item.code) && (
                      <Check size={14} className="bulk-check" aria-hidden="true" />
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
