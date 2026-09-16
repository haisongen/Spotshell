import { useCallback, useLayoutEffect, useRef, type UIEvent } from 'react'

interface ScrollMemory<T extends HTMLElement> {
  ref: (node: T | null) => void
  onScroll: (event: UIEvent<T>) => void
}

/**
 * Remembers a scroll container's offset per key so switching detail tabs and
 * coming back lands where the user left off instead of jumping to the top.
 * Positions live for the lifetime of the owning component only.
 */
export function useScrollMemory<T extends HTMLElement>(key: string): ScrollMemory<T> {
  const offsets = useRef(new Map<string, number>())
  const keyRef = useRef(key)
  keyRef.current = key
  const nodeRef = useRef<T | null>(null)

  const ref = useCallback((node: T | null) => {
    nodeRef.current = node
  }, [])

  // Restore after the new panel has been laid out, so scrollTop can actually be set.
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!node) return
    node.scrollTop = offsets.current.get(key) ?? 0
  }, [key])

  const onScroll = useCallback((event: UIEvent<T>) => {
    offsets.current.set(keyRef.current, event.currentTarget.scrollTop)
  }, [])

  return { ref, onScroll }
}
