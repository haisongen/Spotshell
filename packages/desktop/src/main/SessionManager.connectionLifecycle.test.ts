import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  SHELL_INTEGRATION_SNIPPET,
  type SSHClient,
  type SSHConnectionConfig,
} from '@spotshell/core'
import type { SessionSummary } from '../shared/ipc-types'
import { SessionManager } from './SessionManager'

class Deferred<T> {
  readonly promise: Promise<T>
  private resolvePromise!: (value: T | PromiseLike<T>) => void
  private rejectPromise!: (reason?: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve
      this.rejectPromise = reject
    })
  }

  resolve(value: T): void {
    this.resolvePromise(value)
  }

  reject(reason: unknown): void {
    this.rejectPromise(reason)
  }
}

class FakeStream extends EventEmitter {
  readonly stderr = new EventEmitter()
  destroyed = false

  write(): boolean {
    return true
  }

  setWindow(): void {}

  end(): void {
    this.destroyed = true
  }

  destroy(): void {
    this.destroyed = true
  }
}

class FakeSshClient extends EventEmitter {
  readonly connected = new Deferred<void>()
  readonly shellRequested = new Deferred<FakeStream>()
  disconnectCount = 0
  destroyCount = 0
  connectionConfig?: SSHConnectionConfig
  readonly writes: string[] = []

  connect(config: SSHConnectionConfig): Promise<void> {
    this.connectionConfig = config
    return this.connected.promise
  }

  requestShell(): Promise<FakeStream> {
    return this.shellRequested.promise
  }

  write(data: string): boolean {
    this.writes.push(data)
    return true
  }

  resizeWindow(): void {}

  disconnect(): void {
    this.disconnectCount += 1
  }

  destroy(): void {
    this.destroyCount += 1
  }

  failConnection(error: Error): void {
    this.emit('error', error)
    this.connected.reject(error)
  }
}

function asSshClient(client: FakeSshClient): SSHClient {
  return client as unknown as SSHClient
}

function createManager(clients: FakeSshClient[], shellIntegration = false): SessionManager {
  return new SessionManager(
    () => null,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => shellIntegration,
    () => 'saved',
    () => {
      const client = new FakeSshClient()
      clients.push(client)
      return asSshClient(client)
    }
  )
}

test('shell integration forwards startup stdout byte-for-byte and clears once after the first OSC D', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients, true)
  const session = await connect(manager)
  const ready = waitForStatus(manager, session.id, 'ready')
  const stream = new FakeStream()
  const output: Buffer[] = []
  manager.on('output', (id: string, data: Buffer) => {
    if (id === session.id) output.push(data)
  })

  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(stream)
  await ready

  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET])
  assert.doesNotMatch(clients[0]!.writes[0]!, /\bstty\b|__spotshell_ne_/)

  const raw = Buffer.from(
    `Last login\r\n[root@server ~]# ${SHELL_INTEGRATION_SNIPPET}\x1b]6973;D;0;/root\x07[root@server ~]# `,
  )
  stream.emit('data', raw)
  assert.equal(output.length, 1)
  assert.strictEqual(output[0], raw)
  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET])

  await delay(130)
  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET, '\x0c'])

  manager.close(session.id)
})

test('a later startup stdout chunk resets the OSC D quiet window', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients, true)
  const session = await connect(manager)
  const ready = waitForStatus(manager, session.id, 'ready')
  const stream = new FakeStream()
  const output: Buffer[] = []
  manager.on('output', (id: string, data: Buffer) => {
    if (id === session.id) output.push(data)
  })

  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(stream)
  await ready
  const marker = Buffer.from('\x1b]6973;D;0;/root\x07')
  const prompt = Buffer.from('\r\n(base) root@server:~# ')
  stream.emit('data', marker)
  await delay(70)
  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET])

  stream.emit('data', prompt)
  assert.deepEqual(output, [marker, prompt])
  await delay(50)
  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET])
  await delay(70)
  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET, '\x0c'])

  manager.close(session.id)
})

test('subsequent OSC D markers never trigger another Ctrl+L', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients, true)
  const session = await connect(manager)
  const ready = waitForStatus(manager, session.id, 'ready')
  const stream = new FakeStream()

  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(stream)
  await ready
  stream.emit('data', Buffer.from('\x1b]6973;D;0;/root\x07'))
  await delay(130)
  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET, '\x0c'])

  stream.emit('data', Buffer.from('\x1b]6973;D;0;/root\x07'))
  await delay(130)
  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET, '\x0c'])

  manager.close(session.id)
})

