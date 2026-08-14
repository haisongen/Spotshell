export function setSessionActive(
  sessions: ReadonlySet<string>,
  sessionId: string,
  active: boolean
): Set<string> {
  const next = new Set(sessions)
  if (active) next.add(sessionId)
  else next.delete(sessionId)
  return next
}
