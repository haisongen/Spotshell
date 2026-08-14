import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { AgentCancelledError, type AgentContext, type AgentHistory, type AgentRuntime, type ChatStreamOptions, type SSHClient } from '@spotshell/core'
import type { AgentEvent, SessionSummary } from '../shared/ipc-types'
import { PendingConfirms } from './PendingConfirms'
import { SessionManager, type SessionEnvironmentAccess } from './SessionManager'

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

class BlockingFakeAgent implements AgentRuntime {
  history: AgentHistory = []
  lateToken?: string
  resolveChat?: () => void
  private waiters: Array<() => void> = []

  async chatStream(
    message: string,
    _context: AgentContext,
    options: ChatStreamOptions = {},
  ): Promise<string> {
    options.onEvent?.({ type: 'token', text: `partial:${message}` })
    return new Promise((resolve, reject) => {
      const finishCancelled = (): void => reject(new AgentCancelledError())
      if (options.signal?.aborted) {
        finishCancelled()
        return
      }
      options.signal?.addEventListener('abort', finishCancelled, { once: true })
      this.resolveChat = () => {
        if (this.lateToken) {
          options.onEvent?.({ type: 'token', text: this.lateToken })
          options.onEvent?.({
            type: 'context_usage',
            usage: {
              contextWindowTokens: 8000,
              outputReserveTokens: 1000,
              safetyReserveTokens: 256,
              availableInputBudget: 6000,
              usedInputTokens: 999,
              slots: [],
              omittedGuidance: [],
              conflicts: [],
            },
          })
        }
        this.history = [...this.history, { content: message } as never]
        resolve(`done:${message}`)
      }
      this.waiters.push(this.resolveChat)
    })
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
  agent: AgentRuntime,
  access: SessionEnvironmentAccess = {
    getBoundEnvironmentId: () => undefined,
    environmentExists: async () => true,
    setBoundEnvironmentId: () => undefined,
  },
): SessionManager {
  return new SessionManager(
    () => ({ apiKey: 'test-key' }),
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    () => 'saved',
    () => new ReadySshClient() as unknown as SSHClient,
    () => agent,
    access,
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

test('startNewContext cancels in-flight generation then opens a new epoch', async () => {
  const agent = new BlockingFakeAgent()
  const manager = createManager(agent)
  const events = collectAgentEvents(manager)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)

  const chatPromise = manager.chat(session.id, 'long generation')
  await new Promise<void>((resolve) => setImmediate(resolve))

  const next = await manager.startNewContext(session.id)
  assert.equal(next.contextEpoch, 2)
  assert.equal(await chatPromise, '')

  assert.ok(events.some((event) =>
    event.type === 'cancelled' && event.epoch === 1 && event.sessionId === session.id,
  ))
  assert.ok(events.some((event) =>
    event.type === 'context_boundary' && event.epoch === 2 && event.previousEpoch === 1,
  ))
})

test('pending command approval is cancelled with a terminal state when opening a new epoch', async () => {
  const manager = createManager(new BlockingFakeAgent())
  const events = collectAgentEvents(manager)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)

  const harness = manager as unknown as {
    confirms: PendingConfirms
    requestConfirm(sessionId: string, command: string, risk: 'write'): Promise<boolean>
  }
  const pending = harness.requestConfirm(session.id, 'rm -rf /tmp/x', 'write')
  const required = events.find((event) => event.type === 'confirm_required')
  assert.ok(required && required.type === 'confirm_required')
  assert.equal(required.epoch, 1)

  const next = await manager.startNewContext(session.id)
  assert.equal(next.contextEpoch, 2)
  assert.equal(await pending, false)
  assert.ok(events.some((event) =>
    event.type === 'approval_resolved'
    && event.requestId === required.requestId
    && event.status === 'cancelled'
    && event.epoch === 1,
  ))
  // Stale approve after cancel is rejected with the settled status.
  assert.deepEqual(manager.respondConfirm(required.requestId, true), {
    accepted: false,
    status: 'cancelled',
  })
})

test('pending note proposal is cancelled when the old epoch closes', async () => {
  const manager = createManager(new BlockingFakeAgent())
  const events = collectAgentEvents(manager)
  const session = await manager.connect({
    hostId: 'host-1',
    host: 'ops.example',
    port: 22,
    username: 'ops',
  })
  await waitForReady(manager, session.id)

  const harness = manager as unknown as {
    requestNoteProposal(session: unknown, hostId: string, note: string): Promise<string>
    sessions: Map<string, unknown>
  }
  const live = harness.sessions.get(session.id)
  assert.ok(live)
  const pending = harness.requestNoteProposal(live, 'host-1', 'remember restart policy')
  const proposal = events.find((event) => event.type === 'note_proposal')
  assert.ok(proposal && proposal.type === 'note_proposal')
  assert.equal(proposal.epoch, 1)

  await manager.startNewContext(session.id)
  assert.match(await pending, /未确认|not confirmed|取消/i)
  assert.ok(events.some((event) =>
    event.type === 'approval_resolved'
    && event.requestId === proposal.requestId
    && event.status === 'cancelled'
    && event.epoch === 1,
  ))
})

test('running user-terminal command blocks new context with an explicit reason on the summary', async () => {
  const OSC = '\u001b]6973;'
  const BEL = '\u0007'
  const client = new ReadySshClient()
  const manager = new SessionManager(
    () => ({ apiKey: 'test-key' }),
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    () => 'saved',
    () => client as unknown as SSHClient,
    () => new BlockingFakeAgent(),
  )
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)
  client.stream.emit('data', Buffer.from(`${OSC}D;0;/root${BEL}${OSC}C;sleep 60${BEL}`))

  const summary = manager.list().find((item) => item.id === session.id) as SessionSummary
  assert.equal(summary.commandRunning, true)
  assert.match(summary.newContextBlockReason ?? '', /command is running/i)

  await assert.rejects(
    manager.startNewContext(session.id),
    /command is running/i,
  )
  assert.equal(manager.list()[0]?.contextEpoch, 1)
})

