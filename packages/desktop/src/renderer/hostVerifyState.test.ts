import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostVerifyRequest } from '../shared/ipc-types'
import { closeMatchingHostVerify } from './hostVerifyState'

const request: HostVerifyRequest = {
  requestId: 'request-two', sessionId: 'connection-two', host: 'host', port: 22,
  fingerprint: 'SHA256:value',
}

test('host verify closure only clears the matching request', () => {
  assert.equal(closeMatchingHostVerify(request, {
    requestId: 'request-one', sessionId: 'connection-one',
  }), request)
  assert.equal(closeMatchingHostVerify(request, {
    requestId: request.requestId, sessionId: request.sessionId,
  }), null)
})
