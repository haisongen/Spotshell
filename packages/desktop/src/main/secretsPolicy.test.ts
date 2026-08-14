import assert from 'node:assert/strict'
import test from 'node:test'
import { allowPlaintextSecrets } from './secretsPolicy'

test('plaintext secrets are dev-only', () => {
  assert.equal(allowPlaintextSecrets(false), true)
  assert.equal(allowPlaintextSecrets(true), false)
})