test('missing or invalid OSC D never sends Ctrl+L and forwards stdout immediately', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients, true)
  const session = await connect(manager)
  const ready = waitForStatus(manager, session.id, 'ready')
  const stream = new FakeStream()
  const output: Buffer[] = []
  manager.on('output', (id: string, data: Buffer) => {
    if (id === session.id) output.push(data)
  })

  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(stream)
  await ready
  const raw = Buffer.from('restricted-shell\r\n$ \x1b]6973;D;not-a-code;/root\x07')
  stream.emit('data', raw)
  assert.strictEqual(output[0], raw)
  await delay(1_050)
  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET])

  manager.close(session.id)
})

test('disabled shell integration writes nothing and forwards stdout immediately', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients, false)
  const session = await connect(manager)
  const ready = waitForStatus(manager, session.id, 'ready')
  const stream = new FakeStream()
  const output: Buffer[] = []
  manager.on('output', (id: string, data: Buffer) => {
    if (id === session.id) output.push(data)
  })

  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(stream)
  await ready
  const raw = Buffer.from('plain stdout')
  stream.emit('data', raw)

  assert.deepEqual(clients[0]!.writes, [])
  assert.strictEqual(output[0], raw)
  manager.close(session.id)
})

test('user input cancels the pending automatic clear and is written unchanged', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients, true)
  const session = await connect(manager)
  const ready = waitForStatus(manager, session.id, 'ready')
  const stream = new FakeStream()
  const output: Buffer[] = []
  manager.on('output', (id: string, data: Buffer) => {
    if (id === session.id) output.push(data)
  })

  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(stream)
  await ready
  stream.emit('data', Buffer.from('\x1b]6973;D;0;/root\x07'))
  manager.write(session.id, 'echo ready\r')
  await delay(130)

  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET, 'echo ready\r'])
  manager.close(session.id)
})

test('stream close cancels the pending automatic clear', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients, true)
  const session = await connect(manager)
  const ready = waitForStatus(manager, session.id, 'ready')
  const stream = new FakeStream()

  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(stream)
  await ready
  stream.emit('data', Buffer.from('\x1b]6973;D;0;/root\x07'))
  stream.emit('close')
  await delay(130)

  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET])
  manager.close(session.id)
})

test('client close cancels the pending automatic clear', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients, true)
  const session = await connect(manager)
  const ready = waitForStatus(manager, session.id, 'ready')
  const stream = new FakeStream()

  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(stream)
  await ready
  stream.emit('data', Buffer.from('\x1b]6973;D;0;/root\x07'))
  clients[0]!.emit('close')
  await delay(130)

  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET])
  manager.close(session.id)
})

test('close cancels the pending automatic clear', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients, true)
  const session = await connect(manager)
  const ready = waitForStatus(manager, session.id, 'ready')
  const stream = new FakeStream()

  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(stream)
  await ready
  stream.emit('data', Buffer.from('\x1b]6973;D;0;/root\x07'))
  manager.close(session.id)
  await delay(130)

  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET])
})

test('reconnect cancels the old clear and gives the new attempt one independent clear', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients, true)
  const session = await connect(manager)
  const firstReady = waitForStatus(manager, session.id, 'ready')
  const firstStream = new FakeStream()
  const output: Buffer[] = []
  manager.on('output', (id: string, data: Buffer) => {
    if (id === session.id) output.push(data)
  })

  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(firstStream)
  await firstReady
  firstStream.emit('data', Buffer.from('\x1b]6973;D;0;/old\x07'))

  await manager.reconnect(session.id)
  const secondReady = waitForStatus(manager, session.id, 'ready')
  const secondStream = new FakeStream()
  clients[1]!.connected.resolve(undefined)
  clients[1]!.shellRequested.resolve(secondStream)
  await secondReady
  firstStream.emit('data', Buffer.from('\x1b]6973;D;0;/old\x07[old]# '))
  await delay(130)

  assert.deepEqual(clients[0]!.writes, [SHELL_INTEGRATION_SNIPPET])
  assert.deepEqual(clients[1]!.writes, [SHELL_INTEGRATION_SNIPPET])
  secondStream.emit('data', Buffer.from('\x1b]6973;D;0;/new\x07'))
  await delay(130)
  assert.deepEqual(clients[1]!.writes, [SHELL_INTEGRATION_SNIPPET, '\x0c'])
  manager.close(session.id)
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function connect(manager: SessionManager, host = 'server.example'): Promise<SessionSummary> {
  return manager.connect({
    host,
    port: 22,
    username: 'operator',
    password: 'secret',
  })
}

function waitForStatus(
  manager: SessionManager,
  sessionId: string,
  status: SessionSummary['status']
): Promise<SessionSummary> {
  return new Promise((resolve) => {
    const onStatus = (summary: SessionSummary): void => {
      if (summary.id !== sessionId || summary.status !== status) return
      manager.removeListener('status', onStatus)
      resolve(summary)
    }
    manager.on('status', onStatus)
  })
}

