import { useEffect, useLayoutEffect, type RefObject } from 'react'
import { placePanel } from './listbox'

/**
 * Show `panel` in the top layer next to `anchor` while `open` is true, keep
 * it placed on scroll and resize, and call `onDismiss` on a press outside
 * both. The top layer means no parent's overflow or a dialog can clip it.
 */
export function useAnchoredPanel(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  { align = 'start', matchWidth = false }: { align?: 'start' | 'end'; matchWidth?: boolean } = {},
) {
  useLayoutEffect(() => {
    const trigger = anchor.current
    const element = panel.current
    if (!open || !trigger || !element) return
    if (typeof element.showPopover === 'function' && !element.matches(':popover-open')) {
      element.showPopover()
    }
    const place = (event?: Event) => {
      if (event && event.target instanceof Node && element.contains(event.target)) return
      const rect = trigger.getBoundingClientRect()
      if (matchWidth) element.style.minWidth = `${rect.width}px`
      const spot = placePanel(
        rect,
        {
          width: element.offsetWidth,
          height: element.scrollHeight + element.offsetHeight - element.clientHeight,
        },
        { width: window.innerWidth, height: window.innerHeight },
        align,
      )
      element.style.top = `${spot.top}px`
      element.style.left = `${spot.left}px`
      element.style.maxHeight = `${spot.maxHeight}px`
      element.dataset.side = spot.side
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, panel, align, matchWidth])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return
      onDismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, anchor, panel, onDismiss])
}
