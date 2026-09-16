import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterKnowledgeItems,
  isKnowledgeSortMode,
  matchesKnowledgeQuery,
  parseKnowledgeQuery,
  sortKnowledgeItems,
} from './knowledgeFilter'

const items = [
  {
    id: 'nginx',
    name: 'Nginx 故障排查',
    description: '面向生产 Web 节点的只读检查与安全恢复步骤。',
    tags: ['nginx', 'production', 'runbook'],
  },
  {
    id: 'disk',
    name: '磁盘满查',
    description: '定位磁盘使用率过高的挂载点。',
    tags: ['disk'],
  },
  { id: 'bare', name: 'Bare module' },
]

test('parses a query into lowercase terms and ignores extra whitespace', () => {
  assert.deepEqual(parseKnowledgeQuery('  Nginx   PROD '), ['nginx', 'prod'])
  assert.deepEqual(parseKnowledgeQuery('   '), [])
})

test('matches across name, description and tags', () => {
  assert.equal(matchesKnowledgeQuery(items[0], ['故障']), true)
  assert.equal(matchesKnowledgeQuery(items[0], ['只读检查']), true)
  assert.equal(matchesKnowledgeQuery(items[0], ['runbook']), true)
  assert.equal(matchesKnowledgeQuery(items[0], ['kafka']), false)
})

test('requires every term to match (AND), not just one', () => {
  assert.equal(matchesKnowledgeQuery(items[0], ['nginx', 'production']), true)
  assert.equal(matchesKnowledgeQuery(items[0], ['nginx', 'kafka']), false)
})

test('treats an empty query as matching everything', () => {
  assert.equal(matchesKnowledgeQuery(items[1], []), true)
  assert.deepEqual(filterKnowledgeItems(items, '   ').map((item) => item.id), [
    'nginx',
    'disk',
    'bare',
  ])
})

test('tolerates rows without description or tags', () => {
  assert.equal(matchesKnowledgeQuery(items[2], ['bare']), true)
  assert.equal(matchesKnowledgeQuery(items[2], ['nginx']), false)
})

test('filters case-insensitively and keeps the original order', () => {
  assert.deepEqual(filterKnowledgeItems(items, 'NGINX').map((item) => item.id), ['nginx'])
  assert.deepEqual(filterKnowledgeItems(items, '磁盘').map((item) => item.id), ['disk'])
  assert.deepEqual(filterKnowledgeItems(items, 'zzz'), [])
})

test('returns a copy so callers cannot mutate the source list', () => {
  const all = filterKnowledgeItems(items, '')
  assert.notEqual(all, items)
  assert.equal(all.length, items.length)
})

const sortable = [
  { id: 'b', name: 'Beta', draftSavedAt: '2026-01-02T00:00:00.000Z' },
  { id: 'a', name: 'Alpha', draftSavedAt: '2026-03-09T00:00:00.000Z' },
  { id: 'c', name: 'Gamma', draftSavedAt: '2026-02-05T00:00:00.000Z' },
]

test('sorts by name', () => {
  assert.deepEqual(
    sortKnowledgeItems(sortable, 'name').map((item) => item.id),
    ['a', 'b', 'c']
  )
})

test('sorts by most recently edited first', () => {
  assert.deepEqual(
    sortKnowledgeItems(sortable, 'recent').map((item) => item.id),
    ['a', 'c', 'b']
  )
})

test('recent order falls back to name for ties and pushes undated rows last', () => {
  const tied = [
    { id: 'z', name: 'Zed', draftSavedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'n', name: 'Nyx' },
    { id: 'a', name: 'Ada', draftSavedAt: '2026-01-01T00:00:00.000Z' },
  ]
  assert.deepEqual(
    sortKnowledgeItems(tied, 'recent').map((item) => item.id),
    ['a', 'z', 'n']
  )
})

test('sorting never mutates the source list', () => {
  const before = sortable.map((item) => item.id)
  sortKnowledgeItems(sortable, 'recent')
  assert.deepEqual(sortable.map((item) => item.id), before)
})

test('recognizes valid sort modes only', () => {
  assert.equal(isKnowledgeSortMode('name'), true)
  assert.equal(isKnowledgeSortMode('recent'), true)
  assert.equal(isKnowledgeSortMode('size'), false)
  assert.equal(isKnowledgeSortMode(undefined), false)
})
