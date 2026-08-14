import type { ModelProviderErrorInfo, ModelProviderErrorKind } from './types.js';

interface StructuredError {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

const SAFE_MESSAGES: Record<ModelProviderErrorKind, string> = {
  authentication: 'The model provider rejected the API credentials.',
  'rate-limit': 'The model provider rate limit was reached.',
  'model-not-found': 'The requested model was not found.',
  timeout: 'The model provider request timed out.',
  network: 'The model provider could not be reached.',
  'unsupported-tools': 'The selected model does not support tool calling.',
  unknown: 'The model provider request failed.',
};

export function normalizeProviderError(error: unknown): ModelProviderErrorInfo {
  const value = isObject(error) ? error as StructuredError : {};
  const cause = isObject(value.cause) ? value.cause as StructuredError : {};
  const statusCode = toStatusCode(value.statusCode ?? value.status ?? cause.statusCode ?? cause.status);
  const code = String(value.code ?? cause.code ?? '').toLowerCase();
  const message = String(value.message ?? (error instanceof Error ? error.message : '')).toLowerCase();

  let kind: ModelProviderErrorKind = 'unknown';
  if (statusCode === 401 || statusCode === 403 || hasAny(code, message, ['authentication', 'invalid_api_key', 'unauthorized'])) {
    kind = 'authentication';
  } else if (statusCode === 429 || hasAny(code, message, ['rate_limit', 'rate limit'])) {
    kind = 'rate-limit';
  } else if (statusCode === 404 || hasAny(code, message, ['model_not_found', 'model not found', 'does not exist'])) {
    kind = 'model-not-found';
  } else if (hasAny(code, message, ['timeout', 'timed out', 'etimedout', 'aborterror'])) {
    kind = 'timeout';
  } else if (hasAny(code, message, ['econnrefused', 'econnreset', 'enotfound', 'network', 'fetch failed'])) {
    kind = 'network';
  } else if (hasAny(code, message, ['unsupported_tools', 'tool use is not supported', 'does not support tools'])) {
    kind = 'unsupported-tools';
  }

  return {
    kind,
    message: SAFE_MESSAGES[kind],
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function toStatusCode(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

function hasAny(code: string, message: string, needles: readonly string[]): boolean {
  return needles.some((needle) => code.includes(needle) || message.includes(needle));
}
