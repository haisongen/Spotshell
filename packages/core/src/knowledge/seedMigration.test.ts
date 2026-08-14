import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeRepository } from './knowledgeRepository.js';
import {
  ensureOfficialSeedModules,
  listOfficialSeedStatuses,
  previewRestoreOfficialSeed,
  readSeedMigrationMarker,
  restoreAllOfficialSeeds,
  restoreOfficialSeed,
  seedMigrationMarkerPath,
} from './seedMigration.js';
import {
  OFFICIAL_SEED_MODULES,
  serializeOfficialSeedPackage,
} from './seedModules.js';
import { temporaryDirectory } from './temporaryDirectory.testSupport.js';

test('ensureOfficialSeedModules creates seven published global-seed modules once', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-seed-ensure-');
  const repository = new KnowledgeRepository(rootPath);
  const authorized: string[] = [];

  const first = await ensureOfficialSeedModules({
    repository,
    rootPath,
    onCreated: async (seed) => {
      authorized.push(seed.id);
    },
  });

  assert.equal(first.alreadyCompleted, false);
  assert.equal(first.markerWritten, true);
  assert.equal(first.createdIds.length, 7);
  assert.equal(authorized.length, 7);
  assert.equal((await repository.listModules()).length, 7);
  assert.equal((await repository.listAutomaticCandidates()).length, 7);

  const marker = await readSeedMigrationMarker(rootPath);
  assert.ok(marker);
  assert.equal(marker.seedIds.length, 7);

  for (const seed of OFFICIAL_SEED_MODULES) {
    const published = await repository.resolvePublishedObject(seed.id);
    assert.ok(published, seed.key);
    assert.equal(published.revision, 1);
    assert.equal(
      published.contentHash,
      serializeOfficialSeedPackage(seed).contentHash,
      seed.key,
    );
  }

  const second = await ensureOfficialSeedModules({
    repository,
    rootPath,
    onCreated: async () => {
      throw new Error('onCreated must not run after marker');
    },
  });
  assert.equal(second.alreadyCompleted, true);
  assert.equal(second.markerWritten, false);
  assert.deepEqual(second.createdIds, []);
  assert.equal((await repository.listModules()).length, 7);
});

test('upgrade after user edits and deletes does not recreate or overwrite seeds', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-seed-upgrade-');
  const repository = new KnowledgeRepository(rootPath);
  await ensureOfficialSeedModules({ repository, rootPath });

  const disk = OFFICIAL_SEED_MODULES.find((seed) => seed.key === 'disk-full')!;
  const oom = OFFICIAL_SEED_MODULES.find((seed) => seed.key === 'oom')!;
  const detail = await repository.getModule(disk.id);
  await repository.saveFormDraft(disk.id, {
    ...detail.form!,
    description: 'User-edited disk diagnostics.',
    beforeGuidance: '# 磁盘满排查\n\n用户改过的内容。\n',
    inlineGuidance: '- 自定义指导\n',
  });
  await repository.publishDraft(disk.id);
  const editedHash = (await repository.resolvePublishedObject(disk.id))!.contentHash;
  assert.notEqual(editedHash, serializeOfficialSeedPackage(disk).contentHash);

  await repository.moveModuleToTrash(oom.id);
  assert.equal((await repository.listModules()).length, 6);

  const again = await ensureOfficialSeedModules({
    repository,
    rootPath,
    onCreated: async () => {
      throw new Error('must not recreate after marker');
    },
  });
  assert.equal(again.alreadyCompleted, true);
  assert.equal((await repository.resolvePublishedObject(disk.id))!.contentHash, editedHash);
  assert.equal(await repository.resolvePublishedObject(oom.id), undefined);
  assert.ok((await repository.listTrash()).some((entry) => entry.id === oom.id));
});

