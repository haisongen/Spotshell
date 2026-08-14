import type { HostProfile } from '@spotshell/core'
import type { HostConnectionTestDraft } from '../shared/ipc-types'
import type { HostConnectionProbeInput } from './hostConnectionProbe'

export type HostTestResolution =
  | { ok: true; input: HostConnectionProbeInput }
  | { ok: false; message: string }

export function resolveHostTestRequest(
  savedHost: HostProfile,
  draft: HostConnectionTestDraft | undefined,
  savedPassword: string | undefined
): HostTestResolution {
  if (!draft) {
    if (savedHost.authMethod === 'password' && !savedPassword) {
      return { ok: false, message: 'No saved password. Edit this host and save a password before testing.' }
    }
    if (savedHost.authMethod === 'agent') {
      return { ok: true, input: { host: savedHost.host, port: savedHost.port, username: savedHost.username, useAgent: true } }
    }
    if (savedHost.authMethod === 'key') {
      return {
        ok: true,
        input: {
          host: savedHost.host, port: savedHost.port, username: savedHost.username,
          privateKeyPath: savedHost.privateKeyPath,
        },
      }
    }
    return {
      ok: true,
      input: {
        host: savedHost.host,
        port: savedHost.port,
        username: savedHost.username,
        password: savedPassword,
        privateKeyPath: savedHost.privateKeyPath,
      },
    }
  }

  const base = { host: draft.host, port: draft.port, username: draft.username }
  if (draft.authMethod === 'password') {
    const password = draft.password || (draft.useSavedPassword ? savedPassword : undefined)
    if (!password) {
      return { ok: false, message: 'A password is required to test this connection.' }
    }
    return { ok: true, input: { ...base, password } }
  }
  if (draft.authMethod === 'key') {
    if (!draft.privateKeyPath) {
      return { ok: false, message: 'A private key path is required to test this connection.' }
    }
    return { ok: true, input: { ...base, privateKeyPath: draft.privateKeyPath } }
  }
  return { ok: true, input: { ...base, useAgent: true } }
}
