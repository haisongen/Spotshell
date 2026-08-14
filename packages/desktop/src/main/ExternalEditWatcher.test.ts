import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { KnowledgeRepository } from '@spotshell/core'
import { ExternalEditWatcher, objectIdFromKnowledgePath } from './ExternalEditWatcher'

test('objectIdFromKnowledgePath extracts only managed object ids under the root', () => {
  const root = path.join(os.tmpdir(), 'spotshell-knowledge')
  const id = '11111111-1111-4111-8111-111111111111'
  assert.equal(
    objectIdFromKnowledgePath(root, path.join(root, id, 'draft-files', 'notes.md')),
    id,
  )
  assert.equal(
    objectIdFromKnowledgePath(root, path.join(root, 'not-a-uuid', 'draft-files', 'notes.md')),
    null,
  )
  assert.equal(objectIdFromKnowledgePath(root, path.join(os.tmpdir(), 'elsewhere')), null)
})

test('startup scan reports external edits and keeps last valid revision active', async (t) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'spotshell-external-watcher-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  const repository = new KnowledgeRepository(rootPath)
  const module = await repository.createDraft({ name: 'Watcher module' })
  await repository.saveFormDraft(module.id, {
    ...module.form!,
    description: 'desc',
    whenToUse: 'when',
    beforeGuidance: '# body\n',
  })
  await repository.createManagedTextFile(module.id, {
    relativePath: 'notes.md',
    content: 'v1\n',
  })
  const revision = await repository.publishDraft(module.id)

  const watcher = new ExternalEditWatcher(repository, rootPath, 50)
  t.after(() => watcher.stop())
  const events: string[] = []
  watcher.onChange((statuses) => {
    for (const status of statuses) events.push(`${status.id}:${status.status}`)
  })

  fs.writeFileSync(path.join(rootPath, module.id, 'draft-files', 'notes.md'), 'v2 external\n', 'utf8')
  const statuses = await watcher.scanAllNow()
  const match = statuses.find((status) => status.id === module.id)
  assert.equal(match?.status, 'pending')
  assert.ok(events.some((entry) => entry.endsWith(':pending')))

  const published = await repository.resolvePublishedObject(module.id)
  assert.equal(published?.revision, revision.revision)
  assert.equal(
    fs.readFileSync(path.join(published!.rootPath, 'notes.md'), 'utf8'),
    'v1\n',
  )
})
