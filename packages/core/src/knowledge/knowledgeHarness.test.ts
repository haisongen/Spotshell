import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeHarness, KnowledgeHarnessError } from './knowledgeHarness.js';
import type { KnowledgeObjectHandle } from './knowledgeHarness.js';
import { temporaryDirectory } from './temporaryDirectory.testSupport.js';

const OBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function writeObjectRoot(
  rootPath: string,
  files: Record<string, string>
): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootPath, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
  }
}

function fixedModule(rootPath: string, overrides: Partial<KnowledgeObjectHandle> = {}): KnowledgeObjectHandle {
  return {
    id: OBJECT_ID,
    name: 'Release Diagnostics',
    kind: 'knowledge',
    revision: 1,
    contentHash: 'abc123def456',
    rootPath,
    access: 'fixed',
    guidanceFiles: ['rules/service-safety.md'],
    ...overrides,
  };
}

function makeHarness(
  t: test.TestContext,
  files: Record<string, string>,
  overrides: Partial<KnowledgeObjectHandle> = {},
  catalog: import('./knowledgeCatalog.js').KnowledgeCatalogEntry[] = []
): KnowledgeHarness {
  const rootPath = temporaryDirectory(t, 'spotshell-harness-');
  writeObjectRoot(rootPath, files);
  return new KnowledgeHarness({
    objects: [fixedModule(rootPath, overrides)],
    catalog,
  });
}

const SPACE_MD = `---
schema_version: 1
id: ${OBJECT_ID}
kind: knowledge
name: Release Diagnostics
description: Release safety guidance.
when_to_use: Use while diagnosing a failed release.
---

# Release Diagnostics

## Guidance

- Prefer read-only inspection.

## References

See references/troubleshooting.md
`;

test('listEligibleMetadata returns only catalog entries without absolute paths', () => {
  const harness = new KnowledgeHarness({
    objects: [],
    catalog: [{
      id: OBJECT_ID,
      name: 'Release Diagnostics',
      description: 'Release safety guidance.',
      whenToUse: 'Use while diagnosing a failed release.',
      tags: ['release'],
      scope: 'session',
    }],
  });

  const listed = harness.listEligibleMetadata();
  assert.deepEqual(listed, [{
    id: OBJECT_ID,
    name: 'Release Diagnostics',
    description: 'Release safety guidance.',
    whenToUse: 'Use while diagnosing a failed release.',
    tags: ['release'],
    scope: 'session',
  }]);
  assert.equal(JSON.stringify(listed).includes('C:'), false);
  assert.equal(JSON.stringify(listed).includes('/Users/'), false);
});

test('readEntry returns SPACE.md with provenance for an authorized active revision', async (t) => {
  const harness = makeHarness(t, {
    'SPACE.md': SPACE_MD,
    'rules/service-safety.md': 'Do not restart without approval.\n',
    'references/troubleshooting.md': 'Check service status first.\n',
  });

  const result = await harness.readEntry(OBJECT_ID, 1);
  assert.match(result.content, /Prefer read-only inspection/);
  assert.equal(result.provenance.objectId, OBJECT_ID);
  assert.equal(result.provenance.objectName, 'Release Diagnostics');
  assert.equal(result.provenance.revision, 1);
  assert.equal(result.provenance.contentHash, 'abc123def456');
  assert.equal(result.provenance.relativePath, 'SPACE.md');
  assert.equal(result.provenance.startLine, 1);
  assert.ok(result.provenance.endLine >= result.provenance.startLine);
  assert.equal(result.provenance.contentType, 'entry');
  assert.equal(result.provenance.loadReason, 'entry-read');
  assert.equal(result.provenance.objectKind, 'knowledge');
  assert.deepEqual(harness.takeProvenance(), [result.provenance]);
  assert.equal(JSON.stringify(result).includes(path.sep + 'spotshell-harness-'), false);
});

