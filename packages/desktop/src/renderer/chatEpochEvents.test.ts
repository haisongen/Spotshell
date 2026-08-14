import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findPendingToolIndex,
  findStreamingAssistantIndex,
  insertForEpoch,
  lastIndexForEpoch,
  sealStreamingAssistant,
} from './chatEpochEvents'

test('insertForEpoch places late events before a newer context boundary', () => {
  const items = [
    { id: 'u1', contextEpoch: 1 },
    { id: 'a1', contextEpoch: 1 },
    { id: 'boundary', kind: 'context_boundary', contextEpoch: 2 },
    { id: 'u2', contextEpoch: 2 },
  ]
  const next = insertForEpoch(items, { id: 'late-cancel', contextEpoch: 1 })
  assert.deepEqual(next.map((item) => item.id), [
    'u1',
    'a1',
    'late-cancel',
    'boundary',
    'u2',
  ])
})

test('streaming assistant lookup is scoped to the event epoch', () => {
  const items = [
    { role: 'assistant', streaming: true, contextEpoch: 1 },
    { kind: 'context_boundary', contextEpoch: 2 },
    { role: 'assistant', streaming: true, contextEpoch: 2 },
  ]
  assert.equal(findStreamingAssistantIndex(items, 1), 0)
  assert.equal(findStreamingAssistantIndex(items, 2), 2)
})

test('pending tool lookup ignores tools from a newer epoch', () => {
  const items = [
    { role: 'tool', pendingTool: true, contextEpoch: 1 },
    { kind: 'context_boundary', contextEpoch: 2 },
    { role: 'tool', pendingTool: true, contextEpoch: 2 },
  ]
  assert.equal(findPendingToolIndex(items, 1), 0)
  assert.equal(findPendingToolIndex(items, 2), 2)
  assert.equal(lastIndexForEpoch(items, 1), 0)
})

/** Minimal shape of a ChatPanel transcript item, enough for ordering assertions. */
interface TestItem {
  id: string
  role?: string
  kind?: string
  content?: string
  streaming?: boolean
  pendingTool?: boolean
  contextEpoch: number
}

test('sealing before a tool card sends the next text round below it', () => {
  const sealed = sealStreamingAssistant<TestItem>(
    [
      { id: 'u1', role: 'user', contextEpoch: 1 },
      { id: 'a1', role: 'assistant', streaming: true, content: 'round 1', contextEpoch: 1 },
    ],
    1,
  )
  assert.equal(sealed[1]!.streaming, false)
  assert.equal(sealed[1]!.content, 'round 1')

  const withTool = insertForEpoch<TestItem>(sealed, {
    id: 't1',
    role: 'tool',
    pendingTool: true,
    contextEpoch: 1,
  })
  // Round 2 must not find round 1's bubble, so it opens a new one after the tool.
  assert.equal(findStreamingAssistantIndex(withTool, 1), -1)
  assert.deepEqual(
    insertForEpoch<TestItem>(withTool, {
      id: 'a2',
      role: 'assistant',
      streaming: true,
      contextEpoch: 1,
    }).map((item) => item.id),
    ['u1', 'a1', 't1', 'a2'],
  )
})

test('sealing an epoch with no open bubble leaves items untouched', () => {
  const items: TestItem[] = [
    { id: 'a1', role: 'assistant', streaming: false, contextEpoch: 1 },
    { id: 't1', role: 'tool', pendingTool: true, contextEpoch: 1 },
  ]
  assert.deepEqual(sealStreamingAssistant(items, 1), items)
})

test('sealing does not touch a streaming bubble from another epoch', () => {
  const items: TestItem[] = [
    { id: 'a1', role: 'assistant', streaming: true, contextEpoch: 1 },
    { id: 'boundary', kind: 'context_boundary', contextEpoch: 2 },
    { id: 'a2', role: 'assistant', streaming: true, contextEpoch: 2 },
  ]
  const sealed = sealStreamingAssistant(items, 2)
  assert.equal(sealed[0]!.streaming, true)
  assert.equal(sealed[2]!.streaming, false)
})