test('connect returns a connecting workspace before the SSH attempt settles', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)

  const result = await Promise.race([
    connect(manager),
    new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending'))),
  ])

  if (result === 'still-pending') assert.fail('connect did not return before the SSH attempt settled')
  assert.equal(result.status, 'connecting')
  assert.deepEqual(manager.list(), [result])
  assert.equal(clients.length, 1)
})

test('closing a connecting workspace keeps a sink for late SSH errors', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const session = await connect(manager)

  manager.close(session.id)

  const lateError = Object.assign(new Error('connect ETIMEDOUT 192.0.2.1:22'), {
    code: 'ETIMEDOUT',
  })
  assert.doesNotThrow(() => clients[0]!.emit('error', lateError))
  assert.deepEqual(manager.list(), [])
})

test('closing a connecting workspace silences its later failed attempt', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const statuses: SessionSummary[] = []
  manager.on('status', (summary: SessionSummary) => statuses.push(summary))
  const session = await connect(manager)
  statuses.length = 0

  manager.close(session.id)
  clients[0]!.connected.reject(Object.assign(new Error('connect ETIMEDOUT'), {
    code: 'ETIMEDOUT',
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(manager.list(), [])
  assert.deepEqual(statuses, [])
})

test('reconnect returns the existing workspace while its new SSH attempt is connecting', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const session = await connect(manager)
  clients[0]!.connected.resolve(undefined)
  clients[0]!.shellRequested.resolve(new FakeStream())
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(manager.list()[0]?.status, 'ready')

  const result = await Promise.race([
    manager.reconnect(session.id),
    new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending'))),
  ])

  if (result === 'still-pending') assert.fail('reconnect did not return before the SSH attempt settled')
  assert.equal(result.status, 'connecting')
  assert.equal(result.id, session.id)
  assert.equal(clients.length, 2)
})

test('a failed SSH attempt emits one error state even when error event and promise both fail', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const statuses: SessionSummary[] = []
  manager.on('status', (summary: SessionSummary) => statuses.push(summary))
  const session = await connect(manager)
  statuses.length = 0

  clients[0]!.failConnection(Object.assign(new Error('connect ETIMEDOUT 192.0.2.1:22'), {
    code: 'ETIMEDOUT',
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(statuses, [{
    ...session,
    status: 'error',
    errorKind: 'network-timeout',
    errorMessage: 'connect ETIMEDOUT 192.0.2.1:22',
  }])
})

test('one failed connection does not affect another parallel session becoming ready', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const first = await connect(manager, 'unreachable.example')
  const second = await connect(manager, 'healthy.example')

  clients[0]!.failConnection(Object.assign(new Error('connect ETIMEDOUT'), {
    code: 'ETIMEDOUT',
  }))
  clients[1]!.connected.resolve(undefined)
  clients[1]!.shellRequested.resolve(new FakeStream())
  await new Promise<void>((resolve) => setImmediate(resolve))

  const summaries = new Map(manager.list().map((summary) => [summary.id, summary]))
  assert.equal(summaries.get(first.id)?.status, 'error')
  assert.equal(summaries.get(first.id)?.errorKind, 'network-timeout')
  assert.equal(summaries.get(second.id)?.status, 'ready')
  assert.equal(summaries.get(second.id)?.errorMessage, undefined)
})

test('old client events and failure cannot overwrite a reconnect attempt', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const session = await connect(manager)
  await manager.reconnect(session.id)
  const statuses: SessionSummary[] = []
  manager.on('status', (summary: SessionSummary) => statuses.push(summary))

  const lateError = Object.assign(new Error('connect ETIMEDOUT from old attempt'), {
    code: 'ETIMEDOUT',
  })
  assert.doesNotThrow(() => clients[0]!.emit('error', lateError))
  clients[0]!.connected.reject(lateError)
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(manager.list()[0]?.status, 'connecting')
  assert.deepEqual(statuses, [])

  clients[1]!.connected.resolve(undefined)
  clients[1]!.shellRequested.resolve(new FakeStream())
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(manager.list()[0]?.status, 'ready')
})

test('cancelled host verification from an old attempt cannot classify a new failure', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const session = await connect(manager)
  const verifier = clients[0]!.connectionConfig?.hostVerifier
  assert.ok(verifier)

  const oldVerification = verifier({ fingerprint: 'SHA256:old-attempt' })
  await manager.reconnect(session.id)
  assert.equal(await oldVerification, false)

  const failed = waitForStatus(manager, session.id, 'error')
  clients[1]!.failConnection(new Error('All configured authentication methods failed'))
  const failure = await failed

  assert.equal(failure.errorKind, 'authentication-failed')
  assert.equal(
    failure.errorMessage,
    'All configured authentication methods failed'
  )
})

