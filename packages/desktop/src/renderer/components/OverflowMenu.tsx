import { Check, MoreHorizontal } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'

export interface OverflowMenuItem {
  key: string
  label: string
  icon?: ReactNode
  disabled?: boolean
  /** Present (true/false) turns the entry into a radio item with a check column. */
  checked?: boolean
  onSelect: () => void
}

interface OverflowMenuProps {
  /** Accessible name for the trigger and the popup. */
  label: string
  items: OverflowMenuItem[]
  disabled?: boolean
  /** Ancestor selector the popup is kept inside horizontally. */
  boundarySelector: string
  /** Trigger glyph; defaults to the horizontal ellipsis. */
  triggerIcon?: ReactNode
  /** Optional group label rendered above the items. */
  heading?: string
}

interface MenuPosition {
  left: number
  top: number
}

const VIEWPORT_MARGIN = 8
const MENU_GAP = 4

/** Generic "⋯" popup for secondary header actions that should not crowd the row. */
export function OverflowMenu({
  label,
  items,
  disabled = false,
  boundarySelector,
  triggerIcon,
  heading,
}: OverflowMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = (returnFocus: boolean): void => {
    setOpen(false)
    if (returnFocus) {
      requestAnimationFrame(() => {
        const trigger = triggerRef.current
        if (trigger?.isConnected && trigger.offsetParent !== null) trigger.focus()
      })
    }
  }

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return
    const boundary = trigger.closest<HTMLElement>(boundarySelector)

    const triggerRect = trigger.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const boundaryRect = boundary?.getBoundingClientRect()
    // Right-align with the trigger, then clamp into the boundary and the viewport.
    const preferredLeft = triggerRect.right - menuRect.width
    const minLeft = Math.max(
      VIEWPORT_MARGIN,
      (boundaryRect?.left ?? 0) + VIEWPORT_MARGIN
    )
    const maxLeft = Math.min(
      window.innerWidth - menuRect.width - VIEWPORT_MARGIN,
      (boundaryRect?.right ?? window.innerWidth) - menuRect.width - VIEWPORT_MARGIN
    )
    const below = triggerRect.bottom + MENU_GAP
    const top = below + menuRect.height <= window.innerHeight - VIEWPORT_MARGIN
      ? below
      : Math.max(VIEWPORT_MARGIN, triggerRect.top - menuRect.height - MENU_GAP)

    setPosition({
      left: Math.max(minLeft, Math.min(preferredLeft, maxLeft)),
      top,
    })
    const focusFrame = requestAnimationFrame(() => {
      menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [open, boundarySelector])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(true)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    const closeWithoutFocus = (): void => setOpen(false)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', closeWithoutFocus)
    window.addEventListener('scroll', closeWithoutFocus, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', closeWithoutFocus)
      window.removeEventListener('scroll', closeWithoutFocus, true)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const focusMenuItem = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const entries = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    )
    if (entries.length === 0) return
    event.preventDefault()
    const index = entries.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Home') entries[0]?.focus()
    else if (event.key === 'End') entries.at(-1)?.focus()
    else if (event.key === 'ArrowDown') entries[(index + 1 + entries.length) % entries.length]?.focus()
    else entries[(index - 1 + entries.length) % entries.length]?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="chat-overflow-trigger overflow-menu-trigger"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerIcon ?? <MoreHorizontal size={17} aria-hidden="true" />}
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          className="chat-header-menu"
          role="menu"
          aria-label={label}
          style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
          onKeyDown={focusMenuItem}
        >
          {heading ? <div className="chat-header-menu-label">{heading}</div> : null}
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              disabled={item.disabled}
              onClick={() => {
                close(true)
                item.onSelect()
              }}
            >
              {item.checked === undefined ? item.icon : (
                <Check
                  className={item.checked ? undefined : 'chat-header-menu-check-hidden'}
                  size={14}
                  aria-hidden="true"
                />
              )}
              <span>{item.label}</span>
            </button>
          ))}
        </div>,
        document.body
      ) : null}
    </>
  )
}
