import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostVerifyClosed, HostVerifyRequest } from '../shared/ipc-types'
import { SessionManager } from './SessionManager'

function createManager(): SessionManager {
  return new SessionManager(
    () => null,
    { get: () => undefined, set: () => undefined } as never,
    { append: () => undefined } as never,
    () => undefined,
    () => false,
    () => 'saved'
  )
}

test('cancelling one connection verification closes only its matching request', async () => {
  const manager = createManager()
  const requests: HostVerifyRequest[] = []
  const closed: HostVerifyClosed[] = []
  manager.on('hostVerify', (request: HostVerifyRequest) => requests.push(request))
  manager.on('hostVerifyClosed', (event: HostVerifyClosed) => closed.push(event))

  const first = manager.verifyConnectionHostKey('test-one', { host: 'one', port: 22 }, 'SHA256:one')
  const second = manager.verifyConnectionHostKey('test-two', { host: 'two', port: 22 }, 'SHA256:two')
  assert.equal(requests.length, 2)

  manager.cancelHostVerification('test-one')
  assert.equal(await first, false)
  assert.deepEqual(closed, [{ requestId: requests[0]!.requestId, sessionId: 'test-one' }])

  manager.respondHostVerify(requests[1]!.requestId, true)
  assert.equal(await second, true)
  assert.deepEqual(closed[1], { requestId: requests[1]!.requestId, sessionId: 'test-two' })
})
