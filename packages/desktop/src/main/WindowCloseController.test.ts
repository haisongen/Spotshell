import assert from 'node:assert/strict'
import test from 'node:test'
import { WindowCloseController } from './WindowCloseController'

class Deferred<T> {
  readonly promise: Promise<T>
  private resolvePromise!: (value: T) => void

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolvePromise = resolve
    })
  }

  resolve(value: T): void {
    this.resolvePromise(value)
  }
}

test('closes immediately and cleans up when no active connections exist', async () => {
  let cleanupCount = 0
  let completeCount = 0
  const controller = new WindowCloseController({
    activeConnectionCount: () => 0,
    confirmClose: async () => false,
    closeAll: () => { cleanupCount += 1 },
    completeClose: () => { completeCount += 1 },
  })

  assert.equal(controller.requestClose(), true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(cleanupCount, 1)
  assert.equal(completeCount, 1)
  assert.equal(controller.requestClose(), false)
  assert.equal(cleanupCount, 1)
})

test('cancel leaves sessions untouched and allows a later close attempt', async () => {
  let confirmCount = 0
  let cleanupCount = 0
  const controller = new WindowCloseController({
    activeConnectionCount: () => 2,
    confirmClose: async () => { confirmCount += 1; return false },
    closeAll: () => { cleanupCount += 1 },
    completeClose: () => assert.fail('close must remain blocked'),
  })

  assert.equal(controller.requestClose(), true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(controller.requestClose(), true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(confirmCount, 2)
  assert.equal(cleanupCount, 0)
})

test('concurrent close events share one confirmation and cleanup', async () => {
  const confirmation = new Deferred<boolean>()
  let confirmCount = 0
  let cleanupCount = 0
  let completeCount = 0
  const controller = new WindowCloseController({
    activeConnectionCount: () => 3,
    confirmClose: () => { confirmCount += 1; return confirmation.promise },
    closeAll: () => { cleanupCount += 1 },
    completeClose: () => { completeCount += 1 },
  })

  assert.equal(controller.requestClose(), true)
  assert.equal(controller.requestClose(), true)
  assert.equal(confirmCount, 1)
  confirmation.resolve(true)
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(cleanupCount, 1)
  assert.equal(completeCount, 1)
  assert.equal(controller.requestClose(), false)
})

test('confirmation failure keeps close blocked without cleanup', async () => {
  let cleanupCount = 0
  const controller = new WindowCloseController({
    activeConnectionCount: () => 1,
    confirmClose: async () => { throw new Error('dialog failed') },
    closeAll: () => { cleanupCount += 1 },
    completeClose: () => assert.fail('close must remain blocked'),
  })

  assert.equal(controller.requestClose(), true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(cleanupCount, 0)
  assert.equal(controller.requestClose(), true)
})
