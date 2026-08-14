import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appMenuPopupRequestSchema,
  addHostFolderRequestSchema,
  connectRequestSchema,
  closeSessionsRequestSchema,
  duplicateSessionRequestSchema,
  environmentCreateRequestSchema,
  environmentDraftFormRequestSchema,
  environmentDraftSourceRequestSchema,
  environmentExportRequestSchema,
  environmentIdRequestSchema,
  environmentImportRequestSchema,
  agentChatRequestSchema,
  clipboardTextSchema,
  hostConnectionTestRequestSchema,
  hostIdSchema,
  knowledgeCompareRevisionsRequestSchema,
  knowledgeCreateRequestSchema,
  knowledgeDraftFormRequestSchema,
  knowledgeDraftSourceRequestSchema,
  knowledgeIdRequestSchema,
  knowledgeListRevisionsRequestSchema,
  knowledgeMoveToTrashRequestSchema,
  knowledgePreviewDeleteRequestSchema,
  knowledgeRestoreRevisionRequestSchema,
  knowledgeRevisionCleanupRequestSchema,
  environmentMoveToTrashRequestSchema,
  environmentPreviewDeleteRequestSchema,
  trashIdRequestSchema,
  trashPermanentDeleteRequestSchema,
  moveHostRequestSchema,
  knowledgeTargetRespondSchema,
  llmTestRequestSchema,
  noteRespondSchema,
  removeHostFolderRequestSchema,
  renameHostFolderRequestSchema,
  renameSessionRequestSchema,
  savedHostInputSchema,
  sessionEnvironmentSelectionRequestSchema,
  sessionKnowledgeModuleRequestSchema,
  setPolicySchema,
  settingsUpdateSchema,
  termInputSchema,
} from './ipc-schemas'

test('appMenuPopupRequestSchema accepts every menu id and coordinate edge', () => {
  for (const menuId of ['file', 'edit', 'view', 'window', 'help']) {
    assert.ok(appMenuPopupRequestSchema.safeParse({ menuId, x: 0, y: 10_000 }).success)
  }
})

test('appMenuPopupRequestSchema rejects invalid ids, coordinates, and shapes', () => {
  for (const request of [
    { menuId: 'tools', x: 0, y: 40 },
    { menuId: 'file', x: -1, y: 40 },
    { menuId: 'file', x: 10_001, y: 40 },
    { menuId: 'file', x: 1.5, y: 40 },
    { menuId: 'file', x: '1', y: 40 },
    { menuId: 'file', y: 40 },
    { menuId: 'file', x: 0, y: 40, command: 'quit' },
    null,
  ]) {
    assert.equal(appMenuPopupRequestSchema.safeParse(request).success, false)
  }
})

test('connectRequestSchema accepts a minimal valid request and rejects garbage', () => {
  assert.ok(connectRequestSchema.safeParse({ host: 'h', port: 22, username: 'u' }).success)
  assert.ok(connectRequestSchema.safeParse({ host: 'h', port: 22, username: 'u', useAgent: true }).success)
  assert.equal(connectRequestSchema.safeParse({ host: 'h', port: 'not-a-number', username: 'u' }).success, false)
  assert.equal(connectRequestSchema.safeParse(null).success, false)
})

test('setPolicySchema only accepts known policies', () => {
  assert.ok(setPolicySchema.safeParse({ sessionId: 's', policy: 'auto' }).success)
  assert.equal(setPolicySchema.safeParse({ sessionId: 's', policy: 'yolo' }).success, false)
})

test('termInputSchema bounds payload shape', () => {
  assert.ok(termInputSchema.safeParse({ sessionId: 's', data: 'ls\n' }).success)
  assert.equal(termInputSchema.safeParse({ sessionId: 's' }).success, false)
})

test('agentChatRequestSchema requires non-empty message', () => {
  assert.equal(agentChatRequestSchema.safeParse({ sessionId: 's', message: '' }).success, false)
})

