import type { SessionSummary } from '../shared/ipc-types'

export type HostSessionStatus = SessionSummary['status']

// When a host has several sessions, show the most useful one: a live shell
// beats one still connecting, which beats a failure, which beats a closed one.
const PRIORITY: Record<HostSessionStatus, number> = {
  ready: 3,
  connecting: 2,
  error: 1,
  disconnected: 0,
}

const STATUS_KEYS = {
  ready: 'sessionStatusReady',
  connecting: 'sessionStatusConnecting',
  error: 'sessionStatusError',
  disconnected: 'sessionStatusDisconnected',
} as const satisfies Record<HostSessionStatus, string>

export function hostSessionStatusKey(status: HostSessionStatus): (typeof STATUS_KEYS)[HostSessionStatus] {
  return STATUS_KEYS[status]
}

/** Per saved host, the status of its open sessions (quick connects are skipped). */
export function summarizeHostSessions(
  sessions: ReadonlyArray<Pick<SessionSummary, 'hostId' | 'status'>>,
): ReadonlyMap<string, HostSessionStatus> {
  const byHost = new Map<string, HostSessionStatus>()
  for (const session of sessions) {
    if (!session.hostId) continue
    const current = byHost.get(session.hostId)
    if (current === undefined || PRIORITY[session.status] > PRIORITY[current]) {
      byHost.set(session.hostId, session.status)
    }
  }
  return byHost
}
