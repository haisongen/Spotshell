import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { SPACE_V1_LIMITS } from './limits.js';
import { KnowledgeRepository } from './knowledgeRepository.js';
import { temporaryDirectory } from './temporaryDirectory.testSupport.js';

test('only published modules with routing metadata and content enter automatic candidates', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-automatic-candidates-');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Linux diagnostics' });

  await repository.publishDraft(module.id);
  assert.deepEqual(await repository.listAutomaticCandidates(), []);

  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: 'Diagnostic references for Linux hosts.',
    whenToUse: 'Use when investigating Linux service failures.',
    beforeGuidance: '# Linux diagnostics\n\nCheck the service state and journal output.',
  });
  assert.deepEqual(await repository.listAutomaticCandidates(), []);

  await repository.publishDraft(module.id);
  assert.deepEqual(
    (await repository.listAutomaticCandidates()).map((candidate) => candidate.id),
    [module.id]
  );
});

test('an environment draft becomes effective only after explicit publish', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-environment-repository-');
  const repository = new KnowledgeRepository(rootPath);

  const created = await repository.createEnvironmentDraft({ name: 'Production platform' });

  assert.equal(created.latestRevision, undefined);
  assert.deepEqual((await repository.listEnvironments()).map((environment) => environment.id), [
    created.id,
  ]);
  assert.deepEqual(await repository.listPublishedEnvironments(), []);

  const revision = await repository.publishEnvironmentDraft(created.id);

  assert.equal(revision.revision, 1);
  assert.deepEqual(
    (await repository.listPublishedEnvironments()).map((environment) => environment.id),
    [created.id]
  );
});

test('environment association drafts preserve stable ID order until explicitly published', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-environment-associations-');
  const repository = new KnowledgeRepository(rootPath);
  const first = await repository.createDraft({ name: 'Release safety' });
  const second = await repository.createDraft({ name: 'Kubernetes diagnostics' });
  const environment = await repository.createEnvironmentDraft({ name: 'Production platform' });
  await repository.publishEnvironmentDraft(environment.id);

  const draft = await repository.saveEnvironmentFormDraft(environment.id, {
    ...environment.form!,
    always: [second.id, first.id],
    onDemand: [],
  });

  assert.deepEqual(draft.form?.always, [second.id, first.id]);
  assert.deepEqual((await repository.listPublishedEnvironments())[0]?.always, []);

  await repository.publishEnvironmentDraft(environment.id);

  assert.deepEqual((await repository.listPublishedEnvironments())[0]?.always, [
    second.id,
    first.id,
  ]);
});

test('environment associations resolve by stable ID and expose missing modules', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-environment-dependencies-');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Original module name' });
  const environment = await repository.createEnvironmentDraft({ name: 'Production platform' });
  const missingId = '123e4567-e89b-42d3-a456-426614174999';

  await repository.saveEnvironmentFormDraft(environment.id, {
    ...environment.form!,
    always: [module.id],
    onDemand: [missingId],
  });
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    name: 'Renamed module',
  });

  const detail = await repository.getEnvironment(environment.id);

  assert.deepEqual(detail.associations.always, [{
    id: module.id,
    name: 'Renamed module',
    status: 'resolved',
  }]);
  assert.deepEqual(detail.associations.onDemand, [{
    id: missingId,
    status: 'unresolved',
  }]);
});

test('invalid environment guidance remains a draft without replacing valid facts', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-environment-invalid-guidance-');
  const repository = new KnowledgeRepository(rootPath);
  const environment = await repository.createEnvironmentDraft({ name: 'Production platform' });
  await repository.publishEnvironmentDraft(environment.id);
  const publishedBefore = await repository.listPublishedEnvironments();
  const invalidSource = `${environment.source}\n## Guidance\n\nRestart services immediately.\n`;

  const saved = await repository.saveEnvironmentSourceDraft(environment.id, invalidSource);

  assert.equal(saved.source, invalidSource);
  assert.match(saved.draftValidationError ?? '', /must not contain ## Guidance/);
  await assert.rejects(
    () => repository.publishEnvironmentDraft(environment.id),
    /must not contain ## Guidance/
  );
  assert.deepEqual(await repository.listPublishedEnvironments(), publishedBefore);
});

