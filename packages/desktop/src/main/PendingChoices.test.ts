import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingChoices } from './PendingChoices'

test('expires when the user never answers', async () => {
  const choices = new PendingChoices(20)
  assert.deepEqual(await choices.create('s1', 'r1', 3), { status: 'expired' })
})

test('respond carries the picked option index and clears the request', async () => {
  const choices = new PendingChoices(10_000)
  const pending = choices.create('s1', 'r1', 3)
  assert.deepEqual(choices.respond('r1', 2), { accepted: true, status: 'answered' })
  assert.deepEqual(await pending, { status: 'answered', optionIndex: 2 })
  assert.deepEqual(choices.respond('r1', 1), { accepted: false, status: 'answered' })
})

test('declining every option is a distinct terminal state', async () => {
  const choices = new PendingChoices(10_000)
  const pending = choices.create('s1', 'r1', 2)
  assert.deepEqual(choices.respond('r1', null), { accepted: true, status: 'dismissed' })
  assert.deepEqual(await pending, { status: 'dismissed' })
})

test('an index the card never offered is refused and leaves the wait open', async () => {
  const choices = new PendingChoices(10_000)
  const pending = choices.create('s1', 'r1', 2)
  assert.deepEqual(choices.respond('r1', 2), { accepted: false })
  assert.deepEqual(choices.respond('r1', -1), { accepted: false })
  assert.deepEqual(choices.respond('r1', 1.5), { accepted: false })
  // Still answerable with a valid index.
  assert.deepEqual(choices.respond('r1', 1), { accepted: true, status: 'answered' })
  assert.deepEqual(await pending, { status: 'answered', optionIndex: 1 })
})

test('rejectForSession only cancels that session', async () => {
  const choices = new PendingChoices(10_000)
  const a = choices.create('s1', 'r1', 1)
  const b = choices.create('s2', 'r2', 1)
  assert.deepEqual(choices.rejectForSession('s1'), ['r1'])
  assert.deepEqual(await a, { status: 'cancelled' })
  choices.respond('r2', 0)
  assert.deepEqual(await b, { status: 'answered', optionIndex: 0 })
})

test('a late response loses cleanly to an already completed request', async () => {
  const choices = new PendingChoices(5)
  const pending = choices.create('s1', 'r1', 2)
  assert.deepEqual(await pending, { status: 'expired' })
  assert.deepEqual(choices.respond('r1', 0), { accepted: false, status: 'expired' })
  assert.deepEqual(choices.respond('unknown', 0), { accepted: false, status: undefined })
})
