import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  Code2,
  Download,
  FileStack,
  FileText,
  History,
  Layers3,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react'
import type {
  KnowledgeModuleAccessSummary,
  KnowledgeModuleDetail,
  KnowledgeModuleFormDraft,
  ModuleDeletePreview,
  ModuleImportConflictResolution,
  ModuleImportPreview,
  ModuleImportResult,
  SeedModuleStatus,
} from '../../shared/ipc-types'
import { useTranslation } from '../i18n'
import {
  DraftSaveQueue,
  type KnowledgeDraftSave,
  type KnowledgeEditorMode,
} from '../knowledgeSaveQueue'
import { EnvironmentWorkspace } from './EnvironmentWorkspace'
import {
  ExternalChangesHeaderActions,
  ExternalChangesReviewPanel,
  useExternalChanges,
} from './ExternalChangesPanel'
import { ManagedFilesPanel } from './ManagedFilesPanel'
import { RevisionHistoryPanel } from './RevisionHistoryPanel'
import { TrashWorkspace, type TrashRestoredEvent } from './TrashWorkspace'

interface KnowledgeWorkspaceProps {
  hidden: boolean
  target: {
    section: 'environments' | 'modules'
    id: string
    nonce: number
  } | null
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
type KnowledgeSection = 'environments' | 'modules' | 'trash'

export function KnowledgeWorkspace({ hidden, target }: KnowledgeWorkspaceProps): JSX.Element {
  const { t } = useTranslation()
  const [section, setSection] = useState<KnowledgeSection>('environments')
  /** Bumped when trash restore (or other cross-pane catalog changes) so lists reload. */
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [restoredFocus, setRestoredFocus] = useState<{
    section: 'environments' | 'modules'
    id: string
    nonce: number
  } | null>(null)

  useEffect(() => {
    if (target) setSection(target.section)
  }, [target])

  function handleTrashRestored(event: TrashRestoredEvent): void {
    const nextSection = event.kind === 'knowledge' ? 'modules' : 'environments'
    setCatalogRevision((value) => value + 1)
    setRestoredFocus({
      section: nextSection,
      id: event.id,
      nonce: Date.now(),
    })
    setSection(nextSection)
  }

  const environmentFocusId = restoredFocus?.section === 'environments'
    ? restoredFocus.id
    : target?.section === 'environments'
      ? target.id
      : undefined
  const environmentFocusNonce = restoredFocus?.section === 'environments'
    ? restoredFocus.nonce
    : target?.section === 'environments'
      ? target.nonce
      : undefined
  const moduleFocusId = restoredFocus?.section === 'modules'
    ? restoredFocus.id
    : target?.section === 'modules'
      ? target.id
      : undefined
  const moduleFocusNonce = restoredFocus?.section === 'modules'
    ? restoredFocus.nonce
    : target?.section === 'modules'
      ? target.nonce
      : undefined

  return (
    <section className="knowledge-management-workspace" hidden={hidden} aria-label={t('knowledgeWorkspace')}>
      <nav className="knowledge-section-tabs" aria-label={t('knowledgeWorkspaceSections')}>
        <button
          type="button"
          className={section === 'environments' ? 'active' : ''}
          aria-current={section === 'environments' ? 'page' : undefined}
          onClick={() => setSection('environments')}
        >
          <Layers3 size={15} aria-hidden="true" />
          {t('environmentProfiles')}
        </button>
        <button
          type="button"
          className={section === 'modules' ? 'active' : ''}
          aria-current={section === 'modules' ? 'page' : undefined}
          onClick={() => setSection('modules')}
        >
          <BookOpen size={15} aria-hidden="true" />
          {t('knowledgeModules')}
        </button>
        <button
          type="button"
          className={section === 'trash' ? 'active' : ''}
          aria-current={section === 'trash' ? 'page' : undefined}
          onClick={() => setSection('trash')}
        >
          <Trash2 size={15} aria-hidden="true" />
          {t('trashSection')}
        </button>
      </nav>
      <div className="knowledge-workspace" hidden={section !== 'environments'}>
        <EnvironmentWorkspace
          active={section === 'environments'}
          catalogRevision={catalogRevision}
          requestedEnvironmentId={environmentFocusId}
          requestNonce={environmentFocusNonce}
        />
      </div>
      <div className="knowledge-workspace" hidden={section !== 'modules'}>
        <KnowledgeModuleWorkspace
          active={section === 'modules'}
          catalogRevision={catalogRevision}
          requestedModuleId={moduleFocusId}
          requestNonce={moduleFocusNonce}
        />
      </div>
      <div className="knowledge-workspace" hidden={section !== 'trash'}>
        <TrashWorkspace active={section === 'trash'} onRestored={handleTrashRestored} />
      </div>
    </section>
  )
}

function KnowledgeModuleWorkspace({
  active,
  catalogRevision,
  requestedModuleId,
  requestNonce,
}: {
  active: boolean
  catalogRevision: number
  requestedModuleId?: string
  requestNonce?: number
}): JSX.Element {
  const { t } = useTranslation()
  const [modules, setModules] = useState<KnowledgeModuleAccessSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<KnowledgeModuleDetail | null>(null)
  const [mode, setMode] = useState<KnowledgeEditorMode>('form')
  const [tagsText, setTagsText] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [authorizing, setAuthorizing] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [importConflict, setImportConflict] = useState<{
    packagePath: string
    preview: Extract<ModuleImportPreview, { status: 'conflict' }>
  } | null>(null)
  const [deletePreview, setDeletePreview] = useState<ModuleDeletePreview | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [seedPanelOpen, setSeedPanelOpen] = useState(false)
  const [seedStatuses, setSeedStatuses] = useState<SeedModuleStatus[]>([])
  const [seedLoading, setSeedLoading] = useState(false)
  const [seedRestoring, setSeedRestoring] = useState(false)
  const [seedAuthorize, setSeedAuthorize] = useState(true)
  const [seedConflictKey, setSeedConflictKey] = useState<string | null>(null)
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0)
  const saveTimerRef = useRef<number | null>(null)
  const saveQueueRef = useRef<DraftSaveQueue<
    KnowledgeModuleDetail,
    KnowledgeDraftSave
  > | null>(null)
  const detailLoadSequenceRef = useRef(0)
  const selectedIdRef = useRef<string | null>(null)
  const detailRef = useRef<KnowledgeModuleDetail | null>(null)

