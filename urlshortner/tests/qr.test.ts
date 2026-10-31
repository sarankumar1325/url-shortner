import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DESIGN,
  centerFontSize,
  contrastRatio,
  crc32,
  effectiveErrorCorrection,
  isFinder,
  qrGeometry,
  qrSvg,
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
