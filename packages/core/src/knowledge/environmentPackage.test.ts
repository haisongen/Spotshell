import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeRepository } from './knowledgeRepository.js';
import { temporaryDirectory } from './temporaryDirectory.testSupport.js';

async function publishModule(
  repository: KnowledgeRepository,
  name: string,
  body = `# ${name}\n`,
) {
  const module = await repository.createDraft({ name });
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: `${name} description`,
    whenToUse: `Use ${name} when needed.`,
    beforeGuidance: `## Guidance\n\n${name} rules.\n`,
    afterGuidance: body,
  });
  const revision = await repository.publishDraft(module.id);
  return { module, revision };
}

async function publishEnvironmentBundle(repository: KnowledgeRepository) {
  const always = await publishModule(repository, 'Always module', '# Always body\n');
  const onDemand = await publishModule(repository, 'On-demand module', '# On demand body\n');
  const environment = await repository.createEnvironmentDraft({ name: 'Prod web' });
  await repository.saveEnvironmentFormDraft(environment.id, {
    ...environment.form!,
    description: 'Production web facts.',
    always: [always.module.id],
    onDemand: [onDemand.module.id],
    body: '# Prod web\n\n- Region: cn-east-1\n',
  });
  const revision = await repository.publishEnvironmentDraft(environment.id);
  return { always, onDemand, environment, revision };
}

test('export preview lists environment and direct module dependencies before packaging', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-env-export-preview-');
  const repository = new KnowledgeRepository(rootPath);
  const { always, onDemand, environment, revision } = await publishEnvironmentBundle(repository);

  const preview = await repository.previewEnvironmentExport(environment.id);

  assert.equal(preview.environment.id, environment.id);
  assert.equal(preview.environment.name, 'Prod web');
  assert.equal(preview.environment.revision, revision.revision);
  assert.equal(preview.environment.contentHash, revision.contentHash);
  assert.equal(preview.modeDefault, 'self-contained');
  assert.deepEqual(
    preview.modules.map((module) => ({
      id: module.id,
      association: module.association,
      status: module.status,
      name: module.name,
    })),
    [
      {
        id: always.module.id,
        association: 'always',
        status: 'resolved',
        name: 'Always module',
      },
      {
        id: onDemand.module.id,
        association: 'on_demand',
        status: 'resolved',
        name: 'On-demand module',
      },
    ],
  );
});

test('self-contained export includes environment and associated modules but excludes host/auth metadata', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-env-export-bundle-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-export-bundle-pkg-');
  const repository = new KnowledgeRepository(rootPath);
  const { always, onDemand, environment, revision } = await publishEnvironmentBundle(repository);
  const packagePath = path.join(packageDir, 'prod-web.spotshell-environment.json');

  const exported = await repository.exportEnvironment(environment.id, packagePath, 'self-contained');
  const raw = JSON.parse(await fs.readFile(packagePath, 'utf8')) as Record<string, unknown>;

  assert.equal(exported.id, environment.id);
  assert.equal(exported.contentHash, revision.contentHash);
  assert.equal(exported.mode, 'self-contained');
  assert.equal(exported.moduleCount, 2);
  assert.deepEqual(exported.unresolvedModuleIds, []);
  assert.equal(raw.format_version, 1);
  assert.equal(raw.package_kind, 'environment-bundle');
  assert.equal(raw.schema_version, 1);
  const env = raw.environment as { id: string; content_hash: string; files: unknown[] };
  assert.equal(env.id, environment.id);
  assert.equal(env.content_hash, revision.contentHash);
  const modules = raw.modules as Array<{ id: string; content_hash: string }>;
  assert.equal(modules.length, 2);
  assert.deepEqual(
    modules.map((module) => module.id).sort(),
    [always.module.id, onDemand.module.id].sort(),
  );
  assert.equal(modules.find((m) => m.id === always.module.id)?.content_hash, always.revision.contentHash);
  assert.equal(modules.find((m) => m.id === onDemand.module.id)?.content_hash, onDemand.revision.contentHash);

  const packageText = await fs.readFile(packagePath, 'utf8');
  assert.equal(packageText.includes(path.resolve(rootPath)), false);
  assert.equal(packageText.includes('file-origins'), false);
  assert.equal(packageText.includes('revision.json'), false);
  assert.equal(packageText.includes('host'), false);
  assert.equal(packageText.includes('authorization'), false);
  assert.equal(packageText.includes('credential'), false);
});

