import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ModelProvider,
  ModelProviderConfig,
  ModelProviderId,
  ResolvedModel,
} from '@spotshell/core'
import { testLlmConnection } from './llmProbe'

type Assistant = Awaited<ReturnType<ResolvedModel['models']['complete']>>

interface FakeModelsOptions {
  complete?: (options: Record<string, unknown> | undefined) => Promise<Assistant>
}

function assistant(overrides: Partial<Assistant> = {}): Assistant {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'openai',
    model: 'fake',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  } as Assistant
}

/** Minimal stand-in for a pi-ai `Models`; the probe only ever calls `complete`. */
function fakeResolved(
  config: ModelProviderConfig,
  options: FakeModelsOptions = {},
): Promise<ResolvedModel> {
  const complete = options.complete ?? (async () => assistant())
  return Promise.resolve({
    model: { id: config.model } as ResolvedModel['model'],
    models: {
      complete: (_model: unknown, _context: unknown, requestOptions?: Record<string, unknown>) =>
        complete(requestOptions),
    } as unknown as ResolvedModel['models'],
    requestOptions: {
      apiKey: config.apiKey,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    },
  })
}

test('probe dispatches both providers with draft options and draft key precedence', async () => {
  const received: Array<Record<string, unknown>> = []
  const provider = (id: ModelProviderId): ModelProvider => ({
    id,
    defaultModel: id === 'openai' ? 'gpt-default' : 'claude-default',
    resolveModel: (config) => {
      received.push({ ...config })
      return fakeResolved(config)
    },
    normalizeError: () => ({ kind: 'unknown', message: 'failed' }),
    normalizeAssistantFailure: () => ({ kind: 'unknown', message: 'failed' }),
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

test('probe forwards the resolved request options and an abort signal to pi-ai', async () => {
  const seen: Array<Record<string, unknown> | undefined> = []
  const provider: ModelProvider = {
    id: 'openai',
    defaultModel: 'gpt-default',
    resolveModel: (config) => fakeResolved(config, {
      complete: async (options) => {
        seen.push(options)
        return assistant()
      },
    }),
    normalizeError: () => ({ kind: 'unknown', message: 'failed' }),
    normalizeAssistantFailure: () => ({ kind: 'unknown', message: 'failed' }),
  }
  const result = await testLlmConnection({ provider: 'openai', apiKey: 'key' }, {
    getProvider: () => provider,
  })
  assert.equal(result.ok, true)
  assert.equal(seen[0]?.apiKey, 'key')
  assert.equal(seen[0]?.temperature, 0)
  assert.equal(seen[0]?.maxTokens, 8)
  assert.equal(seen[0]?.signal instanceof AbortSignal, true)
})

test('probe only falls back to the selected provider saved key', async () => {
  const seenKeys: string[] = []
  const provider: ModelProvider = {
    id: 'anthropic',
    defaultModel: 'claude-default',
    resolveModel: (config) => {
      seenKeys.push(config.apiKey)
      return fakeResolved(config)
    },
    normalizeError: () => ({ kind: 'unknown', message: 'failed' }),
    normalizeAssistantFailure: () => ({ kind: 'unknown', message: 'failed' }),
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
    resolveModel: () => Promise.reject(new Error('secret response body')),
    normalizeError: () => ({ kind: 'rate-limit', message: 'Rate limited.', statusCode: 429 }),
    normalizeAssistantFailure: () => ({ kind: 'unknown', message: 'failed' }),
  }
  const result = await testLlmConnection({ provider: 'openai', apiKey: 'key' }, {
    getProvider: () => provider,
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'rate-limit')
  assert.equal(result.statusCode, 429)
  assert.doesNotMatch(result.message, /secret response body/)
})

test('probe normalizes a failed assistant message instead of treating it as success', async () => {
  const provider: ModelProvider = {
    id: 'openai',
    defaultModel: 'gpt-default',
    resolveModel: (config) => fakeResolved(config, {
      complete: async () => assistant({
        stopReason: 'error',
        errorMessage: 'OpenAI API error (401): Incorrect API key provided: sk-live-secret',
      }),
    }),
    normalizeError: () => ({ kind: 'unknown', message: 'failed' }),
    normalizeAssistantFailure: (message) => {
      assert.equal(message.stopReason, 'error')
      return {
        kind: 'authentication',
        message: 'The model provider rejected the API credentials.',
        statusCode: 401,
      }
    },
  }
  const result = await testLlmConnection({ provider: 'openai', apiKey: 'key' }, {
    getProvider: () => provider,
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'authentication')
  assert.equal(result.statusCode, 401)
  assert.doesNotMatch(result.message, /sk-live-secret/)
})

test('probe enforces its timeout even when a model ignores abort', async () => {
  const provider: ModelProvider = {
    id: 'openai',
    defaultModel: 'gpt-default',
    resolveModel: (config) => fakeResolved(config, {
      complete: () => new Promise<Assistant>(() => undefined),
    }),
    normalizeError: () => ({ kind: 'unknown', message: 'failed' }),
    normalizeAssistantFailure: () => ({ kind: 'unknown', message: 'failed' }),
  }
  const result = await testLlmConnection({ provider: 'openai', apiKey: 'key' }, {
    getProvider: () => provider,
    timeoutMs: 5,
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'timeout')
})
