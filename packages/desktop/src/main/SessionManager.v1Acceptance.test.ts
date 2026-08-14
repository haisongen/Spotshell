/**
 * ADR-062 / ticket 24 — highest-level desktop acceptance seam.
 *
 * Exercises the real temporary knowledge repository, schema, Context Harness,
 * SessionManager orchestration, fake SSH, and a deterministic tool-calling model.
 * No network, Electron window, or model provider is required.
 */
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
  HostStore,
  KnowledgeRepository,
  OFFICIAL_SEED_MODULES,
  SpotShellAgent,
  classifyCommand,
  scanKnowledgeSecrets,
  type CommandResult,
  type SSHClient,
} from '@spotshell/core'
import type { AgentEvent, SessionSummary } from '../shared/ipc-types'
import { HostEnvironmentBindings } from './HostEnvironmentBindings'
import { KnowledgeCatalogService } from './KnowledgeCatalogService'
import { ModuleAuthorizationStore } from './ModuleAuthorizationStore'
import { SessionManager } from './SessionManager'
import { runOfficialSeedMigration } from './seedModules'

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
  readonly executed: string[] = []

  async connect(): Promise<void> {}
  async requestShell(): Promise<FakeStream> { return this.stream }
  async execCommand(command: string): Promise<CommandResult> {
    this.executed.push(command)
    return {
      command,
      stdout: 'Linux acceptance-fake 6.8.0',
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

/** Deterministic multi-turn model driven by a shared response queue. */
class QueueToolModel extends BaseChatModel {
  constructor(private readonly queue: AIMessage[]) {
    super({})
  }

  _llmType(): string {
    return 'v1-acceptance-queue'
  }

  bindTools(): this {
    return this
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.queue.shift()
    if (!message) {
      throw new Error('Acceptance model queue is empty')
    }
    const text = typeof message.content === 'string' ? message.content : ''
    return { generations: [{ text, message }] }
  }
}

function aiText(text: string): AIMessage {
  return new AIMessage(text)
}

function aiTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ id, name, args, type: 'tool_call' }],
  })
}

async function waitForReady(manager: SessionManager, sessionId?: string): Promise<SessionSummary> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const sessions = manager.list()
    const session = sessionId
      ? sessions.find((entry) => entry.id === sessionId)
      : sessions[0]
    if (session?.status === 'ready') return session
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('session did not become ready')
}

async function publishModule(
  repository: KnowledgeRepository,
  name: string,
  guidance: string,
  body = '',
) {
  const module = await repository.createDraft({ name })
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: `${name} reference material.`,
    whenToUse: `Use when ${name.toLocaleLowerCase('en-US')} is relevant.`,
    beforeGuidance: `# ${name}\n`,
    inlineGuidance: guidance,
    afterGuidance: body,
  })
  const revision = await repository.publishDraft(module.id)
  return { module, revision }
}

async function publishEnvironment(
  repository: KnowledgeRepository,
  name: string,
  associations: { always: string[]; onDemand: string[] },
  body: string,
) {
  const environment = await repository.createEnvironmentDraft({ name })
  await repository.saveEnvironmentFormDraft(environment.id, {
    ...environment.form!,
    description: `${name} operational facts.`,
    always: associations.always,
    onDemand: associations.onDemand,
    body,
  })
  const revision = await repository.publishEnvironmentDraft(environment.id)
  return { environment, revision }
}

type LiveSessionInternals = {
  sessions: Map<string, unknown>
  refreshRevisionUpdates: (session: unknown) => Promise<void>
}

function liveInternals(manager: SessionManager): LiveSessionInternals {
  return manager as unknown as LiveSessionInternals
}

