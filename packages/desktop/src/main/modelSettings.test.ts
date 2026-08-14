import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeSecretsEnvelope,
  encodeSecretsEnvelope,
  normalizeStoredModelSettings,
  setProviderApiKey,
  toPublicProviderSettings,
} from './modelSettings'

test('legacy OpenAI settings normalize into the OpenAI provider profile', () => {
  const stored = normalizeStoredModelSettings({
    openAiModel: 'legacy-model',
    openAiBaseUrl: 'https://legacy.example/v1',
    contextWindowTokens: 32_000,
  })
  assert.equal(stored.activeProvider, 'openai')
  assert.deepEqual(stored.providers.openai, {
    model: 'legacy-model', baseUrl: 'https://legacy.example/v1', contextWindowTokens: 32_000,
  })
  assert.deepEqual(decodeSecretsEnvelope('legacy-secret'), { openai: 'legacy-secret' })
})

test('new profiles have independent defaults, windows, and key state', () => {
  const stored = normalizeStoredModelSettings({
    model: { activeProvider: 'anthropic', providers: {
      openai: { model: 'gpt-custom', contextWindowTokens: 16_000 },
      anthropic: { baseUrl: 'https://claude.example' },
    } },
  })
  const result = toPublicProviderSettings(stored, { openai: 'openai-key' })
  assert.equal(result.openai.model, 'gpt-custom')
  assert.equal(result.openai.hasApiKey, true)
  assert.equal(result.anthropic.model, 'claude-sonnet-4-5')
  assert.equal(result.anthropic.contextWindowTokens, 200_000)
  assert.equal(result.anthropic.hasApiKey, false)
})

test('secret envelopes isolate providers and clearing one preserves the other', () => {
  const encoded = encodeSecretsEnvelope({ openai: 'openai-key', anthropic: 'anthropic-key' })
  const decoded = decodeSecretsEnvelope(encoded)
  assert.deepEqual(setProviderApiKey(decoded, 'anthropic', ''), { openai: 'openai-key' })
  assert.deepEqual(setProviderApiKey(decoded, 'openai', ''), { anthropic: 'anthropic-key' })
})

test('malformed envelope-shaped data and unknown keys are ignored safely', () => {
  assert.deepEqual(decodeSecretsEnvelope('{"version":1,"apiKeys":null}'), {})
  assert.deepEqual(decodeSecretsEnvelope('{"version":2,"apiKeys":{"openai":"x"}}'), {})
  assert.deepEqual(decodeSecretsEnvelope('{"version":1,"apiKeys":{"other":"x"}}'), {})
})
