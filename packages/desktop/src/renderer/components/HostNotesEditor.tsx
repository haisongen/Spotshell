import { useEffect, useState } from 'react'
import type { SavedHostProfile } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'

interface HostNotesEditorProps {
  host: SavedHostProfile
  onSaved: () => Promise<void> | void
}

export function HostNotesEditor({ host, onSaved }: HostNotesEditorProps): JSX.Element {
  const { t } = useTranslation()
  const [notes, setNotes] = useState(host.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  // 切换选中主机时同步内容
  useEffect(() => {
    setNotes(host.notes ?? '')
    setStatus(null)
  }, [host.id, host.notes])

  async function handleSave(): Promise<void> {
    setBusy(true)
    setStatus(null)
    try {
      await window.spotshell.updateHost(host.id, { notes })
      setStatus(t('notesSaved'))
      await onSaved()
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="host-notes-editor">
      <label className="field">
        <span>{t('hostNotes')}</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('hostNotesPlaceholder')}
          rows={4}
          maxLength={4000}
          disabled={busy}
        />
      </label>
      <p className="hint">{t('hostNotesHint')}</p>
      <div className="host-notes-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || notes === (host.notes ?? '')}
          onClick={() => {
            void handleSave()
          }}
        >
          {busy ? t('saving') : t('saveNotes')}
        </button>
        {status ? <span className="muted">{status}</span> : null}
      </div>
    </div>
  )
}
