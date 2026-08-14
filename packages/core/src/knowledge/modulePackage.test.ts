import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeRepository } from './knowledgeRepository.js';
import { temporaryDirectory } from './temporaryDirectory.testSupport.js';

async function publishSampleModule(
  repository: KnowledgeRepository,
  originDir: string,
) {
  const module = await repository.createDraft({ name: 'Portable ops' });
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: 'Reusable operations guidance for portable export.',
    whenToUse: 'Use when sharing a knowledge module between machines.',
    beforeGuidance: '# Portable ops\n\nCheck service health first.\n',
    inlineGuidance: '- Prefer read-only commands.\n',
    afterGuidance: '## References\n\nSee managed notes.\n',
  });
  await repository.createManagedTextFile(module.id, {
    relativePath: 'notes/checklist.md',
    content: '# Checklist\n\n1. Confirm environment.\n',
  });
  // Record a local absolute source origin that must never travel with the package.
  const originPath = path.join(originDir, 'origin.log');
  await fs.writeFile(originPath, 'origin line\n', 'utf8');
  await repository.importManagedTextFile(module.id, {
    relativePath: 'references/origin.log',
    absoluteSourcePath: originPath,
  });
  const revision = await repository.publishDraft(module.id);
  return { module, revision };
}

test('export package includes module entry, managed files, stable id, schema and content hash', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-module-export-');
  const packageDir = temporaryDirectory(t, 'spotshell-module-export-pkg-');
  const originDir = temporaryDirectory(t, 'spotshell-module-export-origin-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision } = await publishSampleModule(repository, originDir);
  const packagePath = path.join(packageDir, 'portable-ops.spotshell-module.json');

  const exported = await repository.exportKnowledgeModule(module.id, packagePath);
  const raw = JSON.parse(await fs.readFile(packagePath, 'utf8')) as Record<string, unknown>;

  assert.equal(exported.id, module.id);
  assert.equal(exported.contentHash, revision.contentHash);
  assert.equal(raw.format_version, 1);
  assert.equal(raw.package_kind, 'knowledge-module');
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.id, module.id);
  assert.equal(raw.content_hash, revision.contentHash);
  assert.equal(typeof raw.exported_at, 'string');
  assert.ok(Array.isArray(raw.files));
  const files = raw.files as Array<{ relative_path: string; content: string }>;
  const paths = files.map((file) => file.relative_path).sort();
  assert.deepEqual(paths, [
    'SPACE.md',
    'notes/checklist.md',
    'references/origin.log',
  ]);
  const packageText = await fs.readFile(packagePath, 'utf8');
  assert.equal(packageText.includes(path.resolve(rootPath)), false);
  assert.equal(packageText.includes(path.resolve(originDir)), false);
  assert.equal(packageText.includes('file-origins'), false);
  assert.equal(packageText.includes('revision.json'), false);
});

test('export requires a published revision and excludes unpublished draft-only modules', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-module-export-draft-');
  const packageDir = temporaryDirectory(t, 'spotshell-module-export-draft-pkg-');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Draft only' });
  const packagePath = path.join(packageDir, 'draft.spotshell-module.json');

  await assert.rejects(
    () => repository.exportKnowledgeModule(module.id, packagePath),
    /published revision/i
  );
  await assert.rejects(() => fs.access(packagePath));
});

test('import creates a managed module with an initial valid revision when stable id is absent', async (t) => {
  const sourceRoot = temporaryDirectory(t, 'spotshell-module-import-src-');
  const targetRoot = temporaryDirectory(t, 'spotshell-module-import-dst-');
  const packageDir = temporaryDirectory(t, 'spotshell-module-import-pkg-');
  const originDir = temporaryDirectory(t, 'spotshell-module-import-origin-');
  const source = new KnowledgeRepository(sourceRoot);
  const { module, revision } = await publishSampleModule(source, originDir);
  const packagePath = path.join(packageDir, 'module.spotshell-module.json');
  await source.exportKnowledgeModule(module.id, packagePath);

  const target = new KnowledgeRepository(targetRoot);
  const preview = await target.previewKnowledgeModuleImport(packagePath);
  assert.equal(preview.status, 'create');
  assert.equal(preview.incoming.id, module.id);
  assert.equal(preview.incoming.contentHash, revision.contentHash);

  const imported = await target.importKnowledgeModule(packagePath);
  assert.equal(imported.status, 'created');
  assert.equal(imported.id, module.id);
  assert.equal(imported.revision, 1);
  assert.equal(imported.contentHash, revision.contentHash);

  const published = await target.resolvePublishedObject(module.id);
  assert.equal(published?.contentHash, revision.contentHash);
  assert.equal(
    await fs.readFile(path.join(published!.rootPath, 'notes', 'checklist.md'), 'utf8'),
    '# Checklist\n\n1. Confirm environment.\n'
  );
  // Import must not recreate local absolute source origins.
  await assert.rejects(() => fs.access(path.join(targetRoot, module.id, 'file-origins.json')));
});

