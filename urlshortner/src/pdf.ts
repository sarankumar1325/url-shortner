/** Minimal single-page PDF writer: one image XObject plus an optional Courier caption. */

export type PdfPage = 'fit' | 'a4' | 'letter'

export const PDF_SIZES_CM = [3, 5, 8, 12] as const
export const PDF_DPI = 600
const POINTS_PER_CM = 72 / 2.54
const PAGE_POINTS: Record<Exclude<PdfPage, 'fit'>, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
}
const FIT_MARGIN = 36
const CAPTION_GAP = 14
const COURIER_ADVANCE = 0.6

export type PdfLayout = {
  width: number
  height: number
  image: { x: number; y: number; size: number }
  caption: { x: number; y: number; fontSize: number; text: string } | null
}

const round = (value: number) => Math.round(value * 100) / 100

/** Pixels needed to print `sizeCm` at the target DPI, capped to keep canvases sane. */
export function pdfPixels(sizeCm: number, dpi = PDF_DPI): number {
  return Math.min(4096, Math.round((sizeCm / 2.54) * dpi))
}

export function pdfLayout(sizeCm: number, page: PdfPage, caption: string | null): PdfLayout {
  const size = round(sizeCm * POINTS_PER_CM)
  let fontSize = Math.max(7, Math.min(14, size / 12))
  const captionHeight = caption ? CAPTION_GAP + fontSize : 0
  const [width, height] =
    page === 'fit'
      ? [round(size + FIT_MARGIN * 2), round(size + FIT_MARGIN * 2 + captionHeight)]
      : PAGE_POINTS[page]
  const x = round((width - size) / 2)
  // PDF space starts bottom-left; keep the code and caption centered as one block.
  const blockBottom = (height - size - captionHeight) / 2
  const y = round(blockBottom + captionHeight)
  let placed: PdfLayout['caption'] = null
  if (caption) {
    const maxWidth = width - FIT_MARGIN
    if (caption.length * COURIER_ADVANCE * fontSize > maxWidth) {
      fontSize = Math.max(5, maxWidth / (caption.length * COURIER_ADVANCE))
    }
    const textWidth = caption.length * COURIER_ADVANCE * fontSize
    placed = {
      x: round((width - textWidth) / 2),
      y: round(y - CAPTION_GAP - fontSize * 0.75),
      fontSize: round(fontSize),
      text: caption,
    }
  }
  return { width, height, image: { x, y, size }, caption: placed }
}

export function pdfString(text: string): string {
  const latin = Array.from(text, (char) => (char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127 ? char : '?')).join('')
  return `(${latin.replace(/[\\()]/g, (char) => `\\${char}`)})`
}

export function buildPdf(options: {
  layout: PdfLayout
  image: { width: number; height: number; data: Uint8Array; filter: 'FlateDecode' | 'DCTDecode' }
  title: string
}): Uint8Array {
  const { layout, image } = options
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  const object = (id: number, body: string | (() => void)) => {
    offsets[id] = length
    push(`${id} 0 obj\n`)
    if (typeof body === 'string') push(body)
    else body()
    push('\nendobj\n')
  }

  let content = `q\n${layout.image.size} 0 0 ${layout.image.size} ${layout.image.x} ${layout.image.y} cm\n/Im0 Do\nQ\n`
  if (layout.caption) {
    const c = layout.caption
    content += `BT\n/F1 ${c.fontSize} Tf\n${c.x} ${c.y} Td\n${pdfString(c.text)} Tj\nET\n`
  }
  const contentBytes = encoder.encode(content)

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${layout.width} ${layout.height}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> /Font << /F1 5 0 R >> >> /Contents 6 0 R >>`,
  )
  object(4, () => {
    push(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${image.filter} /Length ${image.data.length} >>\nstream\n`,
    )
    push(image.data)
    push('\nendstream')
  })
  object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>')
  object(6, () => {
    push(`<< /Length ${contentBytes.length} >>\nstream\n`)
    push(contentBytes)
    push('endstream')
  })
  object(7, `<< /Title ${pdfString(options.title)} /Producer (Shortly QR studio) >>`)

  const xref = length
  let table = `xref\n0 8\n0000000000 65535 f \n`
  for (let id = 1; id <= 7; id += 1) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  push(table)
  push(`trailer\n<< /Size 8 /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}
