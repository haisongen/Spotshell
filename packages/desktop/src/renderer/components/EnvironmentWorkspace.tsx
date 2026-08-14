import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Code2,
  Download,
  FileStack,
  FileText,
  History,
  Layers3,
  Link2,
  Plus,
  Save,
  Trash2,
  Upload,
} from 'lucide-react'
import type {
  EnvironmentDeletePreview,
  EnvironmentDetail,
  EnvironmentExportMode,
  EnvironmentExportPreview,
  EnvironmentFormDraft,
  EnvironmentImportPreview,
  EnvironmentModuleDependency,
  EnvironmentSummary,
  KnowledgeModuleSummary,
  ModuleImportConflictResolution,
} from '../../shared/ipc-types'
import { useTranslation } from '../i18n'
import {
  DraftSaveQueue,
  type KnowledgeDraftSaveMode,
  type KnowledgeEditorMode,
} from '../knowledgeSaveQueue'
import {
  ExternalChangesHeaderActions,
  ExternalChangesReviewPanel,
  useExternalChanges,
} from './ExternalChangesPanel'
import { ManagedFilesPanel } from './ManagedFilesPanel'
import { RevisionHistoryPanel } from './RevisionHistoryPanel'

interface EnvironmentWorkspaceProps {
  active: boolean
  /** Bumped by parent when trash restore / other cross-pane catalog changes occur. */
  catalogRevision?: number
  requestedEnvironmentId?: string
  requestNonce?: number
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
type AssociationMode = 'none' | 'always' | 'onDemand'
/** Environment detail tabs: shared knowledge modes plus module associations. */
type EnvironmentEditorMode = KnowledgeEditorMode | 'associations'

interface EnvironmentDraftSave {
  environmentId: string
  mode: KnowledgeDraftSaveMode
  form?: EnvironmentFormDraft
  source?: string
  sequence: number
}

export function EnvironmentWorkspace({
  active,
  catalogRevision = 0,
  requestedEnvironmentId,
  requestNonce,
}: EnvironmentWorkspaceProps): JSX.Element {
  const { t } = useTranslation()
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([])
  const [modules, setModules] = useState<KnowledgeModuleSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<EnvironmentDetail | null>(null)
  const [mode, setMode] = useState<EnvironmentEditorMode>('form')
  const [tagsText, setTagsText] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [exportPreview, setExportPreview] = useState<EnvironmentExportPreview | null>(null)
  const [exportMode, setExportMode] = useState<EnvironmentExportMode>('self-contained')
  const [importSession, setImportSession] = useState<{
    packagePath: string
    preview: EnvironmentImportPreview
    environmentResolution?: ModuleImportConflictResolution
    moduleResolutions: Record<string, ModuleImportConflictResolution>
  } | null>(null)
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0)
  const [deletePreview, setDeletePreview] = useState<EnvironmentDeletePreview | null>(null)
  const [deleting, setDeleting] = useState(false)
  const saveTimerRef = useRef<number | null>(null)
  const saveQueueRef = useRef<DraftSaveQueue<EnvironmentDetail, EnvironmentDraftSave> | null>(null)
  const detailLoadSequenceRef = useRef(0)
  const selectedIdRef = useRef<string | null>(null)
  const detailRef = useRef<EnvironmentDetail | null>(null)

  selectedIdRef.current = selectedId
  detailRef.current = detail
  if (!saveQueueRef.current) {
    saveQueueRef.current = new DraftSaveQueue((pending) => pending.mode === 'form'
      ? window.spotshell.saveEnvironmentFormDraft({
          id: pending.environmentId,
          form: pending.form!,
        })
      : window.spotshell.saveEnvironmentSourceDraft({
          id: pending.environmentId,
          source: pending.source!,
        }))
  }

