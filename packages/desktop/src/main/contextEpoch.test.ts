import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceEpoch,
  createInitialEpochState,
  markEpochActivity,
  shouldOpenNewEpochOnEnvironmentChange,
} from './contextEpoch'

test('new sessions start at epoch 1 with no activity', () => {
  assert.deepEqual(createInitialEpochState(), {
    contextEpoch: 1,
    epochHasActivity: false,
  })
})

test('marking activity is idempotent within an epoch', () => {
  const marked = markEpochActivity(createInitialEpochState())
  assert.equal(marked.epochHasActivity, true)
  assert.equal(markEpochActivity(marked), marked)
})

test('environment switch opens a new epoch only when the current segment has activity', () => {
  const empty = createInitialEpochState()
  assert.equal(shouldOpenNewEpochOnEnvironmentChange(empty, true), false)
  assert.equal(shouldOpenNewEpochOnEnvironmentChange(empty, false), false)

  const active = markEpochActivity(empty)
  assert.equal(shouldOpenNewEpochOnEnvironmentChange(active, true), true)
  assert.equal(shouldOpenNewEpochOnEnvironmentChange(active, false), false)
})

test('advancing an epoch resets activity and records boundary metadata', () => {
  const active = markEpochActivity(createInitialEpochState())
  const now = new Date('2026-08-04T12:00:00.000Z')
  const { state, boundary } = advanceEpoch(active, 'environment-switch', {
    now,
    fromEnvironmentId: 'env-a',
    fromEnvironmentName: 'Prod',
    toEnvironmentId: 'env-b',
    toEnvironmentName: 'Stage',
  })

  assert.deepEqual(state, { contextEpoch: 2, epochHasActivity: false })
  assert.deepEqual(boundary, {
    epoch: 2,
    previousEpoch: 1,
    createdAt: '2026-08-04T12:00:00.000Z',
    reason: 'environment-switch',
    fromEnvironmentId: 'env-a',
    fromEnvironmentName: 'Prod',
    toEnvironmentId: 'env-b',
    toEnvironmentName: 'Stage',
  })
})

test('user-requested new context advances epoch without environment fields', () => {
  const { state, boundary } = advanceEpoch(createInitialEpochState(), 'user', {
    now: new Date('2026-08-04T08:30:00.000Z'),
  })
  assert.equal(state.contextEpoch, 2)
  assert.equal(boundary.reason, 'user')
  assert.equal(boundary.fromEnvironmentId, undefined)
  assert.equal(boundary.toEnvironmentId, undefined)
})
