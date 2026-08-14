import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyConnectionError } from './connectionError'

test('classifies the screenshot SSH handshake timeout and preserves its message', () => {
  const result = classifyConnectionError(new Error('Timed out while waiting for handshake'))

  assert.deepEqual(result, {
    kind: 'handshake-timeout',
    message: 'Timed out while waiting for handshake',
  })
})

test('classifies the screenshot TCP timeout from its structured error code', () => {
  const error = Object.assign(new Error('connect ETIMEDOUT 192.0.2.10:5233'), {
    code: 'ETIMEDOUT',
  })

  assert.deepEqual(classifyConnectionError(error), {
    kind: 'network-timeout',
    message: 'connect ETIMEDOUT 192.0.2.10:5233',
  })
})

test('maps structured network error codes before inspecting message text', () => {
  const cases = [
    ['EHOSTUNREACH', 'network-timeout'],
    ['ENETUNREACH', 'network-timeout'],
    ['ECONNREFUSED', 'connection-refused'],
    ['ENOTFOUND', 'host-not-found'],
    ['EAI_AGAIN', 'host-not-found'],
    ['ECONNRESET', 'connection-reset'],
  ] as const

  for (const [code, kind] of cases) {
    const error = Object.assign(new Error('Timed out while waiting for handshake'), { code })
    assert.equal(classifyConnectionError(error).kind, kind, code)
  }
})

test('classifies stable SSH and network message fragments when no code exists', () => {
  const cases = [
    ['connect ETIMEDOUT 192.0.2.10:22', 'network-timeout'],
    ['connect EHOSTUNREACH 192.0.2.10:22', 'network-timeout'],
    ['connect ECONNREFUSED 127.0.0.1:22', 'connection-refused'],
    ['getaddrinfo ENOTFOUND missing.example', 'host-not-found'],
    ['All configured authentication methods failed', 'authentication-failed'],
    ['Permission denied (publickey,password)', 'authentication-failed'],
    ['Host key verification was refused', 'host-key-rejected'],
    ['Host fingerprint changed and was rejected', 'host-key-rejected'],
    ['Private key file not found: C:\\keys\\missing', 'key-file-error'],
    ['Cannot read private key: C:\\keys\\id_ed25519', 'key-file-error'],
    ['read ECONNRESET', 'connection-reset'],
    ['Socket closed by remote host', 'connection-reset'],
  ] as const

  for (const [message, kind] of cases) {
    assert.equal(classifyConnectionError(new Error(message)).kind, kind, message)
  }
})

test('classifies the existing Chinese changed-host-fingerprint rejection message', () => {
  const message = '\u4e3b\u673a\u6307\u7eb9\u5df2\u53d8\u5316\uff0c\u8fde\u63a5\u88ab\u62d2\u7edd'

  assert.equal(classifyConnectionError(new Error(message)).kind, 'host-key-rejected')
})

test('returns a presentable fallback for empty and non-error values', () => {
  const values = [new Error(''), '', '   ', null, undefined, { unexpected: true }]

  for (const value of values) {
    assert.deepEqual(classifyConnectionError(value), {
      kind: 'unknown',
      message: 'Unknown SSH connection error',
    })
  }
})

test('uses a nested cause for structured classification and an otherwise empty message', () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:22'), {
    code: 'ECONNREFUSED',
  })
  const wrapped = Object.assign(new Error(''), { cause })

  assert.deepEqual(classifyConnectionError(wrapped), {
    kind: 'connection-refused',
    message: 'connect ECONNREFUSED 127.0.0.1:22',
  })
})

test('does not classify from an Electron remote-method wrapper alone', () => {
  const message = "Error invoking remote method 'session:connect': Error: connect ETIMEDOUT 192.0.2.10:22"

  assert.deepEqual(classifyConnectionError(new Error(message)), {
    kind: 'unknown',
    message,
  })
})

test('redacts credentials from the preserved technical message', () => {
  const message = [
    'Authentication failed: password=super-secret',
    'privateKey="-----BEGIN OPENSSH PRIVATE KEY-----',
    'private-key-content',
    '-----END OPENSSH PRIVATE KEY-----"',
  ].join('\n')

  const result = classifyConnectionError(new Error(message))

  assert.equal(result.kind, 'authentication-failed')
  assert.match(result.message, /Authentication failed/)
  assert.match(result.message, /\[REDACTED\]/)
  assert.doesNotMatch(result.message, /super-secret|private-key-content/)
})

test('redacts credential fields from a serialized authentication object', () => {
  const message = 'Authentication failed: {"username":"ops","password":"secret","privateKey":"key-material"}'

  const result = classifyConnectionError(new Error(message))

  assert.equal(result.kind, 'authentication-failed')
  assert.match(result.message, /"username":"ops"/)
  assert.doesNotMatch(result.message, /"secret"|key-material/)
})
