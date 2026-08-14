import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../shared/ipc-types'
import { SessionManager } from './SessionManager'

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface KnowledgeTargetHarness {
  requestKnowledgeTarget(
    session: { id: string; hostId?: string },
    question: {
      question: string
      candidates: Array<{
        kind: 'host-notes' | 'environment' | 'knowledge'
        targetId: string
        label: string
        reason: string
      }>
    },
  ): Promise<string>
}

function createManager(): SessionManager {
  return new SessionManager(
    () => null,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => '',
    () => false,
    () => '已保存到主机档案',
  )
}

const CANDIDATES = [
  { kind: 'environment' as const, targetId: 'env-1', label: 'CDH 生产', reason: '路径与版本' },
  { kind: 'knowledge' as const, targetId: 'mod-1', label: 'HDFS 排障', reason: '可复用方法' },
]

async function waitForQuestion(
  events: AgentEvent[],
): Promise<Extract<AgentEvent, { type: 'knowledge_target_question' }>> {
  for (let i = 0; i < 20; i++) {
    const found = events.find((event) => event.type === 'knowledge_target_question')
    if (found && found.type === 'knowledge_target_question') return found
    await flush()
  }
  assert.fail('missing knowledge_target_question event')
}

test('the tool call stays suspended until the user picks a landing place', async () => {
  const manager = createManager()
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  let settled = false
  const pending = (manager as unknown as KnowledgeTargetHarness)
    .requestKnowledgeTarget({ id: 's1', hostId: 'h1' }, {
      question: '把这条 HDFS 结论写到哪里？',
      candidates: CANDIDATES,
    })
    .then((result) => {
      settled = true
      return result
    })

  const question = await waitForQuestion(events)
  assert.equal(question.candidates.length, 2)
  assert.equal(settled, false, 'the agent must still be blocked while the card is open')

  const response = manager.respondKnowledgeTarget(question.requestId, 1)
  assert.deepEqual(response, { accepted: true, status: 'approved' })

  const result = await pending
  assert.match(result, /kind=knowledge/)
  assert.match(result, /targetId=mod-1/)
  assert.match(result, /HDFS 排障/)
  assert.ok(
    events.some((event) =>
      event.type === 'approval_resolved'
      && event.requestId === question.requestId
      && event.status === 'approved'),
    'the card must be closed with approval_resolved',
  )
})

test('declining every candidate tells the model to write nothing', async () => {
  const manager = createManager()
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const pending = (manager as unknown as KnowledgeTargetHarness)
    .requestKnowledgeTarget({ id: 's1', hostId: 'h1' }, {
      question: '写到哪里？',
      candidates: CANDIDATES,
    })
  const question = await waitForQuestion(events)

  assert.deepEqual(manager.respondKnowledgeTarget(question.requestId, null), {
    accepted: true,
    status: 'rejected',
  })
  assert.match(await pending, /不要写入任何知识/)
  assert.ok(
    events.some((event) =>
      event.type === 'approval_resolved'
      && event.requestId === question.requestId
      && event.status === 'rejected'),
  )
})

test('an index the card never offered is refused and the wait stays open', async () => {
  const manager = createManager()
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const pending = (manager as unknown as KnowledgeTargetHarness)
    .requestKnowledgeTarget({ id: 's1', hostId: 'h1' }, {
      question: '写到哪里？',
      candidates: CANDIDATES,
    })
  const question = await waitForQuestion(events)

  assert.deepEqual(manager.respondKnowledgeTarget(question.requestId, 5), { accepted: false })
  assert.deepEqual(manager.respondKnowledgeTarget(question.requestId, 0), {
    accepted: true,
    status: 'approved',
  })
  assert.match(await pending, /targetId=env-1/)
})

test('cancelling the turn releases the question without a landing place', async () => {
  const manager = createManager()
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const pending = (manager as unknown as KnowledgeTargetHarness)
    .requestKnowledgeTarget({ id: 's1', hostId: 'h1' }, {
      question: '写到哪里？',
      candidates: CANDIDATES,
    })
  await waitForQuestion(events)

  manager.cancelChat('s1')
  assert.match(await pending, /取消/)
})

test('an empty candidate list never opens a card', async () => {
  const manager = createManager()
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const result = await (manager as unknown as KnowledgeTargetHarness)
    .requestKnowledgeTarget({ id: 's1', hostId: 'h1' }, { question: '写到哪里？', candidates: [] })
  assert.match(result, /没有可选落点/)
  assert.equal(events.some((event) => event.type === 'knowledge_target_question'), false)
})
