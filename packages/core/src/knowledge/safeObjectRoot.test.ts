import assert from 'node:assert/strict';
import fs, { type PathLike } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { SPACE_V1_LIMITS } from './limits.js';
import { SafeObjectRoot } from './safeObjectRoot.js';
import { temporaryDirectory } from './temporaryDirectory.testSupport.js';

test('object file reads reject absolute, drive, UNC, and traversal paths', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-safe-root-');
  fs.writeFileSync(path.join(rootPath, 'SPACE.md'), '# Entry\n', 'utf8');
  const root = await SafeObjectRoot.open(rootPath);

  for (const unsafePath of [
    '/etc/passwd',
    'C:relative-secret.txt',
    'C:\\Users\\operator\\.ssh\\id_rsa',
    '\\\\server\\share\\secret.txt',
    '../outside.txt',
    'references/../../outside.txt',
  ]) {
    await assert.rejects(() => root.readText(unsafePath), /not allowed/);
  }
});

test('object file reads reject a directory swapped to a link after canonicalization', async (t) => {
  const parent = temporaryDirectory(t, 'spotshell-safe-race-');
  const rootPath = path.join(parent, 'object');
  const referencesPath = path.join(rootPath, 'references');
  const backupPath = path.join(rootPath, 'references-backup');
  const outsidePath = path.join(parent, 'outside');
  const targetPath = path.join(referencesPath, 'notes.txt');
  fs.mkdirSync(referencesPath, { recursive: true });
  fs.mkdirSync(outsidePath);
  fs.writeFileSync(targetPath, 'managed content\n', 'utf8');
  fs.writeFileSync(path.join(outsidePath, 'notes.txt'), 'outside secret\n', 'utf8');
  const root = await SafeObjectRoot.open(rootPath);
  const originalRealpath = fsPromises.realpath.bind(fsPromises);
  let swapped = false;
  t.mock.method(fsPromises, 'realpath', async (candidate: PathLike) => {
    const realPath = await originalRealpath(candidate);
    if (!swapped && path.resolve(candidate.toString()) === path.resolve(targetPath)) {
      swapped = true;
      fs.renameSync(referencesPath, backupPath);
      fs.symlinkSync(
        outsidePath,
        referencesPath,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    }
    return realPath;
  });

  await assert.rejects(
    () => root.readText('references/notes.txt'),
    /Links and reparse points are not allowed|changed during validation/
  );
});

test('object enumeration rechecks bytes when a file grows after metadata inspection', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-safe-size-race-');
  const targetPath = path.join(rootPath, 'growing.log');
  fs.writeFileSync(path.join(rootPath, 'SPACE.md'), '# Entry\n', 'utf8');
  fs.writeFileSync(targetPath, 'small\n', 'utf8');
  const root = await SafeObjectRoot.open(rootPath);
  const originalLstat = fsPromises.lstat.bind(fsPromises);
  let expanded = false;
  t.mock.method(fsPromises, 'lstat', async (candidate: PathLike) => {
    const stats = await originalLstat(candidate);
    if (!expanded && path.resolve(candidate.toString()) === path.resolve(targetPath)) {
      expanded = true;
      fs.writeFileSync(
        targetPath,
        Buffer.alloc(SPACE_V1_LIMITS.maxFileBytes + 1, 0x61)
      );
    }
    return stats;
  });

  await assert.rejects(() => root.listTextFiles(), /File exceeds/);
});

test('object file reads reject a target deleted after the root opens', async (t) => {
  const rootPath = temporaryDirectory(t, 'spotshell-safe-deleted-');
  const targetPath = path.join(rootPath, 'notes.txt');
  fs.writeFileSync(targetPath, 'managed content\n', 'utf8');
  const root = await SafeObjectRoot.open(rootPath);
  fs.rmSync(targetPath);

  await assert.rejects(() => root.readText('notes.txt'));
});

