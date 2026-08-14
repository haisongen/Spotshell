import assert from 'node:assert/strict'
import test from 'node:test'
import { setSessionActive } from './chatSessionActivity'

test('tracks simultaneous chat runs independently by session', () => {
  const oneBusy = setSessionActive(new Set(), 'one', true)
  const bothBusy = setSessionActive(oneBusy, 'two', true)
  const onlyTwoBusy = setSessionActive(bothBusy, 'one', false)
  assert.deepEqual([...bothBusy], ['one', 'two'])
  assert.deepEqual([...onlyTwoBusy], ['two'])
  assert.deepEqual([...oneBusy], ['one'])
})
