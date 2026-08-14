import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { HumanMessage } from '@langchain/core/messages'
import type {
  AgentContext,
  AgentHistory,
  AgentRuntime,
  ChatStreamOptions,
  SSHClient,
} from '@spotshell/core'
import type { AgentEvent, SessionSummary } from '../shared/ipc-types'
import { SessionManager, type SessionEnvironmentAccess, type SessionKnowledgeAccess } from './SessionManager'

class FakeStream extends EventEmitter {
  readonly stderr = new EventEmitter()
  destroyed = false
  write(): boolean { return true }
  setWindow(): void {}
  end(): void { this.destroyed = true }
  destroy(): void { this.destroyed = true }
}

class ReadySshClient extends EventEmitter {
  readonly stream = new FakeStream()
  async connect(): Promise<void> {}
  async requestShell(): Promise<FakeStream> { return this.stream }
  write(): boolean { return true }
  resizeWindow(): void {}
  disconnect(): void {}
  destroy(): void {}
}

class FakeAgent implements AgentRuntime {
  history: AgentHistory = []
  chats: Array<{ message: string; context: AgentContext }> = []

  async chatStream(
    message: string,
    context: AgentContext,
    options: ChatStreamOptions = {},
  ): Promise<string> {
    this.chats.push({ message, context })
    this.history = [...this.history, new HumanMessage(message)]
    options.onEvent?.({ type: 'token', text: 'ok' })
    return 'ok'
  }

  getHistory(): AgentHistory {
    return [...this.history]
  }

  setHistory(messages: AgentHistory): void {
    this.history = [...messages]
  }

  clearHistory(): void {
    this.history = []
  }
}

function createManager(
  agent: FakeAgent,
  access: SessionEnvironmentAccess = {
    getBoundEnvironmentId: () => undefined,
    environmentExists: async () => true,
    setBoundEnvironmentId: () => undefined,
    getEnvironmentName: (id) => id === 'env-a' ? 'Prod' : id === 'env-b' ? 'Stage' : id,
  },
  knowledgeAccess: SessionKnowledgeAccess = { isAuthorizedCandidate: async () => true },
): SessionManager {
  const client = new ReadySshClient()
  return new SessionManager(
    () => ({ apiKey: 'test-key' }),
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => 'host notes stay',
    () => false,
    () => 'saved',
    () => client as unknown as SSHClient,
    () => agent,
    access,
    knowledgeAccess,
  )
}

async function waitForReady(manager: SessionManager, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (manager.list().find((session) => session.id === sessionId)?.status === 'ready') return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail(`Session did not become ready: ${sessionId}`)
}

function collectAgentEvents(manager: SessionManager): AgentEvent[] {
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))
  return events
}

test('new sessions expose epoch 1 without activity', async () => {
  const manager = createManager(new FakeAgent())
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  assert.equal(session.contextEpoch, 1)
  assert.equal(session.epochHasActivity, false)
})

test('startNewContext clears agent history, dynamic modules and AI terminal buffer while keeping environment baseline', async () => {
  const agent = new FakeAgent()
  const manager = createManager(agent)
  const events = collectAgentEvents(manager)
  const session = await manager.connect({
    hostId: 'host-1',
    host: 'ops.example',
    port: 22,
    username: 'ops',
  })
  await waitForReady(manager, session.id)
  await manager.selectEnvironment(session.id, 'env-a')
  await manager.loadKnowledgeModule(session.id, 'module-dynamic')
  await manager.pinKnowledgeModule(session.id, 'module-pinned')
  await manager.chat(session.id, 'diagnose latency')

  const live = manager.list().find((item) => item.id === session.id) as SessionSummary
  assert.equal(live.epochHasActivity, true)
  assert.equal(agent.getHistory().length > 0, true)

  const next = await manager.startNewContext(session.id)
  assert.equal(next.contextEpoch, 2)
  assert.equal(next.epochHasActivity, false)
  assert.equal(next.environmentId, 'env-a')
  assert.deepEqual(next.dynamicModuleIds, [])
  // Session-pinned modules remain (not environment-always); only dynamic resets on user new context.
  assert.deepEqual(next.pinnedModuleIds, ['module-pinned'])
  assert.equal(agent.getHistory().length, 0)

  const boundary = events.find((event) => event.type === 'context_boundary')
  assert.ok(boundary && boundary.type === 'context_boundary')
  if (boundary?.type === 'context_boundary') {
    assert.equal(boundary.epoch, 2)
    assert.equal(boundary.previousEpoch, 1)
    assert.equal(boundary.reason, 'user')
    assert.ok(boundary.createdAt)
  }
})

