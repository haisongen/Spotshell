import type { CommandResult } from '../ssh/types.js';

/** Render a structured command result for the model and UI with a final status marker. */
export function formatCommandResult(result: CommandResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
  parts.push(
    result.timedOut
      ? `[timed_out after ${result.durationMs}ms]`
      : `[exit_code=${result.exitCode ?? 'unknown'}]`
  );
  return parts.join('\n');
}