test('agentChatRequestSchema accepts bounded old-context quotes', () => {
  const parsed = agentChatRequestSchema.parse({
    sessionId: 's',
    message: 'continue with this',
    quotes: [{
      sourceMessageId: 'msg-1',
      sourceEpoch: 1,
      role: 'assistant',
      createdAt: '2026-08-01T10:00:00.000Z',
      contentSnapshot: 'prior diagnosis',
    }],
  })
  assert.equal(parsed.quotes?.length, 1)
  assert.equal(parsed.quotes?.[0]?.sourceEpoch, 1)
})

test('agentChatRequestSchema rejects more than five quotes', () => {
  const quote = {
    sourceMessageId: 'msg',
    sourceEpoch: 1,
    role: 'user' as const,
    createdAt: '2026-08-01T10:00:00.000Z',
    contentSnapshot: 'x',
  }
  assert.equal(agentChatRequestSchema.safeParse({
    sessionId: 's',
    message: 'hi',
    quotes: Array.from({ length: 6 }, (_, i) => ({ ...quote, sourceMessageId: `msg-${i}` })),
  }).success, false)
})

test('settingsUpdateSchema accepts a valid context window and rejects out-of-range values', () => {
  const request = (contextWindowTokens: number | null) => ({
    model: { provider: { provider: 'openai', contextWindowTokens } },
  })
  assert.ok(settingsUpdateSchema.safeParse(request(128_000)).success)
  assert.ok(settingsUpdateSchema.safeParse(request(null)).success)
  assert.equal(settingsUpdateSchema.safeParse(request(100)).success, false)
  assert.equal(settingsUpdateSchema.safeParse(request(12.5)).success, false)
  assert.equal(settingsUpdateSchema.safeParse(request(3_000_000)).success, false)
})

test('session action schemas trim and bound titles and batch ids', () => {
  assert.deepEqual(renameSessionRequestSchema.parse({ sessionId: 's', title: '  Production  ' }), {
    sessionId: 's',
    title: 'Production',
  })
  assert.ok(duplicateSessionRequestSchema.safeParse({ sessionId: 's', title: '副本' }).success)
  assert.equal(renameSessionRequestSchema.safeParse({ sessionId: 's', title: '   ' }).success, false)
  assert.equal(renameSessionRequestSchema.safeParse({ sessionId: 's', title: 'x'.repeat(81) }).success, false)
  assert.ok(renameSessionRequestSchema.safeParse({ sessionId: 's', title: '😀'.repeat(80) }).success)
  assert.equal(renameSessionRequestSchema.safeParse({ sessionId: 's', title: '😀'.repeat(81) }).success, false)
  assert.ok(closeSessionsRequestSchema.safeParse({ sessionIds: ['a', 'b', 'a'] }).success)
  assert.equal(closeSessionsRequestSchema.safeParse({ sessionIds: [''] }).success, false)
  assert.equal(closeSessionsRequestSchema.safeParse({ sessionIds: Array(101).fill('s') }).success, false)
})

test('hostIdSchema accepts a non-empty id and rejects invalid payloads', () => {
  assert.ok(hostIdSchema.safeParse('host-1').success)
  assert.equal(hostIdSchema.safeParse('').success, false)
  assert.equal(hostIdSchema.safeParse({ id: 'host-1' }).success, false)
})

test('host folder schemas accept valid root and nested folder operations', () => {
  assert.deepEqual(
    addHostFolderRequestSchema.parse({ name: '  Production  ' }),
    { name: 'Production' }
  )
  assert.ok(addHostFolderRequestSchema.safeParse({ name: 'Database', parentId: 'folder-1' }).success)
  assert.ok(renameHostFolderRequestSchema.safeParse({ id: 'folder-1', name: 'Staging' }).success)
  assert.ok(removeHostFolderRequestSchema.safeParse({ id: 'folder-1' }).success)
})

