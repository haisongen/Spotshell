import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeRepository } from './knowledgeRepository.js';
import { temporaryDirectory } from './temporaryDirectory.testSupport.js';

async function publishedModule(repository: KnowledgeRepository, name: string) {
  const module = await repository.createDraft({ name });
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: `${name} description`,
    whenToUse: `Use ${name}`,
    beforeGuidance: `# ${name}\n`,
  });
  await repository.createManagedTextFile(module.id, {
    relativePath: 'notes/runbook.md',
    content: '# Runbook\n\nv1\n',
  });
  const revision = await repository.publishDraft(module.id);
  return { module, revision };
}

test('open managed object root returns the draft-files directory only', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-external-open-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishedModule(repository, 'Open root');

  const opened = await repository.getManagedObjectRootPath(module.id);
  assert.equal(opened, path.join(rootPath, module.id, 'draft-files'));
  const stats = await fs.stat(opened);
  assert.equal(stats.isDirectory(), true);

  // SPACE.md is materialised for external editors but stays out of managed-file listing.
  await fs.access(path.join(opened, 'SPACE.md'));
  const listed = await repository.listManagedFiles(module.id);
  assert.deepEqual(listed.files.map((file) => file.relativePath), ['notes/runbook.md']);
});

test('startup scan detects external file edits against the app baseline', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-external-scan-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision } = await publishedModule(repository, 'Scan external');

  const clean = await repository.scanExternalChanges(module.id);
  assert.equal(clean.status, 'clean');
  assert.equal(clean.hasPendingExternalChanges, false);

  const draftFiles = path.join(rootPath, module.id, 'draft-files');
  await fs.writeFile(path.join(draftFiles, 'notes', 'runbook.md'), '# Runbook\n\nv2 external\n', 'utf8');
  await fs.writeFile(path.join(draftFiles, 'notes.md~'), 'temp', 'utf8');
  await fs.writeFile(path.join(draftFiles, 'added.txt'), 'new file\n', 'utf8');

  const pending = await repository.scanExternalChanges(module.id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.hasPendingExternalChanges, true);
  assert.equal(pending.latestRevision, revision.revision);
  const changes = new Map(pending.files.map((file) => [file.relativePath, file.change]));
  assert.equal(changes.get('notes/runbook.md'), 'modified');
  assert.equal(changes.get('added.txt'), 'added');
  assert.equal(changes.has('notes.md~'), false);

  // Agent / export continue using the last valid revision, not the dirty working tree.
  const published = await repository.resolvePublishedObject(module.id);
  assert.equal(published?.revision, revision.revision);
  assert.equal(published?.contentHash, revision.contentHash);
  assert.equal(
    await fs.readFile(path.join(published!.rootPath, 'notes', 'runbook.md'), 'utf8'),
    '# Runbook\n\nv1\n',
  );
});

test('editor temp files alone do not mark external changes pending', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-external-temp-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishedModule(repository, 'Temp only');
  const draftFiles = path.join(rootPath, module.id, 'draft-files');
  await fs.writeFile(path.join(draftFiles, 'notes', 'runbook.md.swp'), 'swap', 'utf8');
  await fs.writeFile(path.join(draftFiles, '.#notes'), 'lock', 'utf8');

  const status = await repository.scanExternalChanges(module.id);
  assert.equal(status.status, 'clean');
  assert.deepEqual(status.files, []);
});

test('invalid external content stays quarantined and cannot be partially adopted', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-external-invalid-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision } = await publishedModule(repository, 'Invalid external');
  const draftFiles = path.join(rootPath, module.id, 'draft-files');
  await fs.writeFile(
    path.join(draftFiles, 'SPACE.md'),
    '---\nschema_version: 1\nid: not-a-uuid\nkind: knowledge\nname: X\ndescription: d\nwhen_to_use: w\n---\n# X\n',
    'utf8',
  );

  const preview = await repository.previewExternalChanges(module.id);
  assert.equal(preview.status, 'invalid');
  assert.equal(preview.canAdopt, false);
  assert.ok(preview.validationErrors.length > 0);

  await assert.rejects(
    () => repository.adoptExternalChanges(module.id),
    /cannot be adopted|validation|Stable ID|schema|invalid/i,
  );

  const published = await repository.resolvePublishedObject(module.id);
  assert.equal(published?.revision, revision.revision);
  assert.equal(published?.contentHash, revision.contentHash);
});

