import { describe, expect, test } from 'bun:test'
import { copyText, fullUrl, pasteIsForPage, urlFromPaste } from '../src/clipboard'

describe('paste-to-shorten detection', () => {
  test('accepts http and https URLs as pasted', () => {
    expect(urlFromPaste('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(urlFromPaste('  http://example.com  ')).toBe('http://example.com')
    expect(urlFromPaste('https://example.com/path\n')).toBe('https://example.com/path')
  })

  test('adds https:// to bare domains', () => {
    expect(urlFromPaste('example.com')).toBe('https://example.com')
    expect(urlFromPaste('docs.example.co.uk/guide?x=1')).toBe('https://docs.example.co.uk/guide?x=1')
    expect(urlFromPaste('localhost.dev:8080/x')).toBe('https://localhost.dev:8080/x')
  })

  test('ignores text that is not a link', () => {
    for (const value of [
      '',
      '   ',
      'hello world',
      'just-a-word',
      'see https://example.com for details',
      'mailto:someone@example.com',
      'javascript:alert(1)',
      'ftp://example.com/file',
      'https://',
      '1.5',
    ]) {
      expect(urlFromPaste(value)).toBeNull()
    }
  })

  test('ignores very long clipboard contents', () => {
    expect(urlFromPaste(`https://example.com/${'a'.repeat(9000)}`)).toBeNull()
  })

  test('only shortens when the paste would not land in a field', () => {
    expect(pasteIsForPage({ tagName: 'BODY' }, false)).toBe(true)
    expect(pasteIsForPage({ tagName: 'BUTTON' }, false)).toBe(true)
    expect(pasteIsForPage(null, false)).toBe(true)
    expect(pasteIsForPage({ tagName: 'INPUT' }, false)).toBe(false)
    expect(pasteIsForPage({ tagName: 'TEXTAREA' }, false)).toBe(false)
    expect(pasteIsForPage({ tagName: 'DIV', isContentEditable: true }, false)).toBe(false)
    expect(pasteIsForPage({ tagName: 'BODY' }, true)).toBe(false)
  })
})

describe('copy fallback', () => {
  test('uses the Clipboard API when it works', async () => {
    const written: string[] = []
    let legacyCalls = 0
    const outcome = await copyText('https://s.example/abc', {
      writeText: async (value) => {
        written.push(value)
      },
      legacyCopy: () => {
        legacyCalls += 1
        return true
      },
    })
    expect(outcome).toBe('clipboard')
    expect(written).toEqual(['https://s.example/abc'])
    expect(legacyCalls).toBe(0)
  })

  test('falls back to execCommand when the Clipboard API is blocked', async () => {
    const outcome = await copyText('value', {
      writeText: async () => {
        throw new DOMException('denied', 'NotAllowedError')
      },
      legacyCopy: () => true,
    })
    expect(outcome).toBe('legacy')
  })

  test('falls back to execCommand when there is no Clipboard API', async () => {
    expect(await copyText('value', { legacyCopy: () => true })).toBe('legacy')
  })

  test('asks for a manual copy when both methods fail', async () => {
    const outcome = await copyText('value', {
      writeText: async () => {
        throw new Error('blocked')
      },
      legacyCopy: () => false,
    })
    expect(outcome).toBe('manual')
  })
})

describe('full URLs', () => {
  test('keeps URLs that already have a scheme', () => {
    expect(fullUrl('https://s.example/abc')).toBe('https://s.example/abc')
    expect(fullUrl('http://127.0.0.1:8000/abc')).toBe('http://127.0.0.1:8000/abc')
  })

  test('adds https:// to display-form short links', () => {
    expect(fullUrl('s.example/abc')).toBe('https://s.example/abc')
    expect(fullUrl(' s.example/abc+ ')).toBe('https://s.example/abc+')
  })

  test('leaves empty values empty', () => {
    expect(fullUrl('')).toBe('')
  })
})
