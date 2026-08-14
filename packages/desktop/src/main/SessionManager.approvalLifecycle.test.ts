import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../shared/ipc-types'
import { PendingConfirms } from './PendingConfirms'
import { SessionManager } from './SessionManager'

interface ApprovalHarness {
  confirms: PendingConfirms
  requestConfirm(sessionId: string, command: string, risk: 'write'): Promise<boolean>
}

function createManager(): SessionManager {
  return new SessionManager(
    () => null,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    () => 'saved'
  )
}

test('approval timeout emits expired and rejects a stale response', async () => {
  const manager = createManager()
  const harness = manager as unknown as ApprovalHarness
  harness.confirms = new PendingConfirms(5)
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const pending = harness.requestConfirm('s1', 'touch /tmp/x', 'write')
  const required = events.find((event) => event.type === 'confirm_required')
  if (!required || required.type !== 'confirm_required') assert.fail('missing confirmation request')
  assert.equal(await pending, false)
  assert.deepEqual(manager.respondConfirm(required.requestId, true), {
    accepted: false, status: 'expired',
  })
  assert.ok(events.some((event) =>
    event.type === 'approval_resolved' &&
    event.requestId === required.requestId &&
    event.status === 'expired'
  ))
})

test('an accepted response emits the exact approved terminal state', async () => {
  const manager = createManager()
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))
  const pending = (manager as unknown as ApprovalHarness)
    .requestConfirm('s2', 'touch /tmp/y', 'write')
  const required = events.find((event) => event.type === 'confirm_required')
  if (!required || required.type !== 'confirm_required') assert.fail('missing confirmation request')
  assert.deepEqual(manager.respondConfirm(required.requestId, true), {
    accepted: true, status: 'approved',
  })
  assert.equal(await pending, true)
  assert.ok(events.some((event) =>
    event.type === 'approval_resolved' && event.requestId === required.requestId && event.status === 'approved'
  ))
})

test('cancelling a session emits cancelled for its unresolved approval', async () => {
  const manager = createManager()
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))
  const pending = (manager as unknown as ApprovalHarness)
    .requestConfirm('s3', 'touch /tmp/z', 'write')
  const required = events.find((event) => event.type === 'confirm_required')
  if (!required || required.type !== 'confirm_required') assert.fail('missing confirmation request')
  manager.cancelChat('s3')
  assert.equal(await pending, false)
  assert.ok(events.some((event) =>
    event.type === 'approval_resolved' && event.requestId === required.requestId && event.status === 'cancelled'
  ))
})
