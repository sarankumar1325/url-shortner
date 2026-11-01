import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  canShiftMonth,
  clampDay,
  isDay,
  isWithin,
  longDayLabel,
  monthGrid,
  monthOf,
  monthTitle,
  shiftMonth,
  shortDayLabel,
  weekEdge,
  weekdayNames,
} from './calendar'
import { addDays, utcDay } from './ranges'
import { useAnchoredPanel } from './useAnchoredPanel'

const WEEKDAYS = weekdayNames()
const STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

/** A themed UTC date field: a combobox button that opens a month grid. */
export default function DatePicker({
  id,
  value,
  onChange,
  min,
  max,
  placeholder = 'Pick a date',
  clearable = false,
  className = '',
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: {
  id?: string
  /** `YYYY-MM-DD` in UTC, or '' for no date. */
  value: string
  onChange: (value: string) => void
  min?: string
  max?: string
  placeholder?: string
  clearable?: boolean
  className?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const focusGrid = useRef(false)
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState('')
  const [labelText, setLabelText] = useState<string>()
  const titleId = useId()
  const [today] = useState(() => utcDay(new Date()))
  const selected = isDay(value) ? value : ''

  const dismiss = useCallback(() => setOpen(false), [])
  useAnchoredPanel(open, trigger, panel, dismiss)

  // Only pull focus into the grid on open or keyboard moves, so the month
  // buttons keep focus when clicked.
  useEffect(() => {
    if (!open || !focusGrid.current) return
    focusGrid.current = false
    grid.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus({
      preventScroll: true,
    })
  })

  function show() {
    setFocused(clampDay(selected || today, min, max))
    setLabelText(trigger.current?.labels?.[0]?.textContent?.trim() || undefined)
    focusGrid.current = true
    setOpen(true)
  }

  function close() {
    setOpen(false)
    trigger.current?.focus()
  }

  function choose(day: string) {
    if (!isWithin(day, min, max)) return
    close()
    if (day !== value) onChange(day)
  }

  function moveTo(day: string) {
    focusGrid.current = true
    setFocused(clampDay(day, min, max))
  }

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const { key } = event
    if (key in STEPS) moveTo(addDays(focused, STEPS[key]))
    else if (key === 'PageUp' || key === 'PageDown')
      moveTo(shiftMonth(focused, (key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1)))
    else if (key === 'Home' || key === 'End') moveTo(weekEdge(focused, key === 'Home' ? 'start' : 'end'))
    else if (key === 'Enter' || key === ' ') choose(focused)
    else return
    event.preventDefault()
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      // Keep a surrounding dialog open; Esc only closes the calendar.
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Tab' && panel.current) {
      const stops = [
        ...panel.current.querySelectorAll<HTMLButtonElement>(
          'button:not(:disabled):not([tabindex="-1"])',
        ),
      ]
      const index = stops.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.shiftKey
        ? index <= 0
          ? stops.length - 1
          : index - 1
        : index === stops.length - 1
          ? 0
          : index + 1
      event.preventDefault()
      stops[next]?.focus()
    }
  }

  const shown = focused || today
  const { month } = monthOf(shown)
  const weeks = open ? monthGrid(shown) : []

  return (
    <div className={`select date-picker ${className}`.trim()}>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        className="select-trigger date-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid || undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            show()
          }
        }}
      >
        <CalendarDays size={15} aria-hidden="true" className="date-icon" />
        <span className={`select-value${selected ? '' : ' placeholder'}`}>
          {selected ? shortDayLabel(selected) : placeholder}
        </span>
        <ChevronDown size={15} aria-hidden="true" className="select-chevron" />
      </button>
      {open && (
        <div
          ref={panel}
          popover="manual"
          role="dialog"
          aria-label={labelText ? `Choose ${labelText}` : 'Choose a date'}
          className="dropdown-panel date-panel"
          onKeyDown={onPanelKeyDown}
        >
          <div className="date-header">
            <button
              type="button"
              className="date-nav"
              aria-label="Previous month"
              disabled={!canShiftMonth(shown, -1, min, max)}
              onClick={() => setFocused(clampDay(shiftMonth(shown, -1), min, max))}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <span id={titleId} className="date-title" aria-live="polite">
              {monthTitle(shown)}
            </span>
            <button
              type="button"
              className="date-nav"
              aria-label="Next month"
              disabled={!canShiftMonth(shown, 1, min, max)}
              onClick={() => setFocused(clampDay(shiftMonth(shown, 1), min, max))}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
          <div ref={grid} role="grid" aria-labelledby={titleId} className="date-grid" onKeyDown={onGridKeyDown}>
            <div role="row" className="date-row">
              {WEEKDAYS.map((weekday) => (
                <span key={weekday.long} role="columnheader" aria-label={weekday.long} className="date-weekday">
                  <span aria-hidden="true">{weekday.short}</span>
                </span>
              ))}
            </div>
            {weeks.map((week) => (
              <div role="row" className="date-row" key={week[0]}>
                {week.map((day) => {
                  const outside = monthOf(day).month !== month
                  return (
                    <div role="gridcell" key={day} aria-selected={day === selected}>
                      <button
                        type="button"
                        tabIndex={day === shown ? 0 : -1}
                        className={`date-day${outside ? ' outside' : ''}`}
                        aria-label={longDayLabel(day)}
                        aria-current={day === today ? 'date' : undefined}
                        disabled={!isWithin(day, min, max)}
                        onClick={() => choose(day)}
                      >
                        {Number(day.slice(8, 10))}
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="date-footer">
            <button
              type="button"
              className="text-button"
              disabled={!isWithin(today, min, max)}
              onClick={() => choose(today)}
            >
              Today
            </button>
            {clearable && selected && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  close()
                  onChange('')
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
