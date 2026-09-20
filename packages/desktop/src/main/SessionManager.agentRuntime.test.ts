import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createFauxModelProvider, loadPiAi } from '@spotshell/core/testing'
import { assistantMessage } from '@spotshell/core'
import { AgentCancelledError, SpotShellAgent } from '@spotshell/core'
import type {
  AgentContext,
  AgentConfig,
  AgentHistory,
  AgentRuntime,
  ChatStreamOptions,
  CommandResult,
  SSHClient,
} from '@spotshell/core'
import type { AgentEvent, SessionSummary } from '../shared/ipc-types'
import { SessionManager } from './SessionManager'

class FakeStream extends EventEmitter {
  readonly stderr = new EventEmitter()
  destroyed = false

  write(): boolean {
    return true
  }

  setWindow(): void {}

  end(): void {
    this.destroyed = true
  }

  destroy(): void {
    this.destroyed = true
  }
}

class FakeSshClient extends EventEmitter {
  readonly stream = new FakeStream()

  async connect(): Promise<void> {}

  async requestShell(): Promise<FakeStream> {
    return this.stream
  }

  async execCommand(command: string): Promise<CommandResult> {
    return {
      command,
      stdout: 'Linux desktop-fake 6.8.0',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    }
  }

  write(): boolean {
    return true
  }

  resizeWindow(): void {}

  disconnect(): void {}

  destroy(): void {}
}

class FakeAgent implements AgentRuntime {
  readonly chats: Array<{ message: string; context: AgentContext }> = []
  private history: AgentHistory = []

  async chatStream(
    message: string,
    context: AgentContext,
    options: ChatStreamOptions = {}
  ): Promise<string> {
    this.chats.push({ message, context })
    options.onEvent?.({ type: 'token', text: 'deterministic ' })
    options.onEvent?.({ type: 'token', text: 'reply' })
    return 'deterministic reply'
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

class BlockingFakeAgent extends FakeAgent {
  override async chatStream(
    _message: string,
    _context: AgentContext,
    options: ChatStreamOptions = {}
  ): Promise<string> {
    return new Promise((_resolve, reject) => {
      const rejectCancelled = (): void => reject(new AgentCancelledError())
      if (options.signal?.aborted) {
        rejectCancelled()
        return
      }
      options.signal?.addEventListener('abort', rejectCancelled, { once: true })
    })
  }
}

class DeferredFakeAgent extends FakeAgent {
  private resolveTurn?: (value: string) => void

  override async chatStream(
    message: string,
    context: AgentContext,
  ): Promise<string> {
    this.chats.push({ message, context })
    return new Promise((resolve) => { this.resolveTurn = resolve })
  }

  finish(value = 'finished old turn'): void {
    this.resolveTurn?.(value)
  }
}

/**
 * Scripts the same two-step exchange the old langchain fake produced: first a
 * tool call, then a text answer that quotes the tool result. The faux provider
 * replays fixed responses, so the assertion that the tool result actually
 * reached the model moved onto the recorded request (see the test below).
 */
async function toolCallingFauxProvider() {
  const { fauxAssistantMessage, fauxToolCall } = await loadPiAi()
  return createFauxModelProvider({
    responses: [
      fauxAssistantMessage([
        fauxToolCall('execute_ssh_command', { command: 'uname -a' }, { id: 'desktop-call-1' }),
      ]),
      fauxAssistantMessage('Observed SSH result: Linux desktop-fake 6.8.0'),
    ],
  })
}

async function waitForReady(manager: SessionManager): Promise<SessionSummary> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const session = manager.list()[0]
    if (session?.status === 'ready') return session
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('session did not become ready')
}

function createManager(agent: AgentRuntime): SessionManager {
  return new SessionManager(
    () => ({ apiKey: 'test-key' }),
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => 'host-specific note',
    () => false,
    () => 'saved',
    () => new FakeSshClient() as unknown as SSHClient,
    () => agent
  )
}

test('chat can run through injected SSH and Agent runtimes without external services', async () => {
  const fakeAgent = new FakeAgent()
  const manager = createManager(fakeAgent)
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const connecting = await manager.connect({
    hostId: 'host-1',
    host: 'server.example',
    port: 22,
    username: 'operator',
    password: 'secret',
  })
  const ready = await waitForReady(manager)
  const reply = await manager.chat(ready.id, 'Inspect the service')

  assert.equal(connecting.id, ready.id)
  assert.equal(reply, 'deterministic reply')
  assert.deepEqual(fakeAgent.chats, [{
    message: 'Inspect the service',
    context: {
      terminalHistory: '',
      lastCommand: undefined,
      lastError: undefined,
      currentDirectory: undefined,
      lastExitCode: undefined,
      hostNotes: 'host-specific note',
    },
  }])
  assert.deepEqual(events, [
    { type: 'status', sessionId: ready.id, epoch: 1, text: 'thinking' },
    { type: 'token_delta', sessionId: ready.id, epoch: 1, text: 'deterministic ' },
    { type: 'token_delta', sessionId: ready.id, epoch: 1, text: 'reply' },
    { type: 'final', sessionId: ready.id, epoch: 1, text: 'deterministic reply' },
  ])
})

test('cancelChat aborts an injected Agent runtime and emits a cancelled event', async () => {
  const manager = createManager(new BlockingFakeAgent())
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))
  await manager.connect({
    host: 'server.example',
    port: 22,
    username: 'operator',
    password: 'secret',
  })
  const ready = await waitForReady(manager)

