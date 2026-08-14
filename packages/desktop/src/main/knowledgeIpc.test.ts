import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  KnowledgeRepository,
  type EnvironmentDetail,
  type KnowledgeModuleDetail,
} from '@spotshell/core'
import { IpcChannels } from '../shared/ipc-types'
import { registerKnowledgeIpc, type KnowledgeIpcRegistrar } from './knowledgeIpc'
import { ModuleAuthorizationStore } from './ModuleAuthorizationStore'

test('knowledge IPC handlers validate payloads before updating the real repository', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-knowledge-ipc-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(rootPath)
  const authorizationStore = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  const registrar: KnowledgeIpcRegistrar = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
  }
  registerKnowledgeIpc(registrar, repository, authorizationStore)

  const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const handler = handlers.get(channel)
    assert.ok(handler, `missing handler for ${channel}`)
    return await handler({}, payload) as T
  }

  await assert.rejects(
    () => invoke(IpcChannels.knowledgeCreate, { name: 'Module', id: 'forged' }),
    /Invalid payload/
  )
  const created = await invoke<KnowledgeModuleDetail>(
    IpcChannels.knowledgeCreate,
    { name: 'Nginx module' }
  )
  assert.equal((await invoke<KnowledgeModuleDetail[]>(IpcChannels.knowledgeList)).length, 1)

  await assert.rejects(
    () => invoke(IpcChannels.knowledgeSaveFormDraft, {
      id: created.id,
      form: { ...created.form, revision: 99 },
    }),
    /Invalid payload/
  )
  const invalidDraft = await invoke<KnowledgeModuleDetail>(
    IpcChannels.knowledgeSaveSourceDraft,
    { id: created.id, source: 'unfinished source' }
  )
  assert.match(invalidDraft.draftValidationError ?? '', /frontmatter/)
  await assert.rejects(
    () => invoke(IpcChannels.knowledgePublish, { id: created.id, extra: true }),
    /Invalid payload/
  )
});

test('environment IPC handlers validate managed fields and update the real repository', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-environment-ipc-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(rootPath)
  const authorizationStore = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  registerKnowledgeIpc({
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
  }, repository, authorizationStore)

  const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const handler = handlers.get(channel)
    assert.ok(handler, `missing handler for ${channel}`)
    return await handler({}, payload) as T
  }

  await assert.rejects(
    () => invoke(IpcChannels.environmentCreate, { name: 'Production', id: 'forged' }),
    /Invalid payload/
  )
  const created = await invoke<EnvironmentDetail>(
    IpcChannels.environmentCreate,
    { name: 'Production' }
  )
  assert.equal((await invoke<EnvironmentDetail[]>(IpcChannels.environmentList)).length, 1)

  await assert.rejects(
    () => invoke(IpcChannels.environmentSaveFormDraft, {
      id: created.id,
      form: { ...created.form, revision: 99 },
    }),
    /Invalid payload/
  )
  const invalidDraft = await invoke<EnvironmentDetail>(
    IpcChannels.environmentSaveSourceDraft,
    { id: created.id, source: `${created.source}\n## Guidance\n\nUnsafe rule.\n` }
  )
  assert.match(invalidDraft.draftValidationError ?? '', /must not contain ## Guidance/)
  await assert.rejects(
    () => invoke(IpcChannels.environmentPublish, { id: created.id, extra: true }),
    /Invalid payload/
  )
})

