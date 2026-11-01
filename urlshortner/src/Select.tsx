import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { edgeIndex, stepIndex, typeaheadIndex } from './listbox'
import { useAnchoredPanel } from './useAnchoredPanel'

export type SelectOption<T extends string = string> = {
  value: T
  label: string
  /** A second, quieter line in the list; the trigger shows only the label. */
  hint?: string
  /** Options sharing a group sit under one heading; keep groups contiguous. */
  group?: string
  disabled?: boolean
}

export default function Select<T extends string>({
  id,
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: {
  id?: string
  value: T | ''
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  disabled?: boolean
  /** Extra classes on the wrapper: select-sm, select-lg, select-auto. */
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [labelText, setLabelText] = useState<string>()
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`
  const current = options.findIndex((option) => option.value === value)
  const selected = current >= 0 ? options[current] : undefined

  const close = useCallback(() => setOpen(false), [])
  useAnchoredPanel(open, trigger, panel, close, { matchWidth: true })

  useEffect(() => {
    if (open && active >= 0) {
      document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
    }
  })

  function show(index: number) {
    setActive(index >= 0 ? index : edgeIndex(options, 'first'))
    setLabelText(trigger.current?.labels?.[0]?.textContent?.trim() || undefined)
    setOpen(true)
  }

  function choose(index: number) {
    const option = options[index]
    if (!option || option.disabled) return
    setOpen(false)
    trigger.current?.focus()
    if (option.value !== value) onChange(option.value)
  }

  function typeahead(key: string) {
    const now = Date.now()
    const text = now - typed.current.at < 600 ? typed.current.text + key : key
    typed.current = { text, at: now }
    const index = typeaheadIndex(options, text, open ? active : current)
    if (index >= 0) show(index)
    else if (!open) show(current)
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const key = event.key
    const printable = key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
    const typing = Date.now() - typed.current.at < 600 && typed.current.text !== ''
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault()
        show(current >= 0 ? current : edgeIndex(options, key === 'ArrowUp' ? 'last' : 'first'))
      } else if (printable) {
        event.preventDefault()
        typeahead(key)
      }
      return
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      if (event.altKey) choose(active)
      else setActive(stepIndex(options, active, key === 'ArrowDown' ? 1 : -1))
    } else if (key === 'PageDown' || key === 'PageUp') {
      event.preventDefault()
      setActive(stepIndex(options, active, key === 'PageDown' ? 8 : -8))
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault()
      setActive(edgeIndex(options, key === 'Home' ? 'first' : 'last'))
    } else if (key === 'Enter' || (key === ' ' && !typing)) {
      event.preventDefault()
      choose(active)
    } else if (key === 'Escape') {
      // Keep a surrounding dialog open; Esc only closes the list.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    } else if (key === 'Tab') {
      setOpen(false)
    } else if (printable) {
      event.preventDefault()
      typeahead(key)
    }
  }

  return (
    <div className={`select ${className}`.trim()}>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show(current))}
        onKeyDown={onKeyDown}
      >
        <span className={`select-value${selected ? '' : ' placeholder'}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={15} aria-hidden="true" className="select-chevron" />
      </button>
      {open && (
        <div
          ref={panel}
          id={listId}
          popover="manual"
          role="listbox"
          aria-label={ariaLabel ?? (ariaLabelledBy ? undefined : labelText)}
          aria-labelledby={ariaLabel ? undefined : ariaLabelledBy}
          className="dropdown-panel select-panel"
        >
          {options.map((option, index) => {
            const heading =
              option.group && option.group !== options[index - 1]?.group ? option.group : null
            const isSelected = index === current
            return (
              <div key={option.value} role="presentation">
                {heading && (
                  <div role="presentation" className="dropdown-group">
                    {heading}
                  </div>
                )}
                <div
                  id={optionId(index)}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  className={`select-option${index === active ? ' active' : ''}`}
                  onPointerMove={() => {
                    if (!option.disabled && index !== active) setActive(index)
                  }}
                  // Focus stays on the trigger, which owns the keyboard.
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <span className="select-option-text">
                    <span className="select-option-label">{option.label}</span>
                    {option.hint && <span className="select-option-hint">{option.hint}</span>}
                  </span>
                  {isSelected && <Check size={15} aria-hidden="true" className="select-check" />}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
