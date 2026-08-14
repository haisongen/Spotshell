import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_MESSAGE_REFERENCE_CHARS,
  MAX_PENDING_REFERENCES,
  MAX_PENDING_REFERENCE_TOTAL_CHARS,
  MAX_TOOL_REFERENCE_CHARS,
  addPendingReference,
  createMessageReference,
  formatUserQuotesForAgent,
  isReferenceableFromEpoch,
  removePendingReference,
  toAgentChatQuote,
} from './messageReference'

const source = {
  id: 'msg-1',
  role: 'assistant' as const,
  content: 'previous diagnosis about memory',
  contextEpoch: 1,
  createdAt: '2026-08-01T10:00:00.000Z',
}

test('old-epoch messages are referenceable; current-epoch messages are not', () => {
  assert.equal(isReferenceableFromEpoch(1, 2), true)
  assert.equal(isReferenceableFromEpoch(2, 2), false)
  assert.equal(isReferenceableFromEpoch(3, 2), false)
  assert.equal(isReferenceableFromEpoch(undefined, 2), false)
})

test('createMessageReference freezes a content snapshot with source metadata', () => {
  const result = createMessageReference(source, {
    currentEpoch: 2,
    now: '2026-08-01T12:00:00.000Z',
    id: 'ref-1',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.reference, {
    id: 'ref-1',
    sourceMessageId: 'msg-1',
    sourceEpoch: 1,
    role: 'assistant',
    createdAt: '2026-08-01T10:00:00.000Z',
    referencedAt: '2026-08-01T12:00:00.000Z',
    contentSnapshot: 'previous diagnosis about memory',
    truncated: false,
  })
})

test('mutating the original message content does not change a frozen snapshot', () => {
  const mutable = { ...source, content: 'original body' }
  const result = createMessageReference(mutable, { currentEpoch: 2, id: 'ref-2' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  mutable.content = 'later UI rewrite'
  assert.equal(result.reference.contentSnapshot, 'original body')
})

test('tool output longer than the limit requires an explicit char range', () => {
  const tool = {
    id: 'tool-1',
    role: 'tool' as const,
    content: 'x'.repeat(MAX_TOOL_REFERENCE_CHARS + 1),
    contextEpoch: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
  }
  const rejected = createMessageReference(tool, { currentEpoch: 2 })
  assert.equal(rejected.ok, false)
  if (rejected.ok) return
  assert.equal(rejected.error, 'tool_output_too_large')
  assert.equal(rejected.maxChars, MAX_TOOL_REFERENCE_CHARS)

  const accepted = createMessageReference(tool, {
    currentEpoch: 2,
    id: 'ref-tool',
    charRange: { start: 0, end: MAX_TOOL_REFERENCE_CHARS },
  })
  assert.equal(accepted.ok, true)
  if (!accepted.ok) return
  assert.equal(accepted.reference.contentSnapshot.length, MAX_TOOL_REFERENCE_CHARS)
  assert.equal(accepted.reference.truncated, true)
  assert.deepEqual(accepted.reference.charRange, { start: 0, end: MAX_TOOL_REFERENCE_CHARS })
})

test('pending references can be added and removed before send', () => {
  const first = createMessageReference(source, { currentEpoch: 2, id: 'ref-a' })
  assert.equal(first.ok, true)
  if (!first.ok) return
  const second = createMessageReference({
    ...source,
    id: 'msg-2',
    content: 'second quote',
  }, { currentEpoch: 2, id: 'ref-b' })
  assert.equal(second.ok, true)
  if (!second.ok) return

  const added = addPendingReference([], first.reference)
  assert.equal(added.ok, true)
  if (!added.ok) return
  const withTwo = addPendingReference(added.pending, second.reference)
  assert.equal(withTwo.ok, true)
  if (!withTwo.ok) return
  assert.equal(withTwo.pending.length, 2)

  const remaining = removePendingReference(withTwo.pending, 'ref-a')
  assert.deepEqual(remaining.map((item) => item.id), ['ref-b'])
})

test('pending reference limits reject unbounded bulk restore', () => {
  let pending: ReturnType<typeof createMessageReference> extends { ok: true; reference: infer R }
    ? R[]
    : never = []
  for (let i = 0; i < MAX_PENDING_REFERENCES; i += 1) {
    const created = createMessageReference({
      ...source,
      id: `msg-${i}`,
      content: `body ${i}`,
    }, { currentEpoch: 2, id: `ref-${i}` })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const next = addPendingReference(pending, created.reference)
    assert.equal(next.ok, true)
    if (!next.ok) return
    pending = next.pending
  }
  const overflow = createMessageReference({
    ...source,
    id: 'msg-overflow',
    content: 'one more',
  }, { currentEpoch: 2, id: 'ref-overflow' })
  assert.equal(overflow.ok, true)
  if (!overflow.ok) return
  const rejected = addPendingReference(pending, overflow.reference)
  assert.equal(rejected.ok, false)
  if (rejected.ok) return
  assert.equal(rejected.error, 'too_many')

  // Multiple large-but-valid messages can exceed the combined char budget.
  assert.ok(MAX_MESSAGE_REFERENCE_CHARS * 2 > MAX_PENDING_REFERENCE_TOTAL_CHARS)
  const chunk = 'y'.repeat(MAX_MESSAGE_REFERENCE_CHARS)
  const firstHuge = createMessageReference({
    ...source,
    id: 'msg-huge-1',
    content: chunk,
  }, { currentEpoch: 2, id: 'ref-huge-1' })
  assert.equal(firstHuge.ok, true)
  if (!firstHuge.ok) return
  const withHuge = addPendingReference([], firstHuge.reference)
  assert.equal(withHuge.ok, true)
  if (!withHuge.ok) return
  const secondHuge = createMessageReference({
    ...source,
    id: 'msg-huge-2',
    content: chunk,
  }, { currentEpoch: 2, id: 'ref-huge-2' })
  assert.equal(secondHuge.ok, true)
  if (!secondHuge.ok) return
  const totalOverflow = addPendingReference(withHuge.pending, secondHuge.reference)
  assert.equal(totalOverflow.ok, false)
  if (totalOverflow.ok) return
  assert.equal(totalOverflow.error, 'total_too_large')
})

test('formatUserQuotesForAgent preserves snapshots for model delivery', () => {
  const created = createMessageReference(source, { currentEpoch: 2, id: 'ref-fmt' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const text = formatUserQuotesForAgent([created.reference])
  assert.match(text, /source epoch 1/i)
  assert.match(text, /msg-1/)
  assert.match(text, /previous diagnosis about memory/)
  assert.match(text, /assistant/i)
})

test('toAgentChatQuote maps a frozen snapshot for IPC without live message content', () => {
  const created = createMessageReference(source, { currentEpoch: 2, id: 'ref-ipc' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.deepEqual(toAgentChatQuote(created.reference), {
    sourceMessageId: 'msg-1',
    sourceEpoch: 1,
    role: 'assistant',
    createdAt: '2026-08-01T10:00:00.000Z',
    contentSnapshot: 'previous diagnosis about memory',
  })
})