test('readEntry rejects unauthorized, wrong revision, and missing objects', async (t) => {
  const harness = makeHarness(t, { 'SPACE.md': SPACE_MD });

  await assert.rejects(
    () => harness.readEntry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeHarnessError);
      assert.match(error.message, /not authorized|not selected|unavailable/i);
      return true;
    }
  );

  await assert.rejects(
    () => harness.readEntry(OBJECT_ID, 99),
    (error: unknown) => {
      assert.ok(error instanceof KnowledgeHarnessError);
      assert.match(error.message, /revision/i);
      return true;
    }
  );
});

test('listTextFiles returns object-relative paths only and hides revision metadata', async (t) => {
  const harness = makeHarness(t, {
    'SPACE.md': SPACE_MD,
    'revision.json': '{"id":"secret-system-meta"}\n',
    'rules/service-safety.md': 'rule\n',
    'references/troubleshooting.md': 'ref\n',
  });

  const listed = await harness.listTextFiles(OBJECT_ID, 1);
  assert.deepEqual(
    listed.files.map((file) => file.relativePath),
    ['references/troubleshooting.md', 'rules/service-safety.md', 'SPACE.md']
  );
  assert.equal(listed.files.some((file) => path.isAbsolute(file.relativePath)), false);
  assert.equal(listed.files.some((file) => file.relativePath === 'revision.json'), false);

  await assert.rejects(
    () => harness.readLines(OBJECT_ID, 1, 'revision.json', { startLine: 1 }),
    /metadata|not readable/i
  );
});

test('searchText finds literal matches with preview and provenance limits', async (t) => {
  const harness = makeHarness(t, {
    'SPACE.md': SPACE_MD,
    'references/troubleshooting.md': [
      'line one',
      'service timeout on pod restart',
      'line three with service timeout again',
      'unrelated',
    ].join('\n') + '\n',
  });

  const result = await harness.searchText(OBJECT_ID, 1, {
    pattern: 'service timeout',
    mode: 'literal',
  });

  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0]?.relativePath, 'references/troubleshooting.md');
  assert.equal(result.matches[0]?.line, 2);
  assert.match(result.matches[0]?.preview ?? '', /service timeout/);
  assert.ok((result.matches[0]?.preview.length ?? 0) <= 500);
  assert.equal(result.matches[0]?.provenance.contentType, 'search-preview');
  assert.equal(result.matches[0]?.provenance.loadReason, 'search');
  assert.equal(harness.takeProvenance().length, 2);
});

test('searchText supports controlled regex with match and timeout limits', async (t) => {
  const lines = Array.from({ length: 50 }, (_, index) => `error-${index} failed`);
  const harness = makeHarness(t, {
    'SPACE.md': SPACE_MD,
    'references/troubleshooting.md': `${lines.join('\n')}\n`,
  });

  const result = await harness.searchText(OBJECT_ID, 1, {
    pattern: 'error-\\d+ failed',
    mode: 'regex',
    maxMatches: 5,
  });
  assert.equal(result.matches.length, 5);
  assert.equal(result.truncated, true);

  await assert.rejects(
    () => harness.searchText(OBJECT_ID, 1, {
      pattern: 'a'.repeat(300),
      mode: 'regex',
    }),
    /pattern|characters|limit/i
  );
});

test('readLines returns bounded ranges and requires explicit continuation', async (t) => {
  const content = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join('\n') + '\n';
  const harness = makeHarness(t, {
    'SPACE.md': SPACE_MD,
    'references/troubleshooting.md': content,
  });

  const first = await harness.readLines(OBJECT_ID, 1, 'references/troubleshooting.md', {
    startLine: 1,
    maxLines: 10,
  });
  assert.equal(first.startLine, 1);
  assert.equal(first.endLine, 10);
  assert.match(first.content, /line-1/);
  assert.match(first.content, /line-10/);
  assert.equal(first.content.includes('line-11'), false);
  assert.equal(first.hasMore, true);
  assert.equal(first.provenance.contentType, 'reference');
  assert.equal(first.provenance.loadReason, 'line-read');

  const next = await harness.readLines(OBJECT_ID, 1, 'references/troubleshooting.md', {
    startLine: 11,
    maxLines: 10,
  });
  assert.equal(next.startLine, 11);
  assert.equal(next.endLine, 20);
  assert.match(next.content, /line-11/);
});

