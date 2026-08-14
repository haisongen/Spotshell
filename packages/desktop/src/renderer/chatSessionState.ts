export type SessionValues<T> = Record<string, T>

export function setSessionValue<T>(
  current: SessionValues<T>,
  sessionId: string,
  value: T | null
): SessionValues<T> {
  if (value === null) {
    if (!(sessionId in current)) return current
    const next = { ...current }
    delete next[sessionId]
    return next
  }
  if (current[sessionId] === value) return current
  return { ...current, [sessionId]: value }
}
