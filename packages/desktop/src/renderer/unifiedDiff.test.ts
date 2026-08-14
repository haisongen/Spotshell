import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyUnifiedDiffLine, parseUnifiedDiff } from './unifiedDiff'

test('classifyUnifiedDiffLine maps git markers correctly', () => {
  assert.equal(classifyUnifiedDiffLine('--- a/SPACE.md'), 'meta')
  assert.equal(classifyUnifiedDiffLine('+++ b/SPACE.md'), 'meta')
  assert.equal(classifyUnifiedDiffLine('@@ -1,2 +1,3 @@'), 'hunk')
  assert.equal(classifyUnifiedDiffLine('-old tip'), 'del')
  assert.equal(classifyUnifiedDiffLine('+new tip'), 'add')
  assert.equal(classifyUnifiedDiffLine(' context'), 'context')
  assert.equal(classifyUnifiedDiffLine(''), 'context')
  assert.equal(classifyUnifiedDiffLine('\\ No newline at end of file'), 'context')
})

test('parseUnifiedDiff classifies every line of a sample patch', () => {
  const diff = [
    '--- a/notes/tip.md',
    '+++ b/notes/tip.md',
    '@@ -1,1 +1,1 @@',
    '-old tip',
    '+new tip',
    '',
  ].join('\n')

  assert.deepEqual(parseUnifiedDiff(diff), [
    { kind: 'meta', text: '--- a/notes/tip.md' },
    { kind: 'meta', text: '+++ b/notes/tip.md' },
    { kind: 'hunk', text: '@@ -1,1 +1,1 @@' },
    { kind: 'del', text: '-old tip' },
    { kind: 'add', text: '+new tip' },
  ])
})

test('parseUnifiedDiff returns empty array for empty input', () => {
  assert.deepEqual(parseUnifiedDiff(''), [])
})
