import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeRepository } from './knowledgeRepository.js';
import { temporaryDirectory } from './temporaryDirectory.testSupport.js';

async function publishModuleWithBody(
  repository: KnowledgeRepository,
  name: string,
  body: string,
  managedFiles: Array<{ relativePath: string; content: string }> = [],
) {
  const module = await repository.createDraft({ name });
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: `${name} description`,
    whenToUse: `Use ${name}`,
    beforeGuidance: body,
  });
  for (const file of managedFiles) {
    await repository.createManagedTextFile(module.id, {
      relativePath: file.relativePath,
      content: file.content,
    });
  }
  const revision = await repository.publishDraft(module.id);
  return { module, revision };
}

test('listRevisionHistory shows origin, effective marker, and agent-active pin', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-rev-history-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishModuleWithBody(repository, 'History module', '# v1\n');
  await repository.saveFormDraft(module.id, {
    ...(await repository.getModule(module.id)).form!,
    beforeGuidance: '# v2\n',
  });
  await repository.publishDraft(module.id);
  const restored = await repository.restoreRevision(module.id, 1);

  assert.equal(restored.revision, 3);

  const history = await repository.listRevisionHistory(module.id, {
    agentActiveRevisions: [2],
  });

  assert.equal(history.length, 3);
  assert.equal(history[0]?.revision, 3);
  assert.equal(history[0]?.isCurrentEffective, true);
  assert.equal(history[0]?.origin, 'restore:1');
  assert.equal(history[1]?.revision, 2);
  assert.equal(history[1]?.isAgentActive, true);
  assert.equal(history[2]?.revision, 1);
  assert.match(history[2]?.contentHash ?? '', /^[a-f0-9]{64}$/);
  assert.ok(history[2]?.createdAt);
});

test('compareRevisions reports entry and managed file diffs', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-rev-compare-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishModuleWithBody(
    repository,
    'Compare module',
    '# first\n',
    [{ relativePath: 'docs/a.md', content: 'alpha\n' }],
  );
  await repository.saveFormDraft(module.id, {
    ...(await repository.getModule(module.id)).form!,
    beforeGuidance: '# second\n',
  });
  await repository.createManagedTextFile(module.id, {
    relativePath: 'docs/b.md',
    content: 'beta\n',
  });
  await repository.publishDraft(module.id);

  const comparison = await repository.compareRevisions(module.id, 1, 2);
  assert.equal(comparison.entryChanged, true);
  const byPath = new Map(comparison.files.map((file) => [file.relativePath, file.change]));
  assert.equal(byPath.get('SPACE.md'), 'modified');
  assert.equal(byPath.get('docs/a.md'), 'unchanged');
  assert.equal(byPath.get('docs/b.md'), 'added');
});

test('restoreRevision creates a new valid revision without rewriting history', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-rev-restore-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision: first } = await publishModuleWithBody(
    repository,
    'Restore module',
    '# original\n',
  );
  await repository.saveFormDraft(module.id, {
    ...(await repository.getModule(module.id)).form!,
    beforeGuidance: '# changed\n',
  });
  await repository.publishDraft(module.id);

  const restored = await repository.restoreRevision(module.id, 1);
  assert.equal(restored.revision, 3);
  assert.equal(restored.contentHash, first.contentHash);

  const history = await repository.listRevisionHistory(module.id);
  assert.deepEqual(history.map((entry) => entry.revision), [3, 2, 1]);
  assert.equal(history.find((entry) => entry.revision === 1)?.contentHash, first.contentHash);

  const published = await repository.resolvePublishedObject(module.id);
  assert.equal(published?.revision, 3);
  assert.equal(published?.contentHash, first.contentHash);
});