test('definition-only export keeps stable module ids and reports unresolved dependency risk', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-env-export-definition-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-export-definition-pkg-');
  const repository = new KnowledgeRepository(rootPath);
  const { always, onDemand, environment, revision } = await publishEnvironmentBundle(repository);
  const packagePath = path.join(packageDir, 'prod-web-def.spotshell-environment.json');

  const exported = await repository.exportEnvironment(environment.id, packagePath, 'definition-only');
  const raw = JSON.parse(await fs.readFile(packagePath, 'utf8')) as {
    package_kind: string
    environment: { files: Array<{ relative_path: string; content: string }> }
    modules: unknown[]
  };

  assert.equal(exported.mode, 'definition-only');
  assert.equal(exported.moduleCount, 0);
  assert.equal(raw.package_kind, 'environment-definition');
  assert.deepEqual(raw.modules, []);
  assert.equal(exported.contentHash, revision.contentHash);
  const space = raw.environment.files.find((file) => file.relative_path === 'SPACE.md');
  assert.ok(space);
  assert.match(space!.content, new RegExp(always.module.id));
  assert.match(space!.content, new RegExp(onDemand.module.id));
  // Definition-only warns that associations may become unresolved on import.
  assert.deepEqual(
    exported.unresolvedModuleIds.sort(),
    [always.module.id, onDemand.module.id].sort(),
  );
});

test('self-contained import creates environment and modules with matching hashes and associations', async (t) => {
  const sourceRoot = temporaryDirectory(t, 'spotshell-env-import-src-');
  const targetRoot = temporaryDirectory(t, 'spotshell-env-import-dst-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-import-pkg-');
  const source = new KnowledgeRepository(sourceRoot);
  const { always, onDemand, environment, revision } = await publishEnvironmentBundle(source);
  const packagePath = path.join(packageDir, 'bundle.spotshell-environment.json');
  await source.exportEnvironment(environment.id, packagePath, 'self-contained');

  const target = new KnowledgeRepository(targetRoot);
  const preview = await target.previewEnvironmentImport(packagePath);
  assert.equal(preview.packageKind, 'environment-bundle');
  assert.equal(preview.environment.status, 'create');
  assert.equal(preview.modules.length, 2);
  assert.ok(preview.modules.every((module) => module.status === 'create'));

  const imported = await target.importEnvironment(packagePath);
  assert.equal(imported.environment.status, 'created');
  assert.equal(imported.environment.id, environment.id);
  assert.equal(imported.environment.contentHash, revision.contentHash);
  assert.equal(imported.modules.length, 2);
  assert.deepEqual(imported.unresolvedModuleIds, []);

  const envDetail = await target.getEnvironment(environment.id);
  assert.equal(envDetail.latestContentHash, revision.contentHash);
  assert.deepEqual(envDetail.associations.always.map((dep) => dep.id), [always.module.id]);
  assert.deepEqual(envDetail.associations.onDemand.map((dep) => dep.id), [onDemand.module.id]);
  assert.ok(envDetail.associations.always.every((dep) => dep.status === 'resolved'));
  assert.ok(envDetail.associations.onDemand.every((dep) => dep.status === 'resolved'));

  const alwaysPublished = await target.resolvePublishedObject(always.module.id);
  const onDemandPublished = await target.resolvePublishedObject(onDemand.module.id);
  assert.equal(alwaysPublished?.contentHash, always.revision.contentHash);
  assert.equal(onDemandPublished?.contentHash, onDemand.revision.contentHash);
});

