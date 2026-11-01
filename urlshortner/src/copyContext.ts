import { createContext, useContext } from 'react'
import { copyText } from './clipboard'

export type CopyValue = (value: string, message?: string) => Promise<void>

/** Provided by the workspace shell, which owns the toast and the manual-copy dialog. */
export const CopyContext = createContext<CopyValue | null>(null)

async function copyQuietly(value: string): Promise<void> {
  if (value) await copyText(value)
}

export function useCopy(): CopyValue {
  return useContext(CopyContext) ?? copyQuietly
}
