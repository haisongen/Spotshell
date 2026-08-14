import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectRequest, SessionSummary } from '../../shared/ipc-types'
import {
  mergeSessionStatus,
  removeSession,
  type SessionListState,
} from '../sessionConnectionState'
import { removeSessions } from '../sessionTabActions'

const emptyState: SessionListState = { sessions: [], activeSessionId: null }

export function useSessions(): {
  sessions: SessionSummary[]
  activeSessionId: string | null
  setActiveSessionId: (id: string | null) => void
  connect: (req: ConnectRequest) => Promise<SessionSummary>
  reconnect: (sessionId: string) => Promise<SessionSummary>
  close: (sessionId: string) => Promise<void>
  rename: (sessionId: string, title: string) => Promise<SessionSummary>
  duplicate: (sessionId: string, title: string) => Promise<SessionSummary>
  closeMany: (sessionIds: readonly string[], keepSessionId?: string) => Promise<void>
  cycleActive: (direction: 1 | -1) => void
  reconnectingSessionIds: ReadonlySet<string>
  error: string | null
  clearError: () => void
} {
  const [state, setState] = useState<SessionListState>(emptyState)
  const [reconnectingSessionIds, setReconnectingSessionIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const closedSessionIdsRef = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    const list = await window.spotshell.listSessions()
    setState((current) => {
      const listedIds = new Set(list.map((session) => session.id))
      const sessions = [
        ...list,
        ...current.sessions.filter((session) => !listedIds.has(session.id)),
      ].filter((session) => !closedSessionIdsRef.current.has(session.id))
      const activeStillExists = sessions.some(
        (session) => session.id === current.activeSessionId
      )
      return {
        sessions,
        activeSessionId: activeStillExists
          ? current.activeSessionId
          : (sessions[0]?.id ?? null),
      }
    })
    return list
  }, [])

  useEffect(() => {
    let cancelled = false

    refresh().catch((err: unknown) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
    })

    const offStatus = window.spotshell.onSessionStatus((summary) => {
      setState((current) =>
        mergeSessionStatus(current, summary, closedSessionIdsRef.current)
      )
      if (summary.status !== 'connecting') {
        setReconnectingSessionIds((current) => {
          if (!current.has(summary.id)) return current
          const next = new Set(current)
          next.delete(summary.id)
          return next
        })
      }
    })

    return () => {
      cancelled = true
      offStatus()
    }
  }, [refresh])

  const connect = useCallback(async (req: ConnectRequest): Promise<SessionSummary> => {
    setError(null)
    try {
      const summary = await window.spotshell.connectSession(req)
      setState((current) =>
        mergeSessionStatus(current, summary, closedSessionIdsRef.current)
      )
      return summary
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      throw err instanceof Error ? err : new Error(message)
    }
  }, [])

  const reconnect = useCallback(async (sessionId: string): Promise<SessionSummary> => {
    setError(null)
    setReconnectingSessionIds((current) => new Set(current).add(sessionId))
    try {
      const summary = await window.spotshell.reconnectSession(sessionId)
      setState((current) => ({
        ...mergeSessionStatus(current, summary, closedSessionIdsRef.current),
        activeSessionId: summary.id,
      }))
      if (summary.status !== 'connecting') {
        setReconnectingSessionIds((current) => {
          const next = new Set(current)
          next.delete(sessionId)
          return next
        })
      }
      return summary
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setReconnectingSessionIds((current) => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
      throw err instanceof Error ? err : new Error(message)
    }
  }, [])

  const close = useCallback(
    async (sessionId: string): Promise<void> => {
      setError(null)
      closedSessionIdsRef.current.add(sessionId)
      setReconnectingSessionIds((current) => {
        if (!current.has(sessionId)) return current
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
      setState((current) => removeSession(current, sessionId))
      try {
        await window.spotshell.closeSession(sessionId)
      } catch (err: unknown) {
        closedSessionIdsRef.current.delete(sessionId)
        await refresh().catch(() => undefined)
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        throw err instanceof Error ? err : new Error(message)
      }
    },
    [refresh]
  )

  const rename = useCallback(async (sessionId: string, title: string): Promise<SessionSummary> => {
    setError(null)
    try {
      const summary = await window.spotshell.renameSession({ sessionId, title })
      setState((current) => mergeSessionStatus(current, summary, closedSessionIdsRef.current))
      return summary
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw err instanceof Error ? err : new Error(message)
    }
  }, [])

  const duplicate = useCallback(async (sessionId: string, title: string): Promise<SessionSummary> => {
    setError(null)
    try {
      const summary = await window.spotshell.duplicateSession({ sessionId, title })
      setState((current) => ({
        ...mergeSessionStatus(current, summary, closedSessionIdsRef.current),
        activeSessionId: summary.id,
      }))
      return summary
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw err instanceof Error ? err : new Error(message)
    }
  }, [])

  const closeMany = useCallback(async (
    sessionIds: readonly string[],
    keepSessionId?: string
  ): Promise<void> => {
    const ids = [...new Set(sessionIds)]
    if (ids.length === 0) return
    setError(null)
    for (const id of ids) closedSessionIdsRef.current.add(id)
    setReconnectingSessionIds((current) => {
      const next = new Set(current)
      for (const id of ids) next.delete(id)
      return next
    })
    setState((current) => removeSessions(current, ids, keepSessionId))
    try {
      await window.spotshell.closeSessions({ sessionIds: ids })
    } catch (err: unknown) {
      for (const id of ids) closedSessionIdsRef.current.delete(id)
      await refresh().catch(() => undefined)
      const message = err instanceof Error ? err.message : String(err)
      throw err instanceof Error ? err : new Error(message)
    }
  }, [refresh])

  const cycleActive = useCallback((direction: 1 | -1) => {
    setState((current) => {
      if (current.sessions.length === 0) return current
      const index = current.sessions.findIndex(
        (session) => session.id === current.activeSessionId
      )
      const base = index >= 0 ? index : 0
      const next = (base + direction + current.sessions.length) % current.sessions.length
      return { ...current, activeSessionId: current.sessions[next]!.id }
    })
  }, [])

  return {
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
    setActiveSessionId: (activeSessionId) =>
      setState((current) => ({ ...current, activeSessionId })),
    connect,
    reconnect,
    close,
    rename,
    duplicate,
    closeMany,
    cycleActive,
    reconnectingSessionIds,
    error,
    clearError: () => setError(null),
  }
}
