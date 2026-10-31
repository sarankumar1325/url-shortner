import { useEffect, useState } from 'react'
import { checkAlias, isProblem } from './api'

export type AliasState =
  | { status: 'idle'; message: '' }
  | { status: 'checking' | 'available' | 'unavailable' | 'error'; message: string }

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/
export const ALIAS_CHECK_DELAY_MS = 350

/** Only well-formed aliases are worth a round trip; the form explains the rest. */
export function aliasCheckable(alias: string): boolean {
  return ALIAS_PATTERN.test(alias)
}

export function useAliasAvailability(alias: string): AliasState {
  const [result, setResult] = useState<{ alias: string; state: AliasState } | null>(null)
  const checkable = aliasCheckable(alias)

  useEffect(() => {
    if (!checkable) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const answer = await checkAlias(alias, controller.signal)
        setResult({
          alias,
          state: {
            status: answer.available ? 'available' : 'unavailable',
            message: answer.message,
          },
        })
      } catch (failure) {
        if (isProblem(failure) && failure.problem.kind === 'cancelled') return
        setResult({
          alias,
          state: { status: 'error', message: 'Availability could not be checked right now.' },
        })
      }
    }, ALIAS_CHECK_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [alias, checkable])

  if (!checkable) return { status: 'idle', message: '' }
  if (!result || result.alias !== alias) {
    return { status: 'checking', message: 'Checking availability…' }
  }
  return result.state
}
