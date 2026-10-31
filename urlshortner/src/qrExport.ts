import { buildPdf, pdfLayout, pdfPixels, type PdfPage } from './pdf'
import {
  GLYPH_SIZE,
  MAX_CENTER_TEXT,
  centerFontSize,
  fontFor,
  formatInfo,
  qrExportName,
  qrGeometry,
  qrSvg,
  qrText,
  type QrDesign,
  type QrFormat,
} from './qr'

export type PdfOptions = { sizeCm: number; page: PdfPage; caption: boolean }

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image failed to load'))
    image.src = src
  })
}

async function ensureFont(design: QrDesign) {
  const font = fontFor(design.font)
  const usesText = design.center.kind === 'text' || design.moduleStyle === 'ascii'
  if (!usesText || !document.fonts?.load) return
  try {
    await Promise.all([document.fonts.load(`${font.weight} 32px ${font.stack}`), document.fonts.load(`800 32px ${font.stack}`)])
  } catch {
    // Canvas falls back to the next family in the stack.
  }
}

export async function renderCanvas(text: string, design: QrDesign, pixels: number): Promise<HTMLCanvasElement> {
  await ensureFont(design)
  const { extent, path, center, glyphs } = qrGeometry(text, design)
  const font = fontFor(design.font)
  const canvas = document.createElement('canvas')
  canvas.width = pixels
  canvas.height = pixels
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas unavailable')
  context.scale(pixels / extent, pixels / extent)
  context.fillStyle = design.background
  context.fillRect(0, 0, extent, extent)
  context.fillStyle = design.foreground
  context.fill(new Path2D(path), 'evenodd')
  if (glyphs.length) {
    context.font = `800 ${GLYPH_SIZE}px ${font.stack}`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (const glyph of glyphs) context.fillText(glyph.char, glyph.x, glyph.y)
  }
  if (center) {
    const pad = 0.35
    context.fillStyle = design.background
    context.beginPath()
    context.roundRect(center.x + pad, center.y + pad, center.size - pad * 2, center.size - pad * 2, center.size * 0.18)
    context.fill()
    if (design.center.kind === 'text') {
      const label = design.center.text.slice(0, MAX_CENTER_TEXT)
      context.fillStyle = design.foreground
      context.font = `${font.weight} ${centerFontSize(center.size, label)}px ${font.stack}`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(label, center.x + center.size / 2, center.y + center.size / 2)
    } else if (design.center.kind === 'logo') {
      const image = await loadImage(design.center.dataUrl)
      const box = center.size * 0.68
      const ratio = Math.min(box / image.width, box / image.height)
      const width = image.width * ratio
      const height = image.height * ratio
      context.drawImage(image, center.x + (center.size - width) / 2, center.y + (center.size - height) / 2, width, height)
    }
  }
  return canvas
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      // Browsers without the encoder silently fall back to PNG.
      if (!blob) reject(new Error(`${type} failed`))
      else if (blob.type !== type) reject(new Error(`${type} is not supported by this browser`))
      else resolve(blob)
    }, type, 0.95),
  )
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function renderPdf(text: string, design: QrDesign, options: PdfOptions, caption: string): Promise<Blob> {
  const pixels = pdfPixels(options.sizeCm)
  const canvas = await renderCanvas(text, design, pixels)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas unavailable')
  const rgba = context.getImageData(0, 0, pixels, pixels).data
  const rgb = new Uint8Array(pixels * pixels * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]
    rgb[j + 1] = rgba[i + 1]
    rgb[j + 2] = rgba[i + 2]
  }
  const bytes = buildPdf({
    layout: pdfLayout(options.sizeCm, options.page, options.caption ? caption : null),
    image: { width: pixels, height: pixels, data: await deflate(rgb), filter: 'FlateDecode' },
    title: caption,
  })
  return new Blob([bytes as BlobPart], { type: 'application/pdf' })
}

export async function exportQr(
  format: QrFormat,
  text: string,
  design: QrDesign,
  options: { pixels: number; pdf: PdfOptions; code: string; caption: string },
): Promise<{ name: string; blob: Blob }> {
  const name = qrExportName(options.code, format)
  const { mime } = formatInfo(format)
  if (format === 'svg') return { name, blob: new Blob([qrSvg(text, design, options.pixels)], { type: mime }) }
  if (format === 'txt') return { name, blob: new Blob([qrText(text, design)], { type: mime }) }
  if (format === 'pdf') return { name, blob: await renderPdf(text, design, options.pdf, options.caption) }
  return { name, blob: await canvasBlob(await renderCanvas(text, design, options.pixels), mime) }
}

export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function canCopyImages(): boolean {
  return typeof ClipboardItem !== 'undefined' && Boolean(navigator.clipboard?.write)
}

/** Clipboard image writes only accept PNG; the promise keeps Safari's user-gesture window open. */
export async function copyPng(text: string, design: QrDesign, pixels: number): Promise<void> {
  const blob = renderCanvas(text, design, pixels).then((canvas) => canvasBlob(canvas, 'image/png'))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}
