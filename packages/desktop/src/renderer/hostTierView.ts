import type { SavedHostProfile, SessionSummary } from '../shared/ipc-types'
import type { HostTier } from '../shared/hostTier'

export { HOST_TIERS, isHostTier } from '../shared/hostTier'
export type { HostTier }

type TierLabelKey = 'tierProduction' | 'tierStaging' | 'tierTesting' | 'tierDevelopment'

const LABEL_KEYS: Record<HostTier, TierLabelKey> = {
  production: 'tierProduction',
  staging: 'tierStaging',
  testing: 'tierTesting',
  development: 'tierDevelopment',
}

type TierShortLabelKey =
  | 'tierShortProduction'
  | 'tierShortStaging'
  | 'tierShortTesting'
  | 'tierShortDevelopment'

const SHORT_LABEL_KEYS: Record<HostTier, TierShortLabelKey> = {
  production: 'tierShortProduction',
  staging: 'tierShortStaging',
  testing: 'tierShortTesting',
  development: 'tierShortDevelopment',
}

export function hostTierLabelKey(tier: HostTier): TierLabelKey {
  return LABEL_KEYS[tier]
}

export function hostTierShortLabelKey(tier: HostTier): TierShortLabelKey {
  return SHORT_LABEL_KEYS[tier]
}

/** CSS modifier shared by every tier cue (`tier-production`, …). */
export function hostTierClass(tier: HostTier | undefined): string {
  return tier ? `tier-${tier}` : ''
}

/** What an approval is about to act on, as shown to the user. */
export interface SessionTarget {
  title: string
  /** `user@host:port` of the saved host; absent for quick-connect sessions. */
  address?: string
  tier?: HostTier
}

type TargetHost = Pick<SavedHostProfile, 'id' | 'tier' | 'username' | 'host' | 'port'>

export function describeSessionTarget(
  session: Pick<SessionSummary, 'hostId' | 'title'> | null | undefined,
  hosts: ReadonlyArray<TargetHost> | null | undefined,
): SessionTarget | null {
  if (!session) return null
  const host = session.hostId ? hosts?.find((entry) => entry.id === session.hostId) : undefined
  if (!host) return { title: session.title }
  return {
    title: session.title,
    address: `${host.username}@${host.host}:${host.port}`,
    tier: host.tier,
  }
}

/**
 * Tier of the saved host a session was opened from. Quick-connect sessions and
 * sessions whose host has since been deleted are unmarked.
 */
export function sessionTier(
  session: Pick<SessionSummary, 'hostId'> | null | undefined,
  hosts: ReadonlyArray<Pick<SavedHostProfile, 'id' | 'tier'>> | null | undefined,
): HostTier | undefined {
  if (!session?.hostId || !hosts) return undefined
  return hosts.find((host) => host.id === session.hostId)?.tier
}
