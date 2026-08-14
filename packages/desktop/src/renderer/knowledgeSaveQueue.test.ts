import assert from 'node:assert/strict'
import test from 'node:test'
import type { KnowledgeModuleDetail } from '../shared/ipc-types'
import { DraftSaveQueue, type KnowledgeDraftSave } from './knowledgeSaveQueue'

test('knowledge draft saves are serialized and flush includes edits queued in flight', async () => {
  const calls: Array<{
    save: KnowledgeDraftSave
    resolve: (detail: KnowledgeModuleDetail) => void
  }> = []
  const queue = new DraftSaveQueue<KnowledgeModuleDetail, KnowledgeDraftSave>(
    (save) => new Promise((resolve) => {
      calls.push({ save, resolve })
    }),
  )
  const first = sourceSave('first')
  const second = sourceSave('second')

  queue.schedule(first)
  const flushed = queue.flush()
  queue.schedule(second)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.save.source, 'first')
  calls[0]!.resolve(detail('first'))
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.save.source, 'second')
  calls[1]!.resolve(detail('second'))

  assert.equal((await flushed)?.source, 'second')
})

function sourceSave(source: string): Omit<KnowledgeDraftSave, 'sequence'> {
  return {
    moduleId: '123e4567-e89b-42d3-a456-426614174000',
    mode: 'source',
    source,
  }
}

function detail(source: string): KnowledgeModuleDetail {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    name: 'Module',
    description: 'Description',
    whenToUse: 'When needed',
    tags: [],
    draftSavedAt: '2026-08-02T00:00:00.000Z',
    source,
  }
}