test('late generation events keep the old epoch and do not pollute the new usage meter or history', async () => {
  const agent = new BlockingFakeAgent()
  agent.lateToken = 'should-stay-on-epoch-1'
  const manager = createManager(agent)
  const events = collectAgentEvents(manager)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)

  // Drive a turn without abort so we can force a late completion after epoch advance.
  // Manually mark active turn then complete after startNewContext by resolving after cancel path fails:
  // Use settle-less path: open epoch while chat finishes without abort by clearing chatAbort after start.
  // Instead: start chat, advance epoch via private open while chat still holds turn epoch stamp.
  const chatPromise = manager.chat(session.id, 'race')
  await new Promise<void>((resolve) => setImmediate(resolve))

  // Abort is part of startNewContext; re-test late isolation by completing after cancel is ignored:
  // Inject a second chat that ends after epoch change by simulating late token emission post-boundary.
  await manager.startNewContext(session.id)
  assert.equal(await chatPromise, '')

  // Force a synthetic late emission through a new chat that captures epoch then we advance first.
  const agent2 = new BlockingFakeAgent()
  agent2.lateToken = 'late-after-boundary'
  const manager2 = createManager(agent2)
  const events2 = collectAgentEvents(manager2)
  const session2 = await manager2.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager2, session2.id)

  // Access private map to advance epoch while a turn is active without aborting first.
  const liveSessions = (manager2 as unknown as {
    sessions: Map<string, {
      epoch: { contextEpoch: number; epochHasActivity: boolean }
      activeTurnEpoch: number | null
      contextUsage?: { usedInputTokens: number }
      agent: AgentRuntime | null
    }>
    openNewContextEpoch: (
      session: unknown,
      reason: 'user',
      options: { clearPinnedModules: boolean },
    ) => Promise<void>
  }).sessions
  const live = liveSessions.get(session2.id)
  assert.ok(live)

  const chat2 = manager2.chat(session2.id, 'will finish late')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(live.activeTurnEpoch, 1)

  // Advance epoch without settle so the in-flight turn can complete as a late event.
  await (manager2 as unknown as {
    openNewContextEpoch: (
      session: unknown,
      reason: 'user',
      options: { clearPinnedModules: boolean },
    ) => Promise<void>
  }).openNewContextEpoch(live, 'user', { clearPinnedModules: false })

  assert.equal(manager2.list()[0]?.contextEpoch, 2)
  // Complete the old turn after the boundary.
  agent2.resolveChat?.()
  await chat2

  const lateTokens = events2.filter((event) =>
    event.type === 'token_delta' && event.text === 'late-after-boundary',
  )
  assert.equal(lateTokens.length, 1)
  assert.equal(lateTokens[0]?.epoch, 1)

  const lateUsage = events2.filter((event) =>
    event.type === 'context_usage' && event.epoch === 1 && event.usage.usedInputTokens === 999,
  )
  assert.equal(lateUsage.length, 1)
  // Current epoch meter must not adopt the late usage figure.
  assert.notEqual(manager2.list()[0]?.contextUsage?.usedInputTokens, 999)
  // Late completion clears polluted history on the agent.
  assert.equal(agent2.getHistory().length, 0)
  // Boundary still present for the new segment.
  assert.ok(events2.some((event) => event.type === 'context_boundary' && event.epoch === 2))
  void events
})

