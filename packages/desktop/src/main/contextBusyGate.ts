/**
 * Deterministic gating for opening a new Agent context epoch while work is in flight.
 * Cancelable work (generation, knowledge reads, pending approvals) is settled first.
 * Running SSH commands block until they finish or are explicitly stopped.
 */

export type NewContextGateInput = {
  /** User-terminal shell integration reports a command in progress. */
  terminalCommandRunning: boolean
  /** Agent-side SSH exec channel currently running a remote command. */
  agentCommandRunning: boolean
}

export type NewContextGateResult =
  | { allowed: true }
  | { allowed: false; reason: 'running-command'; message: string }

export const RUNNING_COMMAND_BLOCKS_NEW_CONTEXT =
  'A terminal command is running; wait for it to finish or stop it before opening a new context'

export const RUNNING_COMMAND_BLOCKS_ENVIRONMENT_SWITCH =
  'A terminal command is running; wait for it to finish or stop it before changing environments'

/** Decide whether a new context (or environment switch that needs one) may proceed. */
export function assessNewContextGate(input: NewContextGateInput): NewContextGateResult {
  if (input.terminalCommandRunning || input.agentCommandRunning) {
    return {
      allowed: false,
      reason: 'running-command',
      message: RUNNING_COMMAND_BLOCKS_NEW_CONTEXT,
    }
  }
  return { allowed: true }
}

/** True when an event belongs to a closed epoch and must not mutate current Agent state. */
export function isLateEpochEvent(eventEpoch: number, currentEpoch: number): boolean {
  return eventEpoch !== currentEpoch
}
