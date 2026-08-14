import assert from 'node:assert/strict'
import test from 'node:test'
import { formatContextBoundaryLabel } from './contextBoundary'

test('formats a user-requested context boundary with time and epoch', () => {
  const label = formatContextBoundaryLabel({
    epoch: 2,
    previousEpoch: 1,
    createdAt: '2026-08-04T12:00:00.000Z',
    reason: 'user',
  }, 'zh-CN')
  assert.match(label, /上下文 #2/)
  assert.match(label, /已开启新上下文/)
})

test('formats an environment-switch boundary with from and to names', () => {
  const label = formatContextBoundaryLabel({
    epoch: 3,
    previousEpoch: 2,
    createdAt: '2026-08-04T12:00:00.000Z',
    reason: 'environment-switch',
    fromEnvironmentName: 'Prod',
    toEnvironmentName: 'Stage',
  }, 'en')
  assert.match(label, /Context #3/)
  assert.match(label, /Environment: Prod → Stage/)
})
