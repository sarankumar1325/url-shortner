import type { RedirectRule, RuleDevice } from './api'
import { normalizeDestination, titleFor, validateDraft } from './links'

export const MAX_RULES = 10
export const MAX_RULE_COUNTRIES = 50

export const RULE_DEVICES: readonly { value: RuleDevice; label: string }[] = [
  { value: 'ios', label: 'iPhone and iPad' },
  { value: 'android', label: 'Android' },
  { value: 'mobile', label: 'Any phone' },
  { value: 'tablet', label: 'Any tablet' },
  { value: 'desktop', label: 'Desktop' },
]

/** One rule as the editor holds it; countries stay as typed until saved. */
export type RuleDraft = {
  id: string
  devices: RuleDevice[]
  countries: string
  url: string
}

export type RuleErrors = { conditions?: string; countries?: string; url?: string }

let nextId = 0
function draftId(): string {
  nextId += 1
  return `rule-${nextId}`
}

export function emptyRule(): RuleDraft {
  return { id: draftId(), devices: [], countries: '', url: '' }
}

export function draftsFromRules(rules: readonly RedirectRule[]): RuleDraft[] {
  return rules.map((rule) => ({
    id: draftId(),
    devices: [...(rule.devices ?? [])],
    countries: (rule.countries ?? []).join(', '),
    url: rule.url,
  }))
}

export function toggleDevice(devices: readonly RuleDevice[], device: RuleDevice): RuleDevice[] {
  const next = devices.includes(device)
    ? devices.filter((item) => item !== device)
    : [...devices, device]
  // Keep the order the API stores, so an unchanged rule compares equal.
  return RULE_DEVICES.map((item) => item.value).filter((value) => next.includes(value))
}

export function moveRule<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta
  if (target < 0 || target >= items.length) return [...items]
  const next = [...items]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

/** "de, AT fr" -> ["AT", "DE", "FR"]; anything but two letters is an error. */
export function parseCountries(input: string): { codes: string[]; error: string | null } {
  const parts = input
    .split(/[\s,;]+/)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean)
  const bad = parts.find((part) => !/^[A-Z]{2}$/.test(part))
  if (bad) return { codes: [], error: `“${bad}” is not a two-letter country code, like DE or US.` }
  const codes = [...new Set(parts)].sort()
  if (codes.length > MAX_RULE_COUNTRIES)
    return { codes: [], error: `Use at most ${MAX_RULE_COUNTRIES} countries.` }
  return { codes, error: null }
}

let regionNames: Intl.DisplayNames | null | undefined
export function countryName(code: string): string | null {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' })
    } catch {
      regionNames = null
    }
  }
  try {
    return regionNames?.of(code) ?? null
  } catch {
    return null
  }
}

export function validateRules(drafts: readonly RuleDraft[]): {
  rules: RedirectRule[]
  errors: Record<string, RuleErrors>
  valid: boolean
} {
  const rules: RedirectRule[] = []
  const errors: Record<string, RuleErrors> = {}
  if (drafts.length > MAX_RULES) {
    const last = drafts[drafts.length - 1]
    errors[last.id] = { conditions: `Use at most ${MAX_RULES} rules.` }
  }
  for (const draft of drafts) {
    const problem: RuleErrors = { ...errors[draft.id] }
    const countries = parseCountries(draft.countries)
    if (countries.error) problem.countries = countries.error
    else if (draft.devices.length === 0 && countries.codes.length === 0)
      problem.conditions = 'Choose at least one device or country.'
    const url = normalizeDestination(draft.url)
    const urlError = url
      ? validateDraft(url, '', '', []).destination
      : 'Add the URL these visitors should go to.'
    if (urlError) problem.url = urlError
    if (Object.keys(problem).length > 0) errors[draft.id] = problem
    const rule: RedirectRule = { url }
    if (draft.devices.length > 0) rule.devices = [...draft.devices]
    if (countries.codes.length > 0) rule.countries = countries.codes
    rules.push(rule)
  }
  const valid = Object.keys(errors).length === 0
  return { rules: valid ? rules : [], errors, valid }
}

/** Map API issues such as redirect_rules.2.url back to the rule they belong to. */
export function ruleFieldErrors(
  drafts: readonly RuleDraft[],
  issues: readonly { field: string; message: string }[],
): Record<string, RuleErrors> {
  const mapped: Record<string, RuleErrors> = {}
  for (const issue of issues) {
    const match = /^redirect_rules\.(\d+)(?:\.(devices|countries|url))?$/.exec(issue.field)
    const draft = match ? drafts[Number(match[1])] : undefined
    if (!match || !draft) continue
    const key = match[2] === 'url' ? 'url' : match[2] === 'countries' ? 'countries' : 'conditions'
    mapped[draft.id] = { ...mapped[draft.id], [key]: issue.message }
  }
  return mapped
}

export function sameRules(a: readonly RedirectRule[], b: readonly RedirectRule[]): boolean {
  // Postgres JSONB does not keep key order, so compare a fixed shape.
  const shape = (rules: readonly RedirectRule[]) =>
    JSON.stringify(rules.map((rule) => [rule.url, rule.devices ?? [], rule.countries ?? []]))
  return shape(a) === shape(b)
}

export function ruleSummary(rule: RedirectRule): string {
  const devices = (rule.devices ?? []).map(
    (device) => RULE_DEVICES.find((item) => item.value === device)?.label ?? device,
  )
  const conditions = [devices.join(' or '), (rule.countries ?? []).join(', ')].filter(Boolean)
  return `${conditions.join(' in ')} → ${titleFor(rule.url)}`
}