test('import classifies environment and module conflicts separately and requires explicit choices', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-env-import-conflict-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-import-conflict-pkg-');
  const repository = new KnowledgeRepository(rootPath);
  const { always, onDemand, environment } = await publishEnvironmentBundle(repository);
  const packagePath = path.join(packageDir, 'bundle.spotshell-environment.json');
  await repository.exportEnvironment(environment.id, packagePath, 'self-contained');

  // Diverge both the environment and one module locally.
  await repository.saveEnvironmentFormDraft(environment.id, {
    ...(await repository.getEnvironment(environment.id)).form!,
    description: 'Local environment divergence.',
  });
  await repository.publishEnvironmentDraft(environment.id);
  await repository.saveFormDraft(always.module.id, {
    ...(await repository.getModule(always.module.id)).form!,
    description: 'Local module divergence.',
  });
  await repository.publishDraft(always.module.id);

  const preview = await repository.previewEnvironmentImport(packagePath);
  assert.equal(preview.environment.status, 'conflict');
  const alwaysPreview = preview.modules.find((module) => module.id === always.module.id);
  const onDemandPreview = preview.modules.find((module) => module.id === onDemand.module.id);
  assert.equal(alwaysPreview?.status, 'conflict');
  assert.equal(onDemandPreview?.status, 'identical');

  await assert.rejects(
    () => repository.importEnvironment(packagePath),
    /explicit resolution/i,
  );
  await assert.rejects(
    () => repository.importEnvironment(packagePath, {
      environmentResolution: 'use-imported',
    }),
    /Module import conflict/i,
  );

  const imported = await repository.importEnvironment(packagePath, {
    environmentResolution: 'use-imported',
    moduleResolutions: {
      [always.module.id]: 'keep-local',
    },
  });
  assert.equal(imported.environment.status, 'updated');
  assert.equal(
    imported.modules.find((module) => module.id === always.module.id)?.status,
    'kept-local',
  );

  const envDetail = await repository.getEnvironment(environment.id);
  assert.equal(envDetail.description, 'Production web facts.');
  const alwaysDetail = await repository.getModule(always.module.id);
  assert.equal(alwaysDetail.description, 'Local module divergence.');
});

test('definition-only import keeps missing modules as visible unresolved dependencies', async (t) => {
  const sourceRoot = temporaryDirectory(t, 'spotshell-env-def-import-src-');
  const targetRoot = temporaryDirectory(t, 'spotshell-env-def-import-dst-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-def-import-pkg-');
  const source = new KnowledgeRepository(sourceRoot);
  const { always, onDemand, environment, revision } = await publishEnvironmentBundle(source);
  const packagePath = path.join(packageDir, 'definition.spotshell-environment.json');
  await source.exportEnvironment(environment.id, packagePath, 'definition-only');

  const target = new KnowledgeRepository(targetRoot);
  const preview = await target.previewEnvironmentImport(packagePath);
  assert.equal(preview.packageKind, 'environment-definition');
  assert.deepEqual(
    preview.unresolvedModuleIds.sort(),
    [always.module.id, onDemand.module.id].sort(),
  );
  assert.ok(preview.modules.every((module) => module.status === 'missing'));

  const imported = await target.importEnvironment(packagePath);
  assert.equal(imported.environment.status, 'created');
  assert.equal(imported.environment.contentHash, revision.contentHash);
  assert.deepEqual(imported.modules, []);
  assert.deepEqual(
    imported.unresolvedModuleIds.sort(),
    [always.module.id, onDemand.module.id].sort(),
  );

  const envDetail = await target.getEnvironment(environment.id);
  assert.deepEqual(
    envDetail.associations.always.map((dep) => ({ id: dep.id, status: dep.status })),
    [{ id: always.module.id, status: 'unresolved' }],
  );
  assert.deepEqual(
    envDetail.associations.onDemand.map((dep) => ({ id: dep.id, status: dep.status })),
    [{ id: onDemand.module.id, status: 'unresolved' }],
  );
  // No guessed or network-fetched substitute modules.
  assert.deepEqual(await target.listModules(), []);
});

test('import does not change host bindings or local authorization state', async (t) => {
  const sourceRoot = temporaryDirectory(t, 'spotshell-env-import-isolation-src-');
  const targetRoot = temporaryDirectory(t, 'spotshell-env-import-isolation-dst-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-import-isolation-pkg-');
  const source = new KnowledgeRepository(sourceRoot);
  const { environment } = await publishEnvironmentBundle(source);
  const packagePath = path.join(packageDir, 'bundle.spotshell-environment.json');
  await source.exportEnvironment(environment.id, packagePath, 'self-contained');

  const target = new KnowledgeRepository(targetRoot);
  // Pre-create an unrelated local auth/host-like marker file outside the repository objects.
  const localAuthPath = path.join(targetRoot, '..', 'module-authorizations.json');
  const localHostsPath = path.join(targetRoot, '..', 'hosts.json');
  await fs.writeFile(localAuthPath, '{"authorized":["local-only"]}\n', 'utf8');
  await fs.writeFile(localHostsPath, '{"hosts":[{"id":"host-1"}]}\n', 'utf8');
  const authBefore = await fs.readFile(localAuthPath, 'utf8');
  const hostsBefore = await fs.readFile(localHostsPath, 'utf8');

  await target.importEnvironment(packagePath);

  assert.equal(await fs.readFile(localAuthPath, 'utf8'), authBefore);
  assert.equal(await fs.readFile(localHostsPath, 'utf8'), hostsBefore);
  const packageText = await fs.readFile(packagePath, 'utf8');
  assert.equal(packageText.includes('module-authorizations'), false);
  assert.equal(packageText.includes('hosts.json'), false);
});

