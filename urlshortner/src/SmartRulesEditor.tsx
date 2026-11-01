import { useState } from 'react'
import { ArrowDown, ArrowUp, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { isProblem, type RedirectRule } from './api'
import {
  MAX_RULES,
  RULE_DEVICES,
  countryName,
  draftsFromRules,
  emptyRule,
  moveRule,
  parseCountries,
  ruleFieldErrors,
  sameRules,
  toggleDevice,
  validateRules,
  type RuleDraft,
  type RuleErrors,
} from './smartRules'

export default function SmartRulesEditor({
  rules,
  canEdit,
  onSave,
  describeError,
}: {
  rules: RedirectRule[]
  canEdit: boolean
  /** Resolves with the rules the API stored. */
  onSave: (rules: RedirectRule[] | null) => Promise<RedirectRule[]>
  describeError: (error: unknown) => string
}) {
  const [drafts, setDrafts] = useState<RuleDraft[]>(() => draftsFromRules(rules))
  const [errors, setErrors] = useState<Record<string, RuleErrors>>({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const disabled = !canEdit || busy

  function change(id: string, patch: Partial<RuleDraft>, clear: keyof RuleErrors) {
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)),
    )
    if (errors[id]?.[clear] || (clear !== 'url' && errors[id]?.conditions)) {
      const rest = { ...errors[id], [clear]: undefined, conditions: undefined }
      setErrors({ ...errors, [id]: rest })
    }
  }

  async function save() {
    const checked = validateRules(drafts)
    setErrors(checked.errors)
    setFormError('')
    if (!checked.valid) {
      const first = drafts.find((draft) => checked.errors[draft.id])
      if (first) {
        const problem = checked.errors[first.id]
        const field = problem.countries || problem.conditions ? 'countries' : 'url'
        document.getElementById(`${first.id}-${field}`)?.focus()
      }
      return
    }
    setBusy(true)
    try {
      const stored = await onSave(checked.rules.length > 0 ? checked.rules : null)
      setDrafts(draftsFromRules(stored))
    } catch (failure) {
      const mapped = isProblem(failure) ? ruleFieldErrors(drafts, failure.problem.errors) : {}
      if (Object.keys(mapped).length > 0) setErrors(mapped)
      else setFormError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const pending = validateRules(drafts)
  const unchanged = pending.valid && sameRules(pending.rules, rules)

  return (
    <div className="rules-editor">
      {drafts.length === 0 ? (
        <p className="field-hint">
          No rules yet. Everyone goes to the main destination.
        </p>
      ) : (
        <ol className="rule-list">
          {drafts.map((draft, index) => {
            const problem = errors[draft.id] ?? {}
            const countries = parseCountries(draft.countries)
            const names = countries.error
              ? ''
              : countries.codes
                  .map((code) => countryName(code) ?? code)
                  .join(', ')
            return (
              <li className="rule-card" key={draft.id}>
                <div className="rule-head">
                  <strong id={`${draft.id}-title`}>Rule {index + 1}</strong>
                  <div className="rule-tools">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move rule ${index + 1} up`}
                      disabled={disabled || index === 0}
                      onClick={() => setDrafts(moveRule(drafts, index, -1))}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move rule ${index + 1} down`}
                      disabled={disabled || index === drafts.length - 1}
                      onClick={() => setDrafts(moveRule(drafts, index, 1))}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove rule ${index + 1}`}
                      disabled={disabled}
                      onClick={() =>
                        setDrafts(drafts.filter((item) => item.id !== draft.id))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <fieldset
                  className="rule-devices"
                  aria-describedby={problem.conditions ? `${draft.id}-conditions` : undefined}
                >
                  <legend>Devices</legend>
                  {RULE_DEVICES.map((device) => (
                    <label className="device-chip" key={device.value}>
                      <input
                        type="checkbox"
                        checked={draft.devices.includes(device.value)}
                        disabled={disabled}
                        onChange={() =>
                          change(
                            draft.id,
                            { devices: toggleDevice(draft.devices, device.value) },
                            'conditions',
                          )
                        }
                      />
                      <span>{device.label}</span>
                    </label>
                  ))}
                </fieldset>
                <label htmlFor={`${draft.id}-countries`}>
                  Countries <span className="meta">(two-letter codes)</span>
                </label>
                <input
                  id={`${draft.id}-countries`}
                  value={draft.countries}
                  onChange={(event) =>
                    change(draft.id, { countries: event.target.value }, 'countries')
                  }
                  placeholder="Any country, or DE, AT, CH"
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={disabled}
                  aria-invalid={Boolean(problem.countries)}
                  aria-describedby={`${draft.id}-countries-hint`}
                />
                <p
                  id={`${draft.id}-countries-hint`}
                  className={problem.countries ? 'field-error' : 'field-hint'}
                >
                  {problem.countries || names || 'Leave empty to match every country.'}
                </p>
                {problem.conditions && (
                  <p className="field-error" id={`${draft.id}-conditions`}>
                    {problem.conditions}
                  </p>
                )}
                <label htmlFor={`${draft.id}-url`}>Send these visitors to</label>
                <input
                  id={`${draft.id}-url`}
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={draft.url}
                  onChange={(event) => change(draft.id, { url: event.target.value }, 'url')}
                  placeholder="https://apps.apple.com/…"
                  disabled={disabled}
                  aria-invalid={Boolean(problem.url)}
                  aria-describedby={problem.url ? `${draft.id}-url-error` : undefined}
                />
                {problem.url && (
                  <p className="field-error" id={`${draft.id}-url-error`}>
                    {problem.url}
                  </p>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {formError && (
        <p className="field-error" role="alert">
          {formError}
        </p>
      )}
      <div className="rule-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => setDrafts([...drafts, emptyRule()])}
          disabled={disabled || drafts.length >= MAX_RULES}
        >
          <Plus size={14} /> Add rule
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void save()}
          disabled={disabled || unchanged}
        >
          {busy ? <LoaderCircle size={14} className="spin" /> : null}
          Save rules
        </button>
      </div>
      <p className="field-hint">
        Rules are checked from top to bottom and the first match wins. Within a
        rule, every condition you set must match. Up to {MAX_RULES} rules.
      </p>
    </div>
  )
}
