import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { ChatResult } from '@langchain/core/outputs'
import {
  KnowledgeRepository,
  SpotShellAgent,
  type CommandResult,
  type SSHClient,
} from '@spotshell/core'
import type { AgentEvent, SessionSummary } from '../shared/ipc-types'
import { KnowledgeCatalogService } from './KnowledgeCatalogService'
import { ModuleAuthorizationStore } from './ModuleAuthorizationStore'
import { SessionManager } from './SessionManager'

class FakeStream extends EventEmitter {
  readonly stderr = new EventEmitter()
  destroyed = false
  write(): boolean { return true }
  setWindow(): void {}
  end(): void { this.destroyed = true }
  destroy(): void { this.destroyed = true }
}

class FakeSshClient extends EventEmitter {
  readonly stream = new FakeStream()
  async connect(): Promise<void> {}
  async requestShell(): Promise<FakeStream> { return this.stream }
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
  write(): boolean { return true }
  resizeWindow(): void {}
  disconnect(): void {}
  destroy(): void {}
}

/** Scripted model that can select a module, refuse one, or answer without tools. */
class ScriptedSelectModel extends BaseChatModel {
  private invocation = 0

  constructor(
    private readonly getPlan: () => {
      mode: 'select-related' | 'select-unauthorized' | 'answer-only'
      relatedId: string
      unauthorizedId: string
    },
  ) {
    super({})
  }

  _llmType(): string {
    return 'desktop-dynamic-module-fake'
  }

  bindTools(): this {
    return this
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.invocation += 1
    const plan = this.getPlan()
    if (plan.mode === 'answer-only') {
      return {
        generations: [{
          text: 'Follow-up with active module guidance.',
          message: new AIMessage('Follow-up with active module guidance.'),
        }],
      }
    }
    if (this.invocation === 1) {
      const objectId = plan.mode === 'select-unauthorized'
        ? plan.unauthorizedId
        : plan.relatedId
      return {
        generations: [{
          text: '',
          message: new AIMessage({
            content: '',
            tool_calls: [{
              id: 'select-1',
              name: 'select_knowledge_module',
              args: {
                objectId,
                reason: plan.mode === 'select-unauthorized'
                  ? 'try unauthorized'
                  : 'User asked about JVM heap pressure',
              },
              type: 'tool_call',
            }],
          }),
        }],
      }
    }
    const text = plan.mode === 'select-unauthorized'
      ? 'Unauthorized module was refused.'
      : 'Loaded JVM guidance for heap pressure.'
    return {
      generations: [{ text, message: new AIMessage(text) }],
    }
  }
}

async function waitForReady(manager: SessionManager): Promise<SessionSummary> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const session = manager.list()[0]
    if (session?.status === 'ready') return session
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('session did not become ready')
}

async function createEligibleModule(
  repository: KnowledgeRepository,
  name: string,
  guidance: string,
) {
  const module = await repository.createDraft({ name })
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: `${name} reference material.`,
    whenToUse: `Use when ${name.toLocaleLowerCase('en-US')} is relevant.`,
    beforeGuidance: `# ${name}\n\n## Guidance\n\n${guidance}`,
  })
  await repository.publishDraft(module.id)
  return module
}