test('import with matching stable id and content hash reuses the local revision', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-module-import-identical-');
  const packageDir = temporaryDirectory(t, 'spotshell-module-import-identical-pkg-');
  const originDir = temporaryDirectory(t, 'spotshell-module-import-identical-origin-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision } = await publishSampleModule(repository, originDir);
  const packagePath = path.join(packageDir, 'module.spotshell-module.json');
  await repository.exportKnowledgeModule(module.id, packagePath);

  const preview = await repository.previewKnowledgeModuleImport(packagePath);
  assert.equal(preview.status, 'identical');

  const imported = await repository.importKnowledgeModule(packagePath);
  assert.equal(imported.status, 'identical');
  assert.equal(imported.revision, revision.revision);
  assert.equal(imported.contentHash, revision.contentHash);
  assert.equal((await repository.getModule(module.id)).latestRevision, 1);
});

test('import conflict offers keep-local, use-imported, and import-as-copy without auto-merge', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-module-import-conflict-');
  const packageDir = temporaryDirectory(t, 'spotshell-module-import-conflict-pkg-');
  const originDir = temporaryDirectory(t, 'spotshell-module-import-conflict-origin-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision: localRevision } = await publishSampleModule(repository, originDir);
  const packagePath = path.join(packageDir, 'module.spotshell-module.json');
  await repository.exportKnowledgeModule(module.id, packagePath);

  // Local diverges after export.
  await repository.saveFormDraft(module.id, {
    ...(await repository.getModule(module.id)).form!,
    description: 'Local-only description that differs from the package.',
  });
  const diverged = await repository.publishDraft(module.id);
  assert.notEqual(diverged.contentHash, localRevision.contentHash);

  const preview = await repository.previewKnowledgeModuleImport(packagePath);
  assert.equal(preview.status, 'conflict');
  if (preview.status !== 'conflict') throw new Error('expected conflict');
  assert.equal(preview.local.contentHash, diverged.contentHash);
  assert.equal(preview.incoming.contentHash, localRevision.contentHash);

  await assert.rejects(
    () => repository.importKnowledgeModule(packagePath),
    /explicit resolution/i
  );

  const kept = await repository.importKnowledgeModule(packagePath, 'keep-local');
  assert.equal(kept.status, 'kept-local');
  assert.equal(kept.revision, diverged.revision);
  assert.equal(kept.contentHash, diverged.contentHash);
  assert.equal((await repository.getModule(module.id)).latestRevision, diverged.revision);

  const updated = await repository.importKnowledgeModule(packagePath, 'use-imported');
  assert.equal(updated.status, 'updated');
  assert.equal(updated.revision, diverged.revision + 1);
  assert.equal(updated.contentHash, localRevision.contentHash);
  assert.equal((await repository.resolvePublishedObject(module.id))?.contentHash, localRevision.contentHash);

  // Re-diverge so copy path can be exercised against a conflict again.
  await repository.saveFormDraft(module.id, {
    ...(await repository.getModule(module.id)).form!,
    description: 'Local diverged again for copy conflict.',
  });
  await repository.publishDraft(module.id);

  const copied = await repository.importKnowledgeModule(packagePath, 'import-as-copy');
  assert.equal(copied.status, 'copied');
  assert.notEqual(copied.id, module.id);
  assert.equal(copied.sourceId, module.id);
  assert.equal(copied.revision, 1);
  assert.notEqual(copied.contentHash, localRevision.contentHash); // id rewrite changes hash
  const copyPublished = await repository.resolvePublishedObject(copied.id);
  assert.ok(copyPublished);
  assert.match(
    await fs.readFile(path.join(copyPublished.rootPath, 'SPACE.md'), 'utf8'),
    new RegExp(copied.id)
  );
  // Original module remains intact.
  assert.ok(await repository.resolvePublishedObject(module.id));
});

