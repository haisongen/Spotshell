import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertUniqueSpaceIds,
  extractGuidanceBody,
  extractInlineGuidance,
  parseSpaceDocument,
  repairMissingSpaceFrontmatter,
  serializeSpaceDocument,
  spaceDocumentFromForm,
  toSpaceForm,
} from './spaceDocument.js';

function readFixture(name: string): string {
  return fs.readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}/SPACE.md`, import.meta.url)),
    'utf8'
  );
}

test('a simple knowledge SPACE.md round-trips without losing form semantics', () => {
  const document = parseSpaceDocument(readFixture('simple-knowledge'));

  assert.deepEqual(document.metadata, {
    schema_version: 1,
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'knowledge',
    name: 'Service Basics',
    description: 'Common checks for a single Linux service.',
    when_to_use: 'Use when a service is unavailable or unhealthy.',
    tags: ['linux', 'service'],
  });
  assert.match(document.body, /^# Service Basics/m);

  const serialized = serializeSpaceDocument(document);

  assert.deepEqual(parseSpaceDocument(serialized), document);
});

test('a complex knowledge SPACE.md preserves explicit guidance semantics', () => {
  const document = parseSpaceDocument(readFixture('complex-knowledge'));

  assert.equal(document.metadata.kind, 'knowledge');
  assert.deepEqual(document.metadata.guidance_files, ['rules/service-safety.md']);
  assert.match(
    extractInlineGuidance(document),
    /Prefer read-only inspection before proposing a change\./
  );

  assert.deepEqual(parseSpaceDocument(serializeSpaceDocument(document)), document);
});

test('an environment SPACE.md round-trips always and on-demand module associations', () => {
  const document = parseSpaceDocument(readFixture('environment'));

  assert.equal(document.metadata.kind, 'environment');
  assert.deepEqual(document.metadata.modules, {
    always: ['11111111-1111-4111-8111-111111111111'],
    on_demand: ['22222222-2222-4222-8222-222222222222'],
  });

  assert.deepEqual(parseSpaceDocument(serializeSpaceDocument(document)), document);
});

test('an environment SPACE.md rejects a Guidance section', () => {
  const source = `${readFixture('environment')}\n## Guidance\n\nRestart the service.\n`;

  assert.throws(
    () => parseSpaceDocument(source),
    /environment SPACE\.md must not contain ## Guidance/
  );
});

test('an environment SPACE.md rejects duplicate module stable IDs', () => {
  const source = readFixture('environment').replace(
    '  on_demand:\n    - 22222222-2222-4222-8222-222222222222',
    '  on_demand:\n    - 11111111-1111-4111-8111-111111111111'
  );

  assert.throws(() => parseSpaceDocument(source), /Duplicate module stable ID/);
});

test('a collection rejects duplicate SPACE.md stable IDs', () => {
  const document = parseSpaceDocument(readFixture('simple-knowledge'));

  assert.throws(
    () => assertUniqueSpaceIds([document, document]),
    /Duplicate SPACE\.md stable ID/
  );
});

test('SPACE.md rejects malformed or duplicate YAML fields', () => {
  assert.throws(
    () => parseSpaceDocument('---\nkind: [\n---\n\n# Broken\n'),
    /Invalid SPACE\.md YAML/
  );
  const duplicateId = readFixture('simple-knowledge').replace(
    'kind: knowledge',
    'id: 22222222-2222-4222-8222-222222222222\nkind: knowledge'
  );
  assert.throws(() => parseSpaceDocument(duplicateId), /Invalid SPACE\.md YAML/);
});

test('SPACE.md rejects missing metadata and illegal stable IDs', () => {
  const missingDescription = readFixture('simple-knowledge').replace(
    'description: Common checks for a single Linux service.\n',
    ''
  );
  const illegalId = readFixture('simple-knowledge').replace(
    '11111111-1111-4111-8111-111111111111',
    'not-a-stable-id'
  );
  const nonCanonicalId = readFixture('simple-knowledge').replace(
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
  );

  assert.throws(() => parseSpaceDocument(missingDescription), /Invalid SPACE\.md metadata/);
  assert.throws(() => parseSpaceDocument(illegalId), /Invalid SPACE\.md metadata/);
  assert.throws(() => parseSpaceDocument(nonCanonicalId), /canonical lowercase UUIDs/);
});

