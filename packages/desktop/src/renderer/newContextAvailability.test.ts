import assert from 'node:assert/strict'
import test from 'node:test'
import { getNewContextAvailability } from './newContextAvailability'

test('new context stays available while generation is busy (cancelable)', () => {
  assert.deepEqual(
    getNewContextAvailability({ commandRunning: false }),
    { available: true },
  )
})

test('new context is disabled with an explicit reason while a command runs', () => {
  assert.deepEqual(
    getNewContextAvailability({ commandRunning: true }),
    { available: false, reason: 'running-command' },
  )
})

test('local pending actions also disable the control', () => {
  assert.deepEqual(
    getNewContextAvailability({ commandRunning: false, localPending: true }),
    { available: false, reason: 'local-pending' },
  )
})
