import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface ContextMenuSurfaceProps {
  x: number
  y: number
  label: string
  returnFocusTo?: HTMLElement | null
  onClose: () => void
  children: ReactNode
}

const VIEWPORT_MARGIN = 8

export function ContextMenuSurface(props: ContextMenuSurfaceProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(props.onClose)
  const returnFocusRef = useRef(props.returnFocusTo)
  const [position, setPosition] = useState({ left: props.x, top: props.y })
  closeRef.current = props.onClose
  returnFocusRef.current = props.returnFocusTo

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(VIEWPORT_MARGIN,
        Math.min(props.x, window.innerWidth - rect.width - VIEWPORT_MARGIN)),
      top: Math.max(VIEWPORT_MARGIN,
        Math.min(props.y, window.innerHeight - rect.height - VIEWPORT_MARGIN)),
    })
    const frame = requestAnimationFrame(() => {
      menu.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [props.x, props.y])

  useEffect(() => {
    const close = (): void => closeRef.current()
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
    }
  }, [])

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)')]
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length
    items[next].focus()
  }

  return (
    <div ref={menuRef} className={'host-context-menu'} role={'menu'} aria-label={props.label}
      style={position} onKeyDown={moveFocus}>
      {props.children}
    </div>
  )
}
