import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeRepository } from './knowledgeRepository.js';
import { temporaryDirectory } from './temporaryDirectory.testSupport.js';

async function publishModule(repository: KnowledgeRepository, name: string) {
  const module = await repository.createDraft({ name });
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: `${name} description`,
    whenToUse: `Use ${name}`,
    beforeGuidance: `# ${name}\n`,
  });
  const revision = await repository.publishDraft(module.id);
  return { module, revision };
}

async function publishEnvironment(
  repository: KnowledgeRepository,
  name: string,
  associations: { always?: string[]; onDemand?: string[] } = {},
) {
  const environment = await repository.createEnvironmentDraft({ name });
  await repository.saveEnvironmentFormDraft(environment.id, {
    ...environment.form!,
    description: `${name} facts`,
    always: associations.always ?? [],
    onDemand: associations.onDemand ?? [],
  });
  const revision = await repository.publishEnvironmentDraft(environment.id);
  return { environment, revision };
}

test('previewDeleteModule lists referencing environments and blocks deletion', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-trash-preview-mod-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishModule(repository, 'Shared rules');
  await publishEnvironment(repository, 'Prod', { always: [module.id] });

  const preview = await repository.previewDeleteModule(module.id);
  assert.equal(preview.canDelete, false);
  assert.equal(preview.referencedBy.length, 1);
  assert.equal(preview.referencedBy[0]?.mode, 'always');
  assert.equal(preview.referencedBy[0]?.environmentName, 'Prod');

  await assert.rejects(
    () => repository.moveModuleToTrash(module.id),
    /still referenced/i,
  );
  assert.equal((await repository.listPublished()).length, 1);
});

test('unreferenced module moves to trash and leaves catalogs/exports', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-trash-move-mod-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision } = await publishModule(repository, 'Standalone');

  const preview = await repository.previewDeleteModule(module.id);
  assert.equal(preview.canDelete, true);

  const trashed = await repository.moveModuleToTrash(module.id);
  assert.equal(trashed.id, module.id);
  assert.equal(trashed.kind, 'knowledge');
  assert.equal(trashed.latestRevision, revision.revision);
  assert.ok(trashed.expiresAt);

  assert.equal((await repository.listPublished()).length, 0);
  assert.equal((await repository.listModules()).length, 0);
  assert.equal(await repository.resolvePublishedObject(module.id), undefined);

  const trash = await repository.listTrash();
  assert.equal(trash.length, 1);
  assert.equal(trash[0]?.id, module.id);
  assert.equal(trash[0]?.name, 'Standalone');

  // Object directory moved under trash/
  await assert.rejects(() => fs.access(path.join(rootPath, module.id)));
  await fs.access(path.join(rootPath, 'trash', module.id, 'trash.json'));
});

test('environment bound to hosts cannot enter trash', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-trash-env-bound-');
  const repository = new KnowledgeRepository(rootPath);
  const { environment } = await publishEnvironment(repository, 'Bound env');

  const preview = await repository.previewDeleteEnvironment(environment.id, [
    { hostId: 'h1', hostName: 'db-1' },
  ]);
  assert.equal(preview.canDelete, false);
  assert.equal(preview.blockers[0]?.code, 'environment-bound');

  await assert.rejects(
    () => repository.moveEnvironmentToTrash(environment.id, [
      { hostId: 'h1', hostName: 'db-1' },
    ]),
    /bound to .*host/i,
  );
  assert.equal((await repository.listEnvironments()).length, 1);
});

test('unbound environment enters trash with association snapshot and restores original id', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-trash-env-restore-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishModule(repository, 'Dep module');
  const { environment } = await publishEnvironment(repository, 'App env', {
    always: [module.id],
  });

  const trashed = await repository.moveEnvironmentToTrash(environment.id, []);
  assert.equal(trashed.kind, 'environment');
  assert.deepEqual(trashed.referenceSnapshot.associations.always, [module.id]);
  assert.equal((await repository.listEnvironments()).length, 0);
  assert.equal((await repository.listPublishedEnvironments()).length, 0);
  // Module remains available
  assert.equal((await repository.listPublished()).length, 1);

  const restored = await repository.restoreFromTrash(environment.id);
  assert.equal(restored.id, environment.id);
  assert.equal(restored.kind, 'environment');

  const live = await repository.getEnvironment(environment.id);
  assert.equal(live.name, 'App env');
  assert.equal(live.latestRevision, 1);
  assert.deepEqual(live.form?.always, [module.id]);
  assert.equal((await repository.listTrash()).length, 0);
});

