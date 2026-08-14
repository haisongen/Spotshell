import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  KnowledgeRepository,
  OFFICIAL_SEED_MODULES,
} from '@spotshell/core'
import { ModuleAuthorizationStore } from './ModuleAuthorizationStore'
import {
  listSeedModuleStatuses,
  restoreSeedModule,
  runOfficialSeedMigration,
} from './seedModules'

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('desktop seed migration creates modules and grants global on-demand once', async (t) => {
  const rootPath = temporaryDirectory('spotshell-desktop-seed-')
  const authPath = path.join(rootPath, 'module-authorizations.json')
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))

  const repository = new KnowledgeRepository(rootPath)
  const authorizations = new ModuleAuthorizationStore(authPath)

  const first = await runOfficialSeedMigration(repository, rootPath, authorizations)
  assert.equal(first.createdIds.length, 7)
  assert.equal(authorizations.listGlobalOnDemandIds().length, 7)

  // User revokes one authorization and deletes another module.
  const disk = OFFICIAL_SEED_MODULES.find((seed) => seed.key === 'disk-full')!
  const oom = OFFICIAL_SEED_MODULES.find((seed) => seed.key === 'oom')!
  authorizations.setGlobalOnDemand(disk.id, false)
  await repository.moveModuleToTrash(oom.id)

  const second = await runOfficialSeedMigration(repository, rootPath, authorizations)
  assert.equal(second.alreadyCompleted, true)
  assert.equal(authorizations.isGlobalOnDemand(disk.id), false)
  assert.equal(authorizations.isGlobalOnDemand(oom.id), true) // orphan auth may remain
  assert.equal(await repository.resolvePublishedObject(oom.id), undefined)

  // Explicit restore from trash does not re-grant when authorizeGlobalOnDemand is false.
  authorizations.setGlobalOnDemand(oom.id, false)
  await restoreSeedModule(repository, rootPath, authorizations, {
    seedKey: 'oom',
    authorizeGlobalOnDemand: false,
  })
  assert.ok(await repository.resolvePublishedObject(oom.id))
  assert.equal(authorizations.isGlobalOnDemand(oom.id), false)

  const statuses = await listSeedModuleStatuses(repository, rootPath)
  assert.equal(statuses.find((item) => item.key === 'oom')?.presence, 'present-identical')
})
