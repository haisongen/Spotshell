import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { nextListboxIndex } from '../listboxNavigation'

interface ListboxNavigation<T extends HTMLElement> {
  listRef: RefObject<T>
  onKeyDown: (event: ReactKeyboardEvent<T>) => void
}

/**
 * Arrow/Home/End focus movement for a roving-tabindex listbox whose options are
 * buttons carrying role="option". Movement only changes focus; Enter and Space
 * still select through the button's own click handler.
 */
export function useListboxNavigation<T extends HTMLElement>(): ListboxNavigation<T> {
  const listRef = useRef<T>(null)

  const onKeyDown = useCallback((event: ReactKeyboardEvent<T>): void => {
    const list = listRef.current
    if (!list) return
    const options = Array.from(
      list.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')
    )
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    const target = nextListboxIndex(event.key, current, options.length)
    if (target === null) return
    event.preventDefault()
    options[target]?.focus()
  }, [])

  return { listRef, onKeyDown }
}
