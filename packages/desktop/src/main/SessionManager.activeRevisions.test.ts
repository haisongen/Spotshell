import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { KnowledgeHarness, SSHClient } from '@spotshell/core'
import { KnowledgeHarness as RealKnowledgeHarness } from '@spotshell/core'
import { SessionManager, type SessionKnowledgeAccess } from './SessionManager'
import type { AgentEvent } from '../shared/ipc-types'

class FakeStream extends EventEmitter {
  readonly stderr = new EventEmitter()
  destroyed = false
  write(): boolean { return true }
  setWindow(): void {}
  end(): void { this.destroyed = true }
  destroy(): void { this.destroyed = true }
}

class ReadySshClient extends EventEmitter {
  readonly stream = new FakeStream()
  async connect(): Promise<void> {}
  async requestShell(): Promise<FakeStream> { return this.stream }
  write(): boolean { return true }
  resizeWindow(): void {}
  disconnect(): void {}
  destroy(): void {}
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function emptyHarness(): KnowledgeHarness {
  return new RealKnowledgeHarness({ objects: [], catalog: [] })
}

test('session keeps host notes pin after notes change until user applies', async () => {
  let notes = 'old notes'
  const events: AgentEvent[] = []
  const knowledgeAccess: SessionKnowledgeAccess = {
    isAuthorizedCandidate: async () => false,
    buildHarness: async () => emptyHarness(),
    resolveLatestPublished: async () => undefined,
  }
  const manager = new SessionManager(
    () => null,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => notes,
    () => false,
    () => 'saved',
    () => new ReadySshClient() as unknown as SSHClient,
    undefined,
    {
      getBoundEnvironmentId: () => undefined,
      environmentExists: async () => false,
      setBoundEnvironmentId: () => undefined,
    },
    knowledgeAccess,
  )
  manager.on('agent', (event: AgentEvent) => { events.push(event) })

  const session = await manager.connect({
    hostId: 'host-1',
    host: 'ops.example',
    port: 22,
    username: 'ops',
  })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (manager.list().find((entry) => entry.id === session.id)?.status === 'ready') break
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  // Force pin host notes through context refresh path.
  const live = (manager as unknown as {
    sessions: Map<string, {
      activeRevisions: Map<string, { revision: number; contentHash: string; contentSnapshot?: string }>
      revisionUpdatesAvailable: Array<{ objectId: string; latestRevision: number; latestContentHash: string }>
    }>
    pinHostNotes: (session: unknown) => void
    refreshRevisionUpdates: (session: unknown) => Promise<void>
  })
  const state = live.sessions.get(session.id)
  assert.ok(state)
  live.pinHostNotes(state)
  await live.refreshRevisionUpdates(state)
  assert.equal(state.activeRevisions.size, 1)
  assert.equal(manager.list()[0]?.revisionUpdatesAvailable.length, 0)

  notes = 'new notes'
  // Repository changes refresh active sessions immediately; no chat turn is required.
  await manager.refreshKnowledgeRevisionUpdates()
  const updates = manager.list()[0]?.revisionUpdatesAvailable ?? []
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.latestContentHash, hash('new notes'))

  // Keep current version dismisses this concrete latest.
  await manager.keepKnowledgeRevision({
    sessionId: session.id,
    objectId: updates[0]!.objectId,
    latestRevision: updates[0]!.latestRevision,
    latestContentHash: updates[0]!.latestContentHash,
  })
  assert.equal(manager.list()[0]?.revisionUpdatesAvailable.length, 0)

  // Changing target again resurfaces the update.
  notes = 'even newer notes'
  await live.refreshRevisionUpdates(state)
  const resurfaced = manager.list()[0]?.revisionUpdatesAvailable ?? []
  assert.equal(resurfaced.length, 1)

  await manager.applyKnowledgeRevision({
    sessionId: session.id,
    objectId: resurfaced[0]!.objectId,
    targetRevision: resurfaced[0]!.latestRevision,
    targetContentHash: resurfaced[0]!.latestContentHash,
  })
  assert.equal(manager.list()[0]?.revisionUpdatesAvailable.length, 0)
  assert.ok(events.some((event) => event.type === 'knowledge_revision_switch'))
  const pin = [...state.activeRevisions.values()][0]
  assert.equal(pin?.contentHash, hash('even newer notes'))
  assert.equal(pin?.contentSnapshot, 'even newer notes')
})

test('apply rejects a stale confirmation when host notes change again', async () => {
  let notes = 'v1'
  const manager = new SessionManager(
    () => null,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => notes,
    () => false,
    () => 'saved',
    () => new ReadySshClient() as unknown as SSHClient,
    undefined,
    {
      getBoundEnvironmentId: () => undefined,
      environmentExists: async () => false,
      setBoundEnvironmentId: () => undefined,
    },
    {
      isAuthorizedCandidate: async () => false,
      buildHarness: async () => emptyHarness(),
    },
  )
  const session = await manager.connect({
    hostId: 'host-2',
    host: 'ops.example',
    port: 22,
    username: 'ops',
  })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (manager.list().find((entry) => entry.id === session.id)?.status === 'ready') break
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const live = (manager as unknown as {
    sessions: Map<string, unknown>
    pinHostNotes: (session: unknown) => void
    refreshRevisionUpdates: (session: unknown) => Promise<void>
  })
  const state = live.sessions.get(session.id)
  assert.ok(state)
  live.pinHostNotes(state)
  notes = 'v2'
  await live.refreshRevisionUpdates(state)
  const update = manager.list()[0]?.revisionUpdatesAvailable[0]
  assert.ok(update)

  notes = 'v3'
  await assert.rejects(
    () => manager.applyKnowledgeRevision({
      sessionId: session.id,
      objectId: update.objectId,
      targetRevision: update.latestRevision,
      targetContentHash: update.latestContentHash,
    }),
    /changed after confirmation|re-?view/i,
  )
})