test('global authorization requires an eligible revision and revocation updates module access', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-knowledge-authorization-ipc-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(path.join(rootPath, 'knowledge'))
  const authorizationStore = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  registerKnowledgeIpc({
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
  }, repository, authorizationStore)
  const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const handler = handlers.get(channel)
    assert.ok(handler, `missing handler for ${channel}`)
    return await handler({}, payload) as T
  }
  const created = await repository.createDraft({ name: 'Linux diagnostics' })
  await repository.publishDraft(created.id)

  await assert.rejects(
    () => invoke(IpcChannels.knowledgeSetGlobalOnDemand, { id: created.id, authorized: true }),
    /eligible published revision/
  )
  await assert.rejects(
    () => invoke(IpcChannels.knowledgeSetGlobalOnDemand, { id: created.id, authorized: 'yes' }),
    /Invalid payload/
  )

  await repository.saveFormDraft(created.id, {
    ...created.form!,
    description: 'Linux service diagnostic references.',
    whenToUse: 'Use while diagnosing Linux service failures.',
    beforeGuidance: '# Linux diagnostics\n\nInspect service state and logs.',
  })
  await repository.publishDraft(created.id)
  await invoke(IpcChannels.knowledgeSetGlobalOnDemand, { id: created.id, authorized: true })
  const authorized = await invoke<Array<{
    id: string
    automaticCandidateEligible: boolean
    globalOnDemand: boolean
  }>>(IpcChannels.knowledgeList)
  assert.deepEqual(authorized.map((module) => ({
    id: module.id,
    eligible: module.automaticCandidateEligible,
    authorized: module.globalOnDemand,
  })), [{ id: created.id, eligible: true, authorized: true }])

  const current = await repository.getModule(created.id)
  await repository.saveFormDraft(created.id, {
    ...current.form!,
    description: 'Describe what this knowledge module contains.',
  })
  await repository.publishDraft(created.id)
  const unavailable = await invoke<Array<{
    automaticCandidateEligible: boolean
    globalOnDemand: boolean
  }>>(IpcChannels.knowledgeList)
  assert.deepEqual(unavailable.map((module) => ({
    eligible: module.automaticCandidateEligible,
    authorized: module.globalOnDemand,
  })), [{ eligible: false, authorized: true }])

  await invoke(IpcChannels.knowledgeSetGlobalOnDemand, { id: created.id, authorized: false })
  const revoked = await invoke<Array<{ globalOnDemand: boolean }>>(IpcChannels.knowledgeList)
  assert.equal(revoked[0]?.globalOnDemand, false)
})

test('managed file IPC creates snapshots and rejects forged payload fields', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-managed-files-ipc-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(rootPath)
  const authorizationStore = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  registerKnowledgeIpc({
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
  }, repository, authorizationStore)

  const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const handler = handlers.get(channel)
    assert.ok(handler, `missing handler for ${channel}`)
    return await handler({ sender: {} }, payload) as T
  }

  const created = await invoke<KnowledgeModuleDetail>(
    IpcChannels.knowledgeCreate,
    { name: 'File host' }
  )
  await assert.rejects(
    () => invoke(IpcChannels.managedFilesCreate, {
      id: created.id,
      relativePath: 'notes/a.md',
      content: 'hello\n',
      forged: true,
    }),
    /Invalid payload/
  )
  const listed = await invoke<{ files: Array<{ relativePath: string }> }>(
    IpcChannels.managedFilesCreate,
    { id: created.id, relativePath: 'notes/a.md', content: 'hello\n' }
  )
  assert.deepEqual(listed.files.map((file) => file.relativePath), ['notes/a.md'])
})

