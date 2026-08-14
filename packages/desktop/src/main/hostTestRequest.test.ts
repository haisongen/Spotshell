import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostProfile } from '@spotshell/core'
import { resolveHostTestRequest } from './hostTestRequest'

const saved: HostProfile = {
  id: 'host-1', name: 'Saved', host: 'saved.internal', port: 22, username: 'deploy',
  authMethod: 'password',
}

test('saved-only tests preserve the saved connection and credential behavior', () => {
  assert.deepEqual(resolveHostTestRequest(saved, undefined, 'saved-secret'), {
    ok: true,
    input: {
      host: 'saved.internal', port: 22, username: 'deploy',
      password: 'saved-secret', privateKeyPath: undefined,
    },
  })
  assert.equal(resolveHostTestRequest(saved, undefined, undefined).ok, false)
})

test('draft password prefers ephemeral input and honors explicit fallback control', () => {
  const draft = {
    host: 'draft.internal', port: 2222, username: 'root', authMethod: 'password' as const,
    password: 'temporary', useSavedPassword: true,
  }
  const ephemeral = resolveHostTestRequest(saved, draft, 'saved-secret')
  assert.equal(ephemeral.ok && ephemeral.input.password, 'temporary')
  const fallback = resolveHostTestRequest(saved, { ...draft, password: undefined }, 'saved-secret')
  assert.equal(fallback.ok && fallback.input.password, 'saved-secret')
  assert.equal(resolveHostTestRequest(saved, {
    ...draft, password: undefined, useSavedPassword: false,
  }, 'saved-secret').ok, false)
})

test('key and agent drafts ignore all password material without mutating saved data', () => {
  const before = structuredClone(saved)
  assert.deepEqual(resolveHostTestRequest(saved, {
    host: 'key.internal', port: 22, username: 'key-user', authMethod: 'key',
    privateKeyPath: '~/.ssh/test', password: 'ignored', useSavedPassword: true,
  }, 'saved-secret'), {
    ok: true,
    input: { host: 'key.internal', port: 22, username: 'key-user', privateKeyPath: '~/.ssh/test' },
  })
  assert.deepEqual(resolveHostTestRequest(saved, {
    host: 'agent.internal', port: 22, username: 'agent-user', authMethod: 'agent',
    privateKeyPath: '~/.ssh/ignored', password: 'ignored', useSavedPassword: true,
  }, 'saved-secret'), {
    ok: true,
    input: { host: 'agent.internal', port: 22, username: 'agent-user', useAgent: true },
  })
  assert.deepEqual(saved, before)
})

test('saved agent profiles use the SSH agent without stale credentials', () => {
  assert.deepEqual(resolveHostTestRequest({
    ...saved, authMethod: 'agent', privateKeyPath: '/ignored',
  }, undefined, 'ignored'), {
    ok: true,
    input: { host: 'saved.internal', port: 22, username: 'deploy', useAgent: true },
  })
})