test('host folder schemas reject missing ids, invalid names, and unknown fields', () => {
  for (const request of [
    {},
    { name: '' },
    { name: '   ' },
    { name: 'x'.repeat(101) },
    { name: 'Production', parentId: '' },
    { name: 'Production', extra: true },
    null,
    'Production',
  ]) {
    assert.equal(addHostFolderRequestSchema.safeParse(request).success, false)
  }

  for (const request of [
    { name: 'Renamed' },
    { id: '', name: 'Renamed' },
    { id: 'folder-1', name: '' },
    { id: 'folder-1', name: 'x'.repeat(101) },
    { id: 'folder-1', name: 'Renamed', extra: true },
    null,
  ]) {
    assert.equal(renameHostFolderRequestSchema.safeParse(request).success, false)
  }

  for (const request of [{}, { id: '' }, { id: 'folder-1', extra: true }, null, 'folder-1']) {
    assert.equal(removeHostFolderRequestSchema.safeParse(request).success, false)
  }
})

test('moveHostRequestSchema accepts root and folder moves and rejects invalid payloads', () => {
  assert.ok(moveHostRequestSchema.safeParse({ hostId: 'host-1' }).success)
  assert.ok(moveHostRequestSchema.safeParse({ hostId: 'host-1', folderId: 'folder-1' }).success)

  for (const request of [
    {},
    { hostId: '' },
    { hostId: 'host-1', folderId: '' },
    { hostId: 'host-1', folderId: 1 },
    { hostId: 'host-1', extra: true },
    null,
    'host-1',
  ]) {
    assert.equal(moveHostRequestSchema.safeParse(request).success, false)
  }
})

test('hostConnectionTestRequestSchema accepts saved and draft tests', () => {
  assert.ok(hostConnectionTestRequestSchema.safeParse({ hostId: 'host-1' }).success)
  assert.ok(hostConnectionTestRequestSchema.safeParse({
    hostId: 'host-1',
    draft: {
      host: 'draft.internal', port: 2222, username: 'root', authMethod: 'password',
      password: 'temporary', useSavedPassword: false,
    },
  }).success)
})

test('hostConnectionTestRequestSchema rejects invalid draft fields and unknown shapes', () => {
  const validDraft = {
    host: 'draft.internal', port: 22, username: 'root', authMethod: 'agent',
    useSavedPassword: false,
  }
  for (const request of [
    { hostId: '' },
    { hostId: 'h', draft: { ...validDraft, host: '' } },
    { hostId: 'h', draft: { ...validDraft, username: '' } },
    { hostId: 'h', draft: { ...validDraft, port: 0 } },
    { hostId: 'h', draft: { ...validDraft, port: 65536 } },
    { hostId: 'h', draft: { ...validDraft, authMethod: 'token' } },
    { hostId: 'h', draft: { ...validDraft, useSavedPassword: 'yes' } },
    { hostId: 'h', draft: { ...validDraft, extra: true } },
  ]) {
    assert.equal(hostConnectionTestRequestSchema.safeParse(request).success, false)
  }
})

test('noteRespondSchema validates requestId + ok', () => {
  assert.ok(noteRespondSchema.safeParse({ requestId: 'r1', ok: true }).success)
  assert.equal(noteRespondSchema.safeParse({ requestId: 'r1', ok: 'yes' }).success, false)
  assert.equal(noteRespondSchema.safeParse({ ok: true }).success, false)
})

test('knowledgeTargetRespondSchema accepts an index or an explicit null', () => {
  assert.ok(knowledgeTargetRespondSchema.safeParse({ requestId: 'r1', optionIndex: 0 }).success)
  assert.ok(knowledgeTargetRespondSchema.safeParse({ requestId: 'r1', optionIndex: null }).success)
  for (const payload of [
    { requestId: 'r1' },
    { requestId: '', optionIndex: 0 },
    { requestId: 'r1', optionIndex: -1 },
    { requestId: 'r1', optionIndex: 1.5 },
    { requestId: 'r1', optionIndex: 6 },
    { requestId: 'r1', optionIndex: 0, extra: true },
  ]) {
    assert.equal(knowledgeTargetRespondSchema.safeParse(payload).success, false)
  }
})

