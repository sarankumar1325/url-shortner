import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Search, type LucideIcon } from 'lucide-react'
import {
  flattenSections,
  moveActive,
  searchPalette,
  type PaletteItem,
} from './palette'

export type PaletteCommand = PaletteItem & {
  icon?: LucideIcon
  run: () => void
}

export default function CommandPalette({
  commands,
  onClose,
}: {
  commands: PaletteCommand[]
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const sections = useMemo(() => searchPalette(commands, query), [commands, query])
  const flat = flattenSections(sections)
  const current = flat[Math.min(active, flat.length - 1)]
  const optionId = (item: PaletteItem) => `${listId}-${item.id}`

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.showModal()
    input.current?.focus()
    return () => {
      element?.close()
      previous?.focus()
    }
  }, [])

  useEffect(() => {
    if (!current) return
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' })
  })

  function run(command: PaletteCommand) {
    onClose()
    // Run after the dialog closes so focus lands where the command puts it.
    window.requestAnimationFrame(() => command.run())
  }

  return (
    <dialog
      ref={dialog}
      className="modal palette"
      aria-label="Command palette"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="palette-search">
        <Search size={17} aria-hidden="true" />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current ? optionId(current) : undefined}
          aria-label="Search links, pages and actions"
          placeholder="Search links, pages and actions…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((index) => moveActive(Math.min(index, flat.length - 1), flat.length, event.key))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (current) run(current)
            } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
              event.preventDefault()
              onClose()
            }
          }}
        />
        <kbd>Esc</kbd>
      </div>
      <div id={listId} role="listbox" aria-label="Results" className="palette-results">
        {sections.map((section) => (
          <div
            role="group"
            key={section.group}
            aria-labelledby={`${listId}-group-${section.group}`}
          >
            <div
              role="presentation"
              id={`${listId}-group-${section.group}`}
              className="palette-group"
            >
              {section.group}
            </div>
            {section.items.map((item) => {
              const index = flat.indexOf(item)
              const Icon = item.icon
              const selected = item === current
              return (
                <div
                  role="option"
                  id={optionId(item)}
                  key={item.id}
                  aria-selected={selected}
                  className={`palette-option${selected ? ' active' : ''}`}
                  onPointerMove={() => {
                    if (!selected) setActive(index)
                  }}
                  onClick={() => run(item)}
                >
                  {Icon && <Icon size={16} aria-hidden="true" />}
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {selected && <CornerDownLeft size={14} aria-hidden="true" className="palette-enter" />}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {flat.length === 0 && (
        <p className="palette-empty" role="status">
          Nothing matches “{query.trim()}”. Try a short code, a destination, or a page name.
        </p>
      )}
      <p className="palette-footer" aria-hidden="true">
        <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>Esc</kbd> close</span>
      </p>
    </dialog>
  )
}