test('one module cannot be both always and on demand in an environment', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-environment-exclusive-associations-');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Shared operations' });
  const environment = await repository.createEnvironmentDraft({ name: 'Production platform' });
  await repository.publishEnvironmentDraft(environment.id);

  const saved = await repository.saveEnvironmentFormDraft(environment.id, {
    ...environment.form!,
    always: [module.id],
    onDemand: [module.id],
  });

  assert.deepEqual(saved.form?.always, [module.id]);
  assert.deepEqual(saved.form?.onDemand, [module.id]);
  assert.match(saved.draftValidationError ?? '', /Duplicate module stable ID/);
  await assert.rejects(
    () => repository.publishEnvironmentDraft(environment.id),
    /Duplicate module stable ID/
  );
  assert.deepEqual((await repository.listPublishedEnvironments())[0]?.always, []);
});

test('typed draft APIs reject cross-kind edits before changing stored content', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-cross-kind-drafts-');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Release safety' });
  const environment = await repository.createEnvironmentDraft({ name: 'Production platform' });

  await assert.rejects(
    () => repository.saveFormDraft(environment.id, module.form!),
    /not a knowledge module/
  );
  await assert.rejects(
    () => repository.saveSourceDraft(environment.id, module.source),
    /not a knowledge module/
  );

  assert.equal((await repository.getEnvironment(environment.id)).source, environment.source);
  assert.equal((await repository.getModule(module.id)).source, module.source);
});

test('form draft saves return the exact form fields without source round-trip rewrites', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-form-preserve-');
  const repository = new KnowledgeRepository(rootPath);

  const environment = await repository.createEnvironmentDraft({ name: 'Production platform' });
  const environmentForm = {
    ...environment.form!,
    // Mid-edit content: no trailing newline; round-tripping via SPACE.md would add one.
    body: 'just a few chars',
    description: 'Live editing facts',
  };
  const savedEnvironment = await repository.saveEnvironmentFormDraft(
    environment.id,
    environmentForm,
  );
  assert.equal(savedEnvironment.form?.body, 'just a few chars');
  assert.equal(savedEnvironment.form?.description, 'Live editing facts');
  assert.deepEqual(savedEnvironment.form, environmentForm);

  const module = await repository.createDraft({ name: 'Release safety' });
  const moduleForm = {
    ...module.form!,
    beforeGuidance: 'hello world',
    afterGuidance: '',
    whenToUse: 'when investigating incidents',
  };
  delete moduleForm.inlineGuidance;
  const savedModule = await repository.saveFormDraft(module.id, moduleForm);
  assert.equal(savedModule.form?.beforeGuidance, 'hello world');
  assert.equal(savedModule.form?.afterGuidance, '');
  assert.equal(savedModule.form?.whenToUse, 'when investigating incidents');
  assert.equal(savedModule.form?.inlineGuidance, undefined);
  assert.deepEqual(savedModule.form, moduleForm);

  // Source-mode saves still rebuild form from SPACE.md (form is not stored).
  const sourceSaved = await repository.saveSourceDraft(
    module.id,
    savedModule.source.replace('hello world', 'from source mode'),
  );
  assert.match(sourceSaved.form?.beforeGuidance ?? '', /from source mode/);
});