test('empty epoch environment switch does not open a new context boundary but still clears AI terminal buffer', async () => {
  const manager = createManager(new FakeAgent())
  const events = collectAgentEvents(manager)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)

  const sessions = (manager as unknown as {
    sessions: Map<string, {
      context: { append: (v: string) => Promise<void>; getRecentContext: (n: number) => string }
    }>
  }).sessions
  const live = sessions.get(session.id)
  assert.ok(live)
  await live.context.append('pre-switch-ai-buffer')

  const selected = await manager.selectEnvironment(session.id, 'env-a')
  assert.equal(selected.contextEpoch, 1)
  assert.equal(selected.environmentId, 'env-a')
  assert.equal(events.some((event) => event.type === 'context_boundary'), false)
  assert.equal(live.context.getRecentContext(4000), '')
})

test('environment switch with agent activity atomically opens a new epoch and records from/to environments', async () => {
  const agent = new FakeAgent()
  const manager = createManager(agent)
  const events = collectAgentEvents(manager)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)
  await manager.selectEnvironment(session.id, 'env-a')
  await manager.loadKnowledgeModule(session.id, 'module-dynamic')
  await manager.pinKnowledgeModule(session.id, 'module-pinned')
  await manager.chat(session.id, 'inspect prod')

  const selected = await manager.selectEnvironment(session.id, 'env-b')
  assert.equal(selected.contextEpoch, 2)
  assert.equal(selected.epochHasActivity, false)
  assert.equal(selected.environmentId, 'env-b')
  assert.deepEqual(selected.dynamicModuleIds, [])
  assert.deepEqual(selected.pinnedModuleIds, [])
  assert.equal(agent.getHistory().length, 0)

  const boundary = events.find((event) => event.type === 'context_boundary')
  assert.ok(boundary && boundary.type === 'context_boundary')
  if (boundary?.type === 'context_boundary') {
    assert.equal(boundary.reason, 'environment-switch')
    assert.equal(boundary.fromEnvironmentId, 'env-a')
    assert.equal(boundary.fromEnvironmentName, 'Prod')
    assert.equal(boundary.toEnvironmentId, 'env-b')
    assert.equal(boundary.toEnvironmentName, 'Stage')
    assert.equal(boundary.epoch, 2)
  }
})

test('startNewContext is blocked while a terminal command is running', async () => {
  const OSC = '\u001b]6973;'
  const BEL = '\u0007'
  const client = new ReadySshClient()
  const agent = new FakeAgent()
  const manager = new SessionManager(
    () => ({ apiKey: 'test-key' }),
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    () => 'saved',
    () => client as unknown as SSHClient,
    () => agent,
    {
      getBoundEnvironmentId: () => undefined,
      environmentExists: async () => true,
      setBoundEnvironmentId: () => undefined,
    },
  )
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)
  client.stream.emit('data', Buffer.from(`${OSC}D;0;/root${BEL}${OSC}C;sleep 60${BEL}`))

  await assert.rejects(
    manager.startNewContext(session.id),
    /terminal command is running/i,
  )
  assert.equal(manager.list()[0]?.contextEpoch, 1)
})

