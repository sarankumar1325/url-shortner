import { describe, expect, test } from 'bun:test'
import type { ApiProblem } from '../src/api'
import { authProblemText, passwordPasteWarning } from '../src/authFeedback'

function problem(overrides: Partial<ApiProblem>): ApiProblem {
  return { kind: 'http', code: 'x', detail: 'Server detail.', errors: [], ...overrides }
}

describe('sign-in feedback', () => {
  test('tells offline apart from an unreachable server', () => {
    expect(authProblemText(problem({ kind: 'network' }), 0, false)).toMatch(/offline/)
    expect(authProblemText(problem({ kind: 'network' }), 0, true)).toMatch(/Could not reach/)
  })

  test('counts down rate limits', () => {
    expect(authProblemText(problem({ status: 429 }), 12, true)).toBe(
      'Too many attempts. You can try again in 12 seconds.',
    )
    expect(authProblemText(problem({ status: 429 }), 1, true)).toMatch(/in 1 second\./)
    expect(authProblemText(problem({ status: 429 }), 0, true)).toBe('You can try again now.')
  })

  test('blames the server for 5xx errors', () => {
    expect(authProblemText(problem({ status: 503 }), 0, true)).toMatch(/on its side/)
  })

  test('shows the server message for other errors', () => {
    expect(authProblemText(problem({ status: 401, detail: 'Wrong email or password.' }), 0, true)).toBe(
      'Wrong email or password.',
    )
  })

  test('warns about whitespace at the edges of a pasted password', () => {
    expect(passwordPasteWarning('hunter2 ')).toMatch(/ends with a space/)
    expect(passwordPasteWarning('hunter2\n')).toMatch(/line break/)
    expect(passwordPasteWarning(' hunter2')).toMatch(/starts with a space/)
    expect(passwordPasteWarning('hunter 2')).toBeNull()
  })
})
