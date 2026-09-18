import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessage, StopReason } from '@earendil-works/pi-ai';
import { normalizeAssistantFailure } from './errorNormalization.js';
import type { ModelProviderErrorKind } from './types.js';

/**
 * The redaction contract: every kind maps to a fixed sentence, and nothing the
 * provider wrote ever reaches the caller. Duplicated here on purpose so a change
 * to `SAFE_MESSAGES` fails this test instead of silently reshaping the UI.
 */
const SAFE_MESSAGES: Record<ModelProviderErrorKind, string> = {
  authentication: 'The model provider rejected the API credentials.',
  'rate-limit': 'The model provider rate limit was reached.',
  'model-not-found': 'The requested model was not found.',
  timeout: 'The model provider request timed out.',
  network: 'The model provider could not be reached.',
  'unsupported-tools': 'The selected model does not support tool calling.',
  unknown: 'The model provider request failed.',
};

function failure(
  overrides: Partial<AssistantMessage> & { stopReason?: StopReason },
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    timestamp: 0,
    ...overrides,
  };
}

const CASES: ReadonlyArray<{
  kind: ModelProviderErrorKind;
  errorMessage: string;
  statusCode?: number;
  diagnostics?: AssistantMessage['diagnostics'];
}> = [
  {
    kind: 'authentication',
    errorMessage: 'OpenAI API error (401): {"error":{"message":"Incorrect API key provided: sk-live-abc123"}}',
    statusCode: 401,
  },
  {
    kind: 'rate-limit',
    errorMessage: 'Anthropic API error (429): {"type":"rate_limit_error"}',
    statusCode: 429,
  },
  {
    kind: 'model-not-found',
    errorMessage: '404 The model `gpt-9-imaginary` does not exist or you do not have access to it.',
    statusCode: 404,
  },
  {
    kind: 'timeout',
    errorMessage: 'Connection error: the request timed out after 600000ms',
  },
  {
    kind: 'network',
    errorMessage: 'fetch failed',
    diagnostics: [
      {
        type: 'provider_transport_failure',
        timestamp: 0,
        error: { name: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:11434', code: 'ECONNREFUSED' },
      },
    ],
  },
  {
    kind: 'unsupported-tools',
    errorMessage: 'Bad request: tool use is not supported for this model',
  },
  {
    kind: 'unknown',
    errorMessage: 'Provider stopped with: sensitive',
  },
];

test('normalizeAssistantFailure classifies every provider error kind', () => {
  for (const testCase of CASES) {
    const info = normalizeAssistantFailure(
      failure({ errorMessage: testCase.errorMessage, diagnostics: testCase.diagnostics }),
    );
    assert.equal(info.kind, testCase.kind, `kind for: ${testCase.errorMessage}`);
    assert.equal(info.message, SAFE_MESSAGES[testCase.kind]);
    assert.equal(info.statusCode, testCase.statusCode);
  }
  // Every kind in the union has a case above.
  assert.deepEqual(
    [...CASES.map((entry) => entry.kind)].sort(),
    (Object.keys(SAFE_MESSAGES) as ModelProviderErrorKind[]).sort(),
  );
});

test('normalizeAssistantFailure never leaks provider text or credential fragments', () => {
  for (const testCase of CASES) {
    const info = normalizeAssistantFailure(failure({ errorMessage: testCase.errorMessage }));
    assert.equal(Object.keys(info).every((key) => ['kind', 'message', 'statusCode'].includes(key)), true);
    assert.equal(info.message, SAFE_MESSAGES[info.kind]);
    assert.doesNotMatch(info.message, /sk-live-abc123/);
    assert.doesNotMatch(info.message, /gpt-9-imaginary/);
    assert.doesNotMatch(info.message, /127\.0\.0\.1/);
  }
});

test('normalizeAssistantFailure reads an HTTP status out of diagnostics details', () => {
  const info = normalizeAssistantFailure(
    failure({
      errorMessage: 'Upstream gateway rejected the request',
      diagnostics: [{ type: 'provider_response_failure', timestamp: 0, details: { status: 403 } }],
    }),
  );
  assert.equal(info.kind, 'authentication');
  assert.equal(info.statusCode, 403);
});

test('normalizeAssistantFailure treats an abort with no provider text as a timeout', () => {
  const info = normalizeAssistantFailure(failure({ stopReason: 'aborted' }));
  assert.equal(info.kind, 'timeout');
  assert.equal(info.message, SAFE_MESSAGES.timeout);
  assert.equal(info.statusCode, undefined);
});

test('normalizeAssistantFailure ignores three-digit numbers that are not a status', () => {
  const info = normalizeAssistantFailure(
    failure({ errorMessage: 'Provider returned an unparseable payload of 512 bytes' }),
  );
  assert.equal(info.kind, 'unknown');
  assert.equal(info.statusCode, undefined);
});
