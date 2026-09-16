import { ChevronDown, ChevronRight } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from '../i18n'

interface CollapsibleEditorProps {
  label: string
  value: string
  disabled?: boolean
  /** Sections start collapsed so the form fits one screen; the primary body opts in. */
  defaultOpen?: boolean
  onChange: (value: string) => void
}

/**
 * One markdown body in the knowledge form, collapsible so three full-height
 * editors do not push the rest of the form off screen. The collapsed header
 * still reports whether the section has content, so nothing hides silently.
 */
export function CollapsibleEditor({
  label,
  value,
  disabled = false,
  defaultOpen = false,
  onChange,
}: CollapsibleEditorProps): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()

  const lines = value ? value.split('\n').length : 0
  const summary = value.trim()
    ? t('knowledgeSectionLines', { count: lines })
    : t('knowledgeSectionEmpty')

  return (
    <section className={`knowledge-collapsible${open ? ' open' : ''}`}>
      <button
        type="button"
        className="knowledge-collapsible-header"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        {open
          ? <ChevronDown size={14} aria-hidden="true" />
          : <ChevronRight size={14} aria-hidden="true" />}
        <span className="knowledge-collapsible-label">{label}</span>
        <span className="knowledge-collapsible-summary">{summary}</span>
      </button>
      {open ? (
        <div id={panelId} className="knowledge-collapsible-body">
          <textarea
            aria-label={label}
            className="knowledge-markdown-editor"
            disabled={disabled}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      ) : null}
    </section>
  )
}
