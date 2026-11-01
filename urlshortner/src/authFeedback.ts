import type { ApiProblem } from './api'

/** The message shown above the sign-in and sign-up forms. */
export function authProblemText(
  problem: ApiProblem,
  waitSeconds: number,
  online: boolean,
): string {
  if (problem.kind === 'network') {
    return online
      ? 'Could not reach Shortly. The server may be restarting; try again in a moment.'
      : 'You appear to be offline. Check your connection and try again.'
  }
  if (problem.kind === 'timeout') {
    return 'Shortly took too long to answer. Try again; your details are still here.'
  }
  if (problem.status === 429) {
    return waitSeconds > 0
      ? `Too many attempts. You can try again in ${waitSeconds} second${waitSeconds === 1 ? '' : 's'}.`
      : 'You can try again now.'
  }
  if (problem.status !== undefined && problem.status >= 500) {
    return 'Shortly had a problem on its side. Nothing is wrong with your details; try again shortly.'
  }
  return problem.detail
}

/**
 * Password managers and notes often add a trailing space or newline to a
 * copied password. Passwords are compared exactly, so call it out.
 */
export function passwordPasteWarning(pasted: string): string | null {
  if (/[\r\n]\s*$/.test(pasted)) return 'The pasted password ends with a line break. Remove it if it is not part of your password.'
  if (/\s$/.test(pasted)) return 'The pasted password ends with a space. Remove it if it is not part of your password.'
  if (/^\s/.test(pasted)) return 'The pasted password starts with a space. Remove it if it is not part of your password.'
  return null
}
