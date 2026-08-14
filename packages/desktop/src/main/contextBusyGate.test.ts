import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessNewContextGate,
  isLateEpochEvent,
  RUNNING_COMMAND_BLOCKS_NEW_CONTEXT,
} from './contextBusyGate'

test('new context is allowed when no remote command is running', () => {
  assert.deepEqual(
    assessNewContextGate({ terminalCommandRunning: false, agentCommandRunning: false }),
    { allowed: true },
  )
})

test('user-terminal command blocks immediate new context with an explicit reason', () => {
  assert.deepEqual(
    assessNewContextGate({ terminalCommandRunning: true, agentCommandRunning: false }),
    {
      allowed: false,
      reason: 'running-command',
      message: RUNNING_COMMAND_BLOCKS_NEW_CONTEXT,
    },
  )
})

test('agent SSH exec in flight blocks immediate new context', () => {
  const result = assessNewContextGate({
    terminalCommandRunning: false,
    agentCommandRunning: true,
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) {
    assert.equal(result.reason, 'running-command')
    assert.match(result.message, /command is running/i)
  }
})

test('late events are those whose epoch no longer matches the current segment', () => {
  assert.equal(isLateEpochEvent(1, 1), false)
  assert.equal(isLateEpochEvent(1, 2), true)
  assert.equal(isLateEpochEvent(2, 1), true)
})