test('object enumeration rejects directory links and Windows Junctions', async (t) => {
  const parent = temporaryDirectory(t, 'spotshell-safe-link-');
  const rootPath = path.join(parent, 'object');
  const outsidePath = path.join(parent, 'outside');
  fs.mkdirSync(rootPath);
  fs.mkdirSync(outsidePath);
  fs.writeFileSync(path.join(rootPath, 'SPACE.md'), '# Entry\n', 'utf8');
  fs.writeFileSync(path.join(outsidePath, 'secret.txt'), 'secret\n', 'utf8');
  fs.symlinkSync(
    outsidePath,
    path.join(rootPath, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const root = await SafeObjectRoot.open(rootPath);

  await assert.rejects(() => root.listTextFiles(), /Links and reparse points are not allowed/);
});

test('object enumeration rejects unsupported encodings and PDF files', async (t) => {
  const encodingRoot = temporaryDirectory(t, 'spotshell-safe-encoding-');
  fs.writeFileSync(path.join(encodingRoot, 'SPACE.md'), '# Entry\n', 'utf8');
  fs.writeFileSync(path.join(encodingRoot, 'legacy.txt'), Buffer.from([0xff, 0xfe, 0x41]));
  const invalidEncoding = await SafeObjectRoot.open(encodingRoot);
  await assert.rejects(() => invalidEncoding.listTextFiles(), /not valid UTF-8/);

  const pdfRoot = temporaryDirectory(t, 'spotshell-safe-pdf-');
  fs.writeFileSync(path.join(pdfRoot, 'SPACE.md'), '# Entry\n', 'utf8');
  fs.writeFileSync(path.join(pdfRoot, 'manual.pdf'), '%PDF-1.7\n', 'utf8');
  const unsupportedPdf = await SafeObjectRoot.open(pdfRoot);
  await assert.rejects(() => unsupportedPdf.listTextFiles(), /PDF files are not supported/);
});

test('schema v1 safety limits are frozen at the validated prototype values', () => {
  assert.deepEqual(SPACE_V1_LIMITS, {
    maxFilesPerObject: 256,
    maxDirectoriesPerObject: 64,
    maxDirectoryDepth: 8,
    maxFileBytes: 2 * 1024 * 1024,
    maxObjectBytes: 16 * 1024 * 1024,
    maxGuidanceFiles: 16,
    maxRelativePathChars: 240,
    maxRegexPatternChars: 256,
    maxRegexExecutionMs: 50,
    maxSearchMatches: 100,
    maxSearchPreviewChars: 500,
    maxReadLines: 200,
    maxReadBytes: 64 * 1024,
  });
  assert.equal(Object.isFrozen(SPACE_V1_LIMITS), true);
});

test('object enumeration enforces file size and directory depth limits', async (t) => {
  const oversizedRoot = temporaryDirectory(t, 'spotshell-safe-size-');
  fs.writeFileSync(path.join(oversizedRoot, 'SPACE.md'), '# Entry\n', 'utf8');
  fs.writeFileSync(
    path.join(oversizedRoot, 'oversized.log'),
    Buffer.alloc(SPACE_V1_LIMITS.maxFileBytes + 1)
  );
  const oversizedObject = await SafeObjectRoot.open(oversizedRoot);
  await assert.rejects(() => oversizedObject.listTextFiles(), /File exceeds/);

  const deepRoot = temporaryDirectory(t, 'spotshell-safe-depth-');
  fs.writeFileSync(path.join(deepRoot, 'SPACE.md'), '# Entry\n', 'utf8');
  let currentDirectory = deepRoot;
  for (let depth = 0; depth <= SPACE_V1_LIMITS.maxDirectoryDepth; depth += 1) {
    currentDirectory = path.join(currentDirectory, `level-${depth}`);
    fs.mkdirSync(currentDirectory);
  }
  const deepObject = await SafeObjectRoot.open(deepRoot);
  await assert.rejects(() => deepObject.listTextFiles(), /Directory depth exceeds/);
});
