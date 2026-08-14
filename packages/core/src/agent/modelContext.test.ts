import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  DEFAULT_CONTEXT_WINDOW,
  lookupKnownModelContextWindow,
  normalizeContextWindow,
  resolveContextWindow,
} from './modelContext.js';

describe('model context window', () => {
  it('prefills known model windows case-insensitively', () => {
    assert.equal(lookupKnownModelContextWindow('gpt-4o-mini'), 128_000);
    assert.equal(lookupKnownModelContextWindow('GPT-4O'), 128_000);
    assert.equal(lookupKnownModelContextWindow('claude-3-5-sonnet'), 200_000);
    assert.equal(lookupKnownModelContextWindow('claude-sonnet-4-5'), 200_000);
    assert.equal(lookupKnownModelContextWindow('totally-custom-model'), undefined);
  });

  it('accepts positive integers inside the configured range', () => {
    assert.equal(normalizeContextWindow(8192), 8192);
    assert.equal(normalizeContextWindow(CONTEXT_WINDOW_MIN), CONTEXT_WINDOW_MIN);
    assert.equal(normalizeContextWindow(CONTEXT_WINDOW_MAX), CONTEXT_WINDOW_MAX);
  });

  it('rejects zero, negatives, non-integers, and out-of-range values', () => {
    assert.equal(normalizeContextWindow(0), undefined);
    assert.equal(normalizeContextWindow(-1), undefined);
    assert.equal(normalizeContextWindow(12.5), undefined);
    assert.equal(normalizeContextWindow(CONTEXT_WINDOW_MIN - 1), undefined);
    assert.equal(normalizeContextWindow(CONTEXT_WINDOW_MAX + 1), undefined);
    assert.equal(normalizeContextWindow(Number.NaN), undefined);
  });

  it('resolves explicit config first, then known model prefill, then default', () => {
    assert.equal(resolveContextWindow({ contextWindowTokens: 32_000, model: 'gpt-4o' }), 32_000);
    assert.equal(resolveContextWindow({ model: 'gpt-4o-mini' }), 128_000);
    assert.equal(resolveContextWindow({ model: 'custom-x' }), DEFAULT_CONTEXT_WINDOW);
    assert.equal(resolveContextWindow({}), DEFAULT_CONTEXT_WINDOW);
  });
});