test('clipboardTextSchema accepts text including an empty string', () => {
  assert.ok(clipboardTextSchema.safeParse('copied').success)
  assert.ok(clipboardTextSchema.safeParse('').success)
  assert.equal(clipboardTextSchema.safeParse({ text: 'wrong shape' }).success, false)
})

test('savedHostInputSchema accepts notes and bounds their length', () => {
  assert.ok(
    savedHostInputSchema.safeParse({
      name: 'a', host: 'h', port: 22, username: 'u', notes: 'CDH 6.3 集群',
    }).success
  )
  assert.equal(
    savedHostInputSchema.safeParse({
      name: 'a', host: 'h', port: 22, username: 'u', notes: 'x'.repeat(4001),
    }).success,
    false
  )
})

test('settingsUpdateSchema accepts shellIntegration boolean', () => {
  assert.ok(settingsUpdateSchema.safeParse({ shellIntegration: false }).success)
  assert.equal(settingsUpdateSchema.safeParse({ shellIntegration: 'yes' }).success, false)
})

test('settingsUpdateSchema accepts allowAutoContextCompaction boolean', () => {
  assert.ok(settingsUpdateSchema.safeParse({ allowAutoContextCompaction: true }).success)
  assert.ok(settingsUpdateSchema.safeParse({ allowAutoContextCompaction: false }).success)
  assert.equal(
    settingsUpdateSchema.safeParse({ allowAutoContextCompaction: 'yes' }).success,
    false,
  )
})

test('savedHostInputSchema accepts a target folder and rejects an empty folder id', () => {
  const input = { name: 'a', host: 'h', port: 22, username: 'u' }
  assert.ok(savedHostInputSchema.safeParse({ ...input, folderId: 'folder-1' }).success)
  assert.equal(savedHostInputSchema.safeParse({ ...input, folderId: '' }).success, false)
})

test('environment binding schemas accept canonical ids and explicit session persistence intent', () => {
  const environmentId = '123e4567-e89b-42d3-a456-426614174000'
  const host = { name: 'a', host: 'h', port: 22, username: 'u' }
  assert.ok(savedHostInputSchema.safeParse({ ...host, environmentId }).success)
  assert.equal(savedHostInputSchema.safeParse({ ...host, environmentId: 'env-prod' }).success, false)

  assert.ok(sessionEnvironmentSelectionRequestSchema.safeParse({
    sessionId: 'session-1', environmentId, persistForHost: false,
  }).success)
  assert.ok(sessionEnvironmentSelectionRequestSchema.safeParse({
    sessionId: 'session-1', persistForHost: true,
  }).success)
  assert.equal(sessionEnvironmentSelectionRequestSchema.safeParse({
    sessionId: 'session-1', environmentId, persistForHost: false, agentSelected: true,
  }).success, false)
  assert.equal(sessionEnvironmentSelectionRequestSchema.safeParse({
    sessionId: 'session-1', environmentId, persistForHost: 'yes',
  }).success, false)
})

test('session knowledge module requests require bounded session and module ids', () => {
  const moduleId = '123e4567-e89b-42d3-a456-426614174000'
  assert.ok(sessionKnowledgeModuleRequestSchema.safeParse({
    sessionId: 'session-1', moduleId,
  }).success)
  assert.equal(sessionKnowledgeModuleRequestSchema.safeParse({
    sessionId: '', moduleId,
  }).success, false)
  assert.equal(sessionKnowledgeModuleRequestSchema.safeParse({
    sessionId: 'session-1', moduleId, agentSelected: true,
  }).success, false)
})

