import assert from 'node:assert/strict'
import test from 'node:test'
import type { SSHConnectionConfig } from '@spotshell/core'
import {
  probeHostConnection,
  type ProbeClient,
} from './hostConnectionProbe'

class FakeClient implements ProbeClient {
  config?: SSHConnectionConfig
  connectCalls = 0
  disconnectCalls = 0
  destroyCalls = 0
  requestShellCalls = 0

  constructor(private readonly connectResult: () => Promise<void> = async () => undefined) {}

  async connect(config: SSHConnectionConfig): Promise<void> {
    this.connectCalls += 1
    this.config = config
    return this.connectResult()
  }

  disconnect(): void {
    this.disconnectCalls += 1
  }

  destroy(): void {
    this.destroyCalls += 1
  }

  requestShell(): void {
    this.requestShellCalls += 1
  }
}

const input = { host: 'server.example', port: 22, username: 'ops' }

test('successful probe passes configuration and verifier through, then disconnects once', async () => {
  const client = new FakeClient()
  const verifier = async (): Promise<boolean> => true
  const times = [100, 137]

  const result = await probeHostConnection(
    { ...input, password: 'secret', hostVerifier: verifier },
    { clientFactory: () => client, now: () => times.shift() ?? 137 }
  )

  assert.deepEqual(result, { ok: true, message: 'Connection successful', latencyMs: 37 })
  assert.equal(client.config?.host, input.host)
  assert.equal(client.config?.password, 'secret')
  assert.equal(client.config?.hostVerifier, verifier)
  assert.equal(client.disconnectCalls, 1)
  assert.equal(client.destroyCalls, 0)
  assert.equal(client.requestShellCalls, 0)
})

test('connect errors are returned with elapsed time and cleanup runs once', async () => {
  const client = new FakeClient(async () => { throw new Error('Authentication failed') })
  const times = [10, 34]

  const result = await probeHostConnection(input, {
    clientFactory: () => client,
    now: () => times.shift() ?? 34,
  })

  assert.deepEqual(result, { ok: false, message: 'Authentication failed', latencyMs: 24 })
  assert.equal(client.disconnectCalls, 1)
  assert.equal(client.destroyCalls, 0)
  assert.equal(client.requestShellCalls, 0)
})

test('connect errors reuse the safe connection error message without changing the result contract', async () => {
  const client = new FakeClient(async () => {
    throw new Error('Authentication failed: password=super-secret')
  })
  const times = [10, 34]

  const result = await probeHostConnection(input, {
    clientFactory: () => client,
    now: () => times.shift() ?? 34,
  })

  assert.deepEqual(result, {
    ok: false,
    message: 'Authentication failed: password=[REDACTED]',
    latencyMs: 24,
  })
})

test('private key read failure is returned without attempting connection', async () => {
  const client = new FakeClient()
  const result = await probeHostConnection(
    { ...input, privateKeyPath: 'missing-key' },
    {
      clientFactory: () => client,
      readPrivateKey: () => { throw new Error('Private key file not found: missing-key') },
    }
  )

  assert.equal(result.ok, false)
  assert.match(result.message, /Private key file not found/)
  assert.equal(client.connectCalls, 0)
  assert.equal(client.disconnectCalls, 1)
  assert.equal(client.destroyCalls, 0)
  assert.equal(client.requestShellCalls, 0)
})

test('a stalled connection times out and is destroyed once', async () => {
  const client = new FakeClient(() => new Promise<void>(() => undefined))
  const result = await probeHostConnection(input, {
    clientFactory: () => client,
    timeoutMs: 10,
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /timed out after 10 ms/)
  assert.equal(client.disconnectCalls, 0)
  assert.equal(client.destroyCalls, 1)
  assert.equal(client.requestShellCalls, 0)
})

test('agent authentication forwards the resolved socket to SSH', async () => {
  const client = new FakeClient()
  const result = await probeHostConnection({ ...input, useAgent: true }, {
    clientFactory: () => client,
    resolveAgentSocket: () => '/tmp/agent.sock',
  })
  assert.equal(result.ok, true)
  assert.equal(client.config?.agent, '/tmp/agent.sock')
  assert.equal(client.config?.password, undefined)
  assert.equal(client.config?.privateKey, undefined)
})

test('agent authentication fails clearly when no socket is available', async () => {
  const client = new FakeClient()
  const result = await probeHostConnection({ ...input, useAgent: true }, {
    clientFactory: () => client,
    resolveAgentSocket: () => undefined,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /SSH_AUTH_SOCK/)
  assert.equal(client.connectCalls, 0)
})
