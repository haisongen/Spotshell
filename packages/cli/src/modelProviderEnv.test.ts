import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelProviderEnv } from './modelProviderEnv.js';

test('defaults to the legacy OpenAI environment contract', () => {
  assert.deepEqual(parseModelProviderEnv({ OPENAI_API_KEY: 'openai-key' }), {
    provider: 'openai', apiKey: 'openai-key', baseURL: undefined, model: 'gpt-4o-mini',
  });
});

test('Anthropic reads only ANTHROPIC variables', () => {
  assert.deepEqual(parseModelProviderEnv({
    SPOTSHELL_MODEL_PROVIDER: 'anthropic',
    OPENAI_API_KEY: 'must-not-leak',
    ANTHROPIC_API_KEY: 'anthropic-key',
    ANTHROPIC_BASE_URL: 'https://anthropic.example',
    ANTHROPIC_MODEL: 'claude-custom',
  }), {
    provider: 'anthropic', apiKey: 'anthropic-key', baseURL: 'https://anthropic.example', model: 'claude-custom',
  });
});

test('rejects unknown providers before SSH startup', () => {
  assert.throws(
    () => parseModelProviderEnv({ SPOTSHELL_MODEL_PROVIDER: 'unknown' }),
    /Invalid SPOTSHELL_MODEL_PROVIDER/,
  );
});
