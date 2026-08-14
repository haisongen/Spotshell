import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendApproval,
  applyApprovalResponse,
  closeSessionApprovals,
  countPendingApprovals,
  isApprovalItem,
  markKnowledgeTargetChoice,
  resolveApproval,
  type ApprovalItem,
} from './chatApprovals'

const command: ApprovalItem = {
  id: 'card-command', kind: 'command-approval', requestId: 'request-command', sessionId: 'one',
  command: 'rm -rf /tmp/example', risk: 'destructive', status: 'pending',
}
const note: ApprovalItem = {
  id: 'card-note', kind: 'note-approval', requestId: 'request-note', sessionId: 'two',
  note: 'Kerberos is enabled', status: 'pending',
}

const target: ApprovalItem = {
  id: 'card-target', kind: 'knowledge-target', requestId: 'request-target', sessionId: 'one',
  question: '写到哪里？', status: 'pending',
  candidates: [
    { kind: 'environment', targetId: 'env-1', label: 'CDH 生产', reason: '环境事实' },
    { kind: 'knowledge', targetId: 'mod-1', label: 'HDFS 排障', reason: '可复用' },
  ],
}

test('a knowledge-target card is a first-class approval and closes with the session', () => {
  const state = appendApproval({}, target)
  assert.equal(isApprovalItem(target), true)
  assert.equal(countPendingApprovals(state), 1)
  const closed = closeSessionApprovals(state, 'one', 'cancelled')
  assert.equal((closed.one?.[0] as ApprovalItem).status, 'cancelled')
  assert.equal(countPendingApprovals(closed), 0)
})

test('marking the chosen landing place leaves other cards untouched', () => {
  const state = appendApproval(appendApproval({}, target), note)
  const chosen = markKnowledgeTargetChoice(state, target.requestId, 1)
  assert.equal((chosen.one?.[0] as typeof target).chosenIndex, 1)
  assert.equal(chosen.two?.[0], note)
  // Declining picks nothing, so there is no index to record.
  assert.equal(markKnowledgeTargetChoice(state, target.requestId, null), state)
  assert.equal(markKnowledgeTargetChoice(state, 'unknown-request', 0), state)
})

test('appends approvals to their sessions and ignores duplicate request ids', () => {
  const first = appendApproval({}, command)
  const second = appendApproval(first, note)
  assert.equal(countPendingApprovals(second), 2)
  assert.equal(second.one?.[0], command)
  assert.equal(second.two?.[0], note)
  assert.equal(appendApproval(second, { ...command, id: 'duplicate' }), second)
})

test('resolves only the matching pending request and duplicate responses are idempotent', () => {
  const state = appendApproval(appendApproval({}, command), note)
  const resolved = resolveApproval(state, command.requestId, 'approved')
  assert.equal((resolved.one?.[0] as ApprovalItem).status, 'approved')
  assert.equal((resolved.two?.[0] as ApprovalItem).status, 'pending')
  assert.equal(resolveApproval(resolved, command.requestId, 'rejected'), resolved)
  assert.equal(countPendingApprovals(resolved), 1)
})

test('cancellation and expiry preserve cards but remove them from the pending count', () => {
  const state = appendApproval(appendApproval({}, command), note)
  const cancelled = closeSessionApprovals(state, 'one', 'cancelled')
  const expired = closeSessionApprovals(cancelled, 'two', 'expired')
  assert.equal((expired.one?.[0] as ApprovalItem).status, 'cancelled')
  assert.equal((expired.two?.[0] as ApprovalItem).status, 'expired')
  assert.equal(countPendingApprovals(expired), 0)
})

test('an explicit request lifecycle event can expire exactly one approval', () => {
  const state = appendApproval(appendApproval({}, command), note)
  const expired = resolveApproval(state, command.requestId, 'expired')
  assert.equal((expired.one?.[0] as ApprovalItem).status, 'expired')
  assert.equal((expired.two?.[0] as ApprovalItem).status, 'pending')
})

test('ack and lifecycle event ordering preserves the authoritative cancelled state', () => {
  const state = appendApproval({}, command)
  const cancelledAck = { accepted: false, status: 'cancelled' as const }
  const eventFirst = applyApprovalResponse(
    resolveApproval(state, command.requestId, 'cancelled'),
    command.requestId,
    cancelledAck
  )
  const ackFirst = resolveApproval(
    applyApprovalResponse(state, command.requestId, cancelledAck),
    command.requestId,
    'cancelled'
  )
  assert.equal((eventFirst.one?.[0] as ApprovalItem).status, 'cancelled')
  assert.equal((ackFirst.one?.[0] as ApprovalItem).status, 'cancelled')
  assert.equal(applyApprovalResponse(state, command.requestId, { accepted: false }), state)
})
