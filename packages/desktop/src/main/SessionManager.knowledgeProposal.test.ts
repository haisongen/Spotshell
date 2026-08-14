import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import type { AgentEvent, KnowledgeChangeProposalPayload } from '../shared/ipc-types'
import { SessionManager, type SessionKnowledgeAccess } from './SessionManager'

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface KnowledgeProposalHarness {
  requestKnowledgeProposal(
    session: {
      id: string
      hostId?: string
      environmentId?: string
      activeRevisions: Map<string, never>
      knowledgeHarness: null
    },
    request: {
      targetKind: 'host-notes' | 'environment' | 'knowledge'
      targetId: string
      reason: string
      terminalEvidence?: string
      files: Array<{ relativePath: string; after: string }>
    },
  ): Promise<string>
}

function createManager(options: {
  notes?: string
  knowledgeAccess?: SessionKnowledgeAccess
  savedNotes?: Array<{ hostId: string; notes: string }>
}): SessionManager {
  let currentNotes = options.notes ?? ''
  return new SessionManager(
    () => null,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => currentNotes,
    () => false,
    (hostId, note) => {
      currentNotes = currentNotes ? `${currentNotes}\n\n${note}` : note
      options.savedNotes?.push({ hostId, notes: currentNotes })
      return '已保存到主机档案'
    },
    undefined,
    undefined,
    undefined,
    options.knowledgeAccess,
    (hostId, notes) => {
      currentNotes = notes
      options.savedNotes?.push({ hostId, notes })
      return '已保存到主机档案'
    },
  )
}

async function waitForProposal(events: AgentEvent[]): Promise<Extract<AgentEvent, { type: 'knowledge_proposal' }>> {
  for (let i = 0; i < 20; i++) {
    const found = events.find((event) => event.type === 'knowledge_proposal')
    if (found && found.type === 'knowledge_proposal') return found
    await flush()
  }
  assert.fail('missing knowledge_proposal event')
}

test('knowledge proposal emits, accepts after review, and writes host notes', async () => {
  const savedNotes: Array<{ hostId: string; notes: string }> = []
  const manager = createManager({ notes: 'existing', savedNotes })
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const session = {
    id: 's1',
    hostId: 'h1',
    activeRevisions: new Map(),
    knowledgeHarness: null,
  }
  const pending = (manager as unknown as KnowledgeProposalHarness).requestKnowledgeProposal(session, {
    targetKind: 'host-notes',
    targetId: 'h1',
    reason: 'Durable host tip',
    terminalEvidence: 'df -h\n[exit_code=0]',
    files: [{ relativePath: 'notes', after: 'existing\n\nnew tip' }],
  })

  const proposalEvent = await waitForProposal(events)
  assert.equal(proposalEvent.proposal.targetKind, 'host-notes')
  assert.equal(proposalEvent.proposal.baseContentHash, hash('existing'))
  assert.match(proposalEvent.unifiedDiff, /new tip/)
  assert.deepEqual(savedNotes, [])

  const response = await manager.respondKnowledgeProposal(proposalEvent.requestId, { ok: true })
  assert.equal(response.accepted, true)
  assert.equal(response.status, 'approved')
  assert.equal(await pending, '用户已接受提案并更新 Host Notes')
  assert.deepEqual(savedNotes, [{ hostId: 'h1', notes: 'existing\n\nnew tip' }])
})

test('knowledge proposal rejects without writing and cancels on chat cancel', async () => {
  const savedNotes: Array<{ hostId: string; notes: string }> = []
  const manager = createManager({ notes: 'keep', savedNotes })
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const session = {
    id: 's1',
    hostId: 'h1',
    activeRevisions: new Map(),
    knowledgeHarness: null,
  }
  const pendingReject = (manager as unknown as KnowledgeProposalHarness).requestKnowledgeProposal(session, {
    targetKind: 'host-notes',
    targetId: 'h1',
    reason: 'reject me',
    files: [{ relativePath: 'notes', after: 'changed' }],
  })
  const first = await waitForProposal(events)
  await manager.respondKnowledgeProposal(first.requestId, { ok: false })
  assert.match(await pendingReject, /未确认|未写入/)
  assert.deepEqual(savedNotes, [])

  events.length = 0
  const pendingCancel = (manager as unknown as KnowledgeProposalHarness).requestKnowledgeProposal(session, {
    targetKind: 'host-notes',
    targetId: 'h1',
    reason: 'cancel me',
    files: [{ relativePath: 'notes', after: 'changed-again' }],
  })
  await waitForProposal(events)
  manager.cancelChat('s1')
  assert.match(await pendingCancel, /取消|未写入/)
  assert.deepEqual(savedNotes, [])
})

test('knowledge proposal detects stale base for managed modules without writing', async () => {
  let latestRevision = 1
  let latestHash = 'hash-v1'
  const applied: unknown[] = []
  const knowledgeAccess: SessionKnowledgeAccess = {
    // Candidates-only check would reject environment-fixed modules; proposal path must
    // still allow fixed/readable targets via isProposalAllowedModule / harness.
    isAuthorizedCandidate: async () => false,
    isProposalAllowedModule: async (_env, moduleId) =>
      moduleId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resolveLatestPublished: async (id) => ({
      id,
      name: 'JVM',
      kind: 'knowledge',
      revision: latestRevision,
      contentHash: latestHash,
    }),
    readPublishedRevisionFiles: async () => ([
      { relativePath: 'SPACE.md', content: 'old', contentHash: 'file-old' },
    ]),
    applyAcceptedKnowledgeProposal: async (id, options) => {
      applied.push({ id, options })
      return { revision: latestRevision + 1, contentHash: 'hash-v2', origin: 'ai-proposal' }
    },
  }
  const manager = createManager({ knowledgeAccess })
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const session = {
    id: 's1',
    environmentId: 'env-1',
    pinnedModuleIds: new Set<string>(),
    dynamicModuleIds: new Set<string>(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']),
    activeRevisions: new Map(),
    knowledgeHarness: null,
  }
  const pending = (manager as unknown as KnowledgeProposalHarness).requestKnowledgeProposal(session, {
    targetKind: 'knowledge',
    targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    reason: 'update module',
    files: [{ relativePath: 'SPACE.md', after: 'new' }],
  })

  const proposalEvent = await waitForProposal(events)

  // Concurrent save changes the base before accept → rebase for re-review (no write yet).
  latestRevision = 2
  latestHash = 'hash-v2'

  const response = await manager.respondKnowledgeProposal(proposalEvent.requestId, { ok: true })
  assert.equal(response.accepted, false)
  assert.equal(response.status, 'conflict')
  assert.equal((response.proposal as KnowledgeChangeProposalPayload | undefined)?.status, 'pending')
  assert.equal((response.proposal as KnowledgeChangeProposalPayload | undefined)?.baseRevision, 2)
  assert.deepEqual(applied, [])

  // Second accept against the rebased base writes.
  const accepted = await manager.respondKnowledgeProposal(proposalEvent.requestId, { ok: true })
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.status, 'approved')
  assert.equal(applied.length, 1)
  assert.match(await pending, /已接受提案/)
})