test('late dynamic module selection is visible but does not join the new epoch module set', async () => {
  const agent = new BlockingFakeAgent()
  const manager = createManager(agent)
  const events = collectAgentEvents(manager)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)

  const harness = manager as unknown as {
    sessions: Map<string, {
      epoch: { contextEpoch: number; epochHasActivity: boolean }
      activeTurnEpoch: number | null
      dynamicModuleIds: Set<string>
      pinnedModuleIds: Set<string>
    }>
    applyDynamicModuleSelection: (
      session: unknown,
      selection: {
        moduleId: string
        moduleName: string
        revision: number
        contentHash: string
        reason: string
        loadType: 'dynamic'
      },
    ) => void
    openNewContextEpoch: (
      session: unknown,
      reason: 'user',
      options: { clearPinnedModules: boolean },
    ) => Promise<void>
  }
  const live = harness.sessions.get(session.id)
  assert.ok(live)

  const chatPromise = manager.chat(session.id, 'load something')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(live.activeTurnEpoch, 1)

  // Advance the epoch while the turn is still open so the selection is late.
  await harness.openNewContextEpoch(live, 'user', { clearPinnedModules: false })
  assert.equal(live.epoch.contextEpoch, 2)
  assert.equal(live.activeTurnEpoch, 1)

  harness.applyDynamicModuleSelection(live, {
    moduleId: 'module-late',
    moduleName: 'Late Module',
    revision: 3,
    contentHash: 'hash-late',
    reason: 'needed for diagnosis',
    loadType: 'dynamic',
  })

  agent.resolveChat?.()
  await chatPromise

  assert.equal(manager.list()[0]?.contextEpoch, 2)
  assert.deepEqual(manager.list()[0]?.dynamicModuleIds, [])
  const selected = events.find((event) => event.type === 'knowledge_module_selected')
  assert.ok(selected && selected.type === 'knowledge_module_selected')
  assert.equal(selected.epoch, 1)
  assert.equal(selected.selection.moduleId, 'module-late')
})

test('approved agent SSH exec blocks new context until the command finishes', async () => {
  const agent = new BlockingFakeAgent()
  const manager = createManager(agent)
  const events = collectAgentEvents(manager)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)

  const harness = manager as unknown as {
    sessions: Map<string, { agentExecInFlight: number }>
    requestConfirm(sessionId: string, command: string, risk: 'write'): Promise<boolean>
  }

  const pending = harness.requestConfirm(session.id, 'sleep 30', 'write')
  const required = events.find((event) => event.type === 'confirm_required')
  assert.ok(required && required.type === 'confirm_required')

  // Approve commits agentExecInFlight before PolicyExecutor.inner.execute runs.
  assert.deepEqual(manager.respondConfirm(required.requestId, true), {
    accepted: true,
    status: 'approved',
  })
  assert.equal(await pending, true)
  assert.equal(harness.sessions.get(session.id)?.agentExecInFlight, 1)
  assert.equal(manager.list()[0]?.commandRunning, true)

  await assert.rejects(manager.startNewContext(session.id), /command is running/i)
  assert.equal(manager.list()[0]?.contextEpoch, 1)

  // Release the gate as PolicyExecutor would in finally after exec completes.
  const live = harness.sessions.get(session.id)
  assert.ok(live)
  live.agentExecInFlight = 0
  const next = await manager.startNewContext(session.id)
  assert.equal(next.contextEpoch, 2)
  assert.equal(next.commandRunning, false)
})

test('agent and tool events carry their owning epoch', async () => {
  const agent = new BlockingFakeAgent()
  const manager = createManager(agent)
  const events = collectAgentEvents(manager)
  const session = await manager.connect({ host: 'ops.example', port: 22, username: 'ops' })
  await waitForReady(manager, session.id)

  const chat = manager.chat(session.id, 'tag me')
  await new Promise<void>((resolve) => setImmediate(resolve))
  agent.resolveChat?.()
  await chat

  for (const event of events) {
    assert.equal(typeof event.epoch, 'number')
    assert.ok(event.epoch >= 1)
  }
})
