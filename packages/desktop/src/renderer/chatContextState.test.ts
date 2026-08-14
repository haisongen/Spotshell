import assert from 'node:assert/strict'
import test from 'node:test'
import type { KnowledgeModuleAccessSummary, SessionSummary } from '../shared/ipc-types'
import { availableChatContextActions, deriveChatContext } from './chatContextState'

const environmentId = 'env-production'

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-a',
    title: 'Production',
    status: 'ready',
    environmentId,
    environmentSource: 'session',
    policy: 'ask',
    pinnedModuleIds: ['module-pinned'],
    dynamicModuleIds: ['module-dynamic'],
    activeRevisions: [],
    revisionUpdatesAvailable: [],
    contextEpoch: 1,
    epochHasActivity: false,
    commandRunning: false,
    ...overrides,
  }
}

function module(
  id: string,
  overrides: Partial<KnowledgeModuleAccessSummary> = {},
): KnowledgeModuleAccessSummary {
  return {
    id,
    name: id,
    description: `${id} description`,
    whenToUse: `${id} usage`,
    tags: [],
    draftSavedAt: '2026-08-03T00:00:00.000Z',
    automaticCandidateEligible: true,
    globalOnDemand: false,
    environmentAlways: [],
    environmentOnDemand: [],
    ...overrides,
  }
}

test('groups a session context into fixed, dynamic, and available candidate modules', () => {
  const context = deriveChatContext(session(), [
    module('module-always', { environmentAlways: [{ id: environmentId, name: 'Production' }] }),
    module('module-pinned'),
    module('module-dynamic'),
    module('module-on-demand', { environmentOnDemand: [{ id: environmentId, name: 'Production' }] }),
    module('module-global', { globalOnDemand: true }),
    module('module-ineligible', { automaticCandidateEligible: false, globalOnDemand: true }),
  ])

  assert.deepEqual(context.fixed.map((entry) => [entry.id, entry.action]), [
    ['module-always', 'manage'],
    ['module-pinned', 'unpin'],
  ])
  assert.deepEqual(context.dynamic.map((entry) => [entry.id, entry.action]), [
    ['module-dynamic', 'unload'],
  ])
  assert.deepEqual(context.candidates.map((entry) => [entry.id, entry.action]), [
    ['module-global', 'load'],
    ['module-on-demand', 'load'],
  ])
})

test('does not leak pinned or dynamic state when switching the active session', () => {
  const modules = [module('module-pinned'), module('module-dynamic'), module('module-global', { globalOnDemand: true })]
  const first = deriveChatContext(session(), modules)
  const second = deriveChatContext(session({
    id: 'session-b',
    environmentId: undefined,
    environmentSource: 'none',
    pinnedModuleIds: [],
    dynamicModuleIds: [],
  }), modules)

  assert.deepEqual(first.fixed.map((entry) => entry.id), ['module-pinned'])
  assert.deepEqual(first.dynamic.map((entry) => entry.id), ['module-dynamic'])
  assert.deepEqual(second.fixed, [])
  assert.deepEqual(second.dynamic, [])
  assert.deepEqual(second.candidates.map((entry) => entry.id), ['module-global'])
})

test('exposes only the user actions allowed for each context group', () => {
  const context = deriveChatContext(session(), [
    module('module-always', { environmentAlways: [{ id: environmentId, name: 'Production' }] }),
    module('module-pinned'),
    module('module-dynamic'),
    module('module-candidate', { globalOnDemand: true }),
  ])

  assert.deepEqual(availableChatContextActions(context.fixed[0]!), ['manage'])
  assert.deepEqual(availableChatContextActions(context.fixed[1]!), ['manage', 'unpin'])
  assert.deepEqual(availableChatContextActions(context.dynamic[0]!), ['manage', 'pin', 'unload'])
  assert.deepEqual(availableChatContextActions(context.candidates[0]!), ['manage', 'load', 'pin'])
})
