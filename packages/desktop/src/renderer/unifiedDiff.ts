/** Line kinds for git-style unified diff coloring. */
export type UnifiedDiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind
  text: string
}

/**
 * Classify a single unified-diff line by its leading marker.
 * Treats `---` / `+++` as meta (not add/del) so file headers stay neutral.
 */
export function classifyUnifiedDiffLine(line: string): UnifiedDiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

/** Split a unified diff string into classified lines (preserves empty trailing segments). */
export function parseUnifiedDiff(diff: string): UnifiedDiffLine[] {
  if (diff.length === 0) return []
  // Keep a final empty line only when the string ends with a newline and has content before it.
  const raw = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n')
  return raw.map((text) => ({
    kind: classifyUnifiedDiffLine(text),
    text,
  }))
}
