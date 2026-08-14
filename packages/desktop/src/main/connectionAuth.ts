import type { HostProfile, SSHConnectionConfig } from '@spotshell/core'
import type { ConnectRequest } from '../shared/ipc-types'

type ConnectionAuthentication = Pick<SSHConnectionConfig, 'password' | 'privateKey' | 'agent'>

type SavedHostIdentity = Pick<HostProfile, 'id' | 'host' | 'port' | 'username'>

export function assertSavedHostIdentity(
  request: Pick<ConnectRequest, 'hostId' | 'host' | 'port' | 'username'>,
  savedHost: SavedHostIdentity | undefined,
): void {
  if (!request.hostId) return
  if (!savedHost) throw new Error(`Saved host not found: ${request.hostId}`)
  if (
    savedHost.id !== request.hostId
    || savedHost.host !== request.host
    || savedHost.port !== request.port
    || savedHost.username !== request.username
  ) {
    throw new Error(`Connection does not match saved host: ${request.hostId}`)
  }
}

export function resolveConnectionAuthentication(
  request: Pick<ConnectRequest, 'password' | 'privateKeyPath' | 'useAgent'>,
  readPrivateKey: (keyPath: string) => Buffer,
  requireAgentSocket: () => string,
): ConnectionAuthentication {
  if (request.useAgent) {
    return { password: undefined, privateKey: undefined, agent: requireAgentSocket() }
  }
  return {
    password: request.password,
    privateKey: request.privateKeyPath ? readPrivateKey(request.privateKeyPath) : undefined,
    agent: undefined,
  }
}
