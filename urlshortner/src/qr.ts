import { create, type QRCodeErrorCorrectionLevel } from 'qrcode'

export type ModuleStyle =
  | 'square'
  | 'rounded'
  | 'dots'
  | 'diamond'
  | 'bars'
  | 'dither'
  | 'halftone'
  | 'ascii'
export type EyeStyle = 'square' | 'rounded' | 'circle'
export type QrFont = 'sans' | 'serif' | 'mono' | 'rounded' | 'display'
export type AsciiCharset = 'symbols' | 'binary' | 'link'
export type CenterMark =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'logo'; dataUrl: string }

export type QrDesign = {
  foreground: string
  background: string
  margin: number
  moduleStyle: ModuleStyle
  eyeStyle: EyeStyle
  errorCorrection: QRCodeErrorCorrectionLevel
  center: CenterMark
  font: QrFont
  asciiCharset: AsciiCharset
}

export type Glyph = { x: number; y: number; char: string }

export type QrGeometry = {
  /** Modules per side, excluding the quiet zone. */
  count: number
  /** Side of the full square in module units, including the quiet zone. */
  extent: number
  /** Dark modules and finder patterns as one SVG path in module units. */
  path: string
  /** Characters drawn instead of shapes for the ASCII style, centered on each module. */
  glyphs: Glyph[]
  /** Center cut-out in module units, or null without a center mark. */
  center: { x: number; y: number; size: number } | null
  /** Raw module matrix without the quiet zone; true is dark. */
  modules: boolean[][]
}

export const DEFAULT_DESIGN: QrDesign = {
  foreground: '#222921',
  background: '#ffffff',
  margin: 2,
  moduleStyle: 'square',
  eyeStyle: 'square',
  errorCorrection: 'M',
  center: { kind: 'none' },
  font: 'sans',
  asciiCharset: 'symbols',
}

// maxVersion is the densest code each style decoded at in testing (2048 px render, Chrome's
// BarcodeDetector, square and circle eyes); square still decoded at the largest size tried.
export const MODULE_STYLES: { value: ModuleStyle; label: string; artistic: boolean; maxVersion: number }[] = [
  { value: 'square', label: 'Square', artistic: false, maxVersion: 40 },
  { value: 'rounded', label: 'Rounded', artistic: false, maxVersion: 20 },
  { value: 'dots', label: 'Dots', artistic: false, maxVersion: 20 },
  { value: 'bars', label: 'Bars', artistic: false, maxVersion: 22 },
  { value: 'diamond', label: 'Diamond', artistic: true, maxVersion: 17 },
  { value: 'dither', label: 'Dither', artistic: true, maxVersion: 20 },
  { value: 'halftone', label: 'Halftone', artistic: true, maxVersion: 20 },
  { value: 'ascii', label: 'ASCII', artistic: true, maxVersion: 17 },
]

export const FONTS: { value: QrFont; label: string; stack: string; weight: number }[] = [
  {
    value: 'sans',
    label: 'Sans',
    stack: "'Instrument Sans Variable', 'Instrument Sans', Helvetica, Arial, sans-serif",
    weight: 700,
  },
  {
    value: 'serif',
    label: 'Serif',
    stack: "'Instrument Serif', Georgia, 'Times New Roman', serif",
    weight: 400,
  },
  { value: 'mono', label: 'Mono', stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace", weight: 700 },
  {
    value: 'rounded',
    label: 'Rounded',
    stack: "ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', Nunito, sans-serif",
    weight: 700,
  },
  {
    value: 'display',
    label: 'Display',
    stack: "Impact, Haettenschweiler, 'Arial Narrow Bold', 'Franklin Gothic Bold', sans-serif",
    weight: 400,
  },
]

export const ASCII_CHARSETS: { value: AsciiCharset; label: string }[] = [
  { value: 'symbols', label: '#@%&' },
  { value: 'binary', label: '0 1' },
  { value: 'link', label: 'Link code' },
]

export function fontFor(font: QrFont): { stack: string; weight: number } {
  return FONTS.find((item) => item.value === font) ?? FONTS[0]
}

export function isArtistic(style: ModuleStyle): boolean {
  return MODULE_STYLES.find((item) => item.value === style)?.artistic ?? false
}

export const MAX_CENTER_TEXT = 6
const CENTER_RATIO = 0.22
// Dispersed ordering for a 3×3 ordered dither; lower cells fill first.
const DITHER = [
  [0, 7, 3],
  [6, 4, 2],
  [1, 5, 8],
]

const n = (value: number) => Number(value.toFixed(3))

function rect(x: number, y: number, w: number, h: number): string {
  return `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`
}

function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h / 2)
  return (
    `M${n(x + radius)} ${n(y)}h${n(w - 2 * radius)}` +
    `a${n(radius)} ${n(radius)} 0 0 1 ${n(radius)} ${n(radius)}v${n(h - 2 * radius)}` +
    `a${n(radius)} ${n(radius)} 0 0 1 ${n(-radius)} ${n(radius)}h${n(-(w - 2 * radius))}` +
    `a${n(radius)} ${n(radius)} 0 0 1 ${n(-radius)} ${n(-radius)}v${n(-(h - 2 * radius))}` +
    `a${n(radius)} ${n(radius)} 0 0 1 ${n(radius)} ${n(-radius)}Z`
  )
}

