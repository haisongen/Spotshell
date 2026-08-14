import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingConfirms } from './PendingConfirms'

test('resolves false after timeout', async () => {
  const confirms = new PendingConfirms(20)
  assert.deepEqual(await confirms.create('s1', 'r1'), { ok: false, status: 'expired' })
})

test('respond resolves the pending request and clears it', async () => {
  const confirms = new PendingConfirms(10_000)
  const p = confirms.create('s1', 'r1')
  assert.equal(confirms.respond('r1', true), true)
  assert.deepEqual(await p, { ok: true, status: 'approved' })
  assert.equal(confirms.respond('r1', true), false)
})

test('a negative response has a distinct rejected terminal state', async () => {
  const confirms = new PendingConfirms(10_000)
  const pending = confirms.create('s1', 'r1')
  assert.equal(confirms.respond('r1', false), true)
  assert.deepEqual(await pending, { ok: false, status: 'rejected' })
})

test('rejectForSession only rejects that session', async () => {
  const confirms = new PendingConfirms(10_000)
  const a = confirms.create('s1', 'r1')
  const b = confirms.create('s2', 'r2')
  assert.deepEqual(confirms.rejectForSession('s1'), ['r1'])
  assert.deepEqual(await a, { ok: false, status: 'cancelled' })
  confirms.respond('r2', true)
  assert.deepEqual(await b, { ok: true, status: 'approved' })
})

test('a response loses cleanly to an already completed timeout', async () => {
  const confirms = new PendingConfirms(5)
  const pending = confirms.create('s1', 'r1')
  assert.deepEqual(await pending, { ok: false, status: 'expired' })
  assert.equal(confirms.respond('r1', true), false)
  assert.deepEqual(confirms.respondWithStatus('r1', true), { accepted: false, status: 'expired' })
})

test('an acknowledgement reports cancellation instead of guessing a terminal state', async () => {
  const confirms = new PendingConfirms(10_000)
  const pending = confirms.create('s1', 'r1')
  confirms.rejectForSession('s1')
  assert.deepEqual(await pending, { ok: false, status: 'cancelled' })
  assert.deepEqual(confirms.respondWithStatus('r1', true), { accepted: false, status: 'cancelled' })
  assert.deepEqual(confirms.respondWithStatus('unknown', true), { accepted: false, status: undefined })
})
