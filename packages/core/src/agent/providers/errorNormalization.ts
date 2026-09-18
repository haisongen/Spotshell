import type { AssistantMessage, AssistantMessageDiagnostic } from '@earendil-works/pi-ai';
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

  return describe(classifyKind(statusCode, code, message), statusCode);
}

/**
 * pi-ai never throws for request failures: the final `AssistantMessage` carries
 * `stopReason: 'error' | 'aborted'` plus `errorMessage` and `diagnostics`. This
 * is the pi-ai counterpart of `normalizeProviderError` and shares its keyword
 * table, so both entry points collapse to the same `ModelProviderErrorKind` and
 * the same redacted text.
 */
export function normalizeAssistantFailure(message: AssistantMessage): ModelProviderErrorInfo {
  const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
  const text = [message.errorMessage ?? '', ...diagnostics.map(diagnosticText)]
    .join(' ')
    .toLowerCase();
  const code = diagnostics
    .map((entry) => String(entry.error?.code ?? ''))
    .join(' ')
    .toLowerCase();
  const statusCode = diagnosticStatusCode(diagnostics) ?? statusCodeFromText(message.errorMessage);

  let kind = classifyKind(statusCode, code, text);
  // An aborted request is a deadline the caller imposed; the existing keyword
  // table already maps `AbortError` to `timeout`, so stay consistent when the
  // provider gave us no text to match on.
  if (kind === 'unknown' && message.stopReason === 'aborted') kind = 'timeout';

  return describe(kind, statusCode);
}

function describe(kind: ModelProviderErrorKind, statusCode: number | undefined): ModelProviderErrorInfo {
  return {
    kind,
    message: SAFE_MESSAGES[kind],
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

/** Shared classification. `code` and `message` must already be lower-cased. */
function classifyKind(
  statusCode: number | undefined,
  code: string,
  message: string,
): ModelProviderErrorKind {
  if (statusCode === 401 || statusCode === 403 || hasAny(code, message, ['authentication', 'invalid_api_key', 'unauthorized'])) {
    return 'authentication';
  }
  if (statusCode === 429 || hasAny(code, message, ['rate_limit', 'rate limit'])) {
    return 'rate-limit';
  }
  if (statusCode === 404 || hasAny(code, message, ['model_not_found', 'model not found', 'does not exist'])) {
    return 'model-not-found';
  }
  if (hasAny(code, message, ['timeout', 'timed out', 'etimedout', 'aborterror'])) {
    return 'timeout';
  }
  if (hasAny(code, message, ['econnrefused', 'econnreset', 'enotfound', 'network', 'fetch failed'])) {
    return 'network';
  }
  if (hasAny(code, message, ['unsupported_tools', 'tool use is not supported', 'does not support tools'])) {
    return 'unsupported-tools';
  }
  return 'unknown';
}

function diagnosticText(entry: AssistantMessageDiagnostic): string {
  return [entry.type ?? '', entry.error?.name ?? '', entry.error?.message ?? ''].join(' ');
}

function diagnosticStatusCode(diagnostics: readonly AssistantMessageDiagnostic[]): number | undefined {
  for (const entry of diagnostics) {
    const details = isObject(entry.details) ? entry.details as Record<string, unknown> : {};
    const status = toStatusCode(details.statusCode ?? details.status ?? entry.error?.code);
    if (status !== undefined) return status;
  }
  return undefined;
}

/**
 * pi-ai composes provider failures as `"<prefix> (<status>): <body>"`, or lets
 * the SDK message through (`"401 Incorrect API key provided: ..."`). Only those
 * shapes are probed so an arbitrary three-digit number inside a response body
 * cannot be mistaken for an HTTP status.
 */
function statusCodeFromText(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const patterns = [/\((\d{3})\)/, /^\s*(\d{3})\b/, /status(?:\s+code)?[:\s]+(\d{3})\b/i];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const status = match ? toStatusCode(match[1]) : undefined;
    if (status !== undefined) return status;
  }
  return undefined;
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