test('settingsUpdateSchema accepts only explicit dark and light themes', () => {
  assert.ok(settingsUpdateSchema.safeParse({ theme: 'dark' }).success)
  assert.ok(settingsUpdateSchema.safeParse({ theme: 'light' }).success)

  for (const theme of ['system', 'Dark', '', 1, null]) {
    assert.equal(settingsUpdateSchema.safeParse({ theme }).success, false)
  }
})

test('model settings and probe schemas are provider-aware and strict', () => {
  assert.ok(settingsUpdateSchema.safeParse({
    model: {
      activeProvider: 'anthropic',
      provider: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        baseUrl: '',
        contextWindowTokens: 200_000,
        apiKey: 'draft',
      },
    },
  }).success)
  assert.equal(settingsUpdateSchema.safeParse({
    model: { provider: { provider: 'other' } },
  }).success, false)
  assert.equal(settingsUpdateSchema.safeParse({
    model: { provider: { provider: 'openai', contextWindowTokens: 4_095 } },
  }).success, false)
  assert.equal(settingsUpdateSchema.safeParse({
    model: { provider: { provider: 'openai', forged: true } },
  }).success, false)
  assert.ok(llmTestRequestSchema.safeParse({ provider: 'openai', model: 'custom' }).success)
  assert.equal(llmTestRequestSchema.safeParse({ provider: 'anthropic', extra: true }).success, false)
})

test('knowledge IPC schemas accept editable draft fields and reject managed fields', () => {
  const form = {
    name: 'Nginx operations',
    description: '',
    whenToUse: 'Use for Nginx incidents.',
    tags: ['nginx'],
    beforeGuidance: '# Nginx',
    inlineGuidance: '- Run `nginx -t` before reload.',
    afterGuidance: '',
  }
  const id = '123e4567-e89b-42d3-a456-426614174000'

  assert.ok(knowledgeCreateRequestSchema.safeParse({ name: 'Nginx operations' }).success)
  assert.ok(knowledgeIdRequestSchema.safeParse({ id }).success)
  assert.ok(knowledgeDraftFormRequestSchema.safeParse({ id, form }).success)
  assert.ok(knowledgeDraftSourceRequestSchema.safeParse({ id, source: 'invalid draft' }).success)

  for (const managedField of ['id', 'schema_version', 'revision', 'contentHash']) {
    assert.equal(
      knowledgeDraftFormRequestSchema.safeParse({
        id,
        form: { ...form, [managedField]: 'forged' },
      }).success,
      false
    )
  }
})

test('knowledge IPC schemas reject unknown fields, invalid ids, and oversized source', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000'
  assert.equal(knowledgeCreateRequestSchema.safeParse({ name: 'Module', extra: true }).success, false)
  assert.equal(knowledgeIdRequestSchema.safeParse({ id: '../outside' }).success, false)
  assert.equal(knowledgeIdRequestSchema.safeParse({ id, extra: true }).success, false)
  assert.equal(
    knowledgeDraftSourceRequestSchema.safeParse({ id, source: 'x'.repeat(2 * 1024 * 1024 + 1) }).success,
    false
  )
})

test('revision history IPC schemas accept pins and reject forged cleanup fields', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000'
  assert.ok(knowledgeListRevisionsRequestSchema.safeParse({
    id,
    agentActiveRevisions: [1, 2],
  }).success)
  assert.ok(knowledgeCompareRevisionsRequestSchema.safeParse({
    id,
    leftRevision: 1,
    rightRevision: 2,
  }).success)
  assert.ok(knowledgeRestoreRevisionRequestSchema.safeParse({ id, revision: 1 }).success)
  assert.ok(knowledgeRevisionCleanupRequestSchema.safeParse({
    id,
    revisions: [1, 2],
    agentActiveRevisions: [3],
  }).success)

  assert.equal(knowledgeListRevisionsRequestSchema.safeParse({ id, forged: true }).success, false)
  assert.equal(knowledgeCompareRevisionsRequestSchema.safeParse({
    id,
    leftRevision: 0,
    rightRevision: 1,
  }).success, false)
  assert.equal(knowledgeRevisionCleanupRequestSchema.safeParse({
    id,
    revisions: [],
  }).success, false)
})