test('a knowledge draft becomes revision 1 only after explicit publish', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-repository-');
  const repository = new KnowledgeRepository(rootPath);

  const created = await repository.createDraft({ name: 'Nginx operations' });

  assert.match(created.id, /^[a-f0-9-]{36}$/);
  assert.equal(created.latestRevision, undefined);
  assert.deepEqual(await repository.listPublished(), []);
  assert.equal(await repository.resolvePublishedObject(created.id), undefined);

  await repository.saveFormDraft(created.id, {
    name: 'Nginx operations',
    description: 'Safe checks and recovery guidance for Nginx.',
    whenToUse: 'Use when diagnosing Nginx configuration or availability.',
    whenNotToUse: 'Do not use for unrelated application failures.',
    tags: ['nginx', 'web'],
    beforeGuidance: '# Nginx operations\n\nInspect current state before changing configuration.',
    inlineGuidance: '- Never replace configuration without running `nginx -t`.',
    afterGuidance: '## References\n\nRecord the active configuration path.',
  });
  const revision = await repository.publishDraft(created.id);

  assert.equal(revision.revision, 1);
  assert.match(revision.contentHash, /^[a-f0-9]{64}$/);
  assert.equal((await repository.listPublished())[0]?.id, created.id);
  assert.equal((await repository.getModule(created.id)).latestRevision, 1);

  const publishedRoot = await repository.resolvePublishedObject(created.id);
  assert.ok(publishedRoot);
  assert.equal(publishedRoot.kind, 'knowledge');
  assert.equal(publishedRoot.revision, 1);
  assert.equal(publishedRoot.contentHash, revision.contentHash);
  assert.match(publishedRoot.rootPath, new RegExp(`${created.id}.*revisions`));
});

test('an invalid source draft survives reload without replacing the last valid revision', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-invalid-draft-');
  const repository = new KnowledgeRepository(rootPath);
  const created = await repository.createDraft({ name: 'Recovery notes' });
  await repository.publishDraft(created.id);
  const publishedBefore = await repository.listPublished();

  const invalidSource = 'This draft has no YAML frontmatter yet.\n';
  const saved = await repository.saveSourceDraft(created.id, invalidSource);
  const reloaded = await new KnowledgeRepository(rootPath).getModule(created.id);

  assert.equal(saved.source, invalidSource);
  assert.match(saved.draftValidationError ?? '', /YAML frontmatter/);
  assert.equal(saved.form, undefined);
  assert.equal(reloaded.source, invalidSource);
  await assert.rejects(() => repository.publishDraft(created.id), /YAML frontmatter/);
  assert.deepEqual(await repository.listPublished(), publishedBefore);
  assert.equal(reloaded.latestRevision, 1);
});

test('an incomplete form draft is recoverable but cannot be published', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-form-draft-');
  const repository = new KnowledgeRepository(rootPath);
  const created = await repository.createDraft({ name: 'Database recovery' });

  const saved = await repository.saveFormDraft(created.id, {
    ...created.form!,
    description: '',
    whenToUse: 'Use during database recovery planning.',
  });
  const reloaded = await new KnowledgeRepository(rootPath).getModule(created.id);

  assert.equal(saved.form?.description, '');
  assert.equal(reloaded.form?.description, '');
  assert.match(reloaded.source, /description: ""/);
  assert.match(reloaded.draftValidationError ?? '', /description/);
  await assert.rejects(() => repository.publishDraft(created.id), /description/);
  assert.deepEqual(await repository.listPublished(), []);
});

test('secret content and managed identity changes cannot replace a valid revision', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-publish-gates-');
  const repository = new KnowledgeRepository(rootPath);
  const created = await repository.createDraft({ name: 'Release safety' });
  await repository.publishDraft(created.id);
  const publishedBefore = await repository.listPublished();

  await repository.saveSourceDraft(
    created.id,
    `${created.source}\n-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n`
  );
  await assert.rejects(() => repository.publishDraft(created.id), /possible secret.*private-key/i);
  assert.deepEqual(await repository.listPublished(), publishedBefore);

  const changedId = created.source.replace(created.id, '123e4567-e89b-42d3-a456-426614174999');
  await repository.saveSourceDraft(created.id, changedId);
  await assert.rejects(() => repository.publishDraft(created.id), /Stable ID is managed/);
  assert.deepEqual(await repository.listPublished(), publishedBefore);
  assert.equal((await repository.getModule(created.id)).latestRevision, 1);
});

