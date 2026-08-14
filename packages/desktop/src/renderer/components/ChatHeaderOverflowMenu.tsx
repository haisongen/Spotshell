import { Check, MoreHorizontal } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { ExecPolicy } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'

interface ChatHeaderOverflowMenuProps {
  policy: ExecPolicy
  policyDisabled: boolean
  hidden: boolean
  onChangePolicy: (policy: ExecPolicy) => void
}

interface MenuPosition {
  left: number
  top: number
}

const VIEWPORT_MARGIN = 8
const MENU_GAP = 4

export function ChatHeaderOverflowMenu({
  policy,
  policyDisabled,
  hidden,
  onChangePolicy,
}: ChatHeaderOverflowMenuProps): JSX.Element {
  const { t } = useTranslation()
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
    const panel = trigger?.closest<HTMLElement>('.chat-panel')
    if (!trigger || !menu || !panel) return

    const triggerRect = trigger.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const minLeft = Math.max(VIEWPORT_MARGIN, panelRect.left + VIEWPORT_MARGIN)
    const maxLeft = Math.min(
      window.innerWidth - menuRect.width - VIEWPORT_MARGIN,
      panelRect.right - menuRect.width - VIEWPORT_MARGIN
    )
    const below = triggerRect.bottom + MENU_GAP
    const top = below + menuRect.height <= window.innerHeight - VIEWPORT_MARGIN
      ? below
      : Math.max(VIEWPORT_MARGIN, triggerRect.top - menuRect.height - MENU_GAP)

    setPosition({
      left: Math.max(minLeft, maxLeft),
      top,
    })
    const focusFrame = requestAnimationFrame(() => {
      menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [open])

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
  }, [open, hidden])

  useEffect(() => {
    if (hidden) setOpen(false)
  }, [hidden])

  const run = (action: () => void): void => {
    close(true)
    action()
  }

  const focusMenuItem = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    )
    if (items.length === 0) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Home') items[0]?.focus()
    else if (event.key === 'End') items.at(-1)?.focus()
    else if (event.key === 'ArrowDown') items[(index + 1 + items.length) % items.length]?.focus()
    else items[(index - 1 + items.length) % items.length]?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="chat-overflow-trigger"
        title={t('moreChatOptions')}
        aria-label={t('moreChatOptions')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          className="chat-header-menu"
          role="menu"
          aria-label={t('moreChatOptions')}
          style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
          onKeyDown={focusMenuItem}
        >
          <div className="chat-header-menu-label">{t('policyLabel')}</div>
          {(['readonly', 'ask', 'auto'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={policy === value}
              disabled={policyDisabled}
              onClick={() => run(() => onChangePolicy(value))}
            >
              <Check
                className={policy === value ? undefined : 'chat-header-menu-check-hidden'}
                size={14}
                aria-hidden="true"
              />
              <span>
                {t(
                  value === 'readonly'
                    ? 'policyReadonly'
                    : value === 'ask'
                      ? 'policyAsk'
                      : 'policyAuto'
                )}
              </span>
            </button>
          ))}
        </div>,
        document.body
      ) : null}
    </>
  )
}
