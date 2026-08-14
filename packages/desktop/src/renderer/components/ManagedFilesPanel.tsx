import { useEffect, useState } from 'react'
import {
  FilePlus2,
  FileUp,
  ClipboardPaste,
  RefreshCw,
  Trash2,
  Pencil,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react'
import type {
  ManagedObjectFileSummary,
  ManagedObjectFilesDetail,
  SourceUpdatePreview,
} from '../../shared/ipc-types'
import { useTranslation } from '../i18n'

interface ManagedFilesPanelProps {
  objectId: string
  allowGuidance: boolean
  disabled?: boolean
  onMessage?: (message: string | null) => void
}

export function ManagedFilesPanel({
  objectId,
  allowGuidance,
  disabled = false,
  onMessage,
}: ManagedFilesPanelProps): JSX.Element {
  const { t } = useTranslation()
  const [showPaste, setShowPaste] = useState(false)
  const [files, setFiles] = useState<ManagedObjectFilesDetail | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [sourcePreview, setSourcePreview] = useState<SourceUpdatePreview | null>(null)
  const [newPath, setNewPath] = useState('notes/note.md')
  const [pastePath, setPastePath] = useState('notes/pasted.txt')
  const [pasteContent, setPasteContent] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [pendingImport, setPendingImport] = useState<{
    absoluteSourcePath: string
    suggestedRelativePath: string
  } | null>(null)
  const [importPath, setImportPath] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFiles(null)
    setSelectedPath(null)
    setEditorContent('')
    setSourcePreview(null)
    setShowPaste(false)
    setPendingImport(null)
    setConfirmDelete(false)
    window.spotshell.listManagedFiles(objectId)
      .then((detail) => {
        if (!cancelled) setFiles(detail)
      })
      .catch((error: unknown) => {
        if (!cancelled) onMessage?.(errorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [objectId, onMessage])

  async function refresh(detail?: ManagedObjectFilesDetail): Promise<void> {
    const next = detail ?? await window.spotshell.listManagedFiles(objectId)
    setFiles(next)
    if (selectedPath && !next.files.some((file) => file.relativePath === selectedPath)) {
      setSelectedPath(null)
      setEditorContent('')
      setSourcePreview(null)
    }
  }

  async function run(action: () => Promise<ManagedObjectFilesDetail | void>): Promise<void> {
    setBusy(true)
    onMessage?.(null)
    try {
      const result = await action()
      if (result) await refresh(result)
    } catch (error) {
      onMessage?.(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function openFile(file: ManagedObjectFileSummary): Promise<void> {
    setBusy(true)
    onMessage?.(null)
    setSourcePreview(null)
    setConfirmDelete(false)
    try {
      const content = await window.spotshell.readManagedFileContent({
        id: objectId,
        relativePath: file.relativePath,
      })
      setSelectedPath(file.relativePath)
      setEditorContent(content.content)
      setRenameTo(file.relativePath)
    } catch (error) {
      onMessage?.(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function createMarkdown(): Promise<void> {
    let relativePath = newPath.trim()
    if (!relativePath) return
    if (!/\.md$/i.test(relativePath)) {
      relativePath = `${relativePath}.md`
      setNewPath(relativePath)
    }
    await run(() => window.spotshell.createManagedTextFile({
      id: objectId,
      relativePath,
      content: `# ${relativePath.split('/').pop()?.replace(/\.md$/i, '') ?? 'Note'}\n\n`,
    }))
  }

  async function pasteText(): Promise<void> {
    const relativePath = pastePath.trim()
    if (!relativePath) return
    await run(() => window.spotshell.createManagedTextFile({
      id: objectId,
      relativePath,
      content: pasteContent,
    }))
    setPasteContent('')
  }

  async function importFile(): Promise<void> {
    const picked = await window.spotshell.pickManagedImportFile()
    if (!picked) return
    // Electron does not support window.prompt; keep path confirmation in-app.
    setPendingImport(picked)
    setImportPath(`references/${picked.suggestedRelativePath}`)
    setShowPaste(false)
    setConfirmDelete(false)
  }

  async function confirmImport(): Promise<void> {
    if (!pendingImport) return
    const relativePath = importPath.trim()
    if (!relativePath) {
      onMessage?.(t('managedFilesImportPathRequired'))
      return
    }
    await run(async () => {
      const result = await window.spotshell.importManagedTextFile({
        id: objectId,
        relativePath,
        absoluteSourcePath: pendingImport.absoluteSourcePath,
      })
      setPendingImport(null)
      return result
    })
  }

  function cancelImport(): void {
    setPendingImport(null)
    setImportPath('')
  }

  async function saveSelected(): Promise<void> {
    if (!selectedPath) return
    await run(() => window.spotshell.saveManagedFileContent({
      id: objectId,
      relativePath: selectedPath,
      content: editorContent,
    }))
  }

  async function previewSourceUpdate(): Promise<void> {
    if (!selectedPath) return
    setBusy(true)
    onMessage?.(null)
    try {
      const preview = await window.spotshell.previewManagedSourceUpdate({
        id: objectId,
        relativePath: selectedPath,
      })
      setSourcePreview(preview)
    } catch (error) {
      onMessage?.(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function applySourceUpdate(): Promise<void> {
    if (!selectedPath) return
    await run(async () => {
      const result = await window.spotshell.applyManagedSourceUpdate({
        id: objectId,
        relativePath: selectedPath,
      })
      const content = await window.spotshell.readManagedFileContent({
        id: objectId,
        relativePath: selectedPath,
      })
      setEditorContent(content.content)
      setSourcePreview(null)
      return result
    })
  }

  async function renameSelected(): Promise<void> {
    if (!selectedPath || !renameTo.trim() || renameTo.trim() === selectedPath) return
    await run(async () => {
      const result = await window.spotshell.renameManagedFile({
        id: objectId,
        fromRelativePath: selectedPath,
        toRelativePath: renameTo.trim(),
      })
      setSelectedPath(renameTo.trim())
      return result
    })
  }

  async function removeSelected(): Promise<void> {
    if (!selectedPath) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await run(async () => {
      const result = await window.spotshell.removeManagedFile({
        id: objectId,
        relativePath: selectedPath,
      })
      setSelectedPath(null)
      setEditorContent('')
      setSourcePreview(null)
      setConfirmDelete(false)
      return result
    })
  }

  async function toggleGuidance(file: ManagedObjectFileSummary, registered: boolean): Promise<void> {
    await run(() => window.spotshell.setManagedGuidanceRegistration({
      id: objectId,
      relativePath: file.relativePath,
      registered,
    }))
  }

  const selected = files?.files.find((file) => file.relativePath === selectedPath)
  const fileCount = files?.files.length ?? 0

  return (
    <section className="managed-files-panel" role="tabpanel" aria-label={t('managedFilesTitle')}>
      <header className="managed-files-header">
        <div className="managed-files-title-text">
          <strong>{t('managedFilesTitle')}</strong>
          <span className="muted">{t('managedFilesCount', { count: fileCount })}</span>
          <span className="muted managed-files-hint">{t('managedFilesHint')}</span>
        </div>
        <div className="managed-files-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy} onClick={() => { void createMarkdown() }}>
            <FilePlus2 size={14} aria-hidden="true" />
            {t('managedFilesCreateMarkdown')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy} onClick={() => { void importFile() }}>
            <FileUp size={14} aria-hidden="true" />
            {t('managedFilesImport')}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled || busy}
            aria-expanded={showPaste}
            onClick={() => setShowPaste((value) => !value)}
          >
            <ClipboardPaste size={14} aria-hidden="true" />
            {t('managedFilesPaste')}
          </button>
        </div>
      </header>

      <div className="managed-files-toolbar">
        <label className="field managed-files-path-field">
          <span>{t('managedFilesPath')}</span>
          <input
            value={newPath}
            disabled={disabled || busy}
            onChange={(event) => setNewPath(event.target.value)}
            placeholder="notes/runbook.md"
          />
        </label>
      </div>

      {pendingImport ? (
        <div className="managed-files-import-confirm">
          <p className="muted">
            {t('managedFilesImportConfirmHint', { file: pendingImport.suggestedRelativePath })}
          </p>
          <label className="field">
            <span>{t('managedFilesImportPathPrompt')}</span>
            <input
              value={importPath}
              disabled={disabled || busy}
              autoFocus
              onChange={(event) => setImportPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void confirmImport()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelImport()
                }
              }}
            />
          </label>
          <div className="managed-files-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={disabled || busy} onClick={() => { void confirmImport() }}>
              {t('managedFilesImportConfirm')}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy} onClick={cancelImport}>
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {showPaste ? (
        <div className="managed-files-paste">
          <label className="field">
            <span>{t('managedFilesPastePath')}</span>
            <input
              value={pastePath}
              disabled={disabled || busy}
              onChange={(event) => setPastePath(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('managedFilesPasteContent')}</span>
            <textarea
              rows={2}
              value={pasteContent}
              disabled={disabled || busy}
              onChange={(event) => setPasteContent(event.target.value)}
            />
          </label>
          <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy || !pasteContent} onClick={() => { void pasteText() }}>
            <ClipboardPaste size={14} aria-hidden="true" />
            {t('managedFilesPasteConfirm')}
          </button>
        </div>
      ) : null}

      <div className="managed-files-body">
        <div className="managed-files-list" role="listbox" aria-label={t('managedFilesTitle')}>
          {fileCount === 0 ? (
            <p className="muted managed-files-empty">{t('managedFilesEmpty')}</p>
          ) : null}
          {files?.files.map((file) => (
            <button
              key={file.relativePath}
              type="button"
              role="option"
              aria-selected={selectedPath === file.relativePath}
              className={`managed-file-row${selectedPath === file.relativePath ? ' active' : ''}`}
              disabled={disabled || busy}
              onClick={() => { void openFile(file) }}
            >
              <span className="managed-file-path">{file.relativePath}</span>
              <span className="managed-file-meta">
                {file.role === 'guidance' ? t('managedFilesRoleGuidance') : t('managedFilesRoleReference')}
                {file.secretStatus !== 'clean' ? ` · ${t('managedFilesSecret', { status: file.secretStatus })}` : ''}
                {file.origin ? ` · ${t('managedFilesHasOrigin')}` : ''}
              </span>
            </button>
          ))}
        </div>

        <div className="managed-file-editor">
          {selectedPath && selected ? (
            <>
              <div className="managed-file-editor-toolbar">
                <strong title={selectedPath}>{selectedPath}</strong>
                <div className="managed-files-actions">
                  <button type="button" className="btn btn-primary btn-sm" disabled={disabled || busy} onClick={() => { void saveSelected() }}>
                    {t('managedFilesSave')}
                  </button>
                  {selected.origin ? (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy} onClick={() => { void previewSourceUpdate() }}>
                      <RefreshCw size={14} aria-hidden="true" />
                      {t('managedFilesUpdateFromSource')}
                    </button>
                  ) : null}
                  {allowGuidance && selected.guidanceEligible ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={disabled || busy}
                      onClick={() => { void toggleGuidance(selected, selected.role !== 'guidance') }}
                    >
                      {selected.role === 'guidance' ? <ShieldOff size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
                      {selected.role === 'guidance'
                        ? t('managedFilesUnregisterGuidance')
                        : t('managedFilesRegisterGuidance')}
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy} onClick={() => { void removeSelected() }}>
                    <Trash2 size={14} aria-hidden="true" />
                    {confirmDelete ? t('managedFilesConfirmDeleteShort') : t('managedFilesDelete')}
                  </button>
                </div>
              </div>
              {selected.origin ? (
                <p className="muted managed-file-origin" title={selected.origin.sourcePath}>
                  {t('managedFilesOrigin', { path: selected.origin.sourcePath })}
                </p>
              ) : null}
              <div className="managed-file-rename-row">
                <input
                  value={renameTo}
                  disabled={disabled || busy}
                  onChange={(event) => setRenameTo(event.target.value)}
                  aria-label={t('managedFilesRename')}
                />
                <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy} onClick={() => { void renameSelected() }}>
                  <Pencil size={14} aria-hidden="true" />
                  {t('managedFilesRename')}
                </button>
              </div>
              <textarea
                className="knowledge-markdown-editor managed-file-content"
                spellCheck={false}
                disabled={disabled || busy}
                value={editorContent}
                onChange={(event) => setEditorContent(event.target.value)}
                aria-label={selectedPath}
              />
              {sourcePreview ? (
                <div className="managed-source-preview">
                  <header>
                    <strong>
                      {sourcePreview.changed
                        ? t('managedFilesSourceChanged')
                        : t('managedFilesSourceUnchanged')}
                    </strong>
                    {sourcePreview.changed ? (
                      <button type="button" className="btn btn-primary btn-sm" disabled={disabled || busy} onClick={() => { void applySourceUpdate() }}>
                        {t('managedFilesApplySourceUpdate')}
                      </button>
                    ) : null}
                  </header>
                  <pre>{sourcePreview.unifiedDiff}</pre>
                </div>
              ) : null}
            </>
          ) : (
            <p className="muted managed-files-empty">{t('managedFilesSelectFile')}</p>
          )}
        </div>
      </div>
    </section>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
