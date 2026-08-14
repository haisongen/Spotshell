import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SSHClient, type SSHConnectionConfig } from '@spotshell/core'
import type { HostConnectionTestResult } from '../shared/ipc-types'
import { classifyConnectionError } from './connectionError'
import { resolveSshAgentSocket } from './sshAgent'

export interface HostConnectionProbeInput {
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  useAgent?: boolean
  hostVerifier?: SSHConnectionConfig['hostVerifier']
}

export interface ProbeClient {
  connect(config: SSHConnectionConfig): Promise<void>
  disconnect(): void
  destroy(): void
  on?(event: 'error', listener: (error: Error) => void): unknown
}

export interface ProbeOptions {
  clientFactory?: () => ProbeClient
  timeoutMs?: number
  readPrivateKey?: (keyPath: string) => Buffer
  now?: () => number
  resolveAgentSocket?: () => string | undefined
}

export function readPrivateKeyFile(keyPath: string): Buffer {
  const expanded = keyPath.startsWith('~')
    ? path.join(os.homedir(), keyPath.slice(1).replace(/^[\\/]/, ''))
    : keyPath

  if (!fs.existsSync(expanded)) {
    throw new Error(`Private key file not found: ${expanded}`)
  }

  try {
    return fs.readFileSync(expanded)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot read private key: ${expanded} (${message})`)
  }
}

export async function probeHostConnection(
  input: HostConnectionProbeInput,
  options: ProbeOptions = {}
): Promise<HostConnectionTestResult> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const timeoutMs = options.timeoutMs ?? 15_000
  let cleanupMode: 'disconnect' | 'destroy' = 'disconnect'
  let cleanedUp = false
  let timeout: NodeJS.Timeout | undefined
  let client: ProbeClient | undefined
  const ignoreClientError = (): void => undefined

  const cleanup = (): void => {
    if (!client || cleanedUp) return
    cleanedUp = true
    try {
      client[cleanupMode]()
    } catch {
      if (cleanupMode === 'disconnect') {
        try {
          client.destroy()
        } catch {
          // Ignore cleanup errors.
        }
      }
    }
  }

  try {
    client = (options.clientFactory ?? (() => new SSHClient()))()
    // SSHClient forwards errors through EventEmitter as well as rejecting connect().
    client.on?.('error', ignoreClientError)
    const privateKey = input.privateKeyPath
      ? (options.readPrivateKey ?? readPrivateKeyFile)(input.privateKeyPath)
      : undefined
    const agent = input.useAgent
      ? (options.resolveAgentSocket ?? resolveSshAgentSocket)()
      : undefined
    if (input.useAgent && !agent) {
      throw new Error('SSH agent is unavailable: SSH_AUTH_SOCK is not set')
    }
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        cleanupMode = 'destroy'
        cleanup()
        reject(new Error(`Connection timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      timeout.unref?.()
    })

    await Promise.race([
      client.connect({
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
        privateKey,
        agent,
        hostVerifier: input.hostVerifier,
      }),
      timedOut,
    ])

    return { ok: true, message: 'Connection successful', latencyMs: now() - startedAt }
  } catch (error) {
    return {
      ok: false,
      message: classifyConnectionError(error).message,
      latencyMs: now() - startedAt,
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    cleanup()
  }
}