function circle(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`
}

function diamond(x: number, y: number): string {
  return `M${n(x + 0.5)} ${n(y - 0.02)}l0.52 0.52l-0.52 0.52l-0.52 -0.52Z`
}

/** True for modules inside one of the three 7×7 finder patterns. */
export function isFinder(row: number, col: number, count: number): boolean {
  const inBand = (value: number, start: number) => value >= start && value < start + 7
  return (
    (inBand(row, 0) && inBand(col, 0)) ||
    (inBand(row, 0) && inBand(col, count - 7)) ||
    (inBand(row, count - 7) && inBand(col, 0))
  )
}

function finder(x: number, y: number, style: EyeStyle): string {
  // Even-odd fill: outer shape, a hole, then the center inside it.
  if (style === 'circle') {
    return circle(x + 3.5, y + 3.5, 3.5) + circle(x + 3.5, y + 3.5, 2.5) + circle(x + 3.5, y + 3.5, 1.5)
  }
  if (style === 'rounded') {
    return roundRect(x, y, 7, 7, 2) + roundRect(x + 1, y + 1, 5, 5, 1.4) + roundRect(x + 2, y + 2, 3, 3, 0.9)
  }
  return rect(x, y, 7, 7) + rect(x + 1, y + 1, 5, 5) + rect(x + 2, y + 2, 3, 3)
}

export function effectiveErrorCorrection(design: QrDesign): QRCodeErrorCorrectionLevel {
  // A center mark hides modules and artistic styles shrink them; level H recovers up to 30%.
  return design.center.kind === 'none' && !isArtistic(design.moduleStyle) ? design.errorCorrection : 'H'
}

export function asciiCharacters(charset: AsciiCharset, text: string): string {
  if (charset === 'binary') return '01'
  if (charset === 'link') {
    const code = text.split(/[/?#]/).filter(Boolean).at(-1)?.replace(/[^0-9a-z]/gi, '') ?? ''
    return code || '#'
  }
  return '#@%&'
}

export function qrGeometry(text: string, design: QrDesign): QrGeometry {
  const qr = create(text, { errorCorrectionLevel: effectiveErrorCorrection(design) })
  const count = qr.modules.size
  const margin = Math.max(0, Math.round(design.margin))
  const extent = count + margin * 2
  const modules = Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qr.modules.get(row, col) === 1),
  )

  let center: QrGeometry['center'] = null
  let hidden = (_row: number, _col: number) => false
  if (design.center.kind !== 'none') {
    let size = Math.round(count * CENTER_RATIO)
    if (size % 2 !== count % 2) size += 1
    const start = (count - size) / 2
    center = { x: margin + start, y: margin + start, size }
    hidden = (row, col) => row >= start && row < start + size && col >= start && col < start + size
  }
  const dark = (row: number, col: number) =>
    row >= 0 &&
    col >= 0 &&
    row < count &&
    col < count &&
    modules[row][col] &&
    !isFinder(row, col, count) &&
    !hidden(row, col)

  const style = design.moduleStyle
  const parts: string[] = []
  const glyphs: Glyph[] = []
  const chars = style === 'ascii' ? asciiCharacters(design.asciiCharset, text) : ''
  const mid = (count - 1) / 2
  const maxDistance = Math.hypot(mid, mid) || 1

  if (style === 'bars') {
    for (let col = 0; col < count; col += 1) {
      let start = -1
      for (let row = 0; row <= count; row += 1) {
        const on = row < count && dark(row, col)
        if (on && start < 0) start = row
        if (!on && start >= 0) {
          parts.push(roundRect(margin + col + 0.1, margin + start + 0.06, 0.8, row - start - 0.12, 0.4))
          start = -1
        }
      }
    }
  } else {
    let glyphIndex = 0
    for (let row = 0; row < count; row += 1) {
      let runStart = -1
      for (let col = 0; col <= count; col += 1) {
        const on = col < count && dark(row, col)
        const x = margin + col
        const y = margin + row
        if (style === 'square') {
          if (on && runStart < 0) runStart = col
          if (!on && runStart >= 0) {
            parts.push(rect(margin + runStart, y, col - runStart, 1))
            runStart = -1
          }
          continue
        }
        if (!on) continue
        if (style === 'rounded') parts.push(roundRect(x + 0.04, y + 0.04, 0.92, 0.92, 0.32))
        else if (style === 'dots') parts.push(circle(x + 0.5, y + 0.5, 0.46))
        else if (style === 'diamond') parts.push(diamond(x, y))
        else if (style === 'halftone') {
          const distance = Math.hypot(row - mid, col - mid) / maxDistance
          parts.push(circle(x + 0.5, y + 0.5, 0.5 * (1 - 0.34 * distance)))
        } else if (style === 'dither') {
          // Density falls along the diagonal for a dithered gradient; never below 5 of 9 cells.
          const level = Math.round(9 - 4 * ((row + col) / (2 * (count - 1) || 1)))
          for (let i = 0; i < 3; i += 1) {
            for (let j = 0; j < 3; j += 1) {
              if (DITHER[i][j] < level) parts.push(rect(x + j / 3, y + i / 3, 1 / 3, 1 / 3))
            }
          }
        } else if (style === 'ascii') {
          glyphs.push({ x: x + 0.5, y: y + 0.5, char: chars[(row * 7 + col * 13 + glyphIndex) % chars.length] })
          glyphIndex += 1
        }
      }
    }
  }
  for (const [row, col] of [
    [0, 0],
    [0, count - 7],
    [count - 7, 0],
  ]) {
    parts.push(finder(margin + col, margin + row, design.eyeStyle))
  }
  return { count, extent, path: parts.join(''), glyphs, center, modules }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function centerFontSize(boxSize: number, text: string): number {
  return Math.min(boxSize * 0.46, (boxSize * 1.5) / Math.max(1, text.length))
}

export const GLYPH_SIZE = 1.18

export function qrSvg(text: string, design: QrDesign, pixels: number): string {
  const geometry = qrGeometry(text, design)
  const { extent, path, center, glyphs } = geometry
  const fg = escapeXml(design.foreground)
  const bg = escapeXml(design.background)
  const font = fontFor(design.font)
  const family = escapeXml(font.stack)
  const crisp =
    (design.moduleStyle === 'square' || design.moduleStyle === 'dither') && design.eyeStyle === 'square'
  let body = `<path d="${path}" fill="${fg}" fill-rule="evenodd"/>`
  if (glyphs.length) {
    body +=
      `<g fill="${fg}" font-family="${family}" font-weight="800" font-size="${GLYPH_SIZE}" text-anchor="middle" dominant-baseline="central">` +
      glyphs.map((g) => `<text x="${n(g.x)}" y="${n(g.y)}">${escapeXml(g.char)}</text>`).join('') +
      `</g>`
  }
  if (center) {
    const pad = 0.35
    body += `<rect x="${n(center.x + pad)}" y="${n(center.y + pad)}" width="${n(center.size - pad * 2)}" height="${n(center.size - pad * 2)}" rx="${n(center.size * 0.18)}" fill="${bg}"/>`
    if (design.center.kind === 'text') {
      const label = design.center.text.slice(0, MAX_CENTER_TEXT)
      const size = centerFontSize(center.size, label)
      body += `<text x="${n(center.x + center.size / 2)}" y="${n(center.y + center.size / 2)}" fill="${fg}" font-family="${family}" font-weight="${font.weight}" font-size="${n(size)}" text-anchor="middle" dominant-baseline="central">${escapeXml(label)}</text>`
    } else if (design.center.kind === 'logo') {
      const inset = center.size * 0.16
      body += `<image href="${escapeXml(design.center.dataUrl)}" x="${n(center.x + inset)}" y="${n(center.y + inset)}" width="${n(center.size - inset * 2)}" height="${n(center.size - inset * 2)}" preserveAspectRatio="xMidYMid meet"/>`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" width="${pixels}" height="${pixels}"${crisp ? ' shape-rendering="crispEdges"' : ''}>` +
    `<rect width="${extent}" height="${extent}" fill="${bg}"/>` +
    body +
    `</svg>`
  )
}