test('activeConnectionCount counts only connecting and ready sessions', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const connecting = await connect(manager, 'connecting.example')
  const ready = await connect(manager, 'ready.example')
  const failed = await connect(manager, 'failed.example')
  const disconnected = await connect(manager, 'disconnected.example')

  clients[1]!.connected.resolve(undefined)
  clients[1]!.shellRequested.resolve(new FakeStream())
  clients[2]!.failConnection(new Error('All configured authentication methods failed'))
  clients[3]!.connected.resolve(undefined)
  clients[3]!.shellRequested.resolve(new FakeStream())
  await new Promise<void>((resolve) => setImmediate(resolve))
  clients[3]!.emit('close')

  assert.equal(manager.activeConnectionCount(), 2)
  manager.close(connecting.id)
  assert.equal(manager.activeConnectionCount(), 1)
  manager.close(ready.id)
  assert.equal(manager.activeConnectionCount(), 0)
  assert.equal(manager.list().find((session) => session.id === failed.id)?.status, 'error')
  assert.equal(
    manager.list().find((session) => session.id === disconnected.id)?.status,
    'disconnected'
  )
})

test('rename trims the title, emits status, and preserves session metadata', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const source = await connect(manager)
  manager.setPolicy(source.id, 'readonly')
  const statuses: SessionSummary[] = []
  manager.on('status', (summary: SessionSummary) => statuses.push(summary))

  const renamed = manager.rename(source.id, '  Production  ')

  assert.equal(renamed.title, 'Production')
  assert.equal(renamed.id, source.id)
  assert.equal(renamed.policy, 'readonly')
  assert.deepEqual(statuses, [renamed])
  assert.equal(clients.length, 1)
})

test('duplicate creates an independent connecting session with credentials and policy', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const source = await manager.connect({
    hostId: 'host-1',
    host: 'server.example',
    port: 2202,
    username: 'operator',
    password: 'secret',
    title: 'Source',
  })
  manager.setPolicy(source.id, 'auto')

  const duplicate = await manager.duplicate(source.id, ' Source (copy) ')

  assert.notEqual(duplicate.id, source.id)
  assert.equal(duplicate.title, 'Source (copy)')
  assert.equal(duplicate.status, 'connecting')
  assert.equal(duplicate.policy, 'auto')
  assert.equal(duplicate.hostId, 'host-1')
  assert.equal(clients.length, 2)
  assert.notEqual(clients[0], clients[1])
  assert.equal(clients[1]!.connectionConfig?.host, 'server.example')
  assert.equal(clients[1]!.connectionConfig?.port, 2202)
  assert.equal(clients[1]!.connectionConfig?.username, 'operator')
  assert.equal(clients[1]!.connectionConfig?.password, 'secret')
  assert.equal(manager.list().find((session) => session.id === source.id)?.title, 'Source')
})

test('duplicate accepts every source status and always starts connecting', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const connecting = await connect(manager, 'connecting.example')
  const ready = await connect(manager, 'ready.example')
  const failed = await connect(manager, 'failed.example')
  const disconnected = await connect(manager, 'disconnected.example')

  clients[1]!.connected.resolve(undefined)
  clients[1]!.shellRequested.resolve(new FakeStream())
  clients[2]!.failConnection(new Error('All configured authentication methods failed'))
  clients[3]!.connected.resolve(undefined)
  clients[3]!.shellRequested.resolve(new FakeStream())
  await new Promise<void>((resolve) => setImmediate(resolve))
  clients[3]!.emit('close')

  const duplicates = await Promise.all(
    [connecting, ready, failed, disconnected].map((source, index) =>
      manager.duplicate(source.id, `Copy ${index + 1}`),
    ),
  )
  assert.deepEqual(duplicates.map((summary) => summary.status), [
    'connecting',
    'connecting',
    'connecting',
    'connecting',
  ])
  assert.equal(new Set(duplicates.map((summary) => summary.id)).size, 4)
})

test('closeMany deduplicates ids and ignores unknown sessions', async () => {
  const clients: FakeSshClient[] = []
  const manager = createManager(clients)
  const first = await connect(manager, 'first.example')
  const second = await connect(manager, 'second.example')
  const retained = await connect(manager, 'retained.example')

  manager.closeMany([first.id, first.id, 'unknown', second.id])

  assert.deepEqual(manager.list().map((session) => session.id), [retained.id])
  assert.equal(clients[0]!.disconnectCount, 1)
  assert.equal(clients[1]!.disconnectCount, 1)
  assert.equal(clients[2]!.disconnectCount, 0)
})
