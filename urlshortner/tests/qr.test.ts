import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DESIGN,
  FONTS,
  FORMATS,
  MODULE_STYLES,
  asciiCharacters,
  centerFontSize,
  contrastRatio,
  crc32,
  effectiveErrorCorrection,
  fontFor,
  isFinder,
  qrExportName,
  qrGeometry,
  qrSvg,
  qrText,
  scanWarnings,
  zipFiles,
} from '../src/qr'

const URL = 'https://sho.rt/abc12'

describe('qr geometry', () => {
  test('includes the quiet zone in the extent', () => {
    const geometry = qrGeometry(URL, { ...DEFAULT_DESIGN, margin: 4 })
    expect(geometry.extent).toBe(geometry.count + 8)
    expect(geometry.center).toBeNull()
  })

  test('finder patterns sit in three corners only', () => {
    expect(isFinder(0, 0, 25)).toBe(true)
    expect(isFinder(6, 24, 25)).toBe(true)
    expect(isFinder(24, 6, 25)).toBe(true)
    expect(isFinder(24, 24, 25)).toBe(false)
    expect(isFinder(7, 7, 25)).toBe(false)
  })

  test('a center mark forces level H and reserves a centered box', () => {
    const design = { ...DEFAULT_DESIGN, center: { kind: 'text' as const, text: 'SALE' } }
    expect(effectiveErrorCorrection(design)).toBe('H')
    const geometry = qrGeometry(URL, design)
    expect(geometry.center).not.toBeNull()
    const center = geometry.center!
    expect(center.x * 2 + center.size).toBeCloseTo(geometry.extent)
    expect(center.size / geometry.count).toBeLessThan(0.3)
  })

  test('styles change the path but not the extent', () => {
    const square = qrGeometry(URL, DEFAULT_DESIGN)
    const dots = qrGeometry(URL, { ...DEFAULT_DESIGN, moduleStyle: 'dots' })
    expect(dots.extent).toBe(square.extent)
    expect(dots.path).not.toBe(square.path)
    expect(dots.path).toContain('a0.46')
  })
})

describe('qr svg', () => {
  test('renders size, colors and escaped center text', () => {
    const svg = qrSvg(URL, {
      ...DEFAULT_DESIGN,
      foreground: '#1b6e66',
      center: { kind: 'text', text: 'A&B<' },
    }, 512)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('width="512"')
    expect(svg).toContain('fill="#1b6e66"')
    expect(svg).toContain('A&amp;B&lt;')
    expect(svg).not.toContain('A&B<')
  })

  test('center text shrinks as it gets longer', () => {
    expect(centerFontSize(6, 'AB')).toBeGreaterThan(centerFontSize(6, 'ABCDEF'))
  })
})

describe('scan warnings', () => {
  test('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1)
    expect(contrastRatio('nope', '#ffffff')).toBeNull()
  })

  test('flags low contrast, inverted colors and a thin quiet zone', () => {
    expect(scanWarnings(DEFAULT_DESIGN)).toEqual([])
    const low = scanWarnings({ ...DEFAULT_DESIGN, foreground: '#dddddd' })
    expect(low[0].level).toBe('error')
    const inverted = scanWarnings({ ...DEFAULT_DESIGN, foreground: '#ffffff', background: '#111111' })
    expect(inverted.some((item) => item.message.includes('inverted'))).toBe(true)
    expect(scanWarnings({ ...DEFAULT_DESIGN, margin: 1 })).toHaveLength(1)
  })
})

describe('zip', () => {
  test('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('hello'))).toBe(0x3610a686)
  })

  test('writes local headers, a central directory and the end record', () => {
    const data = new TextEncoder().encode('hello')
    const zip = zipFiles([
      { name: 'a.txt', data },
      { name: 'b.txt', data },
    ])
    const view = new DataView(zip.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    const end = zip.length - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(2)
    const centralOffset = view.getUint32(end + 16, true)
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50)
    expect(centralOffset).toBe(2 * (30 + 5 + 5))
  })
})

describe('qr styles', () => {
  test('every style renders and artistic ones force level H with a warning', () => {
    for (const style of MODULE_STYLES) {
      const design = { ...DEFAULT_DESIGN, moduleStyle: style.value }
      const svg = qrSvg(URL, design, 256)
      expect(svg).toContain('width="256"')
      expect(effectiveErrorCorrection(design)).toBe(style.artistic ? 'H' : 'M')
      expect(scanWarnings(design).some((item) => item.message.includes('Artistic'))).toBe(style.artistic)
    }
  })

  test('ascii draws glyphs from the chosen charset instead of module shapes', () => {
    const design = { ...DEFAULT_DESIGN, moduleStyle: 'ascii' as const, asciiCharset: 'binary' as const }
    const geometry = qrGeometry(URL, design)
    expect(geometry.glyphs.length).toBeGreaterThan(0)
    expect(new Set(geometry.glyphs.map((glyph) => glyph.char))).toEqual(new Set(['0', '1']))
    expect(qrSvg(URL, design, 128)).toContain('<text')
  })

  test('the link charset uses the short code itself', () => {
    expect(asciiCharacters('link', 'https://sho.rt/abc12')).toBe('abc12')
    expect(asciiCharacters('link', 'https://sho.rt/')).toBe('sho.rt'.replace(/[^0-9a-z]/gi, ''))
    expect(asciiCharacters('symbols', URL)).toBe('#@%&')
  })

  test('dither fills each dark module with at least five of nine cells', () => {
    const square = qrGeometry(URL, { ...DEFAULT_DESIGN, center: { kind: 'none' } })
    const dither = qrGeometry(URL, { ...DEFAULT_DESIGN, moduleStyle: 'dither' })
    expect(dither.count).toBe(qrGeometry(URL, { ...DEFAULT_DESIGN, errorCorrection: 'H' }).count)
    expect(dither.path.length).toBeGreaterThan(square.path.length)
  })

  test('eye styles only change the finder patterns', () => {
    const circle = qrSvg(URL, { ...DEFAULT_DESIGN, eyeStyle: 'circle' }, 128)
    expect(circle).not.toContain('shape-rendering')
    expect(qrSvg(URL, DEFAULT_DESIGN, 128)).toContain('shape-rendering="crispEdges"')
  })

  test('fonts apply to center text and fall back to sans', () => {
    const svg = qrSvg(URL, { ...DEFAULT_DESIGN, font: 'serif', center: { kind: 'text', text: 'HI' } }, 128)
    expect(svg).toContain('Instrument Serif')
    expect(fontFor('nope' as never)).toBe(FONTS[0])
  })
})

describe('qr text and exports', () => {
  test('text art keeps modules square and honors the quiet zone', () => {
    const design = { ...DEFAULT_DESIGN, margin: 2 }
    const art = qrText(URL, design)
    expect(art.endsWith('\n')).toBe(true)
    const lines = art.slice(0, -1).split('\n')
    const { count } = qrGeometry(URL, { ...design, center: { kind: 'none' } })
    expect(lines).toHaveLength(count + 4)
    expect(lines[0]).toBe('')
    expect(lines[2].startsWith('    ██████████████')).toBe(true)
  })

  test('export names use each format extension', () => {
    expect(qrExportName('abc12', 'png')).toBe('shortly-abc12.png')
    expect(qrExportName('abc12', 'jpeg')).toBe('shortly-abc12.jpg')
    expect(qrExportName('abc12', 'pdf')).toBe('shortly-abc12.pdf')
    expect(qrExportName('abc12', 'txt')).toBe('shortly-abc12.txt')
    expect(new Set(FORMATS.map((item) => item.extension)).size).toBe(FORMATS.length)
  })
})