  useEffect(() => {
    if (!active && catalogRevision === 0) return
    let cancelled = false
    Promise.all([
      window.spotshell.listEnvironments(),
      window.spotshell.listKnowledgeModules(),
    ]).then(([items, moduleItems]) => {
      if (cancelled) return
      setEnvironments(items)
      setModules(moduleItems)
      setSelectedId((current) => {
        if (requestedEnvironmentId && items.some((item) => item.id === requestedEnvironmentId)) {
          return requestedEnvironmentId
        }
        if (current && items.some((item) => item.id === current)) return current
        return items[0]?.id ?? null
      })
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(errorMessage(error))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    }
    // requestedEnvironmentId is preferred after catalog reload (e.g. trash restore).
  }, [active, catalogRevision, requestNonce])

  useEffect(() => {
    if (requestedEnvironmentId) setSelectedId(requestedEnvironmentId)
  }, [requestedEnvironmentId, requestNonce])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    const sequence = ++detailLoadSequenceRef.current
    setDetail(null)
    setMessage(null)
    window.spotshell.getEnvironment(selectedId)
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

  function applyDetail(next: EnvironmentDetail): void {
    setDetail(next)
    setTagsText(next.form?.tags.join(', ') ?? next.tags.join(', '))
    setEnvironments((current) => upsertEnvironmentSummary(current, next))
  }

  /**
   * After background autosave, refresh server-derived metadata without clobbering the
   * live editor (form/source text + tags field mid-keystroke).
   */
  function applyAutosavedDetail(next: EnvironmentDetail): void {
    setDetail((current) => {
      if (!current || current.id !== next.id) return next
      return {
        ...next,
        form: current.form ?? next.form,
        source: current.source,
      }
    })
    setEnvironments((current) => upsertEnvironmentSummary(current, next))
  }

  function scheduleFormSave(form: EnvironmentFormDraft): void {
    scheduleSave({ environmentId: detail!.id, mode: 'form', form })
  }

  function scheduleSourceSave(source: string): void {
    scheduleSave({ environmentId: detail!.id, mode: 'source', source })
  }

  function scheduleSave(save: Omit<EnvironmentDraftSave, 'sequence'>): void {
    saveQueueRef.current!.schedule(save)
    setSaveState('dirty')
    setMessage(null)
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushPendingSave().catch(() => undefined)
    }, 500)
  }

  async function flushPendingSave(): Promise<EnvironmentDetail | null> {
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

  function updateForm(patch: Partial<EnvironmentFormDraft>): void {
    if (!detail?.form) return
    const form = { ...detail.form, ...patch }
    setDetail({ ...detail, form })
    scheduleFormSave(form)
  }

  function setAssociationMode(moduleId: string, nextMode: AssociationMode): void {
    if (!detail?.form) return
    const always = detail.form.always.filter((id) => id !== moduleId)
    const onDemand = detail.form.onDemand.filter((id) => id !== moduleId)
    if (nextMode === 'always') always.push(moduleId)
    if (nextMode === 'onDemand') onDemand.push(moduleId)
    updateForm({ always, onDemand })
  }

  function moveAssociation(group: 'always' | 'onDemand', moduleId: string, offset: -1 | 1): void {
    if (!detail?.form) return
    const ids = [...detail.form[group]]
    const index = ids.indexOf(moduleId)
    const target = index + offset
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    updateForm({ [group]: ids })
  }

  async function switchMode(nextMode: EnvironmentEditorMode): Promise<void> {
    if (mode === nextMode) return
    try {
      const saved = await flushPendingSave()
      if (!saved) return
      applyDetail(saved)
      if ((nextMode === 'form' || nextMode === 'associations') && !saved.form) {
        setMessage(saved.draftValidationError ?? t('knowledgeInvalidSource'))
        return
      }
      setMode(nextMode)
    } catch {
      // Save error is already shown next to the editor.
    }
  }

  async function createEnvironment(): Promise<void> {
    setCreating(true)
    setMessage(null)
    try {
      await flushPendingSave()
      const created = await window.spotshell.createEnvironment({
        name: t('environmentUntitled'),
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
    const environmentId = detail.id
    setPublishing(true)
    setMessage(null)
    try {
      await flushPendingSave()
      const revision = await window.spotshell.publishEnvironmentDraft(environmentId)
      const refreshed = await window.spotshell.getEnvironment(environmentId)
      if (selectedIdRef.current === environmentId) {
        applyDetail(refreshed)
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

  async function selectEnvironment(environmentId: string): Promise<void> {
    if (environmentId === selectedIdRef.current) return
    try {
      await flushPendingSave()
      setSelectedId(environmentId)
    } catch {
      // Keep the current environment selected so the user can resolve the save error.
    }
  }

  async function beginDelete(): Promise<void> {
    if (!detail) return
    setDeleting(true)
    setMessage(null)
    try {
      await flushPendingSave()
      const preview = await window.spotshell.previewDeleteEnvironment(detail.id)
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
      const result = await window.spotshell.moveEnvironmentToTrash(detail.id)
      setDeletePreview(null)
      setMessage(t('environmentDeleted', {
        expires: new Date(result.expiresAt).toLocaleString(),
      }))
      const remaining = await window.spotshell.listEnvironments()
      setEnvironments(remaining)
      setSelectedId(remaining[0]?.id ?? null)
      setDetail(null)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setDeleting(false)
    }
  }

  async function beginExport(): Promise<void> {
    if (!detail?.latestRevision) return
    setExporting(true)
    setMessage(null)
    try {
      await flushPendingSave()
      const preview = await window.spotshell.previewEnvironmentExport({ id: detail.id })
      setExportPreview(preview)
      setExportMode(preview.modeDefault)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setExporting(false)
    }
  }

  async function confirmExport(): Promise<void> {
    if (!detail || !exportPreview) return
    setExporting(true)
    setMessage(null)
    try {
      const packagePath = await window.spotshell.pickEnvironmentExportPath(
        `${sanitizeFileName(detail.name)}.spotshell-environment.json`,
      )
      if (!packagePath) return
      const exported = await window.spotshell.exportEnvironment({
        id: detail.id,
        packagePath,
        mode: exportMode,
      })
      setExportPreview(null)
      if (exportMode === 'definition-only') {
        setMessage(t('environmentExportedDefinition', {
          count: exported.unresolvedModuleIds.length,
        }))
      } else {
        setMessage(t('environmentExportedBundle', {
          modules: exported.moduleCount,
          unresolved: exported.unresolvedModuleIds.length,
        }))
      }
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setExporting(false)
    }
  }

  async function beginImport(): Promise<void> {
    setImporting(true)
    setMessage(null)
    setImportSession(null)
    try {
      await flushPendingSave()
      const packagePath = await window.spotshell.pickEnvironmentImportPath()
      if (!packagePath) return
      const preview = await window.spotshell.previewEnvironmentImport({ packagePath })
      const hasConflicts = preview.environment.status === 'conflict'
        || preview.modules.some((module) => module.status === 'conflict')
      if (hasConflicts) {
        setImportSession({
          packagePath,
          preview,
          moduleResolutions: {},
        })
        return
      }
      const result = await window.spotshell.importEnvironment({ packagePath })
      await applyEnvironmentImportResult(result.environment.id, result.unresolvedModuleIds.length)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setImporting(false)
    }
  }

  async function confirmImportWithResolutions(): Promise<void> {
    if (!importSession) return
    const { preview, packagePath, environmentResolution, moduleResolutions } = importSession
    if (preview.environment.status === 'conflict' && !environmentResolution) {
      setMessage(t('environmentImportNeedEnvironmentResolution'))
      return
    }
    for (const module of preview.modules) {
      if (module.status === 'conflict' && !moduleResolutions[module.id]) {
        setMessage(t('environmentImportNeedModuleResolution', {
          id: module.id.slice(0, 8),
        }))
        return
      }
    }

    setImporting(true)
    setMessage(null)
    try {
      const result = await window.spotshell.importEnvironment({
        packagePath,
        environmentResolution,
        moduleResolutions,
      })
      setImportSession(null)
      await applyEnvironmentImportResult(result.environment.id, result.unresolvedModuleIds.length)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setImporting(false)
    }
  }

  async function applyEnvironmentImportResult(
    environmentId: string,
    unresolvedCount: number,
  ): Promise<void> {
    const [items, moduleItems, refreshed] = await Promise.all([
      window.spotshell.listEnvironments(),
      window.spotshell.listKnowledgeModules(),
      window.spotshell.getEnvironment(environmentId),
    ])
    setEnvironments(items)
    setModules(moduleItems)
    applyDetail(refreshed)
    setSelectedId(environmentId)
    setMode(refreshed.form ? 'form' : 'source')
    setSaveState('idle')
    setMessage(
      unresolvedCount > 0
        ? t('environmentImportedWithUnresolved', { count: unresolvedCount })
        : t('environmentImported'),
    )
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

  const moduleById = useMemo(
    () => new Map(modules.map((module) => [module.id, module])),
    [modules]
  )
  const form = detail?.form
  const assignedIds = new Set([...(form?.always ?? []), ...(form?.onDemand ?? [])])
  const unassignedModules = modules.filter((module) => !assignedIds.has(module.id))
  const busy = creating || publishing || exporting || importing || deleting
    || Boolean(exportPreview)
    || Boolean(importSession)

  const exportPanel = exportPreview ? (
    <div className="knowledge-import-conflict" role="dialog" aria-label={t('environmentExportPreviewTitle')}>
      <div className="knowledge-import-conflict-body">
        <Download size={16} aria-hidden="true" />
        <div>
          <strong>{t('environmentExportPreviewTitle')}</strong>
          <p>
            {t('environmentExportPreviewDetail', {
              name: exportPreview.environment.name,
              revision: exportPreview.environment.revision,
              count: exportPreview.modules.length,
            })}
          </p>
          <ul className="environment-export-dependency-list">
            {exportPreview.modules.map((module) => (
              <li key={`${module.association}:${module.id}`}>
                <code>{module.id.slice(0, 8)}</code>
                {' '}
                {module.name ?? t('environmentUnresolvedModule')}
                {' · '}
                {module.association === 'always' ? t('environmentAlways') : t('environmentOnDemand')}
                {' · '}
                {module.status === 'resolved'
                  ? t('knowledgeRevisionShort', { revision: module.revision ?? 0 })
                  : t('environmentUnresolvedModule')}
              </li>
            ))}
          </ul>
          <div className="environment-export-mode">
            <label>
              <input
                type="radio"
                name="environment-export-mode"
                checked={exportMode === 'self-contained'}
                onChange={() => setExportMode('self-contained')}
              />
              {t('environmentExportSelfContained')}
            </label>
            <label>
              <input
                type="radio"
                name="environment-export-mode"
                checked={exportMode === 'definition-only'}
                onChange={() => setExportMode('definition-only')}
              />
              {t('environmentExportDefinitionOnly')}
            </label>
            {exportMode === 'definition-only' ? (
              <p className="muted">{t('environmentExportDefinitionWarning')}</p>
            ) : null}
          </div>
        </div>
      </div>
      <div className="knowledge-import-conflict-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={exporting}
          onClick={() => setExportPreview(null)}
        >
          {t('knowledgeImportCancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={exporting}
          onClick={() => { void confirmExport() }}
        >
          {exporting ? t('knowledgeExporting') : t('environmentExportConfirm')}
        </button>
      </div>
    </div>
  ) : null

  const importPanel = importSession ? (
    <div className="knowledge-import-conflict" role="dialog" aria-label={t('environmentImportConflictTitle')}>
      <div className="knowledge-import-conflict-body">
        <AlertTriangle size={16} aria-hidden="true" />
        <div>
          <strong>{t('environmentImportConflictTitle')}</strong>
          <p>{t('environmentImportConflictDetail')}</p>
          {importSession.preview.environment.status === 'conflict' ? (
            <div className="environment-import-conflict-item">
              <strong>{t('environmentImportEnvironmentConflict')}</strong>
              <p className="muted">
                {t('knowledgeImportConflictDetail', {
                  id: importSession.preview.environment.incoming.id.slice(0, 8),
                  localRevision: importSession.preview.environment.local?.revision ?? 0,
                  localHash: (importSession.preview.environment.local?.contentHash ?? '').slice(0, 10),
                  incomingHash: importSession.preview.environment.incoming.contentHash.slice(0, 10),
                })}
              </p>
              <select
                value={importSession.environmentResolution ?? ''}
                onChange={(event) => {
                  const value = event.target.value as ModuleImportConflictResolution | ''
                  setImportSession({
                    ...importSession,
                    environmentResolution: value || undefined,
                  })
                }}
              >
                <option value="">{t('environmentImportChooseResolution')}</option>
                <option value="keep-local">{t('knowledgeImportKeepLocal')}</option>
                <option value="use-imported">{t('knowledgeImportUseImported')}</option>
                <option value="import-as-copy">{t('knowledgeImportAsCopy')}</option>
              </select>
            </div>
          ) : null}
          {importSession.preview.modules
            .filter((module) => module.status === 'conflict')
            .map((module) => (
              <div key={module.id} className="environment-import-conflict-item">
                <strong>
                  {t('environmentImportModuleConflict', {
                    name: module.incoming?.name ?? module.id.slice(0, 8),
                  })}
                </strong>
                <p className="muted">
                  {t('knowledgeImportConflictDetail', {
                    id: module.id.slice(0, 8),
                    localRevision: module.local?.revision ?? 0,
                    localHash: (module.local?.contentHash ?? '').slice(0, 10),
                    incomingHash: (module.incoming?.contentHash ?? '').slice(0, 10),
                  })}
                </p>
                <select
                  value={importSession.moduleResolutions[module.id] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value as ModuleImportConflictResolution | ''
                    const next = { ...importSession.moduleResolutions }
                    if (value) next[module.id] = value
                    else delete next[module.id]
                    setImportSession({ ...importSession, moduleResolutions: next })
                  }}
                >
                  <option value="">{t('environmentImportChooseResolution')}</option>
                  <option value="keep-local">{t('knowledgeImportKeepLocal')}</option>
                  <option value="use-imported">{t('knowledgeImportUseImported')}</option>
                  <option value="import-as-copy">{t('knowledgeImportAsCopy')}</option>
                </select>
              </div>
            ))}
          {importSession.preview.unresolvedModuleIds.length > 0 ? (
            <p className="muted">
              {t('environmentImportUnresolvedNote', {
                count: importSession.preview.unresolvedModuleIds.length,
              })}
            </p>
          ) : null}
        </div>
      </div>
      <div className="knowledge-import-conflict-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={importing}
          onClick={() => {
            setImportSession(null)
            setMessage(null)
          }}
        >
          {t('knowledgeImportCancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={importing}
          onClick={() => { void confirmImportWithResolutions() }}
        >
          {importing ? t('knowledgeImporting') : t('environmentImportConfirm')}
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
      const refreshed = await window.spotshell.getEnvironment(id)
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
            <h1>{t('environmentProfiles')}</h1>
            <span>{environments.length}</span>
          </div>
          <div className="knowledge-pane-header-actions">
            <button
              type="button"
              className="title-bar-icon-button knowledge-add-button"
              title={t('environmentImport')}
              aria-label={t('environmentImport')}
              disabled={busy}
              onClick={() => { void beginImport() }}
            >
              <Upload size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="title-bar-icon-button knowledge-add-button"
              title={t('environmentCreate')}
              aria-label={t('environmentCreate')}
              disabled={busy}
              onClick={() => { void createEnvironment() }}
            >
              <Plus size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="knowledge-module-list" role="listbox" aria-label={t('environmentProfiles')}>
          {loading ? <p className="muted knowledge-list-state">{t('loading')}</p> : null}
          {!loading && environments.length === 0 ? (
            <div className="knowledge-list-state">
              <Layers3 size={22} aria-hidden="true" />
              <p>{t('environmentEmpty')}</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => { void createEnvironment() }}>
                <Plus size={14} aria-hidden="true" />
                {t('environmentCreate')}
              </button>
            </div>
          ) : null}
          {environments.map((environment) => (
            <button
              key={environment.id}
              type="button"
              role="option"
              aria-selected={selectedId === environment.id}
              className={`knowledge-module-row${selectedId === environment.id ? ' active' : ''}`}
              disabled={publishing}
              onClick={() => { void selectEnvironment(environment.id) }}
            >
              <span className="knowledge-module-name">{environment.name}</span>
              <span className="knowledge-module-description">{environment.description}</span>
              <span className="knowledge-module-version">
                {environment.latestRevision
                  ? t('knowledgeRevisionShort', { revision: environment.latestRevision })
                  : t('knowledgeDraftOnly')}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="knowledge-detail-pane">
        {!detail ? (
          <div className="knowledge-detail-empty">
            <Layers3 size={28} aria-hidden="true" />
            <p>{t('environmentSelect')}</p>
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
                  disabled={busy || deleting || saveState === 'saving'}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || deleting}
                  onClick={() => { void beginDelete() }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  {t('environmentDelete')}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!detail.latestRevision || busy || deleting}
                  onClick={() => { void beginExport() }}
                >
                  <Download size={15} aria-hidden="true" />
                  {exporting ? t('knowledgeExporting') : t('environmentExport')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={publishing || saveState === 'saving' || busy || deleting}
                  onClick={() => { void publish() }}
                >
                  <Save size={15} aria-hidden="true" />
                  {publishing ? t('knowledgePublishing') : t('knowledgePublish')}
                </button>
              </div>
            </header>

            <ExternalChangesReviewPanel
              model={externalChanges}
              disabled={busy || deleting || saveState === 'saving'}
            />

            {deletePreview ? (
              <section className="knowledge-access-panel" aria-label={t('environmentDeleteTitle')}>
                <div className="knowledge-access-item">
                  <strong>{t('environmentDeleteTitle')}</strong>
                </div>
                {deletePreview.canDelete ? (
                  <p className="muted">
                    {t('environmentDeleteConfirm', {
                      name: deletePreview.name,
                      days: deletePreview.retentionDays,
                      expires: new Date(deletePreview.estimatedExpiresAt).toLocaleString(),
                    })}
                  </p>
                ) : (
                  <>
                    <p className="muted">
                      {t('environmentDeleteBlocked', { count: deletePreview.boundHosts.length })}
                    </p>
                    <ul className="knowledge-module-list">
                      {deletePreview.boundHosts.map((host) => (
                        <li key={host.hostId}>
                          {t('environmentDeleteBoundHost', { name: host.hostName })}
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
                    {t('environmentDelete')}
                  </button>
                </div>
              </section>
            ) : null}

            {exportPanel}
            {importPanel}

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
                aria-selected={mode === 'associations'}
                className={mode === 'associations' ? 'active' : ''}
                disabled={publishing}
                onClick={() => { void switchMode('associations') }}
              >
                <Link2 size={14} aria-hidden="true" />
                {t('environmentAssociations')}
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

            {mode === 'form' && form ? (
              <div className="knowledge-form-editor environment-form-editor" role="tabpanel">
                <div className="knowledge-form-grid">
                  <label className="field">
                    <span>{t('knowledgeName')}</span>
                    <input disabled={publishing} value={form.name} maxLength={100} onChange={(event) => updateForm({ name: event.target.value })} />
                  </label>
                  <label className="field knowledge-field-wide">
                    <span>{t('knowledgeDescription')}</span>
                    <textarea disabled={publishing} rows={2} value={form.description} maxLength={500} onChange={(event) => updateForm({ description: event.target.value })} />
                  </label>
                  <label className="field knowledge-field-wide">
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
                </div>
                <label className="field environment-facts-field">
                  <span>{t('environmentFacts')}</span>
                  <textarea disabled={publishing} className="knowledge-markdown-editor" value={form.body} onChange={(event) => updateForm({ body: event.target.value })} />
                </label>
              </div>
            ) : mode === 'associations' && form ? (
              <div className="knowledge-form-editor" role="tabpanel">
                <section className="environment-associations" aria-label={t('environmentAssociations')}>
                  <div className="environment-associations-header">
                    <h3>{t('environmentAssociations')}</h3>
                    <span>{t('environmentAssociationsDraft')}</span>
                  </div>
                  <AssociationGroup
                    title={t('environmentAlways')}
                    ids={form.always}
                    mode="always"
                    moduleById={moduleById}
                    dependencies={detail.associations.always}
                    disabled={publishing}
                    onModeChange={setAssociationMode}
                    onMove={moveAssociation}
                    t={t}
                  />
                  <AssociationGroup
                    title={t('environmentOnDemand')}
                    ids={form.onDemand}
                    mode="onDemand"
                    moduleById={moduleById}
                    dependencies={detail.associations.onDemand}
                    disabled={publishing}
                    onModeChange={setAssociationMode}
                    onMove={moveAssociation}
                    t={t}
                  />
                  <div className="environment-association-group">
                    <h4>{t('environmentAvailableModules')}</h4>
                    {unassignedModules.length === 0 ? (
                      <p className="muted environment-association-empty">{t('environmentNoAvailableModules')}</p>
                    ) : unassignedModules.map((module) => (
                      <AssociationRow
                        key={module.id}
                        id={module.id}
                        name={module.name}
                        mode="none"
                        disabled={publishing}
                        onModeChange={setAssociationMode}
                        t={t}
                      />
                    ))}
                  </div>
                </section>
              </div>
            ) : mode === 'files' ? (
              <ManagedFilesPanel
                objectId={detail.id}
                allowGuidance={false}
                disabled={publishing || saveState === 'saving'}
                onMessage={setMessage}
              />
            ) : mode === 'history' ? (
              <RevisionHistoryPanel
                objectId={detail.id}
                refreshToken={historyRefreshToken}
                onRestored={async () => {
                  const refreshed = await window.spotshell.getEnvironment(detail.id)
                  applyDetail(refreshed)
                  setEnvironments(await window.spotshell.listEnvironments())
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

interface AssociationGroupProps {
  title: string
  ids: string[]
  mode: Exclude<AssociationMode, 'none'>
  moduleById: Map<string, KnowledgeModuleSummary>
  dependencies: EnvironmentModuleDependency[]
  disabled: boolean
  onModeChange: (moduleId: string, mode: AssociationMode) => void
  onMove: (group: 'always' | 'onDemand', moduleId: string, offset: -1 | 1) => void
  t: (key: string, variables?: Record<string, string | number>) => string
}

function AssociationGroup({
  title,
  ids,
  mode,
  moduleById,
  dependencies,
  disabled,
  onModeChange,
  onMove,
  t,
}: AssociationGroupProps): JSX.Element {
  const dependencyById = new Map(dependencies.map((dependency) => [dependency.id, dependency]))
  return (
    <div className="environment-association-group">
      <h4>{title}</h4>
      {ids.length === 0 ? (
        <p className="muted environment-association-empty">{t('environmentAssociationEmpty')}</p>
      ) : ids.map((id, index) => {
        const module = moduleById.get(id)
        const dependency = dependencyById.get(id)
        return (
          <AssociationRow
            key={id}
            id={id}
            name={module?.name ?? dependency?.name}
            mode={mode}
            unresolved={!module && dependency?.status === 'unresolved'}
            disabled={disabled}
            canMoveUp={index > 0}
            canMoveDown={index < ids.length - 1}
            onModeChange={onModeChange}
            onMove={(offset) => onMove(mode, id, offset)}
            t={t}
          />
        )
      })}
    </div>
  )
}

interface AssociationRowProps {
  id: string
  name?: string
  mode: AssociationMode
  unresolved?: boolean
  disabled: boolean
  canMoveUp?: boolean
  canMoveDown?: boolean
  onModeChange: (moduleId: string, mode: AssociationMode) => void
  onMove?: (offset: -1 | 1) => void
  t: (key: string, variables?: Record<string, string | number>) => string
}

function AssociationRow({
  id,
  name,
  mode,
  unresolved = false,
  disabled,
  canMoveUp = false,
  canMoveDown = false,
  onModeChange,
  onMove,
  t,
}: AssociationRowProps): JSX.Element {
  return (
    <div className={`environment-association-row${unresolved ? ' unresolved' : ''}`}>
      <div className="environment-association-name">
        {unresolved ? <AlertTriangle size={14} aria-hidden="true" /> : null}
        <span>{name ?? t('environmentUnresolvedModule')}</span>
        <code title={id}>{id.slice(0, 8)}</code>
      </div>
      <div className="environment-association-actions">
        {onMove ? (
          <div className="environment-order-actions">
            <button type="button" title={t('environmentMoveUp')} aria-label={t('environmentMoveUp')} disabled={disabled || !canMoveUp} onClick={() => onMove(-1)}>
              <ChevronUp size={14} aria-hidden="true" />
            </button>
            <button type="button" title={t('environmentMoveDown')} aria-label={t('environmentMoveDown')} disabled={disabled || !canMoveDown} onClick={() => onMove(1)}>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div className="environment-mode-control" role="group" aria-label={t('environmentModuleMode')}>
          {(['none', 'always', 'onDemand'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={mode === option ? 'active' : ''}
              aria-pressed={mode === option}
              disabled={disabled}
              onClick={() => onModeChange(id, option)}
            >
              {option === 'none'
                ? t('environmentModeNone')
                : option === 'always'
                  ? t('environmentAlways')
                  : t('environmentOnDemand')}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function parseTags(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean)
}

function upsertEnvironmentSummary(
  environments: EnvironmentSummary[],
  detail: EnvironmentDetail
): EnvironmentSummary[] {
  const summary: EnvironmentSummary = {
    id: detail.id,
    name: detail.name,
    description: detail.description,
    tags: detail.tags,
    draftSavedAt: detail.draftSavedAt,
    latestRevision: detail.latestRevision,
    latestContentHash: detail.latestContentHash,
  }
  const next = environments.filter((environment) => environment.id !== detail.id)
  next.push(summary)
  return next.sort((left, right) => left.name.localeCompare(right.name))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'environment'
}
