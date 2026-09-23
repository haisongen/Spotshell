import type { HostTier } from '@spotshell/core'

/**
 * Renderer-safe copy of core's HOST_TIERS (the renderer only type-imports core).
 * Ordered from most to least sensitive.
 */
export const HOST_TIERS = ['production', 'staging', 'testing', 'development'] as const satisfies readonly HostTier[]

// Compile-time guard: fails if core adds a tier this list is missing.
type MissingTier = Exclude<HostTier, (typeof HOST_TIERS)[number]>
const exhaustive: MissingTier extends never ? true : false = true
void exhaustive

export type { HostTier }

export function isHostTier(value: unknown): value is HostTier {
  return (HOST_TIERS as readonly unknown[]).includes(value)
}
