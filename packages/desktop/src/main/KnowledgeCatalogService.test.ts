import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { KnowledgeRepository } from '@spotshell/core'
import { KnowledgeCatalogService } from './KnowledgeCatalogService'
import { ModuleAuthorizationStore } from './ModuleAuthorizationStore'

test('request catalogs use the published environment and current local authorizations', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-request-catalog-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(path.join(rootPath, 'knowledge'))
  const authorizations = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const service = new KnowledgeCatalogService(repository, authorizations)
  const fixed = await repository.createDraft({ name: 'Release safety' })
  await repository.publishDraft(fixed.id)
  const environmentCandidate = await createEligibleModule(repository, 'Platform diagnostics')
  const globalCandidate = await createEligibleModule(repository, 'Linux diagnostics')
  const environment = await repository.createEnvironmentDraft({ name: 'Production' })
  await repository.saveEnvironmentFormDraft(environment.id, {
    ...environment.form!,
    always: [fixed.id],
    onDemand: [environmentCandidate.id],
  })
  await repository.publishEnvironmentDraft(environment.id)
  authorizations.setGlobalOnDemand(globalCandidate.id, true)

  const authorized = await service.resolveForRequest({
    environmentId: environment.id,
    catalogBudgetTokens: 10_000,
  })
  assert.deepEqual(authorized.fixed.map((entry) => entry.id), [fixed.id])
  assert.deepEqual(authorized.candidates.entries.map((entry) => entry.id), [
    environmentCandidate.id,
    globalCandidate.id,
  ])

  authorizations.setGlobalOnDemand(globalCandidate.id, false)
  const revoked = await service.resolveForRequest({
    environmentId: environment.id,
    catalogBudgetTokens: 10_000,
  })
  assert.deepEqual(revoked.candidates.entries.map((entry) => entry.id), [environmentCandidate.id])
})

test('buildHarness exposes environment, fixed, and dynamic objects with active revisions', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-harness-scope-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(path.join(rootPath, 'knowledge'))
  const authorizations = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const service = new KnowledgeCatalogService(repository, authorizations)

  const fixed = await createEligibleModule(repository, 'Always module')
  const dynamic = await createEligibleModule(repository, 'Dynamic module')
  const environment = await repository.createEnvironmentDraft({ name: 'Staging' })
  await repository.saveEnvironmentFormDraft(environment.id, {
    ...environment.form!,
    always: [fixed.id],
    onDemand: [dynamic.id],
  })
  await repository.publishEnvironmentDraft(environment.id)

  const harness = await service.buildHarness({
    environmentId: environment.id,
    pinnedModuleIds: [],
    dynamicModuleIds: [dynamic.id],
  })
  const overview = harness.listSessionOverview()
  const readableIds = overview.readable.map((entry) => entry.id).sort()
  assert.deepEqual(readableIds, [dynamic.id, environment.id, fixed.id].sort())
  assert.ok(overview.readable.every((entry) => entry.revision === 1))

  const entry = await harness.readEntry(fixed.id, 1)
  assert.match(entry.content, /Always module/)
  assert.equal(entry.provenance.loadReason, 'entry-read')
  assert.equal(entry.provenance.objectName, 'Always module')
  assert.equal(harness.takeProvenance().length, 1)
})

test('buildHarness keeps a pinned active revision after a newer publish', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-harness-pinned-rev-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(path.join(rootPath, 'knowledge'))
  const authorizations = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const service = new KnowledgeCatalogService(repository, authorizations)

  const module = await createEligibleModule(repository, 'Pinned module')
  const first = await repository.getModule(module.id)
  assert.equal(first.latestRevision, 1)
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: 'Second revision description for pin test.',
  })
  const second = await repository.publishDraft(module.id)
  assert.equal(second.revision, 2)

  const harness = await service.buildHarness({
    environmentId: undefined,
    pinnedModuleIds: [module.id],
    dynamicModuleIds: [],
    activeRevisions: new Map([[module.id, 1]]),
  })
  const overview = harness.listSessionOverview()
  const active = overview.readable.find((entry) => entry.id === module.id)
  assert.equal(active?.revision, 1)
  assert.match((await harness.readEntry(module.id, 1)).content, /Pinned module/)
  await assert.rejects(() => harness.readEntry(module.id, 2), /revision mismatch/i)

  const latest = await service.resolveLatestPublished(module.id)
  assert.equal(latest?.revision, 2)
})

test('buildHarness exposes authorized candidates as activatable but not yet readable', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-harness-activatable-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(path.join(rootPath, 'knowledge'))
  const authorizations = new ModuleAuthorizationStore(path.join(rootPath, 'authorizations.json'))
  const service = new KnowledgeCatalogService(repository, authorizations)

  const candidate = await createEligibleModule(repository, 'On demand module')
  const ownedOnly = await createEligibleModule(repository, 'Owned but not authorized')
  authorizations.setGlobalOnDemand(candidate.id, true)
  // ownedOnly is published but not globally authorized and not environment-associated

  const harness = await service.buildHarness({
    environmentId: undefined,
    pinnedModuleIds: [],
    dynamicModuleIds: [],
  })

  await assert.rejects(
    () => harness.readEntry(candidate.id, 1),
    /not authorized|not selected/i
  )
  await assert.rejects(
    () => harness.selectModule(ownedOnly.id, 'should fail'),
    /not an authorized candidate/i
  )

  const selected = await harness.selectModule(candidate.id, 'relevant to the question')
  assert.equal(selected.selection.moduleId, candidate.id)
  assert.equal(selected.selection.loadType, 'dynamic')
  assert.equal(selected.selection.revision, 1)
  assert.match(selected.content, /On demand module/)
  assert.ok(harness.listSessionOverview().readable.some((entry) => entry.id === candidate.id))
})

async function createEligibleModule(
  repository: KnowledgeRepository,
  name: string,
) {
  const module = await repository.createDraft({ name })
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: `${name} reference material.`,
    whenToUse: `Use when ${name.toLocaleLowerCase('en-US')} is relevant.`,
    beforeGuidance: `# ${name}\n\nValidated reference content.`,
  })
  await repository.publishDraft(module.id)
  return module
}