test('restore reuses stable id and reports association conflicts without overwrite', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-trash-restore-conflict-');
  const repository = new KnowledgeRepository(rootPath);
  const { module: modA } = await publishModule(repository, 'A');
  const { module: modB } = await publishModule(repository, 'B');
  const { environment } = await publishEnvironment(repository, 'Env', {
    always: [modA.id],
    onDemand: [modB.id],
  });

  await repository.moveEnvironmentToTrash(environment.id, []);
  // After delete, permanently remove modB so restore cannot re-resolve it.
  await repository.moveModuleToTrash(modB.id);
  await repository.permanentlyDeleteFromTrash(modB.id);

  const restored = await repository.restoreFromTrash(environment.id);
  assert.equal(restored.id, environment.id);
  const missing = restored.associationResults.find((entry) => entry.moduleId === modB.id);
  assert.equal(missing?.status, 'skipped-missing');
  const present = restored.associationResults.find((entry) => entry.moduleId === modA.id);
  assert.ok(present);
  assert.ok(present.status === 'already-present' || present.status === 'restored');
});

test('permanent delete is irreversible and purge removes expired entries', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-trash-purge-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishModule(repository, 'Temp');
  await repository.moveModuleToTrash(module.id);

  const preview = await repository.previewPermanentDelete(module.id);
  assert.equal(preview.canPermanentlyDelete, true);
  assert.equal(preview.irreversible, true);

  await repository.permanentlyDeleteFromTrash(module.id);
  assert.equal((await repository.listTrash()).length, 0);
  await assert.rejects(() => repository.restoreFromTrash(module.id), /not found/i);

  // Expired purge path
  const { module: m2 } = await publishModule(repository, 'Old');
  const entry = await repository.moveModuleToTrash(m2.id);
  // Force-expire by rewriting trash.json
  const trashJsonPath = path.join(rootPath, 'trash', m2.id, 'trash.json');
  const record = JSON.parse(await fs.readFile(trashJsonPath, 'utf8'));
  record.expiresAt = '2020-01-01T00:00:00.000Z';
  record.deletedAt = '2019-12-01T00:00:00.000Z';
  await fs.writeFile(trashJsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const purged = await repository.purgeExpiredTrash(new Date('2026-08-05T00:00:00.000Z'));
  assert.deepEqual(purged.purgedIds, [m2.id]);
  assert.equal((await repository.listTrash()).length, 0);
  assert.equal(entry.id, m2.id);
});

test('agent-active revision blocks permanent delete', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-trash-agent-active-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision } = await publishModule(repository, 'Pinned');
  await repository.moveModuleToTrash(module.id);

  const preview = await repository.previewPermanentDelete(module.id, {
    agentActiveRevisions: [revision.revision],
  });
  assert.equal(preview.canPermanentlyDelete, false);
  assert.equal(preview.blockers[0]?.code, 'agent-active');

  await assert.rejects(
    () => repository.permanentlyDeleteFromTrash(module.id, {
      agentActiveRevisions: [revision.revision],
    }),
    /active Agent/i,
  );
  assert.equal((await repository.listTrash()).length, 1);
});

test('interrupted trash move is repaired into a consistent trash entry', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-trash-repair-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishModule(repository, 'Partial');

  // Simulate crash after writing trash.json but before directory rename.
  const trashMarker = {
    id: module.id,
    kind: 'knowledge',
    name: 'Partial',
    deletedAt: '2026-08-05T00:00:00.000Z',
    expiresAt: '2026-09-04T00:00:00.000Z',
    latestRevision: 1,
    contentHash: 'c'.repeat(64),
    referenceSnapshot: {
      referencedBy: [],
      associations: { always: [], onDemand: [] },
      boundHosts: [],
    },
  };
  await fs.writeFile(
    path.join(rootPath, module.id, 'trash.json'),
    `${JSON.stringify(trashMarker, null, 2)}\n`,
    'utf8',
  );

  const repaired = await repository.repairTrashState();
  assert.ok(repaired.completedMoves.includes(module.id));
  assert.equal((await repository.listModules()).length, 0);
  assert.equal((await repository.listTrash())[0]?.id, module.id);
});
