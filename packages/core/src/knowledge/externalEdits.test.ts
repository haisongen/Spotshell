import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectExternalContentDiff,
  EXTERNAL_EDIT_DEBOUNCE_MS,
  externalOrigin,
  filterWorkingContentPaths,
  isEditorTemporaryPath,
  shouldIgnoreExternalWatchEvent,
  workingTreeFingerprint,
} from './externalEdits.js';
import type { RevisionFileSnapshot } from './revisionHistory.js';

function file(
  relativePath: string,
  content: string,
  contentHash = `hash:${relativePath}:${content}`,
): RevisionFileSnapshot {
  return {
    relativePath,
    content,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    contentHash,
  };
}

test('editor temporary paths are filtered out of working content', () => {
  assert.equal(isEditorTemporaryPath('notes.md'), false);
  assert.equal(isEditorTemporaryPath('notes.md~'), true);
  assert.equal(isEditorTemporaryPath('notes.md.swp'), true);
  assert.equal(isEditorTemporaryPath('.notes.md.swp'), true);
  assert.equal(isEditorTemporaryPath('.#notes.md'), true);
  assert.equal(isEditorTemporaryPath('#notes.md#'), true);
  assert.equal(isEditorTemporaryPath('notes.md.tmp'), true);
  assert.equal(isEditorTemporaryPath('notes.md.partial'), true);
  assert.equal(isEditorTemporaryPath('.DS_Store'), true);
  assert.equal(isEditorTemporaryPath('Thumbs.db'), true);
  assert.equal(isEditorTemporaryPath('__pycache__/x.pyc'), true);
  assert.equal(isEditorTemporaryPath('notes/foo.md.bak'), true);

  assert.deepEqual(
    filterWorkingContentPaths([
      'SPACE.md',
      'notes.md',
      'notes.md~',
      '.#lock',
      'rules/guide.md',
      'rules/guide.md.swp',
      'revision.json',
      'manifest.json',
    ]),
    ['notes.md', 'rules/guide.md', 'SPACE.md'],
  );
});

test('watch events for temp files and system dirs are ignored', () => {
  assert.equal(shouldIgnoreExternalWatchEvent('notes.md'), false);
  assert.equal(shouldIgnoreExternalWatchEvent('notes.md~'), true);
  assert.equal(shouldIgnoreExternalWatchEvent('revisions/00000001/SPACE.md'), true);
  assert.equal(shouldIgnoreExternalWatchEvent('blobs/abc'), true);
  assert.equal(shouldIgnoreExternalWatchEvent('manifest.json'), true);
  assert.equal(shouldIgnoreExternalWatchEvent('draft.json'), true);
  assert.equal(shouldIgnoreExternalWatchEvent('file-origins.json'), true);
  assert.equal(shouldIgnoreExternalWatchEvent('draft-files/notes.md'), false);
  assert.equal(shouldIgnoreExternalWatchEvent('draft-files/notes.md.swp'), true);
});

test('detectExternalContentDiff reports added modified removed and renamed files', () => {
  const baseline = [
    file('SPACE.md', 'entry v1', 'h-space-1'),
    file('notes.md', 'note v1', 'h-note-1'),
    file('old-name.md', 'same body', 'h-rename'),
    file('gone.txt', 'bye', 'h-gone'),
  ];
  const working = [
    file('SPACE.md', 'entry v2', 'h-space-2'),
    file('notes.md', 'note v1', 'h-note-1'),
    file('new-name.md', 'same body', 'h-rename'),
    file('added.log', 'hello', 'h-added'),
  ];

  const result = detectExternalContentDiff(baseline, working);
  assert.equal(result.hasChanges, true);
  assert.ok(result.workingContentHash.length === 64);

  const byPath = new Map(result.files.map((diff) => [diff.relativePath, diff]));
  assert.equal(byPath.get('SPACE.md')?.change, 'modified');
  assert.equal(byPath.get('added.log')?.change, 'added');
  assert.equal(byPath.get('gone.txt')?.change, 'removed');
  assert.equal(byPath.get('new-name.md')?.change, 'renamed');
  assert.equal(byPath.get('new-name.md')?.previousPath, 'old-name.md');
  assert.equal(byPath.has('notes.md'), false);
  assert.equal(byPath.has('old-name.md'), false);
});

test('detectExternalContentDiff is clean when content matches baseline', () => {
  const files = [
    file('SPACE.md', 'entry', 'h1'),
    file('a.md', 'a', 'ha'),
  ];
  const result = detectExternalContentDiff(files, files);
  assert.equal(result.hasChanges, false);
  assert.deepEqual(result.files, []);
  assert.equal(result.workingContentHash, workingTreeFingerprint(files));
});

test('external origin label and debounce constant are stable product seams', () => {
  assert.equal(externalOrigin(), 'external');
  assert.ok(EXTERNAL_EDIT_DEBOUNCE_MS >= 250);
  assert.ok(EXTERNAL_EDIT_DEBOUNCE_MS <= 2000);
});
