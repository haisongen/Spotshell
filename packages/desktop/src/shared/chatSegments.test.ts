import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitCodeBlocks } from './chatSegments'

test('plain text yields a single text segment', () => {
  assert.deepEqual(splitCodeBlocks('hello world'), [{ type: 'text', content: 'hello world' }])
})

test('extracts fenced blocks with and without language tag', () => {
  const input = '先看磁盘：\n```bash\ndf -h\n```\n然后：\n```\ndu -sh /var/*\n```\n完'
  assert.deepEqual(splitCodeBlocks(input), [
    { type: 'text', content: '先看磁盘：\n' },
    { type: 'code', content: 'df -h' },
    { type: 'text', content: '\n然后：\n' },
    { type: 'code', content: 'du -sh /var/*' },
    { type: 'text', content: '\n完' },
  ])
})

test('multi-line code keeps inner newlines, trims only the fence edges', () => {
  const input = '```\ncd /var/log\ntail -n 50 app.log\n```'
  assert.deepEqual(splitCodeBlocks(input), [
    { type: 'code', content: 'cd /var/log\ntail -n 50 app.log' },
  ])
})

test('unterminated fence falls back to text (no half-parsed code)', () => {
  const input = 'try this:\n```bash\ndf -h'
  assert.deepEqual(splitCodeBlocks(input), [{ type: 'text', content: input }])
})

test('empty code block is dropped', () => {
  assert.deepEqual(splitCodeBlocks('a\n```\n```\nb'), [
    { type: 'text', content: 'a\n' },
    { type: 'text', content: '\nb' },
  ])
})
