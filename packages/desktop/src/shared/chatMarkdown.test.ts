import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInline, parseMarkdown } from './chatMarkdown'

test('parseInline recognises bold and inline code and keeps the rest as text', () => {
  assert.deepEqual(parseInline('内存总量 **15Gi**，运行 `free -h` 查看'), [
    { type: 'text', text: '内存总量 ' },
    { type: 'strong', text: '15Gi' },
    { type: 'text', text: '，运行 ' },
    { type: 'code', text: 'free -h' },
    { type: 'text', text: ' 查看' },
  ])
})

test('parseInline leaves shell globs, snake_case and unclosed markers literal', () => {
  for (const text of ['rm *.gz and *.log', 'max_open_files', '**streaming', '** spaced **', 'a ` b']) {
    assert.deepEqual(parseInline(text), [{ type: 'text', text }], text)
  }
})

test('parseInline does not treat markup inside code as bold', () => {
  assert.deepEqual(parseInline('`**x**`'), [{ type: 'code', text: '**x**' }])
})

test('parseMarkdown splits paragraphs on blank lines and keeps soft line breaks', () => {
  assert.deepEqual(parseMarkdown('line one\nline two\n\nnext'), [
    { type: 'paragraph', inline: [{ type: 'text', text: 'line one\nline two' }] },
    { type: 'paragraph', inline: [{ type: 'text', text: 'next' }] },
  ])
})

test('parseMarkdown builds headings (capped at level 3) and lists', () => {
  const blocks = parseMarkdown('## 结论\n- 负载正常\n- 磁盘 **63%**\n\n1. 检查\n2. 重载\n#### 细节')
  assert.deepEqual(blocks, [
    { type: 'heading', level: 2, inline: [{ type: 'text', text: '结论' }] },
    {
      type: 'list', ordered: false, start: 1, items: [
        [{ type: 'text', text: '负载正常' }],
        [{ type: 'text', text: '磁盘 ' }, { type: 'strong', text: '63%' }],
      ],
    },
    {
      type: 'list', ordered: true, start: 1, items: [
        [{ type: 'text', text: '检查' }],
        [{ type: 'text', text: '重载' }],
      ],
    },
    { type: 'heading', level: 3, inline: [{ type: 'text', text: '细节' }] },
  ])
})

test('parseMarkdown keeps an ordered list start and switches list kinds', () => {
  const blocks = parseMarkdown('3. c\n4. d\n- e')
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], {
    type: 'list', ordered: true, start: 3, items: [[{ type: 'text', text: 'c' }], [{ type: 'text', text: 'd' }]],
  })
  assert.equal(blocks[1]?.type === 'list' && blocks[1].ordered, false)
})

test('parseMarkdown folds a continuation line into the previous list item', () => {
  assert.deepEqual(parseMarkdown('- first\n  still first\n- second'), [
    {
      type: 'list', ordered: false, start: 1, items: [
        [{ type: 'text', text: 'first\nstill first' }],
        [{ type: 'text', text: 'second' }],
      ],
    },
  ])
})

test('parseMarkdown passes raw HTML through as plain text', () => {
  assert.deepEqual(parseMarkdown('<img src=x onerror=alert(1)>'), [
    { type: 'paragraph', inline: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
  ])
})

test('parseMarkdown returns no blocks for whitespace-only input', () => {
  assert.deepEqual(parseMarkdown('\n  \n'), [])
})
