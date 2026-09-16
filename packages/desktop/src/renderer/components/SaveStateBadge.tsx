import { AlertTriangle, Check, Circle, Loader2 } from 'lucide-react'

export type DraftSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/**
 * Autosave status as an icon + label pill. The bare grey text it replaces was
 * easy to miss, which mattered most for the error state.
 */
export function SaveStateBadge({
  state,
  label,
}: {
  state: DraftSaveState
  label: string | null
}): JSX.Element | null {
  if (!label || state === 'idle') return null

  const icon = state === 'saving'
    ? <Loader2 size={12} className="knowledge-save-spin" aria-hidden="true" />
    : state === 'saved'
      ? <Check size={12} aria-hidden="true" />
      : state === 'error'
        ? <AlertTriangle size={12} aria-hidden="true" />
        : <Circle size={8} aria-hidden="true" />

  return (
    <span className={`knowledge-save-state ${state}`} role="status">
      {icon}
      <span>{label}</span>
    </span>
  )
}
