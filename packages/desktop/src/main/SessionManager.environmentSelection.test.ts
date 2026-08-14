import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { SSHClient } from '@spotshell/core'
import { SessionManager, type SessionEnvironmentAccess, type SessionKnowledgeAccess } from './SessionManager'

const OSC = '\u001b]6973;'
const BEL = '\u0007'

class PendingSshClient extends EventEmitter {
  connect(): Promise<void> {
    return new Promise(() => undefined)
  }

  disconnect(): void {}

  destroy(): void {}
}

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

function createManager(
  access: SessionEnvironmentAccess,
  createSshClient: () => SSHClient = () => new PendingSshClient() as unknown as SSHClient,
  knowledgeAccess: SessionKnowledgeAccess = { isAuthorizedCandidate: async () => false },
): SessionManager {
  return new SessionManager(
    () => null,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    () => 'saved',
    createSshClient,
    undefined,
    access,
    knowledgeAccess,
  )
}

async function waitForReady(manager: SessionManager, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (manager.list().find((session) => session.id === sessionId)?.status === 'ready') return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail(`Session did not become ready: ${sessionId}`)
}

test('saved-host connections select their valid bound environment', async () => {
  const manager = createManager({
    getBoundEnvironmentId: (hostId) => hostId === 'host-prod' ? 'env-prod' : undefined,
    environmentExists: async (environmentId) => environmentId === 'env-prod',
    setBoundEnvironmentId: () => undefined,
  })

  const session = await manager.connect({
    hostId: 'host-prod',
    host: 'prod.example',
    port: 22,
    username: 'ops',
  })

  assert.equal(session.environmentId, 'env-prod')
  assert.equal(session.environmentSource, 'host-binding')
})

test('saved-host connections reject a missing bound environment without guessing a replacement', async () => {
  const manager = createManager({
    getBoundEnvironmentId: () => 'env-missing',
    environmentExists: async () => false,
    setBoundEnvironmentId: () => undefined,
  })

  await assert.rejects(
    manager.connect({
      hostId: 'host-prod',
      host: 'prod.example',
      port: 22,
      username: 'ops',
    }),
    /Bound environment profile not found: env-missing.*update or clear/i,
  )
  assert.deepEqual(manager.list(), [])
})

test('temporary selection survives reconnect and stays isolated to its tab', async () => {
  const persisted: Array<[string, string | undefined]> = []
  const manager = createManager({
    getBoundEnvironmentId: (hostId) => hostId === 'host-prod' ? 'env-prod' : undefined,
    environmentExists: async (environmentId) => ['env-prod', 'env-stage'].includes(environmentId),
    setBoundEnvironmentId: (hostId, environmentId) => persisted.push([hostId, environmentId]),
  })
  const savedHostSession = await manager.connect({
    hostId: 'host-prod', host: 'prod.example', port: 22, username: 'ops',
  })
  const quickSession = await manager.connect({
    host: 'ad-hoc.example', port: 22, username: 'ops',
  })

  const selected = await manager.selectEnvironment(savedHostSession.id, 'env-stage')
  assert.equal(selected.environmentId, 'env-stage')
  assert.equal(selected.environmentSource, 'session')
  assert.deepEqual(persisted, [])
  assert.equal(manager.list().find((session) => session.id === quickSession.id)?.environmentId, undefined)

  const reconnected = await manager.reconnect(savedHostSession.id)
  assert.equal(reconnected.environmentId, 'env-stage')
  assert.equal(reconnected.environmentSource, 'session')
})

test('duplicating a saved-host tab resolves its automatic binding instead of copying a temporary selection', async () => {
  const manager = createManager({
    getBoundEnvironmentId: (hostId) => hostId === 'host-prod' ? 'env-prod' : undefined,
    environmentExists: async (environmentId) => ['env-prod', 'env-stage'].includes(environmentId),
    setBoundEnvironmentId: () => undefined,
  })
  const source = await manager.connect({
    hostId: 'host-prod', host: 'prod.example', port: 22, username: 'ops',
  })
  await manager.selectEnvironment(source.id, 'env-stage')

  const duplicate = await manager.duplicate(source.id, 'copy')

  assert.equal(duplicate.environmentId, 'env-prod')
  assert.equal(duplicate.environmentSource, 'host-binding')
})