test('revision history IPC lists, restores, and cleans up with protection pins', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-revision-ipc-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(rootPath)
  const authorizationStore = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  let publishedChangeNotifications = 0
  registerKnowledgeIpc({
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
  }, repository, authorizationStore, undefined, undefined, () => {
    publishedChangeNotifications += 1
  })

  const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const handler = handlers.get(channel)
    assert.ok(handler, `missing handler for ${channel}`)
    return await handler({ sender: {} }, payload) as T
  }

  const created = await invoke<KnowledgeModuleDetail>(
    IpcChannels.knowledgeCreate,
    { name: 'Revision IPC module' },
  )
  await invoke(IpcChannels.knowledgeSaveFormDraft, {
    id: created.id,
    form: {
      ...created.form!,
      description: 'History over IPC.',
      whenToUse: 'When testing revisions.',
      beforeGuidance: '# r1\n',
    },
  })
  await invoke(IpcChannels.knowledgePublish, { id: created.id })
  await invoke(IpcChannels.knowledgeSaveFormDraft, {
    id: created.id,
    form: {
      ...created.form!,
      description: 'History over IPC.',
      whenToUse: 'When testing revisions.',
      beforeGuidance: '# r2\n',
    },
  })
  await invoke(IpcChannels.knowledgePublish, { id: created.id })

  await assert.rejects(
    () => invoke(IpcChannels.knowledgeListRevisions, { id: created.id, forged: true }),
    /Invalid payload/,
  )

  assert.equal(publishedChangeNotifications, 2)
  const history = await invoke<Array<{ revision: number; isCurrentEffective: boolean }>>(
    IpcChannels.knowledgeListRevisions,
    { id: created.id, agentActiveRevisions: [1] },
  )
  assert.equal(history.length, 2)
  assert.equal(history[0]?.revision, 2)
  assert.equal(history[0]?.isCurrentEffective, true)

  const restored = await invoke<{ revision: number }>(
    IpcChannels.knowledgeRestoreRevision,
    { id: created.id, revision: 1 },
  )
  assert.equal(restored.revision, 3)

  const preview = await invoke<{ removableRevisions: number[]; blockedRevisions: unknown[] }>(
    IpcChannels.knowledgePreviewRevisionCleanup,
    { id: created.id, revisions: [1, 3], agentActiveRevisions: [1] },
  )
  assert.ok(preview.blockedRevisions.length >= 1)

  const cleaned = await invoke<{ removedRevisions: number[] }>(
    IpcChannels.knowledgeCleanupRevisions,
    { id: created.id, revisions: [2] },
  )
  assert.deepEqual(cleaned.removedRevisions, [2])
})

test('trash IPC previews blockers, moves, restores, and permanently deletes', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-trash-ipc-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(rootPath)
  const authorizationStore = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  let boundHosts: Array<{ hostId: string; hostName: string }> = []
  registerKnowledgeIpc({
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
  }, repository, authorizationStore, {
    listBoundHosts: () => boundHosts,
  })

  const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const handler = handlers.get(channel)
    assert.ok(handler, `missing handler for ${channel}`)
    return await handler({ sender: {} }, payload) as T
  }

  const module = await invoke<KnowledgeModuleDetail>(
    IpcChannels.knowledgeCreate,
    { name: 'Trashable module' },
  )
  await invoke(IpcChannels.knowledgeSaveFormDraft, {
    id: module.id,
    form: {
      ...module.form!,
      description: 'For trash IPC.',
      whenToUse: 'When testing trash.',
      beforeGuidance: '# body\n',
    },
  })
  await invoke(IpcChannels.knowledgePublish, { id: module.id })

  const environment = await invoke<EnvironmentDetail>(
    IpcChannels.environmentCreate,
    { name: 'Bound environment' },
  )
  await invoke(IpcChannels.environmentSaveFormDraft, {
    id: environment.id,
    form: {
      ...environment.form!,
      description: 'Env facts',
      always: [module.id],
      onDemand: [],
      body: '# Env\n',
    },
  })
  await invoke(IpcChannels.environmentPublish, { id: environment.id })

  await assert.rejects(
    () => invoke(IpcChannels.knowledgePreviewDelete, { id: module.id, forged: true }),
    /Invalid payload/,
  )

  const modulePreview = await invoke<{ canDelete: boolean; referencedBy: unknown[] }>(
    IpcChannels.knowledgePreviewDelete,
    { id: module.id },
  )
  assert.equal(modulePreview.canDelete, false)
  assert.equal(modulePreview.referencedBy.length, 1)

  boundHosts = [{ hostId: 'h1', hostName: 'db-1' }]
  const envPreview = await invoke<{ canDelete: boolean; blockers: Array<{ code: string }> }>(
    IpcChannels.environmentPreviewDelete,
    { id: environment.id },
  )
  assert.equal(envPreview.canDelete, false)
  assert.equal(envPreview.blockers[0]?.code, 'environment-bound')

  boundHosts = []
  // Unlink module then trash both
  await invoke(IpcChannels.environmentSaveFormDraft, {
    id: environment.id,
    form: {
      ...environment.form!,
      description: 'Env facts',
      always: [],
      onDemand: [],
      body: '# Env\n',
    },
  })
  await invoke(IpcChannels.environmentPublish, { id: environment.id })

  const trashedModule = await invoke<{ id: string; kind: string }>(
    IpcChannels.knowledgeMoveToTrash,
    { id: module.id },
  )
  assert.equal(trashedModule.id, module.id)
  assert.equal(trashedModule.kind, 'knowledge')

  const trashedEnv = await invoke<{ id: string }>(
    IpcChannels.environmentMoveToTrash,
    { id: environment.id },
  )
  assert.equal(trashedEnv.id, environment.id)

  const trashList = await invoke<Array<{ id: string }>>(IpcChannels.trashList)
  assert.equal(trashList.length, 2)

  const restored = await invoke<{ id: string }>(IpcChannels.trashRestore, { id: module.id })
  assert.equal(restored.id, module.id)

  await invoke(IpcChannels.trashPermanentDelete, { id: environment.id })
  assert.equal((await invoke<unknown[]>(IpcChannels.trashList)).length, 0)
})

