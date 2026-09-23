import test from 'node:test'
import assert from 'node:assert/strict'
import { HOST_TIERS, describeSessionTarget, hostTierClass, hostTierLabelKey, isHostTier, sessionTier } from './hostTierView'

test('every tier has a distinct label key and css class', () => {
  const keys = HOST_TIERS.map(hostTierLabelKey)
  assert.equal(new Set(keys).size, HOST_TIERS.length)
  assert.deepEqual(HOST_TIERS.map(hostTierClass), [
    'tier-production', 'tier-staging', 'tier-testing', 'tier-development',
  ])
  assert.equal(hostTierClass(undefined), '')
})

test('isHostTier accepts only the known tiers', () => {
  for (const tier of HOST_TIERS) assert.ok(isHostTier(tier))
  for (const value of ['', 'prod', 'Production', undefined, null, 0]) assert.equal(isHostTier(value), false)
})

test('describeSessionTarget names the saved host, or only the session for quick connects', () => {
  const hosts = [{ id: 'a', tier: 'production' as const, username: 'ops', host: '10.0.0.1', port: 22 }]
  assert.deepEqual(describeSessionTarget({ hostId: 'a', title: 'prod-jump' }, hosts), {
    title: 'prod-jump', address: 'ops@10.0.0.1:22', tier: 'production',
  })
  assert.deepEqual(describeSessionTarget({ title: 'root@1.2.3.4' }, hosts), { title: 'root@1.2.3.4' })
  assert.deepEqual(describeSessionTarget({ hostId: 'gone', title: 'x' }, hosts), { title: 'x' })
  assert.equal(describeSessionTarget(null, hosts), null)
})

test('sessionTier follows the saved host and is unmarked otherwise', () => {
  const hosts = [{ id: 'a', tier: 'production' as const }, { id: 'b' }]
  assert.equal(sessionTier({ hostId: 'a' }, hosts), 'production')
  assert.equal(sessionTier({ hostId: 'b' }, hosts), undefined)
  assert.equal(sessionTier({ hostId: 'gone' }, hosts), undefined)
  assert.equal(sessionTier({}, hosts), undefined)
  assert.equal(sessionTier({ hostId: 'a' }, null), undefined)
  assert.equal(sessionTier(null, hosts), undefined)
})