test('adopting valid external edits creates a new revision without forging identity', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-external-adopt-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision } = await publishedModule(repository, 'Adopt external');
  const draftFiles = path.join(rootPath, module.id, 'draft-files');
  await fs.writeFile(path.join(draftFiles, 'notes', 'runbook.md'), '# Runbook\n\nadopted\n', 'utf8');
  await fs.writeFile(path.join(draftFiles, 'extra.md'), 'extra body\n', 'utf8');

  // Attempt to forge system metadata must not change stable id / revision bookkeeping.
  await fs.writeFile(
    path.join(rootPath, module.id, 'manifest.json'),
    JSON.stringify({
      ...(JSON.parse(await fs.readFile(path.join(rootPath, module.id, 'manifest.json'), 'utf8')) as object),
      latestRevision: 99,
    }, null, 2),
    'utf8',
  );
  // Restore a readable manifest for the object id (corrupt latestRevision is system-owned;
  // adopt must recompute from real revision dirs / reject forgery). Re-read baseline via scan first.
  // Instead: forge content inside SPACE.md id field.
  const space = await fs.readFile(path.join(draftFiles, 'SPACE.md'), 'utf8');
  const forgedId = space.replace(module.id, '00000000-0000-4000-8000-000000000099');
  await fs.writeFile(path.join(draftFiles, 'SPACE.md'), forgedId, 'utf8');
  // Fix manifest back to a coherent state for identity check.
  const manifest = JSON.parse(
    await fs.readFile(path.join(rootPath, module.id, 'manifest.json'), 'utf8'),
  ) as { id: string; kind: string; createdAt: string; draftSummary: unknown; latestRevision?: number };
  manifest.latestRevision = revision.revision;
  await fs.writeFile(
    path.join(rootPath, module.id, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  await assert.rejects(
    () => repository.adoptExternalChanges(module.id),
    /Stable ID|cannot be changed|adopted/i,
  );

  // Valid external content: restore SPACE.md identity and adopt file changes.
  await fs.writeFile(path.join(draftFiles, 'SPACE.md'), space, 'utf8');
  await fs.writeFile(path.join(draftFiles, 'notes', 'runbook.md'), '# Runbook\n\nadopted\n', 'utf8');
  await fs.writeFile(path.join(draftFiles, 'extra.md'), 'extra body\n', 'utf8');

  const preview = await repository.previewExternalChanges(module.id);
  assert.equal(preview.canAdopt, true);
  assert.equal(preview.status, 'pending');

  const adopted = await repository.adoptExternalChanges(module.id);
  assert.equal(adopted.revision, revision.revision + 1);
  assert.equal(adopted.origin, 'external');
  assert.notEqual(adopted.contentHash, revision.contentHash);

  const published = await repository.resolvePublishedObject(module.id);
  assert.equal(published?.revision, adopted.revision);
  assert.equal(
    await fs.readFile(path.join(published!.rootPath, 'notes', 'runbook.md'), 'utf8'),
    '# Runbook\n\nadopted\n',
  );
  assert.equal(
    await fs.readFile(path.join(published!.rootPath, 'extra.md'), 'utf8'),
    'extra body\n',
  );

  const after = await repository.scanExternalChanges(module.id);
  assert.equal(after.status, 'clean');
});

test('discarding external edits restores the last valid revision working tree', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-external-discard-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision } = await publishedModule(repository, 'Discard external');
  const draftFiles = path.join(rootPath, module.id, 'draft-files');
  await fs.writeFile(path.join(draftFiles, 'notes', 'runbook.md'), 'dirty\n', 'utf8');
  await fs.writeFile(path.join(draftFiles, 'noise.txt'), 'noise\n', 'utf8');

  const pending = await repository.scanExternalChanges(module.id);
  assert.equal(pending.status, 'pending');

  await repository.discardExternalChanges(module.id);

  const status = await repository.scanExternalChanges(module.id);
  assert.equal(status.status, 'clean');
  assert.equal(
    await fs.readFile(path.join(draftFiles, 'notes', 'runbook.md'), 'utf8'),
    '# Runbook\n\nv1\n',
  );
  await assert.rejects(() => fs.access(path.join(draftFiles, 'noise.txt')));

  const published = await repository.resolvePublishedObject(module.id);
  assert.equal(published?.revision, revision.revision);
});

test('scanAllExternalChanges reports every object with pending external edits', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-external-scan-all-');
  const repository = new KnowledgeRepository(rootPath);
  const a = await publishedModule(repository, 'Module A');
  const b = await publishedModule(repository, 'Module B');
  await fs.writeFile(
    path.join(rootPath, a.module.id, 'draft-files', 'notes', 'runbook.md'),
    'changed A\n',
    'utf8',
  );

  const results = await repository.scanAllExternalChanges();
  const byId = new Map(results.map((item) => [item.id, item]));
  assert.equal(byId.get(a.module.id)?.status, 'pending');
  assert.equal(byId.get(b.module.id)?.status, 'clean');
});

test('app form autosave does not absorb external dirty files into the baseline', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-external-no-absorb-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishedModule(repository, 'No absorb');
  const draftFiles = path.join(rootPath, module.id, 'draft-files');
  await fs.writeFile(path.join(draftFiles, 'notes', 'runbook.md'), 'external dirty\n', 'utf8');

  assert.equal((await repository.scanExternalChanges(module.id)).status, 'pending');

  const current = await repository.getModule(module.id);
  await repository.saveFormDraft(module.id, {
    ...current.form!,
    description: 'Still pending after autosave',
  });

  const pending = await repository.scanExternalChanges(module.id);
  assert.equal(pending.status, 'pending');
  assert.ok(pending.files.some((file) => file.relativePath === 'notes/runbook.md'));

  await assert.rejects(
    () => repository.publishDraft(module.id),
    /External changes are pending/,
  );
});

test('unreadable external trees quarantine as invalid instead of throwing', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-external-unreadable-');
  const repository = new KnowledgeRepository(rootPath);
  const { module } = await publishedModule(repository, 'Unreadable');
  const draftFiles = path.join(rootPath, module.id, 'draft-files');
  // Unsupported binary-looking extension should fail path/type validation on walk.
  await fs.writeFile(path.join(draftFiles, 'binary.pdf'), '%PDF-1.4\n', 'utf8');

  const status = await repository.scanExternalChanges(module.id);
  assert.equal(status.status, 'invalid');
  assert.equal(status.hasPendingExternalChanges, true);
  assert.ok(status.validationErrors.length > 0);
});