test('the editor module list includes unpublished drafts without adding them to candidates', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-editor-list-');
  const repository = new KnowledgeRepository(rootPath);
  const zulu = await repository.createDraft({ name: 'Zulu draft' });
  const alpha = await repository.createDraft({ name: 'Alpha module' });
  await repository.publishDraft(alpha.id);

  const editorModules = await repository.listModules();

  assert.deepEqual(editorModules.map((module) => module.name), ['Alpha module', 'Zulu draft']);
  assert.equal(editorModules.find((module) => module.id === zulu.id)?.latestRevision, undefined);
  assert.deepEqual((await repository.listPublished()).map((module) => module.id), [alpha.id]);
});

test('source drafts enforce the SPACE file limit in UTF-8 bytes', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-byte-limit-');
  const repository = new KnowledgeRepository(rootPath);
  const created = await repository.createDraft({ name: 'Unicode reference' });
  const oversizedSource = '界'.repeat(Math.floor(SPACE_V1_LIMITS.maxFileBytes / 3) + 1);

  await assert.rejects(
    () => repository.saveSourceDraft(created.id, oversizedSource),
    /exceeds.*byte limit/i
  );
  assert.equal((await repository.getModule(created.id)).source, created.source);
});

test('publishing a new revision never changes an earlier revision', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-immutable-revisions-');
  const repository = new KnowledgeRepository(rootPath);
  const created = await repository.createDraft({ name: 'Immutable history' });
  const first = await repository.publishDraft(created.id);
  const firstPath = path.join(rootPath, created.id, 'revisions', '00000001', 'SPACE.md');
  const firstSource = await fs.readFile(firstPath, 'utf8');

  await repository.saveFormDraft(created.id, {
    ...created.form!,
    description: 'Updated only in revision two.',
  });
  const second = await repository.publishDraft(created.id);

  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.notEqual(second.contentHash, first.contentHash);
  assert.equal(await fs.readFile(firstPath, 'utf8'), firstSource);
});

test('resolvePublishedObject can open a specific older managed revision snapshot', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-resolve-revision-');
  const repository = new KnowledgeRepository(rootPath);
  const created = await repository.createDraft({ name: 'Pinned history' });
  const first = await repository.publishDraft(created.id);
  await repository.saveFormDraft(created.id, {
    ...created.form!,
    description: 'Second published description.',
  });
  const second = await repository.publishDraft(created.id);

  const latest = await repository.resolvePublishedObject(created.id);
  const pinned = await repository.resolvePublishedObject(created.id, first.revision);
  const missing = await repository.resolvePublishedObject(created.id, 99);

  assert.equal(latest?.revision, second.revision);
  assert.equal(latest?.contentHash, second.contentHash);
  assert.equal(pinned?.revision, first.revision);
  assert.equal(pinned?.contentHash, first.contentHash);
  assert.notEqual(pinned?.rootPath, latest?.rootPath);
  assert.equal(await fs.readFile(path.join(pinned!.rootPath, 'SPACE.md'), 'utf8'), first.source);
  assert.equal(missing, undefined);
});

test('an interrupted temporary module does not poison the editor list', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-interrupted-create-');
  const repository = new KnowledgeRepository(rootPath);
  const created = await repository.createDraft({ name: 'Complete module' });
  await fs.mkdir(path.join(rootPath, '.tmp-interrupted-module'), { recursive: true });
  await fs.writeFile(path.join(rootPath, '.tmp-interrupted-module', 'manifest.json'), '{}');

  assert.deepEqual((await repository.listModules()).map((module) => module.id), [created.id]);
});

test('publish reconciles a revision committed before its manifest update', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-orphan-revision-');
  const repository = new KnowledgeRepository(rootPath);
  const created = await repository.createDraft({ name: 'Recoverable publish' });
  const published = await repository.publishDraft(created.id);
  const manifestPath = path.join(rootPath, created.id, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  delete manifest.latestRevision;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const recovered = await new KnowledgeRepository(rootPath).publishDraft(created.id);

  assert.deepEqual(recovered, published);
  assert.equal((await repository.getModule(created.id)).latestRevision, 1);
});

