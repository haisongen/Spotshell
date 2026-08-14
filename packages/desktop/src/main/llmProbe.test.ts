import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ModelProvider, ModelProviderId } from '@spotshell/core'
import { testLlmConnection } from './llmProbe'

test('probe dispatches both providers with draft options and draft key precedence', async () => {
  const received: Array<Record<string, unknown>> = []
  const provider = (id: ModelProviderId): ModelProvider => ({
    id,
    defaultModel: id === 'openai' ? 'gpt-default' : 'claude-default',
    createChatModel: (config) => {
      received.push({ ...config })
      return new FakeListChatModel({ responses: [{ content: [{ type: 'text', text: 'pong' }] }] })
    },
    normalizeError: () => ({ kind: 'unknown', message: 'failed' }),
  })

  for (const id of ['openai', 'anthropic'] as const) {
    const result = await testLlmConnection({
      provider: id, apiKey: 'draft-key', model: `${id}-model`, baseUrl: `https://${id}.example`,
    }, {
      getProvider: provider,
      getSavedApiKey: () => 'saved-key',
    })
    assert.equal(result.ok, true)
    assert.equal(result.provider, id)
  }
  assert.deepEqual(received.map(({ provider: id, apiKey, baseURL, maxTokens, temperature }) => ({
    provider: id, apiKey, baseURL, maxTokens, temperature,
  })), [
    { provider: 'openai', apiKey: 'draft-key', baseURL: 'https://openai.example', maxTokens: 8, temperature: 0 },
    { provider: 'anthropic', apiKey: 'draft-key', baseURL: 'https://anthropic.example', maxTokens: 8, temperature: 0 },
  ])
})

test('probe only falls back to the selected provider saved key', async () => {
  const seenKeys: string[] = []
  const provider: ModelProvider = {
    id: 'anthropic',
    defaultModel: 'claude-default',
    createChatModel: (config) => {
      seenKeys.push(config.apiKey)
      return new FakeListChatModel({ responses: ['pong'] })
    },
    normalizeError: () => ({ kind: 'unknown', message: 'failed' }),
  }
  const ok = await testLlmConnection({ provider: 'anthropic' }, {
    getProvider: () => provider,
    getSavedApiKey: (id) => id === 'anthropic' ? 'anthropic-saved' : 'openai-saved',
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(seenKeys, ['anthropic-saved'])

  const missing = await testLlmConnection({ provider: 'anthropic' }, {
    getProvider: () => provider,
    getSavedApiKey: (id) => id === 'openai' ? 'openai-only' : undefined,
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.errorKind, 'authentication')
})

test('probe reports normalized errors without returning provider response bodies', async () => {
  const provider: ModelProvider = {
    id: 'openai',
    defaultModel: 'gpt-default',
    createChatModel: () => { throw new Error('secret response body') },
    normalizeError: () => ({ kind: 'rate-limit', message: 'Rate limited.', statusCode: 429 }),
  }
  const result = await testLlmConnection({ provider: 'openai', apiKey: 'key' }, {
    getProvider: () => provider,
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'rate-limit')
  assert.equal(result.statusCode, 429)
  assert.doesNotMatch(result.message, /secret response body/)
})

test('probe enforces its timeout even when a model ignores abort', async () => {
  const provider: ModelProvider = {
    id: 'openai',
    defaultModel: 'gpt-default',
    createChatModel: () => ({
      invoke: () => new Promise(() => undefined),
    }) as unknown as BaseChatModel,
    normalizeError: () => ({ kind: 'unknown', message: 'failed' }),
  }
  const result = await testLlmConnection({ provider: 'openai', apiKey: 'key' }, {
    getProvider: () => provider,
    timeoutMs: 5,
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'timeout')
})