test('failed import validation leaves no half-object or incomplete revision', async (t) => {
  const targetRoot = temporaryDirectory(t, 'spotshell-module-import-fail-');
  const packageDir = temporaryDirectory(t, 'spotshell-module-import-fail-pkg-');
  const packagePath = path.join(packageDir, 'bad.spotshell-module.json');
  await fs.writeFile(packagePath, JSON.stringify({
    format_version: 1,
    package_kind: 'knowledge-module',
    schema_version: 1,
    id: '123e4567-e89b-42d3-a456-426614174000',
    name: 'Bad package',
    content_hash: '0'.repeat(64),
    exported_at: new Date().toISOString(),
    files: [
      {
        relative_path: 'SPACE.md',
        content: [
          '---',
          'schema_version: 1',
          'id: 123e4567-e89b-42d3-a456-426614174000',
          'kind: knowledge',
          'name: Bad package',
          'description: Contains a blocked secret.',
          'when_to_use: Never.',
          '---',
          '',
          '# Bad package',
          '',
          '-----BEGIN OPENSSH PRIVATE KEY-----',
          'secret',
          '',
        ].join('\n'),
      },
    ],
  }, null, 2), 'utf8');

  const repository = new KnowledgeRepository(targetRoot);
  await assert.rejects(
    () => repository.importKnowledgeModule(packagePath),
    /secret/i
  );
  assert.deepEqual(await repository.listModules(), []);
  const entries = await fs.readdir(targetRoot).catch(() => [] as string[]);
  assert.equal(entries.every((entry) => entry.startsWith('.tmp-') === false), true);
});

test('import rejects reserved system metadata paths such as revision.json', async (t) => {
  const targetRoot = temporaryDirectory(t, 'spotshell-module-import-reserved-');
  const packageDir = temporaryDirectory(t, 'spotshell-module-import-reserved-pkg-');
  const packagePath = path.join(packageDir, 'reserved.spotshell-module.json');
  await fs.writeFile(packagePath, JSON.stringify({
    format_version: 1,
    package_kind: 'knowledge-module',
    schema_version: 1,
    id: '123e4567-e89b-42d3-a456-426614174222',
    name: 'Reserved path package',
    content_hash: 'c'.repeat(64),
    exported_at: new Date().toISOString(),
    files: [
      {
        relative_path: 'SPACE.md',
        content: [
          '---',
          'schema_version: 1',
          'id: 123e4567-e89b-42d3-a456-426614174222',
          'kind: knowledge',
          'name: Reserved path package',
          'description: Should reject revision.json payloads.',
          'when_to_use: Never.',
          '---',
          '',
          '# Reserved',
          '',
        ].join('\n'),
      },
      {
        relative_path: 'revision.json',
        content: '{"forged":true}\n',
      },
    ],
  }, null, 2), 'utf8');

  const repository = new KnowledgeRepository(targetRoot);
  await assert.rejects(
    () => repository.importKnowledgeModule(packagePath),
    /revision\.json|system metadata/i
  );
  assert.deepEqual(await repository.listModules(), []);
});

test('use-imported clears local file origins so portable content stays unbound', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-module-import-origins-');
  const packageDir = temporaryDirectory(t, 'spotshell-module-import-origins-pkg-');
  const originDir = temporaryDirectory(t, 'spotshell-module-import-origins-src-');
  const repository = new KnowledgeRepository(rootPath);
  const { module, revision } = await publishSampleModule(repository, originDir);
  const packagePath = path.join(packageDir, 'module.spotshell-module.json');
  await repository.exportKnowledgeModule(module.id, packagePath);

  await repository.saveFormDraft(module.id, {
    ...(await repository.getModule(module.id)).form!,
    description: 'Local divergence before portable overwrite.',
  });
  await repository.publishDraft(module.id);
  assert.equal(
    await fs.access(path.join(rootPath, module.id, 'file-origins.json')).then(() => true, () => false),
    true
  );

  const updated = await repository.importKnowledgeModule(packagePath, 'use-imported');
  assert.equal(updated.status, 'updated');
  assert.equal(updated.contentHash, revision.contentHash);
  await assert.rejects(() => fs.access(path.join(rootPath, module.id, 'file-origins.json')));
});