test('explicit automatic selection persists the saved-host binding', async () => {
  const persisted: Array<[string, string | undefined]> = []
  const manager = createManager({
    getBoundEnvironmentId: () => undefined,
    environmentExists: async (environmentId) => environmentId === 'env-prod',
    setBoundEnvironmentId: (hostId, environmentId) => persisted.push([hostId, environmentId]),
  })
  const session = await manager.connect({
    hostId: 'host-prod', host: 'prod.example', port: 22, username: 'ops',
  })

  const selected = await manager.selectEnvironment(session.id, 'env-prod', true)

  assert.deepEqual(persisted, [['host-prod', 'env-prod']])
  assert.equal(selected.environmentId, 'env-prod')
  assert.equal(selected.environmentSource, 'host-binding')
})

test('clearing a selection restores the no-environment source', async () => {
  const persisted: Array<[string, string | undefined]> = []
  const manager = createManager({
    getBoundEnvironmentId: () => 'env-prod',
    environmentExists: async (environmentId) => environmentId === 'env-prod',
    setBoundEnvironmentId: (hostId, environmentId) => persisted.push([hostId, environmentId]),
  })
  const session = await manager.connect({
    hostId: 'host-prod', host: 'prod.example', port: 22, username: 'ops',
  })

  const temporary = await manager.selectEnvironment(session.id, undefined)
  assert.equal(temporary.environmentId, undefined)
  assert.equal(temporary.environmentSource, 'none')

  const persistedSelection = await manager.selectEnvironment(session.id, undefined, true)
  assert.deepEqual(persisted, [['host-prod', undefined]])
  assert.equal(persistedSelection.environmentId, undefined)
  assert.equal(persistedSelection.environmentSource, 'none')
})

test('quick connections cannot persist a binding until they are saved as a host', async () => {
  const manager = createManager({
    getBoundEnvironmentId: () => undefined,
    environmentExists: async () => true,
    setBoundEnvironmentId: () => assert.fail('quick connection must not persist a binding'),
  })
  const session = await manager.connect({
    host: 'ad-hoc.example', port: 22, username: 'ops',
  })

  await assert.rejects(
    manager.selectEnvironment(session.id, 'env-prod', true),
    /save this quick connection as a host/i,
  )
  assert.equal(manager.list()[0]?.environmentId, undefined)
  assert.equal(manager.list()[0]?.environmentSource, 'none')
})

test('environment selection is blocked while a terminal command is running', async () => {
  const client = new ReadySshClient()
  const manager = createManager({
    getBoundEnvironmentId: () => undefined,
    environmentExists: async () => true,
    setBoundEnvironmentId: () => undefined,
  }, () => client as unknown as SSHClient)
  const session = await manager.connect({
    host: 'ad-hoc.example', port: 22, username: 'ops',
  })
  await waitForReady(manager, session.id)
  client.stream.emit('data', Buffer.from(`${OSC}D;0;/root${BEL}${OSC}C;sleep 60${BEL}`))

  await assert.rejects(
    manager.selectEnvironment(session.id, 'env-prod'),
    /terminal command is running/i,
  )
  assert.equal(manager.list()[0]?.environmentId, undefined)
})

test('knowledge modules remain isolated per session and clear when the environment changes', async () => {
  const manager = createManager({
    getBoundEnvironmentId: () => undefined,
    environmentExists: async () => true,
    setBoundEnvironmentId: () => undefined,
  }, undefined, { isAuthorizedCandidate: async () => true })
  const first = await manager.connect({ host: 'first.example', port: 22, username: 'ops' })
  const second = await manager.connect({ host: 'second.example', port: 22, username: 'ops' })

  await manager.loadKnowledgeModule(first.id, 'module-a')
  await manager.pinKnowledgeModule(first.id, 'module-a')
  assert.deepEqual(manager.list().find((session) => session.id === first.id)?.pinnedModuleIds, ['module-a'])
  assert.deepEqual(manager.list().find((session) => session.id === second.id)?.pinnedModuleIds, [])

  await manager.selectEnvironment(first.id, 'env-next')
  assert.deepEqual(manager.list().find((session) => session.id === first.id)?.pinnedModuleIds, [])
  assert.deepEqual(manager.list().find((session) => session.id === first.id)?.dynamicModuleIds, [])
})

test('session knowledge controls reject modules outside the authorized candidate catalog', async () => {
  const manager = createManager({
    getBoundEnvironmentId: () => undefined,
    environmentExists: async () => true,
    setBoundEnvironmentId: () => undefined,
  })
  const session = await manager.connect({ host: 'prod.example', port: 22, username: 'ops' })

  await assert.rejects(
    manager.loadKnowledgeModule(session.id, 'module-private'),
    /not authorized for this session/i,
  )
  assert.deepEqual(manager.list()[0]?.pinnedModuleIds, [])
  assert.deepEqual(manager.list()[0]?.dynamicModuleIds, [])
})