test('users can create, list, and read a managed markdown note on a knowledge module draft', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-managed-create-');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Ops notes' });

  const listed = await repository.createManagedTextFile(module.id, {
    relativePath: 'notes/runbook.md',
    content: '# Runbook\n\nRestart carefully.\n',
  });

  assert.deepEqual(listed.files.map((file) => file.relativePath), ['notes/runbook.md']);
  assert.equal(listed.files[0]?.role, 'reference');
  assert.equal(listed.files[0]?.guidanceEligible, true);
  assert.equal(listed.kind, 'knowledge');

  const content = await repository.readManagedFileContent(module.id, 'notes/runbook.md');
  assert.equal(content.relativePath, 'notes/runbook.md');
  assert.equal(content.content, '# Runbook\n\nRestart carefully.\n');
});

test('importing a text file copies a managed snapshot that no longer depends on the original', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-managed-import-');
  const sourceDir = temporaryDirectory(t, 'spotshell-managed-import-src-');
  const sourcePath = path.join(sourceDir, 'app.log');
  await fs.writeFile(sourcePath, 'error: connection refused\n', 'utf8');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Log notes' });

  const listed = await repository.importManagedTextFile(module.id, {
    relativePath: 'references/app.log',
    absoluteSourcePath: sourcePath,
  });

  assert.equal(listed.files[0]?.relativePath, 'references/app.log');
  assert.equal(listed.files[0]?.role, 'reference');
  assert.equal(listed.files[0]?.guidanceEligible, false);
  assert.equal(listed.files[0]?.origin?.originalName, 'app.log');
  assert.equal(listed.files[0]?.origin?.sourcePath, path.resolve(sourcePath));

  await fs.writeFile(sourcePath, 'changed externally\n', 'utf8');
  const content = await repository.readManagedFileContent(module.id, 'references/app.log');
  assert.equal(content.content, 'error: connection refused\n');
});

test('publishing a multi-file module copies managed snapshots into the immutable revision root', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-managed-publish-');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Release pack' });
  await repository.createManagedTextFile(module.id, {
    relativePath: 'rules/service-safety.md',
    content: '# Safety\n\nPrefer read-only checks.\n',
  });
  await repository.setGuidanceRegistration(module.id, 'rules/service-safety.md', true);

  const revision = await repository.publishDraft(module.id);
  const published = await repository.resolvePublishedObject(module.id);
  assert.equal(published?.revision, revision.revision);
  assert.deepEqual(published?.guidanceFiles, ['rules/service-safety.md']);
  assert.equal(
    await fs.readFile(path.join(published!.rootPath, 'rules', 'service-safety.md'), 'utf8'),
    '# Safety\n\nPrefer read-only checks.\n'
  );
});

test('users can preview and explicitly apply an update from the original source path', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-managed-source-update-');
  const sourceDir = temporaryDirectory(t, 'spotshell-managed-source-update-src-');
  const sourcePath = path.join(sourceDir, 'notes.txt');
  await fs.writeFile(sourcePath, 'version one\n', 'utf8');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Source update' });
  await repository.importManagedTextFile(module.id, {
    relativePath: 'notes.txt',
    absoluteSourcePath: sourcePath,
  });

  await fs.writeFile(sourcePath, 'version two\n', 'utf8');
  const preview = await repository.previewUpdateFromSource(module.id, 'notes.txt');
  assert.equal(preview.current, 'version one\n');
  assert.equal(preview.incoming, 'version two\n');
  assert.equal(preview.changed, true);
  assert.match(preview.unifiedDiff, /version one/);
  assert.match(preview.unifiedDiff, /version two/);

  // Need a publishable SPACE draft so source-update can create a revision.
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: 'Module used for source update tests.',
    whenToUse: 'When verifying managed snapshot updates.',
    beforeGuidance: '# Source update\n',
  });
  await repository.publishDraft(module.id);

  const applied = await repository.applyUpdateFromSource(module.id, 'notes.txt');
  assert.equal(
    (await repository.readManagedFileContent(module.id, 'notes.txt')).content,
    'version two\n'
  );
  assert.equal(applied.files[0]?.origin?.contentHash.length, 64);
  const published = await repository.resolvePublishedObject(module.id);
  assert.equal(published?.revision, 2);
  assert.equal(
    await fs.readFile(path.join(published!.rootPath, 'notes.txt'), 'utf8'),
    'version two\n'
  );
});