test('import rejects packages with absolute paths or content-hash mismatches', async (t) => {
  const targetRoot = temporaryDirectory(t, 'spotshell-module-import-invalid-');
  const packageDir = temporaryDirectory(t, 'spotshell-module-import-invalid-pkg-');
  const repository = new KnowledgeRepository(targetRoot);

  const absolutePathPackage = path.join(packageDir, 'absolute.spotshell-module.json');
  await fs.writeFile(absolutePathPackage, JSON.stringify({
    format_version: 1,
    package_kind: 'knowledge-module',
    schema_version: 1,
    id: '123e4567-e89b-42d3-a456-426614174111',
    name: 'Absolute path package',
    content_hash: 'a'.repeat(64),
    exported_at: new Date().toISOString(),
    files: [
      {
        relative_path: 'C:/Windows/system32/evil.md',
        content: '# evil\n',
      },
    ],
  }, null, 2), 'utf8');
  await assert.rejects(
    () => repository.importKnowledgeModule(absolutePathPackage),
    /absolute|unsafe|not allowed/i
  );

  const sourceRoot = temporaryDirectory(t, 'spotshell-module-import-hash-src-');
  const originDir = temporaryDirectory(t, 'spotshell-module-import-hash-origin-');
  const source = new KnowledgeRepository(sourceRoot);
  const { module } = await publishSampleModule(source, originDir);
  const packagePath = path.join(packageDir, 'tampered.spotshell-module.json');
  await source.exportKnowledgeModule(module.id, packagePath);
  const packageData = JSON.parse(await fs.readFile(packagePath, 'utf8')) as {
    content_hash: string
    files: Array<{ relative_path: string; content: string }>
  };
  packageData.content_hash = 'b'.repeat(64);
  await fs.writeFile(packagePath, `${JSON.stringify(packageData, null, 2)}\n`, 'utf8');
  await assert.rejects(
    () => repository.importKnowledgeModule(packagePath),
    /content hash mismatch/i
  );
  assert.deepEqual(await repository.listModules(), []);
});

test('export then import preserves normalized object semantics and content hash', async (t) => {
  const sourceRoot = temporaryDirectory(t, 'spotshell-module-roundtrip-src-');
  const targetRoot = temporaryDirectory(t, 'spotshell-module-roundtrip-dst-');
  const packageDir = temporaryDirectory(t, 'spotshell-module-roundtrip-pkg-');
  const originDir = temporaryDirectory(t, 'spotshell-module-roundtrip-origin-');
  const source = new KnowledgeRepository(sourceRoot);
  const { module, revision } = await publishSampleModule(source, originDir);
  const packagePath = path.join(packageDir, 'roundtrip.spotshell-module.json');
  await source.exportKnowledgeModule(module.id, packagePath);

  const target = new KnowledgeRepository(targetRoot);
  const imported = await target.importKnowledgeModule(packagePath);
  assert.equal(imported.status, 'created');
  assert.equal(imported.contentHash, revision.contentHash);

  const reexportPath = path.join(packageDir, 'roundtrip-again.spotshell-module.json');
  const reexported = await target.exportKnowledgeModule(module.id, reexportPath);
  assert.equal(reexported.contentHash, revision.contentHash);

  const first = JSON.parse(await fs.readFile(packagePath, 'utf8')) as {
    content_hash: string
    files: Array<{ relative_path: string; content: string }>
  };
  const second = JSON.parse(await fs.readFile(reexportPath, 'utf8')) as {
    content_hash: string
    files: Array<{ relative_path: string; content: string }>
  };
  assert.equal(first.content_hash, second.content_hash);
  assert.deepEqual(
    first.files.map((file) => file.relative_path).sort(),
    second.files.map((file) => file.relative_path).sort()
  );
});
