import type { ConnectionErrorKind } from '../shared/ipc-types'

export interface ClassifiedConnectionError {
  kind: ConnectionErrorKind
  message: string
}

const codeKinds: Readonly<Record<string, ConnectionErrorKind>> = {
  ETIMEDOUT: 'network-timeout',
  EHOSTUNREACH: 'network-timeout',
  ENETUNREACH: 'network-timeout',
  ECONNREFUSED: 'connection-refused',
  ENOTFOUND: 'host-not-found',
  EAI_AGAIN: 'host-not-found',
  ECONNRESET: 'connection-reset',
}

const unknownMessage = 'Unknown SSH connection error'

function readProperty(value: unknown, property: 'cause' | 'code' | 'message'): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const record = value as Record<string, unknown>
    return property in record ? record[property] : undefined
  } catch {
    return undefined
  }
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<object>()
  let current: unknown = error

  while (chain.length < 8) {
    chain.push(current)
    if (typeof current !== 'object' || current === null || seen.has(current)) break
    seen.add(current)
    const cause = readProperty(current, 'cause')
    if (cause === undefined) break
    current = cause
  }

  return chain
}

function readCode(error: unknown): string | undefined {
  let firstCode: string | undefined
  for (const item of errorChain(error)) {
    const code = readProperty(item, 'code')
    if (typeof code !== 'string') continue
    const normalized = code.toUpperCase()
    if (codeKinds[normalized]) return normalized
    firstCode ??= normalized
  }
  return firstCode
}

function classifyMessage(message: string): ConnectionErrorKind {
  if (/^Error invoking remote method\b/i.test(message)) return 'unknown'
  if (/timed out while waiting for handshake/i.test(message)) return 'handshake-timeout'
  if (/\b(?:ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/i.test(message)) return 'network-timeout'
  if (/\bECONNREFUSED\b/i.test(message)) return 'connection-refused'
  if (/\b(?:ENOTFOUND|EAI_AGAIN)\b/i.test(message)) return 'host-not-found'
  if (/(?:authentication (?:failed|failure)|unable to authenticate|permission denied|configured authentication methods failed)/i.test(message)) {
    return 'authentication-failed'
  }
  if (/(?:host key|fingerprint).*(?:reject|refus|changed|verification failed)|\u4e3b\u673a\u6307\u7eb9.*(?:\u53d8\u5316|\u62d2\u7edd)/i.test(message)) {
    return 'host-key-rejected'
  }
  if (/(?:private key file not found|cannot read private key)/i.test(message)) return 'key-file-error'
  if (/(?:\bECONNRESET\b|connection reset|socket closed)/i.test(message)) return 'connection-reset'
  return 'unknown'
}

function readMessage(error: unknown): string {
  for (const item of errorChain(error)) {
    const value = typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || typeof item === 'bigint'
      ? String(item)
      : readProperty(item, 'message')
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return unknownMessage
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[REDACTED]')
    .replace(
      /((?:["']?)(?:password|passphrase|privateKey)(?:["']?)\s*[:=]\s*)(["'])[^"']*\2/gi,
      '$1$2[REDACTED]$2'
    )
    .replace(
      /((?:["']?)(?:password|passphrase|privateKey)(?:["']?)\s*[:=]\s*)[^\s,;}\]]+/gi,
      '$1[REDACTED]'
    )
}

export function classifyConnectionError(error: unknown): ClassifiedConnectionError {
  const message = readMessage(error)
  const code = readCode(error)
  return {
    kind: code ? (codeKinds[code] ?? 'unknown') : classifyMessage(message),
    message: sanitizeMessage(message),
  }
}
