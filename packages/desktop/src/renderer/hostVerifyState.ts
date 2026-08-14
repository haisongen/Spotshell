import type { HostVerifyClosed, HostVerifyRequest } from '../shared/ipc-types'

export function closeMatchingHostVerify(
  current: HostVerifyRequest | null,
  closed: HostVerifyClosed
): HostVerifyRequest | null {
  return current?.requestId === closed.requestId ? null : current
}
