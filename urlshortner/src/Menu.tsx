import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { LoaderCircle, MoreHorizontal, type LucideIcon } from 'lucide-react'
import { edgeIndex, wrapIndex } from './listbox'
import { useAnchoredPanel } from './useAnchoredPanel'

export type MenuItem = {
  id: string
  label: string
  icon?: LucideIcon
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Draw a rule above this item. */
  separated?: boolean
}

export default function Menu({
  label,
  items,
  busy = false,
}: {
  /** Names both the trigger and the menu, e.g. "More actions for abc123". */
  label: string
  items: readonly MenuItem[]
  busy?: boolean
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)
  const menuId = useId()

  const close = useCallback(() => setOpen(false), [])
  useAnchoredPanel(open, trigger, panel, close, { align: 'end' })

  useEffect(() => {
    if (open) buttons.current[focusIndex]?.focus({ preventScroll: true })
  }, [open, focusIndex])

  function show(edge: 'first' | 'last') {
    setFocusIndex(Math.max(0, edgeIndex(items, edge)))
    setOpen(true)
  }

  function dismiss() {
    setOpen(false)
    trigger.current?.focus()
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const key = event.key
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      setFocusIndex(wrapIndex(items, focusIndex, key === 'ArrowDown' ? 1 : -1))
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault()
      setFocusIndex(edgeIndex(items, key === 'Home' ? 'first' : 'last'))
    } else if (key === 'Escape' || key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      dismiss()
    } else if (key.length === 1 && !event.metaKey && !event.ctrlKey) {
      const letter = key.toLowerCase()
      const count = items.length
      for (let offset = 1; offset <= count; offset += 1) {
        const index = (focusIndex + offset) % count
        if (!items[index].disabled && items[index].label.toLowerCase().startsWith(letter)) {
          setFocusIndex(index)
          break
        }
      }
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={() => (open ? setOpen(false) : show('first'))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            show(event.key === 'ArrowDown' ? 'first' : 'last')
          }
        }}
      >
        {busy ? <LoaderCircle size={16} className="spin" /> : <MoreHorizontal size={18} />}
      </button>
      {open && (
        <div
          ref={panel}
          id={menuId}
          popover="manual"
          role="menu"
          aria-label={label}
          className="dropdown-panel menu-panel"
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => {
            const Icon = item.icon
            return (
              <div key={item.id} role="none">
                {item.separated && <div role="separator" className="menu-separator" />}
                <button
                  ref={(element) => {
                    buttons.current[index] = element
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={index === focusIndex ? 0 : -1}
                  className={`menu-item${item.danger ? ' danger' : ''}`}
                  disabled={item.disabled}
                  onFocus={() => setFocusIndex(index)}
                  onClick={() => {
                    dismiss()
                    item.onSelect()
                  }}
                >
                  {Icon && <Icon size={15} aria-hidden="true" />}
                  {item.label}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