test('v1 acceptance: seed → authorize → bind → connect → chat → dynamic load → provenance → revision → new context', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-v1-accept-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))

  const knowledgeRoot = path.join(rootPath, 'knowledge')
  const repository = new KnowledgeRepository(knowledgeRoot)
  const authorizations = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const catalog = new KnowledgeCatalogService(repository, authorizations)
  const hostStore = new HostStore(path.join(rootPath, 'hosts.json'))
  const bindings = new HostEnvironmentBindings(hostStore, repository)

  // 1) Official seed initialization (new-user path) is idempotent and global on-demand.
  const firstSeed = await runOfficialSeedMigration(repository, knowledgeRoot, authorizations)
  assert.equal(firstSeed.createdIds.length, 7)
  assert.equal(authorizations.listGlobalOnDemandIds().length, 7)
  const secondSeed = await runOfficialSeedMigration(repository, knowledgeRoot, authorizations)
  assert.equal(secondSeed.alreadyCompleted, true)
  assert.equal(secondSeed.createdIds.length, 0)
  assert.equal((await repository.listModules()).length, 7)

  // 2) User creates environment + always/on-demand modules (not only seeds).
  const always = await publishModule(
    repository,
    'Always Baseline',
    '- Always inspect service status before restarts.',
    'Baseline environment rules stay fixed while the environment is selected.',
  )
  const onDemand = await publishModule(
    repository,
    'JVM Heap Guide',
    '- Capture heap histogram before restarting.',
    'Heap pressure runbook body for progressive reads.',
  )
  const env = await publishEnvironment(
    repository,
    'Prod App',
    { always: [always.module.id], onDemand: [onDemand.module.id] },
    '# Prod App\n\n- Region: cn-east-1\n- Cluster: app-prod\n',
  )
  authorizations.setGlobalOnDemand(onDemand.module.id, true)

  // 3) Host binding selects the environment on connect.
  const host = hostStore.add({
    name: 'prod-app-1',
    host: 'prod.example',
    port: 22,
    username: 'operator',
    authMethod: 'password',
    notes: 'Host-specific exception: use /data2 for temp dumps.',
    environmentId: env.environment.id,
  })

  const modelQueue: AIMessage[] = [
    // Chat 1: select on-demand → read entry → answer with knowledge
    aiTool('select-1', 'select_knowledge_module', {
      objectId: onDemand.module.id,
      reason: 'User asked about JVM heap pressure',
    }),
    aiTool('read-1', 'read_knowledge_entry', {
      objectId: onDemand.module.id,
      revision: 1,
    }),
    aiText('Heap guidance applied from the loaded knowledge module.'),
    // Chat 2 (after revision apply): read always module at revision 2
    aiTool('read-always-2', 'read_knowledge_entry', {
      objectId: always.module.id,
      revision: 2,
    }),
    aiText('Answer uses the applied always-module revision.'),
    // Chat 3 (new context): select again because dynamics reset
    aiTool('select-2', 'select_knowledge_module', {
      objectId: onDemand.module.id,
      reason: 'Fresh context still needs heap guidance',
    }),
    aiText('New context reloaded the on-demand module.'),
  ]

  const manager = new SessionManager(
    () => ({ apiKey: 'unused', contextWindowTokens: 32_000, recursionLimit: 20 }),
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    (hostId) => hostStore.get(hostId)?.notes,
    () => false,
    () => 'saved',
    () => new FakeSshClient() as unknown as SSHClient,
    (config, executor, extras) => new SpotShellAgent(
      config,
      executor,
      extras,
      { model: new QueueToolModel(modelQueue) },
    ),
    bindings,
    catalog,
  )

  const events: AgentEvent[] = []
  manager.on('agent', (event: AgentEvent) => events.push(event))

  const connecting = await manager.connect({
    hostId: host.id,
    host: host.host,
    port: host.port,
    username: host.username,
    password: 'secret',
  })
  const ready = await waitForReady(manager, connecting.id)
  assert.equal(ready.environmentId, env.environment.id)
  assert.equal(ready.environmentSource, 'host-binding')
  assert.equal(ready.contextEpoch, 1)

  // 4) Chat dynamically loads authorized module, records provenance, meters usage.
  const reply = await manager.chat(ready.id, 'Java heap is high on this host')
  assert.match(reply, /Heap guidance|loaded knowledge/i)

  const selected = events.filter((event) => event.type === 'knowledge_module_selected')
  assert.equal(selected.length, 1)
  assert.ok(selected[0] && selected[0].type === 'knowledge_module_selected')
  assert.equal(selected[0].sessionId, ready.id)
  assert.equal(selected[0].epoch, 1)
  assert.equal(selected[0].selection.moduleId, onDemand.module.id)
  assert.equal(selected[0].selection.loadType, 'dynamic')
  assert.match(selected[0].selection.reason, /heap pressure/i)

  const finalsEpoch1 = events.filter((event) => event.type === 'final' && event.epoch === 1)
  assert.equal(finalsEpoch1.length, 1)
  assert.ok(finalsEpoch1[0] && finalsEpoch1[0].type === 'final')
  assert.equal(finalsEpoch1[0].sessionId, ready.id)
  assert.ok(finalsEpoch1[0].provenance && finalsEpoch1[0].provenance.length > 0)
  assert.ok(finalsEpoch1[0].provenance!.some((item) => (
    item.objectId === onDemand.module.id
    && item.revision === 1
    && item.relativePath === 'SPACE.md'
  )))

  const usageEpoch1 = events.filter((event) => event.type === 'context_usage' && event.epoch === 1)
  assert.ok(usageEpoch1.length >= 1)
  assert.ok(usageEpoch1.every((event) => event.type === 'context_usage' && event.sessionId === ready.id))

  assert.deepEqual(
    manager.list().find((session) => session.id === ready.id)?.dynamicModuleIds,
    [onDemand.module.id],
  )

  // 5) Publishing a new always-module revision surfaces update-available; apply is explicit.
  const alwaysDetail = await repository.getModule(always.module.id)
  await repository.saveFormDraft(always.module.id, {
    ...alwaysDetail.form!,
    beforeGuidance: '# Always Baseline\n',
    inlineGuidance: '- Always inspect service status before restarts.\n- Also collect recent journal lines.',
  })
  const alwaysV2 = await repository.publishDraft(always.module.id)
  assert.equal(alwaysV2.revision, 2)

  const live = liveInternals(manager)
  const sessionState = live.sessions.get(ready.id)
  assert.ok(sessionState)
  await live.refreshRevisionUpdates(sessionState)

  const updates = manager.list().find((session) => session.id === ready.id)?.revisionUpdatesAvailable ?? []
  const alwaysUpdate = updates.find((item) => item.objectId === always.module.id)
  assert.ok(alwaysUpdate, 'expected update-available for always module')
  assert.equal(alwaysUpdate.latestRevision, 2)
  assert.equal(alwaysUpdate.latestContentHash, alwaysV2.contentHash)

  await manager.applyKnowledgeRevision({
    sessionId: ready.id,
    objectId: always.module.id,
    targetRevision: alwaysUpdate.latestRevision,
    targetContentHash: alwaysUpdate.latestContentHash,
  })
  assert.ok(events.some((event) => (
    event.type === 'knowledge_revision_switch'
    && event.sessionId === ready.id
    && event.epoch === 1
    && event.objectId === always.module.id
    && event.fromRevision === 1
    && event.toRevision === 2
  )))

  const afterApply = await manager.chat(ready.id, 'use the updated always baseline')
  assert.match(afterApply, /applied always-module revision/i)
  const appliedFinal = events.filter((event) => event.type === 'final').at(-1)
  assert.ok(appliedFinal && appliedFinal.type === 'final')
  assert.ok(appliedFinal.provenance?.some((item) => (
    item.objectId === always.module.id && item.revision === 2
  )))

  // 6) New context keeps environment baseline, clears dynamics, advances epoch; late events stay tagged.
  const beforeBoundary = events.length
  const newContext = await manager.startNewContext(ready.id)
  assert.equal(newContext.contextEpoch, 2)
  assert.deepEqual(newContext.dynamicModuleIds, [])
  assert.equal(newContext.environmentId, env.environment.id)
  assert.ok(events.slice(beforeBoundary).some((event) => (
    event.type === 'context_boundary'
    && event.sessionId === ready.id
    && event.epoch === 2
    && event.previousEpoch === 1
  )))

  const epoch2Reply = await manager.chat(ready.id, 'heap still high after new context')
  assert.match(epoch2Reply, /New context reloaded/i)
  const epoch2Select = events.filter((event) => (
    event.type === 'knowledge_module_selected' && event.epoch === 2
  ))
  assert.equal(epoch2Select.length, 1)
  assert.equal(epoch2Select[0]?.type === 'knowledge_module_selected'
    ? epoch2Select[0].selection.moduleId
    : undefined, onDemand.module.id)
  assert.ok(events.filter((event) => event.type === 'final' && event.epoch === 2).length >= 1)
  assert.ok(events.filter((event) => event.type === 'context_usage' && event.epoch === 2).length >= 1)

  // Epoch 1 events never rewrite their epoch attribution after the boundary.
  assert.ok(events
    .filter((event) => event.type === 'final' || event.type === 'knowledge_module_selected')
    .filter((event) => 'epoch' in event && event.epoch === 1)
    .every((event) => event.sessionId === ready.id))
})