test('SPACE.md rejects fields owned by the other kind', () => {
  const environmentWithGuidanceFiles = readFixture('environment').replace(
    'modules:',
    'guidance_files:\n  - rules/unsafe.md\nmodules:'
  );
  const knowledgeWithModules = readFixture('simple-knowledge').replace(
    'tags:',
    'modules:\n  always: []\n  on_demand: []\ntags:'
  );

  assert.throws(
    () => parseSpaceDocument(environmentWithGuidanceFiles),
    /Invalid SPACE\.md metadata/
  );
  assert.throws(() => parseSpaceDocument(knowledgeWithModules), /Invalid SPACE\.md metadata/);
});

test('a knowledge SPACE.md rejects duplicate Guidance sections', () => {
  const source = `${readFixture('complex-knowledge')}\n## Guidance\n\nDuplicate rule.\n`;

  assert.throws(() => parseSpaceDocument(source), /duplicate ## Guidance sections/);
});

test('form and source shapes round-trip all schema v1 fixtures semantically', () => {
  for (const fixture of ['simple-knowledge', 'complex-knowledge', 'environment']) {
    const document = parseSpaceDocument(readFixture(fixture));
    const form = toSpaceForm(document);
    const fromForm = spaceDocumentFromForm(form);

    assert.deepEqual(fromForm, document, fixture);
  }

  const complexForm = toSpaceForm(parseSpaceDocument(readFixture('complex-knowledge')));
  assert.match(complexForm.inlineGuidance ?? '', /Prefer read-only inspection/);
  assert.match(complexForm.afterGuidance, /## References/);
});

test('repairMissingSpaceFrontmatter reattaches the original frontmatter when an AI edit drops it', () => {
  const before = readFixture('simple-knowledge');
  const afterMissingFrontmatter = '# Service Basics\n\nNew appended fact.\n';

  const repaired = repairMissingSpaceFrontmatter(before, afterMissingFrontmatter);
  const document = parseSpaceDocument(repaired);

  assert.deepEqual(document.metadata, parseSpaceDocument(before).metadata);
  assert.match(document.body, /New appended fact\./);
});

test('repairMissingSpaceFrontmatter leaves a deliberate frontmatter edit alone, even if invalid', () => {
  const before = readFixture('simple-knowledge');
  const afterWithBrokenFrontmatter = '---\nnot: valid\n---\n\nbody\n';

  assert.equal(
    repairMissingSpaceFrontmatter(before, afterWithBrokenFrontmatter),
    afterWithBrokenFrontmatter,
  );
});

test('repairMissingSpaceFrontmatter is a no-op when after already has frontmatter', () => {
  const before = readFixture('simple-knowledge');
  const after = readFixture('environment');

  assert.equal(repairMissingSpaceFrontmatter(before, after), after);
});

test('extractGuidanceBody stops at a spaceless ## heading', () => {
  const source = [
    '---',
    'schema_version: 1',
    'id: 11111111-1111-4111-8111-111111111111',
    'kind: knowledge',
    'name: Ambari',
    'description: ambari ops',
    'when_to_use: ambari',
    '---',
    '',
    '## Guidance',
    '',
    '先确认集群状态',
    '',
    '##Hadoop 日志巡检',
    '',
    '巡检步骤',
    '',
  ].join('\n');

  assert.equal(extractGuidanceBody(source), '先确认集群状态');
  // toSpaceForm shares the boundary rule, so the tail lands after Guidance.
  const form = toSpaceForm(parseSpaceDocument(source));
  assert.equal(form.inlineGuidance?.trim(), '先确认集群状态');
  assert.match(form.afterGuidance, /^##Hadoop 日志巡检/);
});

test('extractGuidanceBody returns empty for a document without Guidance', () => {
  assert.equal(extractGuidanceBody(readFixture('simple-knowledge')), '');
  assert.equal(extractGuidanceBody(''), '');
  assert.equal(extractGuidanceBody('## Guidance'), '');
});