test('external edit IPC scans, rejects invalid adopt, and restores last valid content', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-external-ipc-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(rootPath)
  const authorizationStore = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  registerKnowledgeIpc({
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
  }, repository, authorizationStore)

  const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const handler = handlers.get(channel)
    assert.ok(handler, `missing handler for ${channel}`)
    return await handler({ sender: {} }, payload) as T
  }

  const created = await invoke<KnowledgeModuleDetail>(
    IpcChannels.knowledgeCreate,
    { name: 'External IPC' },
  )
  await invoke(IpcChannels.knowledgeSaveFormDraft, {
    id: created.id,
    form: {
      ...created.form,
      description: 'External edit module',
      whenToUse: 'When testing external adopt',
      beforeGuidance: '# External\n',
    },
  })
  await invoke(IpcChannels.managedFilesCreate, {
    id: created.id,
    relativePath: 'notes.md',
    content: 'v1\n',
  })
  const published = await invoke<{ revision: number; contentHash: string }>(
    IpcChannels.knowledgePublish,
    { id: created.id },
  )

  await assert.rejects(
    () => invoke(IpcChannels.knowledgeScanExternalChanges, { id: created.id, extra: true }),
    /Invalid payload/,
  )

  fs.writeFileSync(
    path.join(rootPath, created.id, 'draft-files', 'notes.md'),
    'v2 external\n',
    'utf8',
  )

  const preview = await invoke<{
    status: string
    canAdopt: boolean
    files: Array<{ relativePath: string; change: string }>
  }>(IpcChannels.knowledgePreviewExternalChanges, { id: created.id })
  assert.equal(preview.status, 'pending')
  assert.equal(preview.canAdopt, true)
  assert.ok(preview.files.some((file) => file.relativePath === 'notes.md' && file.change === 'modified'))

  const adopted = await invoke<{ revision: number; origin?: string }>(
    IpcChannels.knowledgeAdoptExternalChanges,
    { id: created.id },
  )
  assert.equal(adopted.revision, published.revision + 1)
  assert.equal(adopted.origin, 'external')

  fs.writeFileSync(
    path.join(rootPath, created.id, 'draft-files', 'notes.md'),
    'dirty again\n',
    'utf8',
  )
  const pending = await invoke<{ status: string }>(
    IpcChannels.knowledgeScanExternalChanges,
    { id: created.id },
  )
  assert.equal(pending.status, 'pending')

  const restored = await invoke<{ status: string }>(
    IpcChannels.knowledgeDiscardExternalChanges,
    { id: created.id },
  )
  assert.equal(restored.status, 'clean')
  assert.equal(
    fs.readFileSync(path.join(rootPath, created.id, 'draft-files', 'notes.md'), 'utf8'),
    'v2 external\n',
  )
})
