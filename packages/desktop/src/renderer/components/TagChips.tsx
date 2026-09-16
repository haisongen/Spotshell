const DEFAULT_VISIBLE = 3

/**
 * Tag chips for a list row. Caps how many render so a heavily tagged object
 * cannot grow the row; the remainder collapses into a "+N" chip whose title
 * lists them in full.
 */
export function TagChips({
  tags,
  max = DEFAULT_VISIBLE,
}: {
  tags: readonly string[]
  max?: number
}): JSX.Element | null {
  if (tags.length === 0) return null
  const visible = tags.slice(0, max)
  const hidden = tags.slice(max)

  return (
    <span className="knowledge-tag-chips">
      {visible.map((tag) => (
        <span key={tag} className="knowledge-tag-chip" title={tag}>
          {tag}
        </span>
      ))}
      {hidden.length > 0 ? (
        <span className="knowledge-tag-chip more" title={hidden.join(', ')}>
          +{hidden.length}
        </span>
      ) : null}
    </span>
  )
}
