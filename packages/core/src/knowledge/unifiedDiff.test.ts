import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUnifiedDiff } from './unifiedDiff.js';

test('buildUnifiedDiff returns a no-op header when content is unchanged', () => {
  assert.equal(buildUnifiedDiff('notes', 'a\n', 'a\n'), '--- a/notes\n+++ b/notes\n');
});

test('buildUnifiedDiff keeps unchanged lines as context instead of full delete+add', () => {
  const before = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n') + '\n';
  const after = ['line1', 'line2', 'CHANGED', 'line4', 'line5'].join('\n') + '\n';
  const diff = buildUnifiedDiff('notes', before, after);

  // Unchanged lines must appear as context ( leading space), not as -/+ churn.
  assert.match(diff, /\n line1\n/);
  assert.match(diff, /\n line2\n/);
  assert.match(diff, /\n line4\n/);
  assert.match(diff, /\n line5\n/);
  assert.match(diff, /\n-line3\n/);
  assert.match(diff, /\n\+CHANGED\n/);
  // Only the one changed line should be deleted/added, not the whole file
  // (exclude the --- a/... / +++ b/... file headers from the count).
  const body = diff.split('\n').slice(2);
  assert.equal(body.filter((line) => line.startsWith('-')).length, 1);
  assert.equal(body.filter((line) => line.startsWith('+')).length, 1);
});

test('buildUnifiedDiff drops far-apart hunks into separate @@ blocks', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n';
  const lines = before.trimEnd().split('\n');
  lines[1] = 'CHANGED-NEAR-TOP';
  lines[18] = 'CHANGED-NEAR-BOTTOM';
  const after = lines.join('\n') + '\n';

  const diff = buildUnifiedDiff('notes', before, after);
  const hunkHeaders = diff.match(/^@@.*@@$/gm) ?? [];
  assert.equal(hunkHeaders.length, 2);
});

test('buildUnifiedDiff handles a pure append', () => {
  const diff = buildUnifiedDiff('notes', 'a\n', 'a\nb\n');
  assert.match(diff, /--- a\/notes/);
  assert.match(diff, /\n\+b\n?$/);
  const body = diff.split('\n').slice(2);
  assert.equal(body.filter((line) => line.startsWith('-')).length, 0);
});