test('failed import rolls back newly created objects so relationships stay atomic', async (t) => {
  const sourceRoot = temporaryDirectory(t, 'spotshell-env-import-atomic-src-');
  const targetRoot = temporaryDirectory(t, 'spotshell-env-import-atomic-dst-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-import-atomic-pkg-');
  const source = new KnowledgeRepository(sourceRoot);
  const { always, environment } = await publishEnvironmentBundle(source);
  const packagePath = path.join(packageDir, 'bundle.spotshell-environment.json');
  await source.exportEnvironment(environment.id, packagePath, 'self-contained');

  // Tamper after export so module payloads validate but environment hash fails mid-import is hard;
  // instead pre-create the environment object so materialization fails after modules are created.
  const target = new KnowledgeRepository(targetRoot);
  const blocking = await target.createEnvironmentDraft({ name: 'Blocking' });
  // Force the environment id to collide by rewriting package environment id to an existing id
  // is not allowed (hash). Simpler: create a module with the always id so module create fails first.
  // Use import with conflict on environment without resolution after modules would have been applied —
  // assertEnvironmentImportResolutions runs before writes, so create a package that passes
  // classification then fails during environment materialization via pre-created env id.
  const packageData = JSON.parse(await fs.readFile(packagePath, 'utf8')) as {
    environment: { id: string; name: string; content_hash: string; files: Array<{ relative_path: string; content: string }> }
    modules: Array<{ id: string; name: string; content_hash: string; files: Array<{ relative_path: string; content: string }> }>
  };
  // Pre-create empty object dirs matching the package environment id to block rename.
  await fs.mkdir(path.join(targetRoot, packageData.environment.id), { recursive: true });
  await fs.writeFile(
    path.join(targetRoot, packageData.environment.id, 'manifest.json'),
    JSON.stringify({
      id: packageData.environment.id,
      kind: 'environment',
      createdAt: new Date().toISOString(),
      draftSummary: { name: 'blocker', description: 'x', tags: [] },
    }, null, 2),
    'utf8',
  );

  await assert.rejects(() => target.importEnvironment(packagePath));

  // Modules created during the failed import must be rolled back.
  assert.equal(
    await fs.access(path.join(targetRoot, always.module.id)).then(() => true, () => false),
    false,
  );
  assert.deepEqual(
    (await target.listModules()).map((module) => module.id),
    [],
  );
  // Pre-existing blocker remains; no published revision for the package environment.
  const blocker = await target.getEnvironment(blocking.id);
  assert.equal(blocker.name, 'Blocking');
});

test('self-contained export then import preserves associations and content hashes', async (t) => {
  const sourceRoot = temporaryDirectory(t, 'spotshell-env-roundtrip-src-');
  const targetRoot = temporaryDirectory(t, 'spotshell-env-roundtrip-dst-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-roundtrip-pkg-');
  const source = new KnowledgeRepository(sourceRoot);
  const { always, onDemand, environment, revision } = await publishEnvironmentBundle(source);
  const packagePath = path.join(packageDir, 'roundtrip.spotshell-environment.json');
  await source.exportEnvironment(environment.id, packagePath, 'self-contained');

  const target = new KnowledgeRepository(targetRoot);
  const imported = await target.importEnvironment(packagePath);
  assert.equal(imported.environment.contentHash, revision.contentHash);

  const reexportPath = path.join(packageDir, 'roundtrip-again.spotshell-environment.json');
  const reexported = await target.exportEnvironment(environment.id, reexportPath, 'self-contained');
  assert.equal(reexported.contentHash, revision.contentHash);

  const first = JSON.parse(await fs.readFile(packagePath, 'utf8')) as {
    environment: { content_hash: string; files: Array<{ relative_path: string; content: string }> }
    modules: Array<{ id: string; content_hash: string }>
  };
  const second = JSON.parse(await fs.readFile(reexportPath, 'utf8')) as {
    environment: { content_hash: string; files: Array<{ relative_path: string; content: string }> }
    modules: Array<{ id: string; content_hash: string }>
  };
  assert.equal(first.environment.content_hash, second.environment.content_hash);
  assert.deepEqual(
    first.modules.map((module) => module.content_hash).sort(),
    second.modules.map((module) => module.content_hash).sort(),
  );

  const envDetail = await target.getEnvironment(environment.id);
  assert.deepEqual(envDetail.associations.always.map((dep) => dep.id), [always.module.id]);
  assert.deepEqual(envDetail.associations.onDemand.map((dep) => dep.id), [onDemand.module.id]);
});

