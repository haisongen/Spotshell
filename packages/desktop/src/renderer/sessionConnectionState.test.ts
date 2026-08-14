import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionSummary } from '../shared/ipc-types'
import {
  connectionErrorTranslationKey,
  mergeSessionStatus,
  removeSession,
} from './sessionConnectionState'

function session(id: string, status: SessionSummary['status']): SessionSummary {
  return { id, title: id, status, policy: 'ask' }
}

test('a new connecting session is added and activated immediately', () => {
  const existing = session('existing', 'ready')
  const connecting = session('new', 'connecting')

  const next = mergeSessionStatus(
    { sessions: [existing], activeSessionId: existing.id },
    connecting,
    new Set()
  )

  assert.deepEqual(next.sessions, [existing, connecting])
  assert.equal(next.activeSessionId, connecting.id)
})

test('closing the active session selects the neighbor that replaces it', () => {
  const first = session('first', 'ready')
  const closing = session('closing', 'error')
  const last = session('last', 'ready')

  const next = removeSession(
    { sessions: [first, closing, last], activeSessionId: closing.id },
    closing.id
  )

  assert.deepEqual(next.sessions, [first, last])
  assert.equal(next.activeSessionId, last.id)
})

test('a late status cannot recreate a locally closed session', () => {
  const remaining = session('remaining', 'ready')
  const state = { sessions: [remaining], activeSessionId: remaining.id }

  const next = mergeSessionStatus(state, session('closed', 'error'), new Set(['closed']))

  assert.strictEqual(next, state)
})

test('connection error kinds select stable friendly copy', () => {
  assert.equal(connectionErrorTranslationKey('network-timeout'), 'connectionErrorNetworkTimeout')
  assert.equal(
    connectionErrorTranslationKey('handshake-timeout'),
    'connectionErrorHandshakeTimeout'
  )
  assert.equal(
    connectionErrorTranslationKey('authentication-failed'),
    'connectionErrorAuthenticationFailed'
  )
  assert.equal(connectionErrorTranslationKey(undefined), 'connectionErrorUnknown')
})