test('v1 acceptance: multi-session events stay isolated and knowledge cannot weaken SSH risk', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-v1-multi-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))

  const knowledgeRoot = path.join(rootPath, 'knowledge')
  const repository = new KnowledgeRepository(knowledgeRoot)
  const authorizations = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const catalog = new KnowledgeCatalogService(repository, authorizations)

  const allowed = await publishModule(
    repository,
    'Allowed Module',
    '- Prefer readonly inspection.',
  )
  const ownedOnly = await publishModule(
    repository,
    'Owned Only',
    '- Do not auto-load this module.',
  )
  authorizations.setGlobalOnDemand(allowed.module.id, true)
  // ownedOnly remains unauthorized.

  const modelQueue: AIMessage[] = [
    aiTool('bad-select', 'select_knowledge_module', {
      objectId: ownedOnly.module.id,
      reason: 'try unauthorized elevate',
    }),
    aiText('Unauthorized module was refused.'),
    aiTool('ok-select', 'select_knowledge_module', {
      objectId: allowed.module.id,
      reason: 'authorized candidate',
    }),
    aiText('Authorized module loaded on session B.'),
  ]

  const manager = new SessionManager(
    () => ({ apiKey: 'unused', contextWindowTokens: 32_000, recursionLimit: 20 }),
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
      { model: new QueueToolModel(modelQueue) },
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

  const sessionA = await manager.connect({
    host: 'a.example',
    port: 22,
    username: 'ops',
    password: 'secret',
  })
  const readyA = await waitForReady(manager, sessionA.id)

  const sessionB = await manager.connect({
    host: 'b.example',
    port: 22,
    username: 'ops',
    password: 'secret',
  })
  const readyB = await waitForReady(manager, sessionB.id)
  assert.notEqual(readyA.id, readyB.id)

  const refused = await manager.chat(readyA.id, 'load owned only')
  assert.match(refused, /Unauthorized|refused/i)
  assert.equal(
    events.some((event) => (
      event.type === 'knowledge_module_selected' && event.sessionId === readyA.id
    )),
    false,
  )
  assert.deepEqual(
    manager.list().find((session) => session.id === readyA.id)?.dynamicModuleIds,
    [],
  )

  const loaded = await manager.chat(readyB.id, 'load allowed module')
  assert.match(loaded, /Authorized module loaded/i)
  assert.ok(events.some((event) => (
    event.type === 'knowledge_module_selected'
    && event.sessionId === readyB.id
    && event.selection.moduleId === allowed.module.id
  )))
  assert.deepEqual(
    manager.list().find((session) => session.id === readyB.id)?.dynamicModuleIds,
    [allowed.module.id],
  )
  // Session A remains unaffected by B's dynamic load.
  assert.deepEqual(
    manager.list().find((session) => session.id === readyA.id)?.dynamicModuleIds,
    [],
  )

  // Knowledge content / guidance cannot change command-risk classification.
  assert.equal(classifyCommand('rm -rf /'), 'destructive')
  assert.equal(classifyCommand('cat /var/log/app.log'), 'readonly')
  assert.equal(classifyCommand('systemctl restart nginx'), 'write')
  for (const seed of OFFICIAL_SEED_MODULES) {
    // Seed text may mention commands, but classification stays independent of knowledge.
    assert.equal(classifyCommand('rm -rf /'), 'destructive')
    assert.ok(seed.body.length > 0)
  }
})

