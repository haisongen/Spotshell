const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bkill\s+-9\b/,
  /\b: \(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
];

/**
 * @deprecated Replaced by classifyCommand in Phase 1. Kept for compatibility only.
 */
export function isDangerousCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  return DANGEROUS_PATTERNS.some((re) => re.test(normalized));
}
