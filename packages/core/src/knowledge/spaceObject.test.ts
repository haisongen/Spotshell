import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSpaceDocument, serializeSpaceDocument } from './spaceDocument.js';
import { loadSpaceObject } from './spaceObject.js';
import { temporaryDirectory } from './temporaryDirectory.testSupport.js';

function fixtureRoot(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));
}

test('a complex knowledge object loads validated text files and a content hash', async () => {
  const object = await loadSpaceObject(fixtureRoot('complex-knowledge'));

  assert.equal(object.document.metadata.kind, 'knowledge');
  assert.deepEqual(object.files.map((file) => file.relativePath), [
    'references/troubleshooting.md',
    'rules/service-safety.md',
    'SPACE.md',
  ]);
  assert.match(object.contentHash, /^[a-f0-9]{64}$/);
});

test('normalized content hash is stable across semantic serialization and line endings', async (t) => {
  const temporaryRoot = temporaryDirectory(t, 'spotshell-space-hash-');
  fs.cpSync(fixtureRoot('complex-knowledge'), temporaryRoot, { recursive: true });
  const before = await loadSpaceObject(temporaryRoot);
  const entryPath = path.join(temporaryRoot, 'SPACE.md');
  const parsed = parseSpaceDocument(fs.readFileSync(entryPath, 'utf8'));
  fs.writeFileSync(
    entryPath,
    serializeSpaceDocument(parsed).replace(/\n/g, '\r\n'),
    'utf8'
  );
  const referencePath = path.join(temporaryRoot, 'references', 'troubleshooting.md');
  fs.writeFileSync(
    referencePath,
    fs.readFileSync(referencePath, 'utf8').replace(/\n/g, '\r\n'),
    'utf8'
  );

  const after = await loadSpaceObject(temporaryRoot);

  assert.deepEqual(after.document, before.document);
  assert.equal(after.contentHash, before.contentHash);
});

test('a guidance file path cannot traverse outside the object root', async (t) => {
  const temporaryRoot = temporaryDirectory(t, 'spotshell-space-path-');
  fs.cpSync(fixtureRoot('simple-knowledge'), temporaryRoot, { recursive: true });
  const entryPath = path.join(temporaryRoot, 'SPACE.md');
  const source = fs.readFileSync(entryPath, 'utf8').replace(
    'tags:',
    'guidance_files:\n  - ../outside.md\ntags:'
  );
  fs.writeFileSync(entryPath, source, 'utf8');

  await assert.rejects(() => loadSpaceObject(temporaryRoot), /path traversal is not allowed/);
});

test('a registered guidance file must exist in the managed object', async (t) => {
  const temporaryRoot = temporaryDirectory(t, 'spotshell-space-missing-');
  fs.cpSync(fixtureRoot('complex-knowledge'), temporaryRoot, { recursive: true });
  fs.rmSync(path.join(temporaryRoot, 'rules', 'service-safety.md'));

  await assert.rejects(() => loadSpaceObject(temporaryRoot), /Guidance file does not exist/);
});

test('guidance files cannot promote SPACE.md itself to guidance', async (t) => {
  const temporaryRoot = temporaryDirectory(t, 'spotshell-space-entry-guidance-');
  fs.cpSync(fixtureRoot('simple-knowledge'), temporaryRoot, { recursive: true });
  const entryPath = path.join(temporaryRoot, 'SPACE.md');
  const source = fs.readFileSync(entryPath, 'utf8').replace(
    'tags:',
    'guidance_files:\n  - SPACE.md\ntags:'
  );
  fs.writeFileSync(entryPath, source, 'utf8');

  await assert.rejects(() => loadSpaceObject(temporaryRoot), /must not reference SPACE.md/);
});

test('guidance file paths must be unique after path normalization', async (t) => {
  const temporaryRoot = temporaryDirectory(t, 'spotshell-space-guidance-duplicate-');
  fs.cpSync(fixtureRoot('complex-knowledge'), temporaryRoot, { recursive: true });
  const entryPath = path.join(temporaryRoot, 'SPACE.md');
  const source = fs.readFileSync(entryPath, 'utf8').replace(
    '  - rules/service-safety.md',
    '  - rules/service-safety.md\n  - rules\\service-safety.md'
  );
  fs.writeFileSync(entryPath, source, 'utf8');

  await assert.rejects(() => loadSpaceObject(temporaryRoot), /Duplicate guidance file path/);
});