test('readLines classifies guidance files and rejects path escape', async (t) => {
  const harness = makeHarness(t, {
    'SPACE.md': SPACE_MD,
    'rules/service-safety.md': 'Do not restart without approval.\n',
  });

  const guidance = await harness.readLines(OBJECT_ID, 1, 'rules/service-safety.md', {
    startLine: 1,
    maxLines: 20,
  });
  assert.equal(guidance.provenance.contentType, 'guidance');

  await assert.rejects(
    () => harness.readLines(OBJECT_ID, 1, '../outside.md', { startLine: 1 }),
    /path|escape|traversal|not allowed/i
  );
  await assert.rejects(
    () => harness.readLines(OBJECT_ID, 1, 'C:/Windows/win.ini', { startLine: 1 }),
    /path|absolute|not allowed/i
  );
});

test('secret-isolated content is refused by read and search tools', async (t) => {
  const harness = makeHarness(t, {
    'SPACE.md': SPACE_MD,
    'references/secrets.md': 'api_key = sk-proj-abcdefghijklmnopqrstuvwxyz\n',
  });

  await assert.rejects(
    () => harness.readLines(OBJECT_ID, 1, 'references/secrets.md', { startLine: 1 }),
    /secret/i
  );
  await assert.rejects(
    () => harness.searchText(OBJECT_ID, 1, { pattern: 'api_key', mode: 'literal' }),
    /secret/i
  );
  assert.deepEqual(harness.takeProvenance(), []);
});

test('knowledge harness has no SSH, write, authorize, revision-apply, or network surface', () => {
  const methods = Object.getOwnPropertyNames(KnowledgeHarness.prototype)
    .filter((name) => name !== 'constructor');
  for (const forbidden of [
    'execute',
    'write',
    'authorize',
    'publish',
    'applyRevision',
    'fetch',
    'ssh',
  ]) {
    assert.equal(methods.some((name) => name.toLocaleLowerCase('en-US').includes(forbidden)), false);
  }
});

test('replaceActiveObject swaps one object pin and clears only that object material cache', async (t) => {
  const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const rootA1 = temporaryDirectory(t, 'spotshell-harness-a1-');
  const rootA2 = temporaryDirectory(t, 'spotshell-harness-a2-');
  const rootB = temporaryDirectory(t, 'spotshell-harness-b-');
  writeObjectRoot(rootA1, {
    'SPACE.md': SPACE_MD.replace('Prefer read-only inspection.', 'Revision one guidance.'),
  });
  writeObjectRoot(rootA2, {
    'SPACE.md': SPACE_MD.replace('Prefer read-only inspection.', 'Revision two guidance.'),
  });
  writeObjectRoot(rootB, {
    'SPACE.md': `---
schema_version: 1
id: ${otherId}
kind: knowledge
name: Other Module
description: Unrelated.
when_to_use: Never.
---

# Other

## Guidance

- Keep other material.
`,
  });

  const harness = new KnowledgeHarness({
    objects: [
      fixedModule(rootA1, { revision: 1, contentHash: 'hash-1' }),
      {
        id: otherId,
        name: 'Other Module',
        kind: 'knowledge',
        revision: 1,
        contentHash: 'hash-b',
        rootPath: rootB,
        access: 'fixed',
      },
    ],
  });

  assert.match((await harness.readEntry(OBJECT_ID, 1)).content, /Revision one guidance/);
  assert.match((await harness.readEntry(otherId, 1)).content, /Keep other material/);

  harness.replaceActiveObject({
    id: OBJECT_ID,
    name: 'Release Diagnostics',
    kind: 'knowledge',
    revision: 2,
    contentHash: 'hash-2',
    rootPath: rootA2,
    access: 'fixed',
  });

  await assert.rejects(() => harness.readEntry(OBJECT_ID, 1), /revision mismatch/i);
  assert.match((await harness.readEntry(OBJECT_ID, 2)).content, /Revision two guidance/);
  assert.match((await harness.readEntry(otherId, 1)).content, /Keep other material/);
  assert.equal(harness.listSessionOverview().readable.find((entry) => entry.id === OBJECT_ID)?.revision, 2);
});