/** The code as text art: two block characters per dark module so cells stay square. */
export function qrText(text: string, design: QrDesign): string {
  const { modules } = qrGeometry(text, { ...design, center: { kind: 'none' } })
  const margin = Math.max(0, Math.round(design.margin))
  const width = modules.length + margin * 2
  const blank = '  '.repeat(width)
  const lines: string[] = []
  for (let i = 0; i < margin; i += 1) lines.push(blank)
  for (const row of modules) {
    lines.push('  '.repeat(margin) + row.map((on) => (on ? '██' : '  ')).join('') + '  '.repeat(margin))
  }
  for (let i = 0; i < margin; i += 1) lines.push(blank)
  return lines.map((line) => line.replace(/\s+$/, '')).join('\n') + '\n'
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function luminance(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  )
}

export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

export type ScanWarning = { level: 'error' | 'warning'; message: string }

export const DENSE_VERSION = 10
// About 0.4 mm per module is the smallest most phone cameras resolve at arm's length.
const MIN_MODULE_MM = 0.4

/** Smallest printed width, in whole centimeters, for a code with this many modules per side. */
export function minPrintCm(count: number, margin: number): number {
  return Math.ceil(((count + 2 * Math.max(0, margin)) * MIN_MODULE_MM) / 10)
}

/** Warnings for a design; pass the module count once content is known to check density too. */
export function scanWarnings(design: QrDesign, count = 0): ScanWarning[] {
  const warnings: ScanWarning[] = []
  if (count > 0) {
    const version = qrVersion(count)
    const style = MODULE_STYLES.find((item) => item.value === design.moduleStyle) ?? MODULE_STYLES[0]
    if (version > style.maxVersion) {
      warnings.push({
        level: 'error',
        message: `${style.label} codes this dense (version ${version}) failed to scan in testing. Switch to Square or shorten the content.`,
      })
    } else if (version > DENSE_VERSION) {
      warnings.push({
        level: 'warning',
        message: `Dense code: version ${version}, ${count}×${count} modules. Print it at least ${minPrintCm(count, design.margin)} cm wide and test-scan it.`,
      })
    }
  }
  const ratio = contrastRatio(design.foreground, design.background)
  if (ratio !== null && ratio < 3) {
    warnings.push({
      level: 'error',
      message: `Contrast is ${ratio.toFixed(1)}:1. Most scanners need at least 3:1, and 4:1 or more is safer.`,
    })
  } else if (ratio !== null && ratio < 4) {
    warnings.push({
      level: 'warning',
      message: `Contrast is ${ratio.toFixed(1)}:1. Older phones may struggle; aim for 4:1 or more.`,
    })
  }
  const fg = luminance(design.foreground)
  const bg = luminance(design.background)
  if (fg !== null && bg !== null && fg > bg) {
    warnings.push({
      level: 'warning',
      message: 'Light-on-dark codes are inverted. Some scanner apps cannot read them.',
    })
  }
  if (design.margin < 2) {
    warnings.push({
      level: 'warning',
      message: 'A quiet zone under 2 modules can fail when the code sits near other artwork.',
    })
  }
  if (isArtistic(design.moduleStyle)) {
    warnings.push({
      level: 'warning',
      message: 'Artistic styles cover less of each module. Error correction is raised to H; test-scan a print before you ship it.',
    })
  }
  return warnings
}

