import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../shared/ipc-types'
import { SessionManager } from './SessionManager'

interface NoteProposalHarness {
  requestNoteProposal(
    session: { id: string },
    hostId: string,
    note: string
  ): Promise<string>
}

function createManager(saved: Array<{ hostId: string; note: string }>): SessionManager {
  return new SessionManager(
    () => null,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    (hostId, note) => {
      saved.push({ hostId, note })
      return '已保存到主机档案'
    }
  )
}

test('note proposal emits, saves only after approval, and returns the persistence result', async () => {
  const saved: Array<{ hostId: string; note: string }> = []
  const manager = createManager(saved)
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const pending = (manager as unknown as NoteProposalHarness)
    .requestNoteProposal({ id: 's1' }, 'h1', 'GSS 报错无害')
  const proposal = events[0]
  assert.equal(proposal?.type, 'note_proposal')
  if (proposal?.type !== 'note_proposal') assert.fail('missing note proposal event')
  assert.equal(proposal.sessionId, 's1')
  assert.equal(proposal.epoch, 1)
  assert.equal(proposal.note, 'GSS 报错无害')
  assert.deepEqual(saved, [])

  manager.respondNoteProposal(proposal.requestId, true)
  assert.equal(await pending, '已保存到主机档案')
  assert.deepEqual(saved, [{ hostId: 'h1', note: 'GSS 报错无害' }])
})

test('cancelling chat rejects a pending note proposal without saving', async () => {
  const saved: Array<{ hostId: string; note: string }> = []
  const manager = createManager(saved)
  const pending = (manager as unknown as NoteProposalHarness)
    .requestNoteProposal({ id: 's1' }, 'h1', 'do not save')

  manager.cancelChat('s1')

  assert.equal(await pending, '用户未确认，备注未保存')
  assert.deepEqual(saved, [])
})
