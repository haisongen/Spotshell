/**
 * Safety fuse: health-check commands embedded in official seed modules
 * must remain classifyCommand=readonly. Canonical list lives in @spotshell/core.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCommand, HEALTH_CHECK_COMMANDS, OFFICIAL_SEED_MODULES } from '@spotshell/core'

test('every health-check command classifies readonly (policy safety fuse)', () => {
  assert.ok(HEALTH_CHECK_COMMANDS.length >= 5)
  for (const cmd of HEALTH_CHECK_COMMANDS) {
    assert.equal(classifyCommand(cmd), 'readonly', cmd)
  }
})

test('desktop package still sees the seven official diagnostic seed keys', () => {
  assert.equal(OFFICIAL_SEED_MODULES.length, 7)
  const keys = OFFICIAL_SEED_MODULES.map((seed) => seed.key).sort()
  assert.deepEqual(keys, [
    'cert-expiry',
    'disk-full',
    'hdfs-yarn',
    'healthcheck',
    'oom',
    'port-conflict',
    'service-down',
  ])
  const healthcheck = OFFICIAL_SEED_MODULES.find((seed) => seed.key === 'healthcheck')!
  for (const cmd of HEALTH_CHECK_COMMANDS) {
    assert.ok(healthcheck.body.includes(cmd), cmd)
  }
})
