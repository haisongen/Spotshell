import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeHostSessions } from './hostSessionStatus'

test('summarizeHostSessions keeps the most useful status per saved host', () => {
  const summary = summarizeHostSessions([
    { hostId: 'a', status: 'error' },
    { hostId: 'a', status: 'ready' },
    { hostId: 'a', status: 'connecting' },
    { hostId: 'b', status: 'disconnected' },
    { hostId: 'b', status: 'error' },
    { hostId: 'c', status: 'connecting' },
    { status: 'ready' },
  ])
  assert.deepEqual([...summary.entries()].sort(), [
    ['a', 'ready'],
    ['b', 'error'],
    ['c', 'connecting'],
  ])
})

test('summarizeHostSessions is empty without saved-host sessions', () => {
  assert.equal(summarizeHostSessions([]).size, 0)
  assert.equal(summarizeHostSessions([{ status: 'ready' }]).size, 0)
})
