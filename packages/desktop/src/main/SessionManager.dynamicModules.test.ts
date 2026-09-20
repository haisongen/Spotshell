import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  KnowledgeRepository,
  SpotShellAgent,
  type CommandResult,
  type SSHClient,
} from '@spotshell/core'
import type { AgentEvent, SessionSummary } from '../shared/ipc-types'
import { KnowledgeCatalogService } from './KnowledgeCatalogService'
import { ModuleAuthorizationStore } from './ModuleAuthorizationStore'
import { createFauxModelProvider, loadPiAi } from '@spotshell/core/testing'
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
/**
 * Replaces the hand-rolled langchain fake. Each phase of the test scripts the
 * provider explicitly instead of flipping a shared `plan` flag, so what the
 * model is about to do is visible at the call site.
 */
async function selectModulePhase(objectId: string, reason: string, answer: string) {
  const { fauxAssistantMessage, fauxToolCall } = await loadPiAi()
  return [
    fauxAssistantMessage([
      fauxToolCall('select_knowledge_module', { objectId, reason }, { id: 'select-1' }),
    ]),
    fauxAssistantMessage(answer),
  ]
}

async function answerOnlyPhase(answer: string) {
  const { fauxAssistantMessage } = await loadPiAi()
  return [fauxAssistantMessage(answer)]
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

  const model = await createFauxModelProvider({
    responses: await selectModulePhase(
      related.id,
      'User asked about JVM heap pressure',
      'Loaded JVM guidance for heap pressure.',
    ),
  })

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
      { providerResolver: () => model.provider },
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
  // Follow-up on the same session and the same agent: re-script the provider so
  // the next turn answers directly instead of selecting a module again. The old
  // langchain fake needed an invocation counter here; the faux provider replays
  // a queue, so the phase is just a new response list.
  model.setResponses(await answerOnlyPhase('Follow-up with active module guidance.'))
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
  model.setResponses(await selectModulePhase(
    ownedOnly.id,
    'try unauthorized',
    'Unauthorized module was refused.',
  ))
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
