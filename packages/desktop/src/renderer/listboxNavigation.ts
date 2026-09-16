/**
 * Roving-tabindex focus target for a key press inside a listbox, or null when the
 * key is not a navigation key. Focus wraps at both ends; a currentIndex of -1
 * means nothing in the list is focused yet.
 */
export function nextListboxIndex(
  key: string,
  currentIndex: number,
  count: number
): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return currentIndex < 0 ? 0 : (currentIndex + 1) % count
    case 'ArrowUp':
      return currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/**
 * Which row carries tabIndex=0 so a single Tab lands on the selected row instead
 * of walking the whole list. Falls back to the first row when the selection is
 * absent or filtered out.
 */
export function activeOptionIndex(
  ids: readonly string[],
  selectedId: string | null
): number {
  if (ids.length === 0) return -1
  const index = selectedId === null ? -1 : ids.indexOf(selectedId)
  return index >= 0 ? index : 0
}