test('identical file content is stored once via content-hash deduplication', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-rev-dedup-');
  const repository = new KnowledgeRepository(rootPath);
  const sharedBody = 'shared reference body\n'.repeat(20);
  const { module } = await publishModuleWithBody(
    repository,
    'Dedup module',
    '# v1\n',
    [{ relativePath: 'docs/shared.md', content: sharedBody }],
  );
  await repository.saveFormDraft(module.id, {
    ...(await repository.getModule(module.id)).form!,
    beforeGuidance: '# v2 only entry changed\n',
  });
  await repository.publishDraft(module.id);

  const blobsPath = path.join(rootPath, module.id, 'blobs');
  const blobNames = await fs.readdir(blobsPath);
  // SPACE.md differs per revision, shared.md is identical — one blob for shared content.
  const sharedHashes = new Set<string>();
  for (const name of blobNames) {
    const content = await fs.readFile(path.join(blobsPath, name), 'utf8');
    if (content === sharedBody || content.replace(/\r\n/g, '\n') === sharedBody) {
      sharedHashes.add(name);
    }
  }
  assert.equal(sharedHashes.size, 1, 'shared managed file content must occupy one blob');

  // Two revision trees still materialise readable files for harness reads.
  const rev1 = await fs.readFile(
    path.join(rootPath, module.id, 'revisions', '00000001', 'docs', 'shared.md'),
    'utf8',
  );
  const rev2 = await fs.readFile(
    path.join(rootPath, module.id, 'revisions', '00000002', 'docs', 'shared.md'),
    'utf8',
  );
  assert.equal(rev1.replace(/\r\n/g, '\n'), sharedBody);
  assert.equal(rev2.replace(/\r\n/g, '\n'), sharedBody);
});

test('cleanup preview and cleanup respect protected revisions and free exclusive space', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-rev-cleanup-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishModuleWithBody(repository, 'Cleanup module', '# r1\n');
  for (const body of ['# r2\n', '# r3\n', '# r4\n']) {
    await repository.saveFormDraft(module.id, {
      ...(await repository.getModule(module.id)).form!,
      beforeGuidance: body,
    });
    await repository.publishDraft(module.id);
  }

  const previewBlocked = await repository.previewRevisionCleanup(
    module.id,
    [1, 4],
    { agentActiveRevisions: [1] },
  );
  assert.deepEqual(previewBlocked.removableRevisions, []);
  assert.ok(previewBlocked.blockedRevisions.some((entry) => entry.revision === 4));
  assert.ok(previewBlocked.blockedRevisions.some((entry) => entry.revision === 1));

  const preview = await repository.previewRevisionCleanup(module.id, [1, 2]);
  assert.deepEqual(preview.removableRevisions, [1, 2]);
  assert.ok(preview.estimatedFreedBytes > 0);
  assert.equal(preview.irreversible, true);

  await assert.rejects(
    () => repository.cleanupRevisions(module.id, [1, 4]),
    /protected/,
  );

  const result = await repository.cleanupRevisions(module.id, [1, 2]);
  assert.deepEqual(result.removedRevisions, [1, 2]);
  assert.ok(result.freedBytes > 0);

  const history = await repository.listRevisionHistory(module.id);
  assert.deepEqual(history.map((entry) => entry.revision), [4, 3]);

  // Retry is safe when already removed.
  await assert.rejects(
    () => repository.cleanupRevisions(module.id, [1]),
    /No removable revisions|not available/,
  );
});

test('partial cleanup failure leaves remaining references consistent and retriable', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-rev-partial-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishModuleWithBody(repository, 'Partial module', '# r1\n');
  for (const body of ['# r2\n', '# r3\n']) {
    await repository.saveFormDraft(module.id, {
      ...(await repository.getModule(module.id)).form!,
      beforeGuidance: body,
    });
    await repository.publishDraft(module.id);
  }

  // Remove r1 directory out-of-band to simulate prior partial cleanup.
  await fs.rm(path.join(rootPath, module.id, 'revisions', '00000001'), {
    recursive: true,
    force: true,
  });

  const history = await repository.listRevisionHistory(module.id);
  assert.deepEqual(history.map((entry) => entry.revision), [3, 2]);

  // Cleaning the already-missing revision is a no-op failure for missing targets;
  // cleaning remaining non-protected historical revision still works.
  const result = await repository.cleanupRevisions(module.id, [2]);
  assert.deepEqual(result.removedRevisions, [2]);
  assert.deepEqual(
    (await repository.listRevisionHistory(module.id)).map((entry) => entry.revision),
    [3],
  );
});

test('insufficient disk space blocks new revision without deleting history', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-rev-disk-');
  const repository = new KnowledgeRepository(rootPath, {
    getFreeDiskBytes: async () => 1024,
    minFreeBytes: 50 * 1024 * 1024,
  });
  const module = await repository.createDraft({ name: 'Disk module' });
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: 'disk test',
    whenToUse: 'disk',
    beforeGuidance: '# body\n',
  });

  await assert.rejects(
    () => repository.publishDraft(module.id),
    /Insufficient disk space/,
  );

  const detail = await repository.getModule(module.id);
  assert.equal(detail.latestRevision, undefined);
  // Draft remains intact for the user to free space and retry.
  assert.match(detail.source, /# body/);
});
