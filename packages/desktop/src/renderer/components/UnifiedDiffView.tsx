import { parseUnifiedDiff, type UnifiedDiffLineKind } from '../unifiedDiff'

interface UnifiedDiffViewProps {
  diff: string
  className?: string
  'aria-label'?: string
}

const KIND_CLASS: Record<UnifiedDiffLineKind, string> = {
  add: 'unified-diff-add',
  del: 'unified-diff-del',
  hunk: 'unified-diff-hunk',
  meta: 'unified-diff-meta',
  context: 'unified-diff-context',
}

/** Renders a unified diff with git-style red/green line coloring. */
export function UnifiedDiffView({
  diff,
  className,
  'aria-label': ariaLabel,
}: UnifiedDiffViewProps): JSX.Element {
  const lines = parseUnifiedDiff(diff)
  const rootClass = ['unified-diff', className].filter(Boolean).join(' ')

  return (
    <pre className={rootClass} aria-label={ariaLabel}>
      {lines.length === 0 ? (
        <span className="unified-diff-line unified-diff-context" />
      ) : (
        lines.map((line, index) => (
          <span
            key={`${index}:${line.kind}:${line.text.slice(0, 24)}`}
            className={`unified-diff-line ${KIND_CLASS[line.kind]}`}
          >
            {line.text || ' '}
            {'\n'}
          </span>
        ))
      )}
    </pre>
  )
}