test('trash IPC schemas accept ids and reject forged fields', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000'
  assert.ok(knowledgePreviewDeleteRequestSchema.safeParse({ id }).success)
  assert.ok(knowledgeMoveToTrashRequestSchema.safeParse({ id }).success)
  assert.ok(environmentPreviewDeleteRequestSchema.safeParse({ id }).success)
  assert.ok(environmentMoveToTrashRequestSchema.safeParse({ id }).success)
  assert.ok(trashIdRequestSchema.safeParse({ id }).success)
  assert.ok(trashPermanentDeleteRequestSchema.safeParse({
    id,
    agentActiveRevisions: [1],
  }).success)

  assert.equal(knowledgePreviewDeleteRequestSchema.safeParse({ id, forged: true }).success, false)
  assert.equal(trashPermanentDeleteRequestSchema.safeParse({
    id,
    agentActiveRevisions: [0],
  }).success, false)
  assert.equal(trashIdRequestSchema.safeParse({ id: 'not-a-uuid' }).success, false)
})

test('environment IPC schemas accept associations and reject managed or unsafe fields', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000'
  const moduleId = '123e4567-e89b-42d3-a456-426614174001'
  const form = {
    name: 'Production platform',
    description: 'Shared production facts.',
    tags: ['production'],
    always: [moduleId],
    onDemand: [],
    body: '# Production platform',
  }

  assert.ok(environmentCreateRequestSchema.safeParse({ name: 'Production' }).success)
  assert.ok(environmentIdRequestSchema.safeParse({ id }).success)
  assert.ok(environmentDraftFormRequestSchema.safeParse({ id, form }).success)
  assert.ok(environmentDraftSourceRequestSchema.safeParse({ id, source: 'draft' }).success)

  assert.equal(
    environmentDraftFormRequestSchema.safeParse({
      id,
      form: { ...form, revision: 2 },
    }).success,
    false
  )
  assert.equal(
    environmentDraftFormRequestSchema.safeParse({
      id,
      form: { ...form, always: ['../outside'] },
    }).success,
    false
  )
  assert.equal(
    environmentDraftFormRequestSchema.safeParse({
      id,
      form: { ...form, onDemand: Array(65).fill(moduleId) },
    }).success,
    false
  )
})

test('environment import/export IPC schemas accept modes and conflict maps and reject unknowns', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000'
  const moduleId = '123e4567-e89b-42d3-a456-426614174001'

  assert.ok(environmentExportRequestSchema.safeParse({
    id,
    packagePath: 'C:/tmp/env.spotshell-environment.json',
    mode: 'self-contained',
  }).success)
  assert.ok(environmentExportRequestSchema.safeParse({
    id,
    packagePath: 'C:/tmp/env.spotshell-environment.json',
    mode: 'definition-only',
  }).success)
  assert.equal(environmentExportRequestSchema.safeParse({
    id,
    packagePath: 'C:/tmp/env.spotshell-environment.json',
    mode: 'full-backup',
  }).success, false)
  assert.equal(environmentExportRequestSchema.safeParse({
    id,
    packagePath: 'C:/tmp/env.spotshell-environment.json',
    includeHosts: true,
  }).success, false)

  assert.ok(environmentImportRequestSchema.safeParse({
    packagePath: 'C:/tmp/env.spotshell-environment.json',
    environmentResolution: 'use-imported',
    moduleResolutions: { [moduleId]: 'keep-local' },
  }).success)
  assert.equal(environmentImportRequestSchema.safeParse({
    packagePath: 'C:/tmp/env.spotshell-environment.json',
    environmentResolution: 'merge',
  }).success, false)
  assert.equal(environmentImportRequestSchema.safeParse({
    packagePath: 'C:/tmp/env.spotshell-environment.json',
    moduleResolutions: { 'not-a-uuid': 'keep-local' },
  }).success, false)
})