test('restore prefers trash, then import, and conflict requires explicit resolution', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-seed-restore-');
  const repository = new KnowledgeRepository(rootPath);
  await ensureOfficialSeedModules({ repository, rootPath });

  const seed = OFFICIAL_SEED_MODULES.find((item) => item.key === 'port-conflict')!;
  await repository.moveModuleToTrash(seed.id);

  const trashPreview = await previewRestoreOfficialSeed({
    repository,
    rootPath,
    seedKey: seed.key,
  });
  assert.equal(trashPreview.status, 'in-trash');

  const fromTrash = await restoreOfficialSeed({ repository, rootPath, seedKey: seed.key });
  assert.equal(fromTrash.status, 'restored-from-trash');
  assert.ok(await repository.resolvePublishedObject(seed.id));

  // Permanently remove and re-import official content.
  await repository.moveModuleToTrash(seed.id);
  await repository.permanentlyDeleteFromTrash(seed.id);
  assert.equal(
    (await previewRestoreOfficialSeed({ repository, rootPath, seedKey: seed.key })).status,
    'missing',
  );
  const recreated = await restoreOfficialSeed({ repository, rootPath, seedKey: seed.key });
  assert.equal(recreated.status, 'created');
  assert.equal(recreated.id, seed.id);

  // Diverge local content, then require conflict resolution.
  const detail = await repository.getModule(seed.id);
  await repository.saveFormDraft(seed.id, {
    ...detail.form!,
    description: 'Locally diverged port guidance.',
    beforeGuidance: '# 端口占用\n\nlocal edit\n',
    inlineGuidance: '- local only\n',
  });
  await repository.publishDraft(seed.id);

  const conflictPreview = await previewRestoreOfficialSeed({
    repository,
    rootPath,
    seedKey: seed.key,
  });
  assert.equal(conflictPreview.status, 'conflict');

  await assert.rejects(
    () => restoreOfficialSeed({ repository, rootPath, seedKey: seed.key }),
    /conflict requires/i,
  );

  const kept = await restoreOfficialSeed({
    repository,
    rootPath,
    seedKey: seed.key,
    conflictResolution: 'keep-local',
  });
  assert.equal(kept.status, 'kept-local');

  const updated = await restoreOfficialSeed({
    repository,
    rootPath,
    seedKey: seed.key,
    conflictResolution: 'use-imported',
  });
  assert.equal(updated.status, 'updated');
  assert.equal(
    (await repository.resolvePublishedObject(seed.id))!.contentHash,
    serializeOfficialSeedPackage(seed).contentHash,
  );
});

test('restore all skips conflicts by default and restores missing seeds', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-seed-restore-all-');
  const repository = new KnowledgeRepository(rootPath);
  await ensureOfficialSeedModules({ repository, rootPath });

  const disk = OFFICIAL_SEED_MODULES.find((seed) => seed.key === 'disk-full')!;
  const cert = OFFICIAL_SEED_MODULES.find((seed) => seed.key === 'cert-expiry')!;

  const detail = await repository.getModule(disk.id);
  await repository.saveFormDraft(disk.id, {
    ...detail.form!,
    description: 'Edited',
    beforeGuidance: '# edited\n',
    inlineGuidance: '- x\n',
  });
  await repository.publishDraft(disk.id);

  await repository.moveModuleToTrash(cert.id);
  await repository.permanentlyDeleteFromTrash(cert.id);

  const results = await restoreAllOfficialSeeds({ repository, rootPath });
  assert.ok(results.some((result) => result.key === 'cert-expiry' && result.status === 'created'));
  assert.ok(!results.some((result) => result.key === 'disk-full' && result.status === 'updated'));
  assert.notEqual(
    (await repository.resolvePublishedObject(disk.id))!.contentHash,
    serializeOfficialSeedPackage(disk).contentHash,
  );
  assert.ok(await repository.resolvePublishedObject(cert.id));
});

test('listOfficialSeedStatuses reports presence for catalog/UI', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-seed-status-');
  const repository = new KnowledgeRepository(rootPath);
  await ensureOfficialSeedModules({ repository, rootPath });

  const oom = OFFICIAL_SEED_MODULES.find((seed) => seed.key === 'oom')!;
  await repository.moveModuleToTrash(oom.id);

  const statuses = await listOfficialSeedStatuses({ repository, rootPath });
  assert.equal(statuses.length, 7);
  assert.equal(statuses.find((item) => item.key === 'oom')?.presence, 'in-trash');
  assert.equal(statuses.find((item) => item.key === 'healthcheck')?.presence, 'present-identical');
});

test('marker file is not treated as a knowledge object directory', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-seed-marker-');
  const repository = new KnowledgeRepository(rootPath);
  await ensureOfficialSeedModules({ repository, rootPath });
  await fs.access(seedMigrationMarkerPath(rootPath));
  assert.equal((await repository.listModules()).length, 7);
  // Root should contain only UUID dirs + marker (+ maybe trash).
  const entries = await fs.readdir(rootPath);
  assert.ok(entries.includes(path.basename(seedMigrationMarkerPath(rootPath))));
});
