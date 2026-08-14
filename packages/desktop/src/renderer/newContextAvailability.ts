/**
 * Pure UI helper: whether the "new context" control is interactive and why not.
 * Generation/knowledge-read busy states stay available so the user can cancel-and-switch.
 */

export type NewContextAvailabilityInput = {
  /** Remote command currently running (user terminal or agent exec). */
  commandRunning: boolean
  /** Local UI action already pending (e.g. environment select). */
  localPending?: boolean
}

export type NewContextAvailability =
  | { available: true }
  | { available: false; reason: 'running-command' | 'local-pending' }

export function getNewContextAvailability(
  input: NewContextAvailabilityInput,
): NewContextAvailability {
  if (input.localPending) return { available: false, reason: 'local-pending' }
  if (input.commandRunning) return { available: false, reason: 'running-command' }
  return { available: true }
}