test('export requires a published environment revision', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-env-export-draft-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-export-draft-pkg-');
  const repository = new KnowledgeRepository(rootPath);
  const environment = await repository.createEnvironmentDraft({ name: 'Draft only' });
  const packagePath = path.join(packageDir, 'draft.spotshell-environment.json');

  await assert.rejects(
    () => repository.exportEnvironment(environment.id, packagePath, 'self-contained'),
    /published revision/i,
  );
  await assert.rejects(() => fs.access(packagePath));
});

test('module import-as-copy remaps environment associations to the new stable ids', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-env-import-copy-remap-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-import-copy-remap-pkg-');
  const repository = new KnowledgeRepository(rootPath);
  const { always, onDemand, environment } = await publishEnvironmentBundle(repository);
  const packagePath = path.join(packageDir, 'bundle.spotshell-environment.json');
  await repository.exportEnvironment(environment.id, packagePath, 'self-contained');

  // Diverge the always module so import requires an explicit resolution.
  await repository.saveFormDraft(always.module.id, {
    ...(await repository.getModule(always.module.id)).form!,
    description: 'Local always module divergence.',
  });
  await repository.publishDraft(always.module.id);

  const imported = await repository.importEnvironment(packagePath, {
    moduleResolutions: {
      [always.module.id]: 'import-as-copy',
    },
  });

  const copied = imported.modules.find((module) => module.status === 'copied');
  assert.ok(copied);
  assert.equal(copied!.sourceId, always.module.id);
  assert.notEqual(copied!.id, always.module.id);

  const envDetail = await repository.getEnvironment(environment.id);
  assert.deepEqual(envDetail.associations.always.map((dep) => dep.id), [copied!.id]);
  assert.deepEqual(envDetail.associations.onDemand.map((dep) => dep.id), [onDemand.module.id]);
  assert.equal(envDetail.associations.always[0]?.status, 'resolved');
  assert.equal(envDetail.associations.onDemand[0]?.status, 'resolved');
  // Original local module remains, but is no longer referenced by the environment.
  const original = await repository.getModule(always.module.id);
  assert.equal(original.description, 'Local always module divergence.');
});

test('import rejects draft-only stable id collisions before any package writes', async (t) => {
  const sourceRoot = temporaryDirectory(t, 'spotshell-env-import-draft-collide-src-');
  const targetRoot = temporaryDirectory(t, 'spotshell-env-import-draft-collide-dst-');
  const packageDir = temporaryDirectory(t, 'spotshell-env-import-draft-collide-pkg-');
  const source = new KnowledgeRepository(sourceRoot);
  const { always, environment } = await publishEnvironmentBundle(source);
  const packagePath = path.join(packageDir, 'bundle.spotshell-environment.json');
  await source.exportEnvironment(environment.id, packagePath, 'self-contained');

  const target = new KnowledgeRepository(targetRoot);
  await fs.mkdir(path.join(targetRoot, always.module.id), { recursive: true });
  await fs.writeFile(
    path.join(targetRoot, always.module.id, 'manifest.json'),
    JSON.stringify({
      id: always.module.id,
      kind: 'knowledge',
      createdAt: new Date().toISOString(),
      draftSummary: { name: 'draft blocker', description: 'x', tags: [] },
    }, null, 2),
    'utf8',
  );

  await assert.rejects(
    () => target.importEnvironment(packagePath),
    /already exists without a matching published revision/i,
  );
  // No other package objects should have been materialized.
  assert.equal(
    await fs.access(path.join(targetRoot, environment.id)).then(() => true, () => false),
    false,
  );
});