/** Byte budget for pasted content: version 40 at level H holds 1,273 bytes, minus headroom. */
export const MAX_PASTE_BYTES = 1200
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob'])
const BARE_HOST = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d{1,5})?([/?#]\S*)?$/i

export type PastedContent = {
  /** Exactly what the code will encode, or '' when nothing usable was pasted. */
  text: string
  kind: 'url' | 'text'
  /** True when a scheme was added so phones open the value as a link. */
  normalized: boolean
  error: string | null
  /** File-name stem for exports. */
  name: string
  /** Short human label for captions and the preview. */
  caption: string
}

function slug(value: string, fallback: string): string {
  const stem = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return stem || fallback
}

function shorten(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

export function pastedContent(raw: string): PastedContent {
  const value = raw.trim()
  const empty = { text: '', kind: 'text' as const, normalized: false, name: 'qr', caption: '' }
  if (!value) return { ...empty, error: null }

  let text = value
  let normalized = false
  // A scheme is letters then a colon not followed by a port number, so "localhost:8000/x" is a host.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(value)?.[1].toLowerCase()
  if (scheme && BLOCKED_SCHEMES.has(scheme)) {
    return { ...empty, error: `${scheme}: links are not allowed in a QR code.` }
  }
  if (!scheme && !/\s/.test(value) && BARE_HOST.test(value)) {
    text = `${/^localhost\b/i.test(value) ? 'http' : 'https'}://${value}`
    normalized = true
  }

  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_PASTE_BYTES) {
    return {
      ...empty,
      error: `That is ${bytes.toLocaleString('en-US')} bytes; a QR code holds about ${MAX_PASTE_BYTES.toLocaleString('en-US')}. Shorten it first.`,
    }
  }

  let url: URL | null = null
  if (/^https?:\/\//i.test(text)) {
    try {
      url = new URL(text)
    } catch {
      url = null
    }
  }
  if (url) {
    const path = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
    return {
      text,
      kind: 'url',
      normalized,
      error: null,
      name: slug(`${url.hostname.replace(/^www\./, '')}${path ? `-${path}` : ''}`, 'qr'),
      caption: shorten(text.replace(/^https?:\/\//i, '').replace(/\/$/, '')),
    }
  }
  return { text, kind: 'text', normalized, error: null, name: slug(text, 'qr-text'), caption: shorten(text) }
}

/** QR version 1–40 from the modules per side. */
export function qrVersion(count: number): number {
  return (count - 17) / 4
}
export type QrFormat = 'png' | 'jpeg' | 'webp' | 'svg' | 'pdf' | 'txt'

export const FORMATS: { value: QrFormat; label: string; mime: string; extension: string }[] = [
  { value: 'png', label: 'PNG', mime: 'image/png', extension: 'png' },
  { value: 'jpeg', label: 'JPEG', mime: 'image/jpeg', extension: 'jpg' },
  { value: 'webp', label: 'WebP', mime: 'image/webp', extension: 'webp' },
  { value: 'svg', label: 'SVG', mime: 'image/svg+xml', extension: 'svg' },
  { value: 'pdf', label: 'PDF', mime: 'application/pdf', extension: 'pdf' },
  { value: 'txt', label: 'Text', mime: 'text/plain;charset=utf-8', extension: 'txt' },
]

export function formatInfo(format: QrFormat) {
  return FORMATS.find((item) => item.value === format) ?? FORMATS[0]
}

export function qrExportName(code: string, format: QrFormat): string {
  return `shortly-${code}.${formatInfo(format).extension}`
}

export function qrSvgFileName(code: string): string {
  return qrExportName(code, 'svg')
}

export function zipFileName(now = new Date()): string {
  return `shortly-qr-codes-${now.toISOString().slice(0, 10)}.zip`
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
/** Minimal store-only ZIP; PNG and SVG payloads gain little from deflate. */
export function zipFiles(
  files: { name: string; data: Uint8Array }[],
  modified = new Date(),
): Uint8Array {
  const encoder = new TextEncoder()
  const dosTime =
    (modified.getHours() << 11) | (modified.getMinutes() << 5) | (modified.getSeconds() >> 1)
  const dosDate =
    ((Math.max(1980, modified.getFullYear()) - 1980) << 9) |
    ((modified.getMonth() + 1) << 5) |
    modified.getDate()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    const crc = crc32(file.data)
    const size = file.data.length

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, 0, true)
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    locals.push(local, file.data)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, dosTime, true)
    cv.setUint16(14, dosDate, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)

    offset += local.length + size
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const out = new Uint8Array(offset + centralSize + end.length)
  let cursor = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}
