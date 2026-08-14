import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionSummary } from '../shared/ipc-types'
import {
  createCloseOtherSessionsSnapshot,
  removeSessions,
} from './sessionTabActions'

function session(id: string, title = id): SessionSummary {
  return { id, title, status: 'ready', policy: 'ask' }
}

test('createCloseOtherSessionsSnapshot captures only current other ids', () => {
  assert.deepEqual(createCloseOtherSessionsSnapshot(
    [session('a'), session('b', 'Keep'), session('c')],
    'b'
  ), {
    keepSessionId: 'b',
    keepTitle: 'Keep',
    closeSessionIds: ['a', 'c'],
  })
  assert.equal(createCloseOtherSessionsSnapshot([session('a')], 'missing'), null)
})

test('removeSessions preserves a retained active session and deduplicates ids', () => {
  assert.deepEqual(removeSessions({
    sessions: [session('a'), session('b'), session('c')],
    activeSessionId: 'b',
  }, ['a', 'a', 'c']), {
    sessions: [session('b')],
    activeSessionId: 'b',
  })
})

test('removeSessions falls back to the neighboring tab when active is removed', () => {
  assert.equal(removeSessions({
    sessions: [session('a'), session('b'), session('c')],
    activeSessionId: 'b',
  }, ['b']).activeSessionId, 'c')
  assert.equal(removeSessions({
    sessions: [session('a'), session('b')],
    activeSessionId: 'b',
  }, ['b']).activeSessionId, 'a')
  assert.equal(removeSessions({ sessions: [session('a')], activeSessionId: 'a' }, ['a']).activeSessionId, null)
})