test('rename and delete atomically keep guidance_files consistent', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-managed-rename-delete-');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Guidance files' });
  await repository.createManagedTextFile(module.id, {
    relativePath: 'rules/old.md',
    content: 'Rule A\n',
  });
  await repository.setGuidanceRegistration(module.id, 'rules/old.md', true);

  const renamed = await repository.renameManagedFile(module.id, 'rules/old.md', 'rules/new.md');
  assert.deepEqual(renamed.guidanceFiles, ['rules/new.md']);
  assert.deepEqual(renamed.files.map((file) => file.relativePath), ['rules/new.md']);
  assert.equal(renamed.files[0]?.role, 'guidance');

  const removed = await repository.removeManagedFile(module.id, 'rules/new.md');
  assert.deepEqual(removed.files, []);
  assert.deepEqual(removed.guidanceFiles, []);
});

test('log and config imports cannot be registered as guidance without becoming reviewable text', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-managed-guidance-guard-');
  const sourceDir = temporaryDirectory(t, 'spotshell-managed-guidance-guard-src-');
  const sourcePath = path.join(sourceDir, 'nginx.conf');
  await fs.writeFile(sourcePath, 'worker_processes auto;\n', 'utf8');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Config module' });
  await repository.importManagedTextFile(module.id, {
    relativePath: 'configs/nginx.conf',
    absoluteSourcePath: sourcePath,
  });

  await assert.rejects(
    () => repository.setGuidanceRegistration(module.id, 'configs/nginx.conf', true),
    /Guidance file must be Markdown or text/i
  );
});

test('managed file import rejects PDF, binary content, and blocking secrets', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-managed-import-rejects-');
  const sourceDir = temporaryDirectory(t, 'spotshell-managed-import-rejects-src-');
  const repository = new KnowledgeRepository(rootPath);
  const module = await repository.createDraft({ name: 'Unsafe imports' });

  const pdfPath = path.join(sourceDir, 'manual.pdf');
  await fs.writeFile(pdfPath, '%PDF-1.4\n', 'utf8');
  await assert.rejects(
    () => repository.importManagedTextFile(module.id, {
      relativePath: 'manual.pdf',
      absoluteSourcePath: pdfPath,
    }),
    /PDF/i
  );

  const binaryPath = path.join(sourceDir, 'blob.txt');
  await fs.writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02]));
  await assert.rejects(
    () => repository.importManagedTextFile(module.id, {
      relativePath: 'blob.txt',
      absoluteSourcePath: binaryPath,
    }),
    /Binary|UTF-8/i
  );

  const secretPath = path.join(sourceDir, 'keys.txt');
  await fs.writeFile(secretPath, '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n', 'utf8');
  await assert.rejects(
    () => repository.importManagedTextFile(module.id, {
      relativePath: 'keys.txt',
      absoluteSourcePath: secretPath,
    }),
    /possible secret/i
  );
});

test('environment profiles can import reference text files without guidance registration', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-managed-environment-');
  const sourceDir = temporaryDirectory(t, 'spotshell-managed-environment-src-');
  const sourcePath = path.join(sourceDir, 'topology.yaml');
  await fs.writeFile(sourcePath, 'cluster: prod\n', 'utf8');
  const repository = new KnowledgeRepository(rootPath);
  const environment = await repository.createEnvironmentDraft({ name: 'Prod env' });

  const listed = await repository.importManagedTextFile(environment.id, {
    relativePath: 'facts/topology.yaml',
    absoluteSourcePath: sourcePath,
  });
  assert.equal(listed.kind, 'environment');
  assert.deepEqual(listed.guidanceFiles, []);
  assert.equal(listed.files[0]?.role, 'reference');

  await assert.rejects(
    () => repository.setGuidanceRegistration(environment.id, 'facts/topology.yaml', true),
    /environment/i
  );

  await repository.publishEnvironmentDraft(environment.id);
  const published = await repository.resolvePublishedObject(environment.id);
  assert.equal(
    await fs.readFile(path.join(published!.rootPath, 'facts', 'topology.yaml'), 'utf8'),
    'cluster: prod\n'
  );
});

