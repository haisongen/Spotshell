/**
 * Agent context epoch state for one SSH tab.
 * Visible Chat transcript is independent; this tracks the backend Agent segment only.
 */

import type { ContextBoundaryPayload, ContextBoundaryReason } from '../shared/ipc-types'

export type { ContextBoundaryReason }

export interface ContextEpochState {
  /** Monotonic segment id starting at 1 for each LiveSession. */
  contextEpoch: number
  /**
   * True once the current epoch has Agent-facing activity
   * (chat history, knowledge reads/tools, or dynamic module selection).
   */
  epochHasActivity: boolean
}

export function createInitialEpochState(): ContextEpochState {
  return { contextEpoch: 1, epochHasActivity: false }
}

export function markEpochActivity(state: ContextEpochState): ContextEpochState {
  if (state.epochHasActivity) return state
  return { ...state, epochHasActivity: true }
}

/** Whether switching environments must open a new Agent context segment. */
export function shouldOpenNewEpochOnEnvironmentChange(
  state: ContextEpochState,
  environmentChanged: boolean,
): boolean {
  return environmentChanged && state.epochHasActivity
}

export function advanceEpoch(
  state: ContextEpochState,
  reason: ContextBoundaryReason,
  options: {
    now?: Date
    fromEnvironmentId?: string
    fromEnvironmentName?: string
    toEnvironmentId?: string
    toEnvironmentName?: string
  } = {},
): { state: ContextEpochState; boundary: ContextBoundaryPayload } {
  const previousEpoch = state.contextEpoch
  const next: ContextEpochState = {
    contextEpoch: previousEpoch + 1,
    epochHasActivity: false,
  }
  const boundary: ContextBoundaryPayload = {
    epoch: next.contextEpoch,
    previousEpoch,
    createdAt: (options.now ?? new Date()).toISOString(),
    reason,
    ...(options.fromEnvironmentId !== undefined
      ? { fromEnvironmentId: options.fromEnvironmentId }
      : {}),
    ...(options.fromEnvironmentName !== undefined
      ? { fromEnvironmentName: options.fromEnvironmentName }
      : {}),
    ...(options.toEnvironmentId !== undefined
      ? { toEnvironmentId: options.toEnvironmentId }
      : {}),
    ...(options.toEnvironmentName !== undefined
      ? { toEnvironmentName: options.toEnvironmentName }
      : {}),
  }
  return { state: next, boundary }
}
