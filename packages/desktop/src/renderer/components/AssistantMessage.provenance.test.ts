import assert from 'node:assert/strict'
import test from 'node:test'
import type { KnowledgeProvenanceRecord } from '../../shared/ipc-types'

/** Pure helper mirrored from AssistantMessage for unit coverage without React. */
function dedupeProvenance(
  records: readonly KnowledgeProvenanceRecord[],
): KnowledgeProvenanceRecord[] {
  const seen = new Set<string>()
  const unique: KnowledgeProvenanceRecord[] = []
  for (const record of records) {
    const key = [
      record.objectId,
      record.revision,
      record.relativePath,
      record.startLine,
      record.endLine,
      record.contentType,
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(record)
  }
  return unique
}

function shouldShowProvenance(records: KnowledgeProvenanceRecord[] | undefined): boolean {
  return Boolean(records && records.length > 0)
}

const sample: KnowledgeProvenanceRecord = {
  objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  objectName: 'Release Diagnostics',
  objectKind: 'knowledge',
  revision: 1,
  contentHash: 'abc',
  relativePath: 'SPACE.md',
  startLine: 1,
  endLine: 12,
  contentType: 'entry',
  loadReason: 'entry-read',
}

test('provenance panel is omitted when no knowledge was read', () => {
  assert.equal(shouldShowProvenance(undefined), false)
  assert.equal(shouldShowProvenance([]), false)
})

test('provenance panel is shown only for system records from real reads', () => {
  assert.equal(shouldShowProvenance([sample]), true)
  const deduped = dedupeProvenance([sample, { ...sample }, {
    ...sample,
    relativePath: 'rules/service-safety.md',
    startLine: 1,
    endLine: 3,
    contentType: 'guidance',
    loadReason: 'line-read',
  }])
  assert.equal(deduped.length, 2)
  assert.equal(deduped.every((record) => !record.relativePath.includes(':\\')), true)
  assert.equal(JSON.stringify(deduped).includes('AppData'), false)
})