  selectedIdRef.current = selectedId
  detailRef.current = detail
  if (!saveQueueRef.current) {
    saveQueueRef.current = new DraftSaveQueue((pending) => pending.mode === 'form'
      ? window.spotshell.saveKnowledgeFormDraft({
          id: pending.moduleId,
          form: pending.form!,
        })
      : window.spotshell.saveKnowledgeSourceDraft({
          id: pending.moduleId,
          source: pending.source!,
        }))
  }

  useEffect(() => {
    if (!active && catalogRevision === 0) return
    let cancelled = false
    window.spotshell.listKnowledgeModules()
      .then((items) => {
        if (cancelled) return
        setModules(items)
        setSelectedId((current) => {
          if (requestedModuleId && items.some((item) => item.id === requestedModuleId)) {
            return requestedModuleId
          }
          if (current && items.some((item) => item.id === current)) return current
          return items[0]?.id ?? null
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(errorMessage(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    }
    // requestedModuleId is read to prefer a just-restored object after catalog reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestNonce drives explicit focus separately
  }, [active, catalogRevision, requestNonce])

  useEffect(() => {
    if (requestedModuleId) setSelectedId(requestedModuleId)
  }, [requestedModuleId, requestNonce])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    const sequence = ++detailLoadSequenceRef.current
    setDetail(null)
    setMessage(null)
    window.spotshell.getKnowledgeModule(selectedId)
      .then((next) => {
        if (sequence !== detailLoadSequenceRef.current) return
        applyDetail(next)
        setMode(next.form ? 'form' : 'source')
        setSaveState('idle')
      })
      .catch((error: unknown) => {
        if (sequence === detailLoadSequenceRef.current) setMessage(errorMessage(error))
      })
  }, [selectedId])

  function applyDetail(next: KnowledgeModuleDetail): void {
    setDetail(next)
    setTagsText(next.form?.tags.join(', ') ?? next.tags.join(', '))
    setModules((current) => upsertSummary(current, next))
  }

  /**
   * After background autosave, refresh server-derived metadata without clobbering the
   * live editor (form/source text + tags field mid-keystroke).
   */
  function applyAutosavedDetail(next: KnowledgeModuleDetail): void {
    setDetail((current) => {
      if (!current || current.id !== next.id) return next
      return {
        ...next,
        form: current.form ?? next.form,
        source: current.source,
      }
    })
    setModules((current) => upsertSummary(current, next))
  }

  function scheduleFormSave(form: KnowledgeModuleFormDraft): void {
    scheduleSave({ moduleId: detail!.id, mode: 'form', form })
  }

  function scheduleSourceSave(source: string): void {
    scheduleSave({ moduleId: detail!.id, mode: 'source', source })
  }

  function scheduleSave(save: Omit<KnowledgeDraftSave, 'sequence'>): void {
    saveQueueRef.current!.schedule(save)
    setSaveState('dirty')
    setMessage(null)
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushPendingSave().catch(() => undefined)
    }, 500)
  }

  async function flushPendingSave(): Promise<KnowledgeModuleDetail | null> {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const queue = saveQueueRef.current!
    if (!queue.hasWork()) return detailRef.current
    setSaveState('saving')
    try {
      const saved = await queue.flush()
      if (saved && selectedIdRef.current === saved.id && detailRef.current?.id === saved.id) {
        applyAutosavedDetail(saved)
        setSaveState('saved')
      }
      return saved ?? detailRef.current
    } catch (error) {
      setSaveState('error')
      setMessage(errorMessage(error))
      throw error
    }
  }

  function updateForm(patch: Partial<KnowledgeModuleFormDraft>): void {
    if (!detail?.form) return
    const form = { ...detail.form, ...patch }
    setDetail({ ...detail, form })
    scheduleFormSave(form)
  }

  async function switchMode(nextMode: KnowledgeEditorMode): Promise<void> {
    if (mode === nextMode) return
    try {
      const saved = await flushPendingSave()
      if (!saved) return
      applyDetail(saved)
      if (nextMode === 'form' && !saved.form) {
        setMessage(saved.draftValidationError ?? t('knowledgeInvalidSource'))
        return
      }
      setMode(nextMode)
    } catch {
      // Save error is already shown next to the editor.
    }
  }

  async function createModule(): Promise<void> {
    setCreating(true)
    setMessage(null)
    try {
      await flushPendingSave()
      const created = await window.spotshell.createKnowledgeModule({
        name: t('knowledgeUntitled'),
      })
      applyDetail(created)
      setSelectedId(created.id)
      setMode('form')
      setSaveState('idle')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setCreating(false)
    }
  }

  async function publish(): Promise<void> {
    if (!detail) return
    const moduleId = detail.id
    setPublishing(true)
    setMessage(null)
    try {
      await flushPendingSave()
      const revision = await window.spotshell.publishKnowledgeDraft(moduleId)
      const refreshed = await window.spotshell.getKnowledgeModule(moduleId)
      const refreshedModules = await window.spotshell.listKnowledgeModules()
      if (selectedIdRef.current === moduleId) {
        applyDetail(refreshed)
        setModules(refreshedModules)
        setSaveState('saved')
        setMessage(t('knowledgePublished', { revision: revision.revision }))
        setHistoryRefreshToken((token) => token + 1)
      }
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setPublishing(false)
    }
  }

  async function selectModule(moduleId: string): Promise<void> {
    if (moduleId === selectedIdRef.current) return
    try {
      await flushPendingSave()
      setSelectedId(moduleId)
    } catch {
      // Keep the current module selected so the user can resolve the save error.
    }
  }

  async function setGlobalOnDemand(authorized: boolean): Promise<void> {
    if (!detail) return
    setAuthorizing(true)
    setMessage(null)
    try {
      await window.spotshell.setKnowledgeGlobalOnDemand({ id: detail.id, authorized })
      setModules(await window.spotshell.listKnowledgeModules())
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setAuthorizing(false)
    }
  }

  async function exportModule(): Promise<void> {
    if (!detail?.latestRevision) return
    setExporting(true)
    setMessage(null)
    try {
      const packagePath = await window.spotshell.pickKnowledgeModuleExportPath(
        `${sanitizeFileName(detail.name)}.spotshell-module.json`,
      )
      if (!packagePath) return
      await window.spotshell.exportKnowledgeModule({
        id: detail.id,
        packagePath,
      })
      setMessage(t('knowledgeExported'))
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setExporting(false)
    }
  }

  async function beginDelete(): Promise<void> {
    if (!detail) return
    setDeleting(true)
    setMessage(null)
    try {
      await flushPendingSave()
      const preview = await window.spotshell.previewDeleteKnowledgeModule(detail.id)
      setDeletePreview(preview)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setDeleting(false)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!detail || !deletePreview?.canDelete) return
    setDeleting(true)
    setMessage(null)
    try {
      const result = await window.spotshell.moveKnowledgeModuleToTrash(detail.id)
      setDeletePreview(null)
      setMessage(t('knowledgeDeleted', {
        expires: new Date(result.expiresAt).toLocaleString(),
      }))
      const remaining = await window.spotshell.listKnowledgeModules()
      setModules(remaining)
      setSelectedId(remaining[0]?.id ?? null)
      setDetail(null)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setDeleting(false)
    }
  }

  async function importModule(): Promise<void> {
    setImporting(true)
    setMessage(null)
    setImportConflict(null)
    try {
      await flushPendingSave()
      const packagePath = await window.spotshell.pickKnowledgeModuleImportPath()
      if (!packagePath) return
      const preview = await window.spotshell.previewKnowledgeModuleImport({ packagePath })
      if (preview.status === 'conflict') {
        setSelectedId(preview.local.id)
        setImportConflict({ packagePath, preview })
        return
      }
      const result = await window.spotshell.importKnowledgeModule({ packagePath })
      await applyImportResult(result)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setImporting(false)
    }
  }

  async function resolveImportConflict(
    conflictResolution: ModuleImportConflictResolution,
  ): Promise<void> {
    if (!importConflict) return
    setImporting(true)
    setMessage(null)
    try {
      const result = await window.spotshell.importKnowledgeModule({
        packagePath: importConflict.packagePath,
        conflictResolution,
      })
      setImportConflict(null)
      await applyImportResult(result)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setImporting(false)
    }
  }

  async function applyImportResult(result: ModuleImportResult): Promise<void> {
    const refreshedModules = await window.spotshell.listKnowledgeModules()
    setModules(refreshedModules)
    if (result.status === 'created' || result.status === 'copied' || result.status === 'updated') {
      const refreshed = await window.spotshell.getKnowledgeModule(result.id)
      applyDetail(refreshed)
      setSelectedId(result.id)
      setMode(refreshed.form ? 'form' : 'source')
      setSaveState('idle')
    } else if (result.status === 'identical' || result.status === 'kept-local') {
      const refreshed = await window.spotshell.getKnowledgeModule(result.id)
      applyDetail(refreshed)
      setSelectedId(result.id)
    }

    if (result.status === 'created') {
      setMessage(t('knowledgeImportCreated', { revision: result.revision }))
    } else if (result.status === 'identical') {
      setMessage(t('knowledgeImportIdentical'))
    } else if (result.status === 'kept-local') {
      setMessage(t('knowledgeImportKeptLocal'))
    } else if (result.status === 'updated') {
      setMessage(t('knowledgeImportUpdated', { revision: result.revision }))
    } else {
      setMessage(t('knowledgeImportCopied', { revision: result.revision }))
    }
  }

  async function openSeedPanel(): Promise<void> {
    setSeedPanelOpen(true)
    setSeedConflictKey(null)
    setSeedLoading(true)
    setMessage(null)
    try {
      setSeedStatuses(await window.spotshell.listSeedModules())
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setSeedLoading(false)
    }
  }

  async function refreshSeedStatuses(): Promise<void> {
    setSeedStatuses(await window.spotshell.listSeedModules())
    setModules(await window.spotshell.listKnowledgeModules())
  }

  async function restoreOneSeed(
    seedKey: string,
    conflictResolution?: ModuleImportConflictResolution,
  ): Promise<void> {
    setSeedRestoring(true)
    setMessage(null)
    try {
      if (!conflictResolution) {
        const preview = await window.spotshell.previewRestoreSeedModule(seedKey)
        if (preview.status === 'conflict') {
          setSeedConflictKey(seedKey)
          return
        }
      }
      const result = await window.spotshell.restoreSeedModule({
        seedKey,
        conflictResolution,
        authorizeGlobalOnDemand: seedAuthorize,
      })
      setSeedConflictKey(null)
      await refreshSeedStatuses()
      const restoredId = 'id' in result ? result.id : undefined
      if (restoredId) {
        const refreshed = await window.spotshell.getKnowledgeModule(restoredId)
        applyDetail(refreshed)
        setSelectedId(restoredId)
        setMode(refreshed.form ? 'form' : 'source')
      }
      const name = seedStatuses.find((item) => item.key === seedKey)?.name ?? seedKey
      setMessage(t('knowledgeSeedRestored', { name }))
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setSeedRestoring(false)
    }
  }

  async function restoreMissingSeeds(): Promise<void> {
    setSeedRestoring(true)
    setMessage(null)
    try {
      const results = await window.spotshell.restoreAllSeedModules({
        authorizeGlobalOnDemand: seedAuthorize,
      })
      await refreshSeedStatuses()
      const changed = results.filter((result) =>
        result.status === 'created'
        || result.status === 'updated'
        || result.status === 'copied'
        || result.status === 'restored-from-trash',
      )
      setMessage(t('knowledgeSeedRestoredAll', { count: changed.length }))
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setSeedRestoring(false)
    }
  }

  function seedPresenceLabel(presence: SeedModuleStatus['presence']): string {
    if (presence === 'present-identical') return t('knowledgeSeedIdentical')
    if (presence === 'present-divergent') return t('knowledgeSeedDivergent')
    if (presence === 'in-trash') return t('knowledgeSeedInTrash')
    return t('knowledgeSeedMissing')
  }

  const saveStatus = saveState === 'dirty'
    ? t('knowledgeDraftPending')
    : saveState === 'saving'
      ? t('knowledgeDraftSaving')
      : saveState === 'saved'
        ? t('knowledgeDraftSaved')
        : saveState === 'error'
          ? t('knowledgeDraftFailed')
          : null
  const selectedAccess = modules.find((module) => module.id === detail?.id)

  const conflictPanel = importConflict ? (
    <div className="knowledge-import-conflict" role="dialog" aria-label={t('knowledgeImportConflictTitle')}>
      <div className="knowledge-import-conflict-body">
        <AlertTriangle size={16} aria-hidden="true" />
        <div>
          <strong>{t('knowledgeImportConflictTitle')}</strong>
          <p>
            {t('knowledgeImportConflictDetail', {
              id: importConflict.preview.local.id.slice(0, 8),
              localRevision: importConflict.preview.local.revision,
              localHash: importConflict.preview.local.contentHash.slice(0, 10),
              incomingHash: importConflict.preview.incoming.contentHash.slice(0, 10),
            })}
          </p>
        </div>
      </div>
      <div className="knowledge-import-conflict-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={importing}
          onClick={() => {
            setImportConflict(null)
            setMessage(null)
          }}
        >
          {t('knowledgeImportCancel')}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={importing}
          onClick={() => { void resolveImportConflict('keep-local') }}
        >
          {t('knowledgeImportKeepLocal')}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={importing}
          onClick={() => { void resolveImportConflict('use-imported') }}
        >
          {t('knowledgeImportUseImported')}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={importing}
          onClick={() => { void resolveImportConflict('import-as-copy') }}
        >
          {importing ? t('knowledgeImporting') : t('knowledgeImportAsCopy')}
        </button>
      </div>
    </div>
  ) : null

  const seedPanel = seedPanelOpen ? (
    <div className="knowledge-import-conflict" role="dialog" aria-label={t('knowledgeRestoreSeedsTitle')}>
      <div className="knowledge-import-conflict-body">
        <RotateCcw size={16} aria-hidden="true" />
        <div>
          <strong>{t('knowledgeRestoreSeedsTitle')}</strong>
          <p>{t('knowledgeRestoreSeedsDetail')}</p>
          <label className="knowledge-seed-authorize">
            <input
              type="checkbox"
              checked={seedAuthorize}
              disabled={seedRestoring}
              onChange={(event) => setSeedAuthorize(event.target.checked)}
            />
            <span>{t('knowledgeRestoreAuthorize')}</span>
          </label>
          {seedLoading ? <p className="muted">{t('loading')}</p> : null}
          {!seedLoading ? (
            <ul className="knowledge-seed-list">
              {seedStatuses.map((seed) => {
                const restorable = seed.presence === 'missing'
                  || seed.presence === 'in-trash'
                  || seed.presence === 'present-divergent'
                return (
                  <li key={seed.key} className="knowledge-seed-row">
                    <div>
                      <strong>{seed.name}</strong>
                      <span className="muted"> · {seedPresenceLabel(seed.presence)}</span>
                      {seedConflictKey === seed.key ? (
                        <p className="muted">{t('knowledgeSeedConflictHint')}</p>
                      ) : null}
                    </div>
                    <div className="knowledge-seed-row-actions">
                      {seedConflictKey === seed.key ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={seedRestoring}
                            onClick={() => { void restoreOneSeed(seed.key, 'keep-local') }}
                          >
                            {t('knowledgeImportKeepLocal')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={seedRestoring}
                            onClick={() => { void restoreOneSeed(seed.key, 'use-imported') }}
                          >
                            {t('knowledgeImportUseImported')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={seedRestoring}
                            onClick={() => { void restoreOneSeed(seed.key, 'import-as-copy') }}
                          >
                            {t('knowledgeImportAsCopy')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!restorable || seedRestoring}
                          onClick={() => { void restoreOneSeed(seed.key) }}
                        >
                          {seedRestoring ? t('knowledgeRestoringSeeds') : t('knowledgeRestoreSeedAction')}
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="knowledge-import-conflict-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={seedRestoring}
          onClick={() => {
            setSeedPanelOpen(false)
            setSeedConflictKey(null)
          }}
        >
          {t('knowledgeImportCancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={seedRestoring || seedLoading}
          onClick={() => { void restoreMissingSeeds() }}
        >
          {seedRestoring ? t('knowledgeRestoringSeeds') : t('knowledgeRestoreAllSeeds')}
        </button>
      </div>
    </div>
  ) : null

  const externalChanges = useExternalChanges({
    objectId: selectedId,
    refreshToken: historyRefreshToken,
    onMessage: setMessage,
    onAdopted: async (revision) => {
      const id = selectedIdRef.current
      if (!id) return
      const refreshed = await window.spotshell.getKnowledgeModule(id)
      applyDetail(refreshed)
      setHistoryRefreshToken((token) => token + 1)
      setMessage(t('externalChangesAdopted', { revision }))
    },
  })

  return (
    <>
      <aside className="knowledge-list-pane">
        <div className="knowledge-pane-header">
          <div>
            <h1>{t('knowledgeModules')}</h1>
            <span>{modules.length}</span>
          </div>
          <div className="knowledge-pane-header-actions">
            <button
              type="button"
              className="title-bar-icon-button knowledge-add-button"
              title={t('knowledgeRestoreSeeds')}
              aria-label={t('knowledgeRestoreSeeds')}
              disabled={creating || publishing || importing || exporting || seedRestoring || Boolean(importConflict)}
              onClick={() => { void openSeedPanel() }}
            >
              <RotateCcw size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="title-bar-icon-button knowledge-add-button"
              title={t('knowledgeImport')}
              aria-label={t('knowledgeImport')}
              disabled={creating || publishing || importing || exporting || Boolean(importConflict)}
              onClick={() => { void importModule() }}
            >
              <Upload size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="title-bar-icon-button knowledge-add-button"
              title={t('knowledgeCreate')}
              aria-label={t('knowledgeCreate')}
              disabled={creating || publishing || importing || exporting || Boolean(importConflict)}
              onClick={() => { void createModule() }}
            >
              <Plus size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="knowledge-module-list" role="listbox" aria-label={t('knowledgeModules')}>
          {loading ? <p className="muted knowledge-list-state">{t('loading')}</p> : null}
          {!loading && modules.length === 0 ? (
            <div className="knowledge-list-state">
              <FileText size={22} aria-hidden="true" />
              <p>{t('knowledgeEmpty')}</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => { void createModule() }}>
                <Plus size={14} aria-hidden="true" />
                {t('knowledgeCreate')}
              </button>
            </div>
          ) : null}
          {modules.map((module) => (
            <button
              key={module.id}
              type="button"
              role="option"
              aria-selected={selectedId === module.id}
              className={`knowledge-module-row${selectedId === module.id ? ' active' : ''}`}
              disabled={publishing}
              onClick={() => { void selectModule(module.id) }}
            >
              <span className="knowledge-module-name">{module.name}</span>
              <span className="knowledge-module-description">{module.description}</span>
              <span className="knowledge-module-version">
                {module.latestRevision
                  ? t('knowledgeRevisionShort', { revision: module.latestRevision })
                  : t('knowledgeDraftOnly')}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="knowledge-detail-pane">
        {conflictPanel}
        {seedPanel}
        {!detail ? (
          <div className="knowledge-detail-empty">
            <FileText size={28} aria-hidden="true" />
            <p>{t('knowledgeSelectModule')}</p>
          </div>
        ) : (
          <>
            <header className="knowledge-detail-header">
              <div className="knowledge-detail-title">
                <h2>{detail.name}</h2>
                <div className="knowledge-managed-meta">
                  <code title={detail.id}>{detail.id.slice(0, 8)}</code>
                  <span>{t('knowledgeSchemaVersion', { version: 1 })}</span>
                  <span>
                    {detail.latestRevision
                      ? t('knowledgeRevision', { revision: detail.latestRevision })
                      : t('knowledgeUnpublished')}
                  </span>
                  {detail.latestContentHash ? (
                    <code title={detail.latestContentHash}>{detail.latestContentHash.slice(0, 10)}</code>
                  ) : null}
                </div>
              </div>
              <div className="knowledge-detail-actions">
                {saveStatus ? <span className={`knowledge-save-state ${saveState}`}>{saveStatus}</span> : null}
                <ExternalChangesHeaderActions
                  model={externalChanges}
                  disabled={
                    publishing
                    || exporting
                    || importing
                    || deleting
                    || saveState === 'saving'
                    || Boolean(importConflict)
                  }
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={
                    publishing
                    || exporting
                    || importing
                    || deleting
                    || saveState === 'saving'
                    || Boolean(importConflict)
                  }
                  onClick={() => { void beginDelete() }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  {t('knowledgeDelete')}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={
                    !detail.latestRevision
                    || publishing
                    || exporting
                    || importing
                    || deleting
                    || saveState === 'saving'
                    || Boolean(importConflict)
                  }
                  onClick={() => { void exportModule() }}
                >
                  <Download size={15} aria-hidden="true" />
                  {exporting ? t('knowledgeExporting') : t('knowledgeExport')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    publishing
                    || exporting
                    || importing
                    || deleting
                    || saveState === 'saving'
                    || Boolean(importConflict)
                  }
                  onClick={() => { void publish() }}
                >
                  <Save size={15} aria-hidden="true" />
                  {publishing ? t('knowledgePublishing') : t('knowledgePublish')}
                </button>
              </div>
            </header>

            <ExternalChangesReviewPanel
              model={externalChanges}
              disabled={
                publishing
                || exporting
                || importing
                || deleting
                || saveState === 'saving'
                || Boolean(importConflict)
              }
            />

            {deletePreview ? (
              <section className="knowledge-access-panel" aria-label={t('knowledgeDeleteTitle')}>
                <div className="knowledge-access-item">
                  <strong>{t('knowledgeDeleteTitle')}</strong>
                </div>
                {deletePreview.canDelete ? (
                  <p className="muted">
                    {t('knowledgeDeleteConfirm', {
                      name: deletePreview.name,
                      days: deletePreview.retentionDays,
                      expires: new Date(deletePreview.estimatedExpiresAt).toLocaleString(),
                    })}
                  </p>
                ) : (
                  <>
                    <p className="muted">
                      {t('knowledgeDeleteBlocked', { count: deletePreview.referencedBy.length })}
                    </p>
                    <ul className="knowledge-module-list">
                      {deletePreview.referencedBy.map((ref) => (
                        <li key={`${ref.environmentId}-${ref.mode}`}>
                          {t('knowledgeDeleteReferencedEnv', {
                            name: ref.environmentName,
                            mode: ref.mode === 'always' ? t('trashModeAlways') : t('trashModeOnDemand'),
                          })}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="knowledge-detail-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={deleting}
                    onClick={() => setDeletePreview(null)}
                  >
                    {t('knowledgeImportCancel')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={deleting || !deletePreview.canDelete}
                    onClick={() => { void confirmDelete() }}
                  >
                    {t('knowledgeDelete')}
                  </button>
                </div>
              </section>
            ) : null}

            {selectedAccess ? (
              <section className="knowledge-access-panel" aria-label={t('knowledgeAccess')}>
                <div className="knowledge-access-item">
                  <span>{t('knowledgeAvailability')}</span>
                  <strong className={selectedAccess.automaticCandidateEligible ? 'ready' : ''}>
                    {selectedAccess.automaticCandidateEligible
                      ? t('knowledgeCandidateEligible')
                      : t('knowledgeCandidateIneligible')}
                  </strong>
                </div>
                <label className="knowledge-access-item knowledge-authorization-toggle">
                  <span>{t('knowledgeGlobalOnDemand')}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={selectedAccess.globalOnDemand}
                    disabled={authorizing || (!selectedAccess.automaticCandidateEligible && !selectedAccess.globalOnDemand)}
                    onChange={(event) => { void setGlobalOnDemand(event.target.checked) }}
                  />
                </label>
                <div className="knowledge-access-item">
                  <span>{t('knowledgeEnvironmentAlways')}</span>
                  <strong>{associationNames(selectedAccess.environmentAlways, t('knowledgeNoAssociations'))}</strong>
                </div>
                <div className="knowledge-access-item">
                  <span>{t('knowledgeEnvironmentOnDemand')}</span>
                  <strong>{associationNames(selectedAccess.environmentOnDemand, t('knowledgeNoAssociations'))}</strong>
                </div>
              </section>
            ) : null}

            <div className="knowledge-editor-tabs" role="tablist" aria-label={t('knowledgeEditorMode')}>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'form'}
                className={mode === 'form' ? 'active' : ''}
                disabled={publishing}
                onClick={() => { void switchMode('form') }}
              >
                <FileText size={14} aria-hidden="true" />
                {t('knowledgeFormMode')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'source'}
                className={mode === 'source' ? 'active' : ''}
                disabled={publishing}
                onClick={() => { void switchMode('source') }}
              >
                <Code2 size={14} aria-hidden="true" />
                {t('knowledgeSourceMode')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'files'}
                className={mode === 'files' ? 'active' : ''}
                disabled={publishing}
                onClick={() => { void switchMode('files') }}
              >
                <FileStack size={14} aria-hidden="true" />
                {t('managedFilesTitle')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'history'}
                className={mode === 'history' ? 'active' : ''}
                disabled={publishing}
                onClick={() => { void switchMode('history') }}
              >
                <History size={14} aria-hidden="true" />
                {t('revisionHistoryTitle')}
              </button>
            </div>

            {message || (mode !== 'files' && mode !== 'history' && detail.draftValidationError) ? (
              <div className="knowledge-editor-message" role="status">
                {mode !== 'files' && mode !== 'history' && detail.draftValidationError
                  ? <AlertTriangle size={15} aria-hidden="true" />
                  : null}
                <span>{message ?? detail.draftValidationError}</span>
              </div>
            ) : null}

            {mode === 'form' && detail.form ? (
              <div className="knowledge-form-editor" role="tabpanel">
                <div className="knowledge-form-grid">
                  <label className="field">
                    <span>{t('knowledgeName')}</span>
                    <input disabled={publishing} value={detail.form.name} maxLength={100} onChange={(event) => updateForm({ name: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>{t('knowledgeTags')}</span>
                    <input
                      value={tagsText}
                      disabled={publishing}
                      maxLength={1000}
                      onChange={(event) => {
                        const value = event.target.value
                        setTagsText(value)
                        updateForm({ tags: parseTags(value) })
                      }}
                    />
                  </label>
                  <label className="field knowledge-field-span">
                    <span>{t('knowledgeDescription')}</span>
                    <textarea disabled={publishing} rows={2} value={detail.form.description} maxLength={500} onChange={(event) => updateForm({ description: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>{t('knowledgeWhenToUse')}</span>
                    <textarea disabled={publishing} rows={2} value={detail.form.whenToUse} maxLength={500} onChange={(event) => updateForm({ whenToUse: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>{t('knowledgeWhenNotToUse')}</span>
                    <textarea disabled={publishing} rows={2} value={detail.form.whenNotToUse ?? ''} maxLength={500} onChange={(event) => updateForm({ whenNotToUse: event.target.value || undefined })} />
                  </label>
                </div>
                <div className="knowledge-content-editors">
                  <label className="field">
                    <span>{t('knowledgeReferenceBody')}</span>
                    <textarea disabled={publishing} className="knowledge-markdown-editor" value={detail.form.beforeGuidance} onChange={(event) => updateForm({ beforeGuidance: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>{t('knowledgeGuidance')}</span>
                    <textarea disabled={publishing} className="knowledge-markdown-editor" value={detail.form.inlineGuidance ?? ''} onChange={(event) => updateForm({ inlineGuidance: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>{t('knowledgeFollowingBody')}</span>
                    <textarea disabled={publishing} className="knowledge-markdown-editor" value={detail.form.afterGuidance} onChange={(event) => updateForm({ afterGuidance: event.target.value })} />
                  </label>
                </div>
              </div>
            ) : mode === 'files' ? (
              <ManagedFilesPanel
                objectId={detail.id}
                allowGuidance
                disabled={publishing || saveState === 'saving'}
                onMessage={setMessage}
              />
            ) : mode === 'history' ? (
              <RevisionHistoryPanel
                objectId={detail.id}
                refreshToken={historyRefreshToken}
                onRestored={async () => {
                  const refreshed = await window.spotshell.getKnowledgeModule(detail.id)
                  applyDetail(refreshed)
                  setModules(await window.spotshell.listKnowledgeModules())
                  setHistoryRefreshToken((token) => token + 1)
                }}
              />
            ) : (
              <div className="knowledge-source-editor" role="tabpanel">
                <textarea
                  aria-label={t('knowledgeSourceMode')}
                  disabled={publishing}
                  spellCheck={false}
                  value={detail.source}
                  onChange={(event) => {
                    const source = event.target.value
                    setDetail({ ...detail, source })
                    scheduleSourceSave(source)
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}

function parseTags(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean)
}

function upsertSummary(
  modules: KnowledgeModuleAccessSummary[],
  detail: KnowledgeModuleDetail
): KnowledgeModuleAccessSummary[] {
  const existing = modules.find((module) => module.id === detail.id)
  const summary: KnowledgeModuleAccessSummary = {
    id: detail.id,
    name: detail.name,
    description: detail.description,
    whenToUse: detail.whenToUse,
    tags: detail.tags,
    draftSavedAt: detail.draftSavedAt,
    latestRevision: detail.latestRevision,
    latestContentHash: detail.latestContentHash,
    automaticCandidateEligible: existing?.automaticCandidateEligible ?? false,
    globalOnDemand: existing?.globalOnDemand ?? false,
    environmentAlways: existing?.environmentAlways ?? [],
    environmentOnDemand: existing?.environmentOnDemand ?? [],
  }
  const next = modules.filter((module) => module.id !== detail.id)
  next.push(summary)
  return next.sort((left, right) => left.name.localeCompare(right.name))
}

function associationNames(
  associations: KnowledgeModuleAccessSummary['environmentAlways'],
  emptyLabel: string,
): string {
  return associations.length > 0
    ? associations.map((association) => association.name).join(', ')
    : emptyLabel
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return sanitized || 'knowledge-module'
}
