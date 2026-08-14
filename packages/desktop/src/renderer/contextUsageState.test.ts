import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContextUsageSnapshot } from '../shared/ipc-types'
import { deriveContextUsageView, formatTokenCount } from './contextUsageState'

function usage(overrides: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    contextWindowTokens: 128_000,
    outputReserveTokens: 8_192,
    safetyReserveTokens: 2_048,
    availableInputBudget: 10_000,
    usedInputTokens: 2_500,
    estimated: true,
    slots: [
      { id: 'system', estimatedTokens: 1_000, shareOfInputBudget: 0.1, estimated: true },
      { id: 'chat', estimatedTokens: 1_500, shareOfInputBudget: 0.15, estimated: true },
      { id: 'guidance', estimatedTokens: 0, shareOfInputBudget: 0, estimated: true },
    ],
    omittedGuidance: [{ id: 'rule-1', moduleName: 'Ops', sourceLayer: 'dynamic' }],
    conflictCount: 1,
    conflicts: [{
      leftId: 'a',
      leftText: 'Never restart',
      leftModuleName: 'Ops',
      rightId: 'b',
      rightText: 'Always restart',
      rightModuleName: 'Ops',
    }],
    ...overrides,
  }
}

test('deriveContextUsageView reports used percent and slot shares against the input budget', () => {
  const view = deriveContextUsageView(usage())
  assert.ok(view)
  assert.equal(view.availableInputBudget, 10_000)
  assert.equal(view.usedInputTokens, 2_500)
  assert.equal(view.usedPercent, 25)
  assert.equal(view.estimated, true)
  const system = view.slots.find((slot) => slot.id === 'system')
  const chat = view.slots.find((slot) => slot.id === 'chat')
  assert.equal(system?.sharePercent, 10)
  assert.equal(chat?.sharePercent, 15)
  assert.equal(view.omittedGuidance.length, 1)
  assert.equal(view.conflictCount, 1)
})

test('deriveContextUsageView returns null without a snapshot', () => {
  assert.equal(deriveContextUsageView(undefined), null)
})

test('provider usage is shown without rewriting estimated used tokens', () => {
  const view = deriveContextUsageView(usage({
    providerUsage: { promptTokens: 9_999, completionTokens: 12, totalTokens: 10_011 },
  }))
  assert.ok(view)
  assert.equal(view.usedInputTokens, 2_500)
  assert.equal(view.providerUsage?.promptTokens, 9_999)
  assert.notEqual(view.usedInputTokens, view.providerUsage?.promptTokens)
})

test('formatTokenCount keeps compact labels for the meter', () => {
  assert.equal(formatTokenCount(512), '512')
  assert.equal(formatTokenCount(1_500), '1.5k')
  assert.equal(formatTokenCount(12_000), '12k')
})
