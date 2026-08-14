import type { SessionSummary } from '../shared/ipc-types'
import type { SessionListState } from './sessionConnectionState'

export interface CloseOtherSessionsSnapshot {
  keepSessionId: string
  keepTitle: string
  closeSessionIds: string[]
}

export function createCloseOtherSessionsSnapshot(
  sessions: readonly SessionSummary[],
  keepSessionId: string
): CloseOtherSessionsSnapshot | null {
  const keep = sessions.find((session) => session.id === keepSessionId)
  if (!keep) return null
  return {
    keepSessionId,
    keepTitle: keep.title,
    closeSessionIds: sessions
      .filter((session) => session.id !== keepSessionId)
      .map((session) => session.id),
  }
}

export function removeSessions(
  state: SessionListState,
  sessionIds: readonly string[],
  preferredActiveSessionId?: string
): SessionListState {
  const removed = new Set(sessionIds)
  if (removed.size === 0) return state
  const firstRemovedIndex = state.sessions.findIndex((session) => removed.has(session.id))
  const sessions = state.sessions.filter((session) => !removed.has(session.id))
  if (sessions.length === state.sessions.length) return state

  if (preferredActiveSessionId && sessions.some((session) => session.id === preferredActiveSessionId)) {
    return { sessions, activeSessionId: preferredActiveSessionId }
  }
  if (state.activeSessionId && !removed.has(state.activeSessionId)) {
    return { sessions, activeSessionId: state.activeSessionId }
  }
  const nextIndex = Math.min(Math.max(firstRemovedIndex, 0), sessions.length - 1)
  return { sessions, activeSessionId: sessions[nextIndex]?.id ?? null }
}
