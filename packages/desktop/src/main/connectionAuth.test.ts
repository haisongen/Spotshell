import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSavedHostIdentity, resolveConnectionAuthentication } from './connectionAuth'

test('saved-host identity must match the host id before privileged host state is used', () => {
  const savedHost = {
    id: 'host-prod',
    host: 'prod.example',
    port: 22,
    username: 'ops',
  }
  assert.doesNotThrow(() => assertSavedHostIdentity(
    {
      hostId: savedHost.id,
      host: savedHost.host,
      port: savedHost.port,
      username: savedHost.username,
    },
    savedHost,
  ))
  assert.throws(
    () => assertSavedHostIdentity(
      {
        hostId: savedHost.id,
        host: 'other.example',
        port: savedHost.port,
        username: savedHost.username,
      },
      savedHost,
    ),
    /does not match/i,
  )
  assert.throws(
    () => assertSavedHostIdentity(
      {
        hostId: 'missing',
        host: savedHost.host,
        port: savedHost.port,
        username: savedHost.username,
      },
      undefined,
    ),
    /not found/i,
  )
})

test('saved agent connect ignores stale password and private key before reading the key', () => {
  let keyReads = 0
  const authentication = resolveConnectionAuthentication({
    useAgent: true, password: 'stale-password', privateKeyPath: '/stale/key',
  }, () => {
    keyReads += 1
    throw new Error('stale key must not be read')
  }, () => '/tmp/agent.sock')
  assert.deepEqual(authentication, {
    password: undefined, privateKey: undefined, agent: '/tmp/agent.sock',
  })
  assert.equal(keyReads, 0)
})

test('reconnect applies the same agent normalization to retained stale credentials', () => {
  const retainedRequest = {
    useAgent: true, password: 'retained-password', privateKeyPath: '/retained/key',
  }
  for (const attempt of ['connect', 'reconnect']) {
    const authentication = resolveConnectionAuthentication(
      retainedRequest,
      () => { throw new Error(`${attempt} read a stale key`) },
      () => '/tmp/agent.sock'
    )
    assert.equal(authentication.agent, '/tmp/agent.sock')
    assert.equal(authentication.privateKey, undefined)
    assert.equal(authentication.password, undefined)
  }
})

test('key and password authentication retain their existing behavior', () => {
  const key = Buffer.from('key')
  assert.deepEqual(resolveConnectionAuthentication({
    password: 'password', privateKeyPath: '/key',
  }, () => key, () => '/unused'), {
    password: 'password', privateKey: key, agent: undefined,
  })
})
