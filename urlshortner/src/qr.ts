import { create, type QRCodeErrorCorrectionLevel } from 'qrcode'

export type ModuleStyle = 'square' | 'rounded' | 'dots'
export type EyeStyle = 'square' | 'rounded'
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
}

export type QrGeometry = {
  /** Modules per side, excluding the quiet zone. */
  count: number
  /** Side of the full square in module units, including the quiet zone. */
  extent: number
  /** Dark modules and finder patterns as one SVG path in module units. */
  path: string
  /** Center cut-out in module units, or null without a center mark. */
  center: { x: number; y: number; size: number } | null
}

export const DEFAULT_DESIGN: QrDesign = {
  foreground: '#222921',
  background: '#ffffff',
  margin: 2,
  moduleStyle: 'square',
  eyeStyle: 'square',
  errorCorrection: 'M',
  center: { kind: 'none' },
}

export const MAX_CENTER_TEXT = 6
const CENTER_RATIO = 0.22

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
  // Even-odd fill: outer square, a hole, then the center square inside it.
  if (style === 'rounded') {
    return roundRect(x, y, 7, 7, 2) + roundRect(x + 1, y + 1, 5, 5, 1.4) + roundRect(x + 2, y + 2, 3, 3, 0.9)
  }
  return rect(x, y, 7, 7) + rect(x + 1, y + 1, 5, 5) + rect(x + 2, y + 2, 3, 3)
}

export function effectiveErrorCorrection(design: QrDesign): QRCodeErrorCorrectionLevel {
  // A center mark hides modules; level H restores up to 30% of the code.
  return design.center.kind === 'none' ? design.errorCorrection : 'H'
}

export function qrGeometry(text: string, design: QrDesign): QrGeometry {
  const qr = create(text, { errorCorrectionLevel: effectiveErrorCorrection(design) })
  const count = qr.modules.size
  const margin = Math.max(0, Math.round(design.margin))
  const extent = count + margin * 2

  let center: QrGeometry['center'] = null
  let hidden = (_row: number, _col: number) => false
  if (design.center.kind !== 'none') {
    let size = Math.round(count * CENTER_RATIO)
    if (size % 2 !== count % 2) size += 1
    const start = (count - size) / 2
    center = { x: margin + start, y: margin + start, size }
    hidden = (row, col) =>
      row >= start && row < start + size && col >= start && col < start + size
  }

  const parts: string[] = []
  for (let row = 0; row < count; row += 1) {
    let runStart = -1
    for (let col = 0; col <= count; col += 1) {
      const dark =
        col < count &&
        qr.modules.get(row, col) === 1 &&
        !isFinder(row, col, count) &&
        !hidden(row, col)
      const x = margin + col
      const y = margin + row
      if (design.moduleStyle === 'square') {
        if (dark && runStart < 0) runStart = col
        if (!dark && runStart >= 0) {
          parts.push(rect(margin + runStart, y, col - runStart, 1))
          runStart = -1
        }
      } else if (dark) {
        parts.push(
          design.moduleStyle === 'dots'
            ? circle(x + 0.5, y + 0.5, 0.46)
            : roundRect(x + 0.04, y + 0.04, 0.92, 0.92, 0.32),
        )
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
  return { count, extent, path: parts.join(''), center }
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

export function qrSvg(text: string, design: QrDesign, pixels: number): string {
  const geometry = qrGeometry(text, design)
  const { extent, path, center } = geometry
  const fg = escapeXml(design.foreground)
  const bg = escapeXml(design.background)
  const crisp = design.moduleStyle === 'square' && design.eyeStyle === 'square'
  let mark = ''
  if (center) {
    const pad = 0.35
    mark += `<rect x="${n(center.x + pad)}" y="${n(center.y + pad)}" width="${n(center.size - pad * 2)}" height="${n(center.size - pad * 2)}" rx="${n(center.size * 0.18)}" fill="${bg}"/>`
    if (design.center.kind === 'text') {
      const label = design.center.text.slice(0, MAX_CENTER_TEXT)
      const size = centerFontSize(center.size, label)
      mark += `<text x="${n(center.x + center.size / 2)}" y="${n(center.y + center.size / 2)}" fill="${fg}" font-family="Inter, Helvetica, Arial, sans-serif" font-weight="700" font-size="${n(size)}" text-anchor="middle" dominant-baseline="central">${escapeXml(label)}</text>`
    } else if (design.center.kind === 'logo') {
      const inset = center.size * 0.16
      mark += `<image href="${escapeXml(design.center.dataUrl)}" x="${n(center.x + inset)}" y="${n(center.y + inset)}" width="${n(center.size - inset * 2)}" height="${n(center.size - inset * 2)}" preserveAspectRatio="xMidYMid meet"/>`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" width="${pixels}" height="${pixels}"${crisp ? ' shape-rendering="crispEdges"' : ''}>` +
    `<rect width="${extent}" height="${extent}" fill="${bg}"/>` +
    `<path d="${path}" fill="${fg}" fill-rule="evenodd"/>` +
    mark +
    `</svg>`
  )
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

export function scanWarnings(design: QrDesign): ScanWarning[] {
  const warnings: ScanWarning[] = []
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
  return warnings
}

export function qrSvgFileName(code: string): string {
  return `shortly-${code}.svg`
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
