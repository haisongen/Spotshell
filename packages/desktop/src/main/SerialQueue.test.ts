import assert from 'node:assert/strict'
import test from 'node:test'
import { SerialQueue } from './SerialQueue'

test('runs tasks for the same key in order', async () => {
  const q = new SerialQueue()
  const order: number[] = []
  const first = q.run('a', async () => {
    await new Promise((r) => setTimeout(r, 30))
    order.push(1)
  })
  const second = q.run('a', async () => {
    order.push(2)
  })
  await Promise.all([first, second])
  assert.deepEqual(order, [1, 2])
})

test('a failed task does not block the next one', async () => {
  const q = new SerialQueue()
  await assert.rejects(
    q.run('a', async () => {
      throw new Error('boom')
    })
  )
  assert.equal(
    await q.run('a', async () => 'ok'),
    'ok'
  )
})