test('fake model integration: related load, unauthorized refuse, follow-up, unload', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-dynamic-modules-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))

  const repository = new KnowledgeRepository(path.join(rootPath, 'knowledge'))
  const authorizations = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const catalog = new KnowledgeCatalogService(repository, authorizations)

  const related = await createEligibleModule(
    repository,
    'JVM Diagnostics',
    '- Capture heap histogram before restarting.',
  )
  const unrelated = await createEligibleModule(
    repository,
    'Network Diagnostics',
    '- Check interface counters first.',
  )
  const ownedOnly = await createEligibleModule(
    repository,
    'Owned Only Secrets',
    '- Never auto-load this module.',
  )
  authorizations.setGlobalOnDemand(related.id, true)
  authorizations.setGlobalOnDemand(unrelated.id, true)

  let plan: {
    mode: 'select-related' | 'select-unauthorized' | 'answer-only'
    relatedId: string
    unauthorizedId: string
  } = {
    mode: 'select-related',
    relatedId: related.id,
    unauthorizedId: ownedOnly.id,
  }

  const manager = new SessionManager(
    () => ({ apiKey: 'unused', contextWindowTokens: 32_000 }),
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    () => 'saved',
    () => new FakeSshClient() as unknown as SSHClient,
    (config, executor, extras) => new SpotShellAgent(
      config,
      executor,
      extras,
      { model: new ScriptedSelectModel(() => plan) },
    ),
    {
      getBoundEnvironmentId: () => undefined,
      environmentExists: async () => false,
      setBoundEnvironmentId: () => undefined,
    },
    catalog,
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

  // 1) Related authorized module is selected inside the agent loop.
  const reply = await manager.chat(ready.id, 'Java heap is high')
  assert.match(reply, /JVM guidance|heap/i)
  const selected = events.filter((event) => event.type === 'knowledge_module_selected')
  assert.equal(selected.length, 1)
  assert.ok(selected[0] && selected[0].type === 'knowledge_module_selected')
  assert.equal(selected[0].selection.moduleId, related.id)
  assert.equal(selected[0].selection.moduleName, 'JVM Diagnostics')
  assert.equal(selected[0].selection.loadType, 'dynamic')
  assert.equal(selected[0].selection.revision, 1)
  assert.match(selected[0].selection.reason, /heap pressure/i)
  assert.deepEqual(
    manager.list().find((session) => session.id === ready.id)?.dynamicModuleIds,
    [related.id],
  )
  assert.equal(
    manager.list().find((session) => session.id === ready.id)?.dynamicModuleIds.includes(unrelated.id),
    false,
  )

  // 2) Follow-up keeps the dynamic module active; no new selection event.
  // Fresh agent instance for answer-only: reconnect keeps session module state only if we stay
  // on the same session. Use the same agent by answering without tools — but the existing agent
  // still has the first scripted model instance which already advanced invocations.
  // Reconnect creates a new model; preserve dynamic modules by not switching environments.
  // Instead unload is tested after we chat with a newly connected session that reloads dynamics.
  // For same-session follow-up, pin the module via load then use a new connection is wrong.
  // Simpler: call chat again — the existing ScriptedSelectModel will treat invocation>1 as final
  // only if plan stays select-related. Switch plan to answer-only AND replace agent by reconnecting
  // is needed. Keep dynamicModuleIds by not clearing them: reconnect creates a NEW session.
  // So for follow-up on the same session we need the same agent to support answer-only.
  plan = { ...plan, mode: 'answer-only' }
  // Existing model instance ignores plan.mode changes for invocation count > 1 when mode was
  // select-related — invocation is already 2+, so next chatStream builds graph once and
  // model.invocation continues. With answer-only mode, any invocation returns final text.
  // But this agent still holds the OLD model created at connect. Fix: factory creates model
  // that reads plan each time; but agent is not recreated. So recreate agent by closing and
  // reconnecting loses dynamicModuleIds.
  // Work around: manually re-load module after reconnect, OR make model always consult plan.
  // ScriptedSelectModel already consults plan each _generate. The problem is only the
  // invocation counter on the same instance: after first chat invocation===2. Second chat
  // resets graph stream but model.invocation stays at 2. With mode answer-only, first line
  // of _generate checks mode first — good, returns answer-only regardless of invocation.
  const afterFirst = events.length
  const followReply = await manager.chat(ready.id, 'what next for the heap?')
  assert.match(followReply, /Follow-up|guidance|heap/i)
  assert.deepEqual(
    manager.list().find((session) => session.id === ready.id)?.dynamicModuleIds,
    [related.id],
  )
  assert.equal(
    events.slice(afterFirst).filter((event) => event.type === 'knowledge_module_selected').length,
    0,
  )

  // 3) Unload removes future activity but does not roll back completed answers.
  const completedFinals = events.filter((event) => event.type === 'final')
  assert.ok(completedFinals.length >= 2)
  manager.unloadKnowledgeModule(ready.id, related.id)
  assert.deepEqual(
    manager.list().find((session) => session.id === ready.id)?.dynamicModuleIds,
    [],
  )
  assert.deepEqual(
    events.filter((event) => event.type === 'final'),
    completedFinals,
  )

  // 4) Unauthorized owned module cannot be selected on a fresh session.
  manager.close(ready.id)
  plan = { ...plan, mode: 'select-unauthorized' }
  await manager.connect({
    host: 'server.example',
    port: 22,
    username: 'operator',
    password: 'secret',
  })
  const unauthorizedSession = await waitForReady(manager)
  const unauthorizedEvents: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => unauthorizedEvents.push(event))
  const refused = await manager.chat(unauthorizedSession.id, 'load owned only')
  assert.match(refused, /Unauthorized|refused/i)
  assert.equal(
    unauthorizedEvents.some((event) => event.type === 'knowledge_module_selected'),
    false,
  )
  assert.deepEqual(
    manager.list().find((session) => session.id === unauthorizedSession.id)?.dynamicModuleIds,
    [],
  )
})