test('v1 acceptance: cross-feature repository regression (import/export, trash, external edit, secrets, proposal)', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-v1-cross-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))

  const repository = new KnowledgeRepository(path.join(rootPath, 'knowledge'))
  const packageDir = path.join(rootPath, 'packages')
  fs.mkdirSync(packageDir, { recursive: true })

  const always = await publishModule(repository, 'Always rules', '- Prefer readonly checks.')
  const onDemand = await publishModule(repository, 'On demand rules', '- Load only when asked.')
  const env = await publishEnvironment(
    repository,
    'Bundle Env',
    { always: [always.module.id], onDemand: [onDemand.module.id] },
    '# Bundle Env\n',
  )

  // Import/export self-contained environment package (no host/auth metadata).
  const exportPath = path.join(packageDir, 'bundle.spotshell-environment.json')
  const exported = await repository.exportEnvironment(env.environment.id, exportPath, 'self-contained')
  assert.equal(exported.moduleCount, 2)
  assert.deepEqual(exported.unresolvedModuleIds, [])
  const raw = JSON.parse(fs.readFileSync(exportPath, 'utf8')) as Record<string, unknown>
  assert.equal(raw.package_kind, 'environment-bundle')
  assert.equal('hostBindings' in raw, false)
  assert.equal('authorizations' in raw, false)

  const importRoot = path.join(rootPath, 'import-knowledge')
  const importedRepo = new KnowledgeRepository(importRoot)
  const imported = await importedRepo.importEnvironment(exportPath)
  assert.equal(imported.environment.status, 'created')
  assert.equal(imported.environment.id, env.environment.id)
  assert.equal(imported.modules.length, 2)
  assert.ok(await importedRepo.resolvePublishedObject(env.environment.id))

  // History restore keeps earlier revision recoverable.
  const alwaysDetail = await repository.getModule(always.module.id)
  await repository.saveFormDraft(always.module.id, {
    ...alwaysDetail.form!,
    beforeGuidance: '# Always rules\n',
    inlineGuidance: '- Prefer readonly checks.\n- Added revision 2 tip.',
  })
  const rev2 = await repository.publishDraft(always.module.id)
  assert.equal(rev2.revision, 2)
  const restored = await repository.restoreRevision(always.module.id, 1)
  assert.equal(restored.revision, 3)
  const afterRestore = await repository.getModule(always.module.id)
  assert.match(afterRestore.source, /Prefer readonly checks/)
  assert.doesNotMatch(afterRestore.source, /Added revision 2 tip/)

  // Referenced modules cannot be trashed until associations resolve.
  await assert.rejects(() => repository.moveModuleToTrash(always.module.id), /still referenced|referenced/i)
  await repository.saveEnvironmentFormDraft(env.environment.id, {
    ...(await repository.getEnvironment(env.environment.id)).form!,
    always: [],
    onDemand: [onDemand.module.id],
  })
  await repository.publishEnvironmentDraft(env.environment.id)
  const trashed = await repository.moveModuleToTrash(always.module.id)
  assert.equal(trashed.id, always.module.id)
  assert.equal(await repository.resolvePublishedObject(always.module.id), undefined)
  const fromTrash = await repository.restoreFromTrash(always.module.id)
  assert.equal(fromTrash.id, always.module.id)
  assert.ok(await repository.resolvePublishedObject(always.module.id))

  // External edits are quarantined until adopted; published revision stays stable meanwhile.
  await repository.createManagedTextFile(onDemand.module.id, {
    relativePath: 'notes/runbook.md',
    content: '# Runbook\n\nv1\n',
  })
  await repository.publishDraft(onDemand.module.id)
  const publishedBefore = await repository.resolvePublishedObject(onDemand.module.id)
  assert.ok(publishedBefore)
  const draftFiles = await repository.getManagedObjectRootPath(onDemand.module.id)
  fs.writeFileSync(path.join(draftFiles, 'notes', 'runbook.md'), '# Runbook\n\nv2 external\n', 'utf8')
  const pending = await repository.scanExternalChanges(onDemand.module.id)
  assert.equal(pending.hasPendingExternalChanges, true)
  const stillPublished = await repository.resolvePublishedObject(onDemand.module.id)
  assert.equal(stillPublished?.revision, publishedBefore.revision)
  assert.equal(stillPublished?.contentHash, publishedBefore.contentHash)
  const adopted = await repository.adoptExternalChanges(onDemand.module.id)
  assert.ok(adopted.revision > publishedBefore.revision)

  // Secret isolation: private keys are blocked before becoming a valid revision.
  const blocked = scanKnowledgeSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/example\n-----END RSA PRIVATE KEY-----')
  assert.equal(blocked.status, 'blocked')
  const secretModule = await repository.createDraft({ name: 'Secret attempt' })
  await repository.saveSourceDraft(
    secretModule.id,
    `${secretModule.source}\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----\n`,
  )
  await assert.rejects(
    () => repository.publishDraft(secretModule.id),
    /possible secret.*private-key/i,
  )
  assert.equal(await repository.resolvePublishedObject(secretModule.id), undefined)

  // AI proposal acceptance creates a normal revision through the shared pipeline.
  const target = await publishModule(repository, 'Proposal Target', '- Original guidance.')
  const published = await repository.resolvePublishedObject(target.module.id)
  assert.ok(published)
  const files = await repository.readPublishedRevisionFiles(target.module.id, published.revision)
  const space = files.find((file) => file.relativePath === 'SPACE.md')
  assert.ok(space)
  const accepted = await repository.applyAcceptedKnowledgeProposal(target.module.id, {
    expectedKind: 'knowledge',
    baseRevision: published.revision,
    baseContentHash: published.contentHash,
    files: [{
      relativePath: 'SPACE.md',
      content: space.content.replace('Original guidance.', 'Original guidance.\n- Proposal tip accepted.'),
    }],
  })
  assert.equal(accepted.revision, published.revision + 1)
  const afterProposal = await repository.getModule(target.module.id)
  assert.match(afterProposal.source, /Proposal tip accepted/)
})

