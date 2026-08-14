/**
 * Plaintext fallback is limited to local development where safeStorage may be
 * unavailable. Packaged builds fail closed instead of writing secrets openly.
 */
export function allowPlaintextSecrets(isPackaged: boolean): boolean {
  return !isPackaged
}
