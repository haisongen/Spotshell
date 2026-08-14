import type { ConnectionErrorKind, SessionSummary } from '../shared/ipc-types'

export type ConnectionErrorTranslationKey =
  | 'connectionErrorNetworkTimeout'
  | 'connectionErrorHandshakeTimeout'
  | 'connectionErrorRefused'
  | 'connectionErrorHostNotFound'
  | 'connectionErrorAuthenticationFailed'
  | 'connectionErrorHostKeyRejected'
  | 'connectionErrorKeyFile'
  | 'connectionErrorReset'
  | 'connectionErrorUnknown'

export function connectionErrorTranslationKey(
  kind: ConnectionErrorKind | undefined
): ConnectionErrorTranslationKey {
  switch (kind) {
    case 'network-timeout':
      return 'connectionErrorNetworkTimeout'
    case 'handshake-timeout':
      return 'connectionErrorHandshakeTimeout'
    case 'connection-refused':
      return 'connectionErrorRefused'
    case 'host-not-found':
      return 'connectionErrorHostNotFound'
    case 'authentication-failed':
      return 'connectionErrorAuthenticationFailed'
    case 'host-key-rejected':
      return 'connectionErrorHostKeyRejected'
    case 'key-file-error':
      return 'connectionErrorKeyFile'
    case 'connection-reset':
      return 'connectionErrorReset'
    default:
      return 'connectionErrorUnknown'
  }
}

export interface SessionListState {
  sessions: SessionSummary[]
  activeSessionId: string | null
}

export function mergeSessionStatus(
  state: SessionListState,
  summary: SessionSummary,
  closedSessionIds: ReadonlySet<string>
): SessionListState {
  if (closedSessionIds.has(summary.id)) return state

  const index = state.sessions.findIndex((session) => session.id === summary.id)
  if (index === -1) {
    return {
      sessions: [...state.sessions, summary],
      activeSessionId:
        summary.status === 'connecting' ? summary.id : (state.activeSessionId ?? summary.id),
    }
  }

  const sessions = state.sessions.slice()
  sessions[index] = summary
  return { ...state, sessions }
}

export function removeSession(state: SessionListState, sessionId: string): SessionListState {
  const index = state.sessions.findIndex((session) => session.id === sessionId)
  if (index === -1) return state

  const sessions = state.sessions.filter((session) => session.id !== sessionId)
  if (state.activeSessionId !== sessionId) return { ...state, sessions }

  const nextIndex = Math.min(index, sessions.length - 1)
  return {
    sessions,
    activeSessionId: nextIndex >= 0 ? (sessions[nextIndex]?.id ?? null) : null,
  }
}