const CANDIDATE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('selectModule activates an authorized candidate and returns entry with selection metadata', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-select-');
  writeObjectRoot(rootPath, {
    'SPACE.md': `---
schema_version: 1
id: ${CANDIDATE_ID}
kind: knowledge
name: JVM Diagnostics
description: JVM heap and GC guidance.
when_to_use: Use when diagnosing Java memory issues.
---

# JVM Diagnostics

## Guidance

- Capture heap histogram before restarting.

## References

See references/heap.md
`,
    'references/heap.md': 'jmap -histo:live <pid>\n',
  });

  const harness = new KnowledgeHarness({
    objects: [],
    catalog: [{
      id: CANDIDATE_ID,
      name: 'JVM Diagnostics',
      description: 'JVM heap and GC guidance.',
      whenToUse: 'Use when diagnosing Java memory issues.',
      tags: ['jvm'],
      scope: 'global',
    }],
    activatable: [{
      id: CANDIDATE_ID,
      name: 'JVM Diagnostics',
      kind: 'knowledge',
      revision: 2,
      contentHash: 'hash-jvm-2',
      rootPath,
      access: 'dynamic',
    }],
  });

  await assert.rejects(
    () => harness.readEntry(CANDIDATE_ID, 2),
    /not authorized|not selected/i
  );

  const selected = await harness.selectModule(
    CANDIDATE_ID,
    'User asked about Java heap pressure'
  );
  assert.equal(selected.selection.moduleId, CANDIDATE_ID);
  assert.equal(selected.selection.moduleName, 'JVM Diagnostics');
  assert.equal(selected.selection.revision, 2);
  assert.equal(selected.selection.contentHash, 'hash-jvm-2');
  assert.equal(selected.selection.reason, 'User asked about Java heap pressure');
  assert.equal(selected.selection.loadType, 'dynamic');
  assert.equal(selected.selection.scope, 'global');
  assert.match(selected.content, /Capture heap histogram/);
  assert.equal(selected.provenance.loadReason, 'entry-read');

  const overview = harness.listSessionOverview();
  assert.equal(overview.readable.length, 1);
  assert.equal(overview.readable[0]?.id, CANDIDATE_ID);
  assert.equal(overview.readable[0]?.access, 'dynamic');
  assert.equal(overview.readable[0]?.revision, 2);

  const body = await harness.readLines(CANDIDATE_ID, 2, 'references/heap.md', { startLine: 1 });
  assert.match(body.content, /jmap -histo:live/);
  assert.equal(body.provenance.loadReason, 'line-read');

  const again = await harness.selectModule(CANDIDATE_ID, 'repeat select');
  assert.equal(again.selection.reason, 'User asked about Java heap pressure');
  assert.equal(harness.listActiveDynamicSelections().length, 1);
});

test('selectModule refuses modules that are only owned, not authorized candidates', async (t) => {
  const ownedRoot = temporaryDirectory(t, 'spotshell-owned-only-');
  writeObjectRoot(ownedRoot, {
    'SPACE.md': `---
schema_version: 1
id: ${CANDIDATE_ID}
kind: knowledge
name: Secret Ops
description: Not authorized.
when_to_use: Never.
---

# Secret Ops
`,
  });

  const harness = new KnowledgeHarness({
    objects: [],
    catalog: [],
    activatable: [],
  });

  await assert.rejects(
    () => harness.selectModule(CANDIDATE_ID, 'try unauthorized'),
    /not authorized|not an authorized candidate/i
  );
  assert.deepEqual(harness.listActiveDynamicSelections(), []);
  // Ensure we never accidentally made the owned path readable.
  await assert.rejects(
    () => harness.readEntry(CANDIDATE_ID, 1),
    /not authorized|not selected/i
  );
  void ownedRoot;
});
