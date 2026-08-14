import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppSettings } from '../shared/ipc-types'
import {
  buildLlmTestRequest,
  buildProviderSettingsPatch,
  createModelProviderDrafts,
} from './modelSettingsForm'

const settings: AppSettings = {
  language: 'en', theme: 'dark', shellIntegration: true,
  recursionLimit: 25, allowAutoContextCompaction: true,
  model: {
    activeProvider: 'openai',
    providers: {
      openai: { model: 'gpt-x', baseUrl: 'https://openai.example', contextWindowTokens: 10_000, hasApiKey: true },
      anthropic: { model: 'claude-x', baseUrl: 'https://anthropic.example', contextWindowTokens: 20_000, hasApiKey: false },
    },
  },
}

test('provider drafts remain independent when switching', () => {
  const drafts = createModelProviderDrafts(settings)
  drafts.anthropic.model = 'changed-claude'
  assert.equal(drafts.openai.model, 'gpt-x')
  assert.equal(drafts.openai.hasApiKey, true)
  assert.equal(drafts.anthropic.hasApiKey, false)
})

test('save, test, and clear requests target one explicit provider', () => {
  const draft = createModelProviderDrafts(settings).anthropic
  draft.apiKey = ' draft-key '
  assert.deepEqual(buildLlmTestRequest('anthropic', draft), {
    provider: 'anthropic', apiKey: 'draft-key', model: 'claude-x', baseUrl: 'https://anthropic.example',
  })
  assert.equal(buildProviderSettingsPatch('anthropic', draft).provider, 'anthropic')
  assert.deepEqual({ provider: 'anthropic', apiKey: '' }, { provider: 'anthropic', apiKey: '' })
})
