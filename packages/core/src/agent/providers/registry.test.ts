import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { AnthropicModelProvider } from './anthropicProvider.js';
import { OpenAIModelProvider } from './openaiProvider.js';
import { getModelProvider, parseModelProviderId } from './registry.js';

test('registry exposes fixed providers and their defaults', () => {
  assert.equal(getModelProvider('openai').defaultModel, 'gpt-4o-mini');
  assert.equal(getModelProvider('anthropic').defaultModel, 'claude-sonnet-4-5');
  assert.throws(() => parseModelProviderId('other'), /Unsupported model provider/);
});

test('OpenAI maps model options and compatible base URL', () => {
  let fields: ConstructorParameters<typeof import('@langchain/openai').ChatOpenAI>[0];
  const provider = new OpenAIModelProvider((input) => {
    fields = input;
    return new FakeListChatModel({ responses: ['ok'] });
  });
  provider.createChatModel({
    provider: 'openai', apiKey: 'openai-key', model: 'custom', baseURL: 'https://llm.example/v1',
    temperature: 0, maxTokens: 8,
  });
  assert.equal(fields!.apiKey, 'openai-key');
  assert.equal(fields!.model, 'custom');
  assert.equal(fields!.configuration?.baseURL, 'https://llm.example/v1');
  assert.equal(fields!.maxTokens, 8);
});

test('Anthropic maps API key and native client base URL', () => {
  let fields: ConstructorParameters<typeof import('@langchain/anthropic').ChatAnthropic>[0];
  const provider = new AnthropicModelProvider((input) => {
    fields = input;
    return new FakeListChatModel({ responses: ['ok'] });
  });
  provider.createChatModel({
    provider: 'anthropic', apiKey: 'anthropic-key', model: 'claude-custom',
    baseURL: 'https://anthropic.example', temperature: 0, maxTokens: 8,
  });
  assert.equal(fields!.apiKey, 'anthropic-key');
  assert.equal(fields!.model, 'claude-custom');
  assert.equal(fields!.clientOptions?.baseURL, 'https://anthropic.example');
});

test('providers reject missing keys and normalize stable error classes', () => {
  const provider = getModelProvider('openai');
  assert.throws(() => provider.createChatModel({ provider: 'openai', apiKey: '', model: 'x' }), /no API key/);
  assert.deepEqual(provider.normalizeError({ status: 401 }), {
    kind: 'authentication', message: 'The model provider rejected the API credentials.', statusCode: 401,
  });
  assert.equal(provider.normalizeError({ statusCode: 429 }).kind, 'rate-limit');
  assert.equal(provider.normalizeError({ code: 'ETIMEDOUT' }).kind, 'timeout');
  assert.equal(provider.normalizeError({ code: 'ENOTFOUND' }).kind, 'network');
  assert.equal(provider.normalizeError(new Error('model not found')).kind, 'model-not-found');
  assert.equal(provider.normalizeError(new Error('tool use is not supported')).kind, 'unsupported-tools');
});
