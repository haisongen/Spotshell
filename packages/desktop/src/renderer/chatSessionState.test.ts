import assert from 'node:assert/strict'
import test from 'node:test'
import { setSessionValue } from './chatSessionState'

test('late status and error updates remain scoped to their originating session', () => {
  let statuses = setSessionValue({}, 'session-b', 'thinking')
  statuses = setSessionValue(statuses, 'session-a', 'running tool')
  assert.equal(statuses['session-b'], 'thinking')
  assert.equal(statuses['session-a'], 'running tool')

  let errors = setSessionValue({}, 'session-b', 'B error')
  errors = setSessionValue(errors, 'session-a', 'late A error')
  assert.equal(errors['session-b'], 'B error')
  assert.equal(errors['session-a'], 'late A error')
})