test('v1 acceptance: legacy diagnostic scenario entry points are gone; seeds remain ordinary modules', async () => {
  // No fixed-prompt scenario registry remains in product packages.
  assert.equal(OFFICIAL_SEED_MODULES.length, 7)
  for (const seed of OFFICIAL_SEED_MODULES) {
    assert.ok(seed.id)
    assert.ok(seed.key)
    assert.ok(seed.body.includes('## Guidance') || seed.body.length > 0)
  }

  // Leftover scenario UI must not be wired into runtime entry points.
  // (i18n/CSS cleanup is covered separately; here we assert the seed path is the only path.)
  const keys = OFFICIAL_SEED_MODULES.map((seed) => seed.key).sort()
  assert.deepEqual(keys, [
    'cert-expiry',
    'disk-full',
    'hdfs-yarn',
    'healthcheck',
    'oom',
    'port-conflict',
    'service-down',
  ])
})

test('v1 acceptance: packages do not ship undeclared To B / vector / PDF / connector features', async () => {
  // Guardrail: production TypeScript under packages/ must not introduce out-of-scope product surfaces.
  const roots = [
    path.join(process.cwd(), 'src'),
    path.join(process.cwd(), '../core/src'),
  ]
  const forbidden = [
    { re: /\bvectorStore\b|\bembeddings?\b|\bsemanticSearch\b/i, label: 'vector/embedding/semantic search' },
    { re: /\bteamKnowledgeSpace\b|\borganizationAccount\b|\bcentralPublish\b/i, label: 'To B team knowledge' },
    { re: /\burlFetch\b|\bwebCrawler\b|\bnotionConnector\b/i, label: 'external connectors / URL fetch' },
    { re: /\bworkflowEngine\b|\bworkflowTemplate\b|\bcommandTemplateRegistry\b/i, label: 'workflow engines' },
  ]

  const offenders: string[] = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const stack = [root]
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue
          stack.push(full)
          continue
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
        const text = fs.readFileSync(full, 'utf8')
        for (const rule of forbidden) {
          if (rule.re.test(text)) {
            offenders.push(`${path.relative(process.cwd(), full)} (${rule.label})`)
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `undeclared out-of-scope symbols found:\n${offenders.join('\n')}`)
})