test('accepted knowledge proposal creates a new valid revision through the publish pipeline', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-proposal-apply-');
  const repository = new KnowledgeRepository(rootPath);
  const created = await repository.createDraft({ name: 'Proposal target' });
  await repository.saveFormDraft(created.id, {
    ...created.form!,
    description: 'Module used for proposal acceptance.',
    whenToUse: 'When testing AI proposal apply.',
    beforeGuidance: '# Proposal target\n\nOld fact.\n',
  });
  const first = await repository.publishDraft(created.id);
  const baseFiles = await repository.readPublishedRevisionFiles(created.id, first.revision);
  const space = baseFiles.find((file) => file.relativePath === 'SPACE.md');
  assert.ok(space);

  const nextSource = space.content.replace('Old fact.', 'New durable fact from diagnosis.');
  const applied = await repository.applyAcceptedKnowledgeProposal(created.id, {
    expectedKind: 'knowledge',
    baseRevision: first.revision,
    baseContentHash: first.contentHash,
    files: [{ relativePath: 'SPACE.md', content: nextSource }],
  });

  assert.equal(applied.revision, 2);
  assert.equal(applied.origin, 'ai-proposal');
  assert.notEqual(applied.contentHash, first.contentHash);
  const published = await repository.resolvePublishedObject(created.id);
  assert.equal(published?.revision, 2);
  assert.match(
    await fs.readFile(path.join(published!.rootPath, 'SPACE.md'), 'utf8'),
    /New durable fact from diagnosis/,
  );
});

test('proposal apply rejects stale base and secret content without writing', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-knowledge-proposal-gates-');
  const repository = new KnowledgeRepository(rootPath);
  const created = await repository.createDraft({ name: 'Proposal gates' });
  await repository.saveFormDraft(created.id, {
    ...created.form!,
    description: 'Secret and stale checks.',
    whenToUse: 'When testing proposal gates.',
    beforeGuidance: '# Gates\n\nBaseline.\n',
  });
  const first = await repository.publishDraft(created.id);
  const second = await repository.publishDraft(created.id);
  assert.equal(second.revision, 2);

  const baseFiles = await repository.readPublishedRevisionFiles(created.id, first.revision);
  const space = baseFiles.find((file) => file.relativePath === 'SPACE.md')!;

  await assert.rejects(
    () => repository.applyAcceptedKnowledgeProposal(created.id, {
      expectedKind: 'knowledge',
      baseRevision: first.revision,
      baseContentHash: first.contentHash,
      files: [{ relativePath: 'SPACE.md', content: space.content.replace('Baseline.', 'Stale base write.') }],
    }),
    /stale/i,
  );
  assert.equal((await repository.resolvePublishedObject(created.id))?.revision, 2);

  const current = await repository.readPublishedRevisionFiles(created.id, second.revision);
  const currentSpace = current.find((file) => file.relativePath === 'SPACE.md')!;
  await assert.rejects(
    () => repository.applyAcceptedKnowledgeProposal(created.id, {
      expectedKind: 'knowledge',
      baseRevision: second.revision,
      baseContentHash: second.contentHash,
      files: [{
        relativePath: 'SPACE.md',
        content: `${currentSpace.content}\n-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n`,
      }],
    }),
    /possible secret/i,
  );
  assert.equal((await repository.resolvePublishedObject(created.id))?.revision, 2);
  assert.equal((await repository.resolvePublishedObject(created.id))?.contentHash, second.contentHash);
});
