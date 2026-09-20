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

  it('uses a provider-reported window only for models the prefill table does not know', () => {
    // User config still wins over everything.
    assert.equal(
      resolveContextWindow({ contextWindowTokens: 32_000, model: 'gpt-4o', providerContextWindow: 400_000 }),
      32_000,
    );
    // A known model keeps its prefill value: a catalog entry reports the model's
    // maximum window, which may need an opt-in request header SpotShell never
    // sends. See the priority note on resolveContextWindow.
    assert.equal(resolveContextWindow({ model: 'gpt-4o', providerContextWindow: 400_000 }), 128_000);
    // Unknown models still beat a blind default by trusting the catalog.
    assert.equal(resolveContextWindow({ model: 'unknown-model', providerContextWindow: 400_000 }), 400_000);
    assert.equal(resolveContextWindow({ providerContextWindow: 400_000 }), 400_000);
  });

  it('keeps the prefill table ahead of a catalog window that needs an opt-in header', () => {
    // pi-ai lists claude-sonnet-4-5 at 1,000,000 tokens, reachable only with the
    // context-1m beta. The effective window without it is the prefill's 200,000.
    assert.equal(
      resolveContextWindow({ model: 'claude-sonnet-4-5', providerContextWindow: 1_000_000 }),
      200_000,
    );
  });

  it('applies the same bounds check to a provider-reported window', () => {
    assert.equal(
      resolveContextWindow({ model: 'gpt-4o', providerContextWindow: CONTEXT_WINDOW_MAX + 1 }),
      128_000,
    );
    assert.equal(
      resolveContextWindow({ model: 'gpt-4o', providerContextWindow: CONTEXT_WINDOW_MIN - 1 }),
      128_000,
    );
    assert.equal(resolveContextWindow({ providerContextWindow: 12.5 }), DEFAULT_CONTEXT_WINDOW);
    assert.equal(resolveContextWindow({ providerContextWindow: Number.NaN }), DEFAULT_CONTEXT_WINDOW);
  });
});
