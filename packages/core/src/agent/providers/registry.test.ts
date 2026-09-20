import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONTEXT_WINDOW } from '../modelContext.js';
import { getModelProvider, parseModelProviderId } from './registry.js';

test('registry exposes fixed providers and their defaults', () => {
  assert.equal(getModelProvider('openai').defaultModel, 'gpt-4o-mini');
  assert.equal(getModelProvider('anthropic').defaultModel, 'claude-sonnet-4-5');
  assert.throws(() => parseModelProviderId('other'), /Unsupported model provider/);
});

test('providers normalize stable error classes', () => {
  const provider = getModelProvider('openai');
  assert.deepEqual(provider.normalizeError({ status: 401 }), {
    kind: 'authentication', message: 'The model provider rejected the API credentials.', statusCode: 401,
  });
  assert.equal(provider.normalizeError({ statusCode: 429 }).kind, 'rate-limit');
  assert.equal(provider.normalizeError({ code: 'ETIMEDOUT' }).kind, 'timeout');
  assert.equal(provider.normalizeError({ code: 'ENOTFOUND' }).kind, 'network');
  assert.equal(provider.normalizeError(new Error('model not found')).kind, 'model-not-found');
  assert.equal(provider.normalizeError(new Error('tool use is not supported')).kind, 'unsupported-tools');
});

test('OpenAI without a base URL resolves through the pi-ai built-in catalog', async () => {
  const resolved = await getModelProvider('openai').resolveModel({
    provider: 'openai', apiKey: 'openai-key', model: 'gpt-4o-mini', temperature: 0, maxTokens: 8,
  });
  assert.equal(resolved.model.id, 'gpt-4o-mini');
  assert.equal(resolved.model.provider, 'openai');
  assert.equal(resolved.model.api, 'openai-responses');
  assert.equal(resolved.model.baseUrl, 'https://api.openai.com/v1');
  assert.equal(resolved.model.contextWindow, 128_000);
  assert.equal(resolved.providerContextWindow, 128_000);
  assert.deepEqual(resolved.requestOptions, { apiKey: 'openai-key', temperature: 0, maxTokens: 8 });
  assert.equal(resolved.models.getProvider('openai')?.id, 'openai');
});

test('Anthropic without a base URL resolves through the pi-ai built-in catalog', async () => {
  const resolved = await getModelProvider('anthropic').resolveModel({
    provider: 'anthropic', apiKey: 'anthropic-key', model: 'claude-sonnet-4-5',
  });
  assert.equal(resolved.model.id, 'claude-sonnet-4-5');
  assert.equal(resolved.model.provider, 'anthropic');
  assert.equal(resolved.model.api, 'anthropic-messages');
  assert.equal(resolved.model.baseUrl, 'https://api.anthropic.com');
  assert.equal(resolved.providerContextWindow, resolved.model.contextWindow);
  assert.equal(resolved.model.contextWindow > 0, true);
  assert.deepEqual(resolved.requestOptions, { apiKey: 'anthropic-key' });
});

test('a model the built-in catalog does not list still targets the official endpoint', async () => {
  const resolved = await getModelProvider('openai').resolveModel({
    provider: 'openai', apiKey: 'openai-key', model: 'gpt-released-after-this-catalog',
  });
  assert.equal(resolved.model.id, 'gpt-released-after-this-catalog');
  assert.equal(resolved.model.api, 'openai-responses');
  assert.equal(resolved.model.baseUrl, 'https://api.openai.com/v1');
  assert.equal(resolved.model.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolved.providerContextWindow, undefined);
});

test('OpenAI with a base URL builds a custom openai-completions provider', async () => {
  const resolved = await getModelProvider('openai').resolveModel({
    provider: 'openai', apiKey: 'proxy-key', model: 'deepseek-chat',
    baseURL: 'https://llm.example/v1', temperature: 0, maxTokens: 8,
  });
  assert.equal(resolved.model.id, 'deepseek-chat');
  assert.equal(resolved.model.provider, 'openai');
  assert.equal(resolved.model.api, 'openai-completions');
  assert.equal(resolved.model.baseUrl, 'https://llm.example/v1');
  // No catalog entry exists, so modelContext.ts supplies the context window.
  assert.equal(resolved.model.contextWindow, 65_536);
  assert.equal(resolved.providerContextWindow, undefined);
  assert.equal(resolved.model.maxTokens, 8_192);
  assert.equal(resolved.models.getProvider('openai')?.baseUrl, 'https://llm.example/v1');
  assert.equal(resolved.models.getModel('openai', 'deepseek-chat')?.api, 'openai-completions');
});

test('Anthropic with a base URL builds a custom anthropic-messages provider', async () => {
  const resolved = await getModelProvider('anthropic').resolveModel({
    provider: 'anthropic', apiKey: 'proxy-key', model: 'claude-custom',
    baseURL: 'https://anthropic.example',
  });
  assert.equal(resolved.model.id, 'claude-custom');
  assert.equal(resolved.model.provider, 'anthropic');
  assert.equal(resolved.model.api, 'anthropic-messages');
  assert.equal(resolved.model.baseUrl, 'https://anthropic.example');
  assert.equal(resolved.model.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolved.providerContextWindow, undefined);
  assert.equal(resolved.models.getModel('anthropic', 'claude-custom')?.baseUrl, 'https://anthropic.example');
});

test('resolveModel rejects a missing API key on both paths', () => {
  for (const id of ['openai', 'anthropic'] as const) {
    assert.throws(
      () => getModelProvider(id).resolveModel({ provider: id, apiKey: '  ', model: 'x' }),
      /no API key/,
    );
    assert.throws(
      () => getModelProvider(id).resolveModel({ provider: id, apiKey: '', model: 'x', baseURL: 'https://x.example' }),
      /no API key/,
    );
  }
});

test('a custom endpoint resolves only the configured key, never ambient environment keys', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-ambient-must-not-be-used';
  try {
    const resolved = await getModelProvider('openai').resolveModel({
      provider: 'openai', apiKey: 'proxy-key', model: 'm', baseURL: 'https://llm.example/v1',
    });
    assert.equal(await resolved.models.getAuth('openai'), undefined);
    const withRequestKey = await resolved.models.getAuth('openai', { apiKey: 'proxy-key' });
    assert.equal(withRequestKey?.auth.apiKey, 'proxy-key');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
