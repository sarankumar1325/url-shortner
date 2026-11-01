import { describe, expect, test } from 'bun:test'
import { createLink, type LinkMetadata } from '../src/api'
import {
  applyMetadata,
  linkPasswordError,
  linksCsv,
  parseLinkCsv,
  recordFromMetadata,
} from '../src/links'

const metadata: LinkMetadata = {
  short_code: 'locked1',
  short_url: 'https://short.example/locked1',
  long_url: 'https://example.com/secret',
  is_custom_alias: false,
  is_active: true,
  expires_at: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  tags: [],
  has_password: true,
}

describe('link passwords', () => {
  test('match the API length rules without trimming', () => {
    expect(linkPasswordError('')).toContain('Enter a password')
    expect(linkPasswordError('abc')).toBe('Use 4–128 characters.')
    expect(linkPasswordError('    ')).toBeNull()
    expect(linkPasswordError('x'.repeat(128))).toBeNull()
    expect(linkPasswordError('x'.repeat(129))).toBe('Use 4–128 characters.')
    // Emoji count as one character each, like Python's len(), not two UTF-16 units.
    expect(linkPasswordError('🔒🔒')).toBe('Use 4–128 characters.')
    expect(linkPasswordError('🔒'.repeat(100))).toBeNull()
  })

  test('track whether a link is protected', () => {
    const record = recordFromMetadata(metadata)
    expect(record.hasPassword).toBe(true)
    expect(recordFromMetadata({ ...metadata, has_password: undefined }).hasPassword).toBe(false)
    expect(applyMetadata(record, { ...metadata, has_password: false }).hasPassword).toBe(false)
    expect(applyMetadata(record, { ...metadata, has_password: undefined }).hasPassword).toBe(true)
  })

  test('export a has_password column', () => {
    const csv = linksCsv([recordFromMetadata(metadata)]).split('\r\n')
    expect(csv[0]).toEndWith(',has_password')
    expect(csv[1]).toEndWith(',yes')
  })

  test('send a password only when one is set', async () => {
    const bodies: unknown[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(metadata), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const signal = new AbortController().signal
      await createLink({ long_url: 'https://example.com/', password: null }, '00000000-0000-4000-8000-000000000010', 'ws', signal)
      await createLink({ long_url: 'https://example.com/', password: '' }, '00000000-0000-4000-8000-000000000011', 'ws', signal)
      await createLink({ long_url: 'https://example.com/', password: 'open sesame' }, '00000000-0000-4000-8000-000000000012', 'ws', signal)
    } finally {
      globalThis.fetch = original
    }
    expect(bodies[0]).toEqual({ long_url: 'https://example.com/' })
    expect(bodies[1]).toEqual({ long_url: 'https://example.com/' })
    expect(bodies[2]).toEqual({ long_url: 'https://example.com/', password: 'open sesame' })
  })
})

describe('importing protected links', () => {
  const now = new Date('2026-03-10T12:00:00Z')

  test('reads a password column by header or position', () => {
    const byHeader = parseLinkCsv('long_url,password\nhttps://example.com/a,letmein\nhttps://example.com/b,', [], now)
    expect(byHeader.rows.map((row) => row.password)).toEqual(['letmein', null])
    expect(byHeader.rows.every((row) => row.valid)).toBe(true)
    const byPosition = parseLinkCsv('https://example.com/a,,,,,,letmein', [], now)
    expect(byPosition.rows[0]).toMatchObject({ valid: true, password: 'letmein' })
  })

  test('flags a short password on that row only', () => {
    const { rows } = parseLinkCsv('long_url,password\nhttps://example.com/a,abc\nhttps://example.com/b,abcd', [], now)
    expect(rows.map((row) => row.valid)).toEqual([false, true])
    expect(rows[0].errors).toEqual(['Password: Use 4–128 characters.'])
  })
})