  const chat = manager.chat(ready.id, 'Wait for cancellation')
  await new Promise<void>((resolve) => setImmediate(resolve))
  manager.cancelChat(ready.id)

  assert.equal(await chat, '')
  assert.deepEqual(events, [
    { type: 'status', sessionId: ready.id, epoch: 1, text: 'thinking' },
    { type: 'cancelled', sessionId: ready.id, epoch: 1 },
  ])
})

test('desktop Chat combines a real Agent with a fake model and fake SSH command result', async () => {
  const fakeSsh = new FakeSshClient()
  const model = await toolCallingFauxProvider()
  const manager = new SessionManager(
    () => ({ apiKey: 'unused' }),
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    () => 'saved',
    () => fakeSsh as unknown as SSHClient,
    (config, executor, extras) =>
      new SpotShellAgent(config, executor, extras, { providerResolver: () => model.provider })
  )
  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))
  await manager.connect({
    host: 'server.example',
    port: 22,
    username: 'operator',
    password: 'secret',
  })
  const ready = await waitForReady(manager)

  const reply = await manager.chat(ready.id, 'Inspect the kernel')

  assert.match(reply, /Linux desktop-fake 6\.8\.0/)
  // A real provider streams the answer in several deltas, so collapse runs of
  // token_delta before comparing the shape, then assert the streamed text is
  // complete — together that is stricter than pinning the delta count.
  const shape = events
    .map((event) => event.type)
    .filter((type, index, all) => !(type === 'token_delta' && all[index - 1] === 'token_delta'))
  assert.deepEqual(shape, [
    'status',
    'context_usage',
    'tool_start',
    'tool_end',
    'token_delta',
    'final',
  ])
  const streamed = events
    .filter((event) => event.type === 'token_delta')
    .map((event) => (event.type === 'token_delta' ? event.text : ''))
    .join('')
  assert.equal(streamed, reply)
  const usage = events.find((event) => event.type === 'context_usage')
  assert.ok(usage && usage.type === 'context_usage')
  assert.equal(usage.usage.estimated, true)
  assert.ok(usage.usage.availableInputBudget > 0)
  assert.ok(usage.usage.slots.some((slot) => slot.id === 'system'))
  const toolEnd = events.find((event) => event.type === 'tool_end')
  assert.ok(toolEnd && toolEnd.type === 'tool_end')
  assert.equal(toolEnd.name, 'execute_ssh_command')
  assert.match(toolEnd.output, /Linux desktop-fake 6\.8\.0/)
  // The tool result must have re-entered the model on the follow-up request.
  const followUp = model.requests[1]
  assert.ok(followUp, 'the tool result should trigger a second provider request')
  const followUpText = followUp.messages.map((m) => JSON.stringify(m.content)).join(' ')
  assert.match(followUpText, /Linux desktop-fake 6\.8\.0/)
})

test('model refresh waits for the active turn, then preserves history for the next provider', async () => {
  let config: AgentConfig | null = { provider: 'openai', apiKey: 'openai-key', model: 'gpt-old' }
  const created: Array<{ config: AgentConfig; agent: FakeAgent }> = []
  const first = new DeferredFakeAgent()
  first.setHistory([assistantMessage('earlier history')])
  const manager = new SessionManager(
    () => config,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    () => 'saved',
    () => new FakeSshClient() as unknown as SSHClient,
    (nextConfig) => {
      const agent = created.length === 0 ? first : new FakeAgent()
      created.push({ config: nextConfig, agent })
      return agent
    },
  )
  await manager.connect({ host: 'server.example', port: 22, username: 'operator', password: 'secret' })
  const ready = await waitForReady(manager)

  const turn = manager.chat(ready.id, 'old-provider-turn')
  await new Promise<void>((resolve) => setImmediate(resolve))
  config = { provider: 'anthropic', apiKey: 'anthropic-key', model: 'claude-new' }
  manager.refreshAllAgentModels()
  assert.equal(created.length, 1)

  first.finish()
  assert.equal(await turn, 'finished old turn')
  assert.equal(created.length, 2)
  assert.equal(created[1]?.config.provider, 'anthropic')
  assert.equal(created[1]?.agent.getHistory()[0]?.text, 'earlier history')
})

test('clearing the active provider key blocks future turns without disconnecting SSH', async () => {
  let config: AgentConfig | null = { provider: 'openai', apiKey: 'openai-key' }
  const manager = new SessionManager(
    () => config,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    () => 'saved',
    () => new FakeSshClient() as unknown as SSHClient,
    () => new FakeAgent(),
  )
  await manager.connect({ host: 'server.example', port: 22, username: 'operator', password: 'secret' })
  const ready = await waitForReady(manager)
  config = null
  manager.refreshAllAgentModels()
  await assert.rejects(
    () => manager.chat(ready.id, 'blocked'),
    /current model provider has no API key/i,
  )
  assert.equal(manager.list()[0]?.status, 'ready')
})