test('new context clears prior AI terminal history injection for the next chat', async () => {
  const agent = new FakeAgent()
  const manager = createManager(agent)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)

  // Write into the session AI buffer through private map for deterministic coverage.
  const sessions = (manager as unknown as {
    sessions: Map<string, {
      context: { append: (v: string) => Promise<void>; getRecentContext: (n: number) => string; clear: () => void }
    }>
  }).sessions
  const live = sessions.get(session.id)
  assert.ok(live)
  await live.context.append('old-ai-buffer-line-should-not-leak')
  assert.match(live.context.getRecentContext(4000), /old-ai-buffer/)

  await manager.startNewContext(session.id)
  assert.equal(live.context.getRecentContext(4000), '')

  await manager.chat(session.id, 'fresh question')
  const last = agent.chats.at(-1)
  assert.ok(last)
  assert.equal(last.context.terminalHistory ?? '', '')
  assert.equal(last.context.lastCommand, undefined)
  assert.equal(last.context.lastError, undefined)
})

test('explicit old-context quotes inject frozen snapshots into the current agent turn', async () => {
  const agent = new FakeAgent()
  const manager = createManager(agent)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)
  await manager.chat(session.id, 'first diagnosis')
  await manager.startNewContext(session.id)

  const originalBody = 'memory pressure caused the OOM'
  await manager.chat(session.id, 'continue with prior evidence', [{
    sourceMessageId: 'msg-old-1',
    sourceEpoch: 1,
    role: 'assistant',
    createdAt: '2026-08-01T10:00:00.000Z',
    contentSnapshot: originalBody,
  }])

  const last = agent.chats.at(-1)
  assert.ok(last)
  assert.match(last.context.userQuotes ?? '', /source epoch 1/i)
  assert.match(last.context.userQuotes ?? '', /msg-old-1/)
  assert.match(last.context.userQuotes ?? '', /memory pressure caused the OOM/)
  // Later mutation of the caller's object must not rewrite what the agent already received.
  assert.equal(last.context.userQuotes?.includes(originalBody), true)
})

test('quotes from the current epoch are rejected; secret-bearing quotes are blocked before send', async () => {
  const agent = new FakeAgent()
  const manager = createManager(agent)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)
  await manager.chat(session.id, 'seed activity')
  await manager.startNewContext(session.id)

  await assert.rejects(
    manager.chat(session.id, 'use current msg', [{
      sourceMessageId: 'msg-current',
      sourceEpoch: 2,
      role: 'user',
      createdAt: '2026-08-01T11:00:00.000Z',
      contentSnapshot: 'still live history',
    }]),
    /older agent context/i,
  )

  await assert.rejects(
    manager.chat(session.id, 'send secret quote', [{
      sourceMessageId: 'msg-secret',
      sourceEpoch: 1,
      role: 'assistant',
      createdAt: '2026-08-01T10:00:00.000Z',
      contentSnapshot: 'key is sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    }]),
    /secret scan/i,
  )
  assert.equal(agent.chats.length, 1)
})

test('oversized tool output quotes must be narrowed and belong to the open epoch only at send time', async () => {
  const agent = new FakeAgent()
  const manager = createManager(agent)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)
  await manager.chat(session.id, 'seed')
  await manager.startNewContext(session.id)

  await assert.rejects(
    manager.chat(session.id, 'too much tool output', [{
      sourceMessageId: 'tool-1',
      sourceEpoch: 1,
      role: 'tool',
      createdAt: '2026-08-01T10:00:00.000Z',
      contentSnapshot: 'x'.repeat(2_001),
    }]),
    /narrow the selection/i,
  )

  await manager.chat(session.id, 'bounded tool fragment', [{
    sourceMessageId: 'tool-1',
    sourceEpoch: 1,
    role: 'tool',
    createdAt: '2026-08-01T10:00:00.000Z',
    contentSnapshot: 'x'.repeat(2_000),
    truncated: true,
    charRange: { start: 0, end: 2_000 },
  }])
  const last = agent.chats.at(-1)
  assert.ok(last?.context.userQuotes)
  assert.match(last?.context.userQuotes ?? '', /tool-1/)
})

