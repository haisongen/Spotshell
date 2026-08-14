import { useState } from 'react'
import { BookOpen, Download, ExternalLink, Pin, PinOff, Sparkles, X } from 'lucide-react'
import type { EnvironmentSummary, KnowledgeModuleAccessSummary, SessionSummary } from '../../shared/ipc-types'
import { availableChatContextActions, deriveChatContext, type ChatContextEntry } from '../chatContextState'
import { useTranslation } from '../i18n'
import { ContextUsageMeter } from './ContextUsageMeter'

type ModuleAction = 'load' | 'pin' | 'unpin' | 'unload'

interface ChatContextBarProps {
  session: SessionSummary
  environments: EnvironmentSummary[]
  modules: KnowledgeModuleAccessSummary[]
  onEnvironmentSelect: (environmentId: string | undefined, persistForHost: boolean) => Promise<void>
  onModuleAction: (action: ModuleAction, moduleId: string) => Promise<void>
  onApplyRevision?: (
    objectId: string,
    targetRevision: number,
    targetContentHash: string,
  ) => Promise<void>
  onKeepRevision?: (
    objectId: string,
    latestRevision: number,
    latestContentHash: string,
  ) => Promise<void>
  onManage: (moduleId?: string) => void
  onManageEnvironment: (environmentId: string) => void
  onStartNewContext?: () => Promise<void>
  /** When true, the control is not interactive (running command or local pending). */
  newContextDisabled?: boolean
  /** Explicit reason shown when the control is blocked (e.g. running SSH command). */
  newContextBlockReason?: string
}

export function ChatContextBar(props: ChatContextBarProps): JSX.Element {
  const { t } = useTranslation()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const context = deriveChatContext(props.session, props.modules)
  const knowledgeSummary = t('contextKnowledgeSummary', {
    fixed: context.fixed.length,
    active: context.dynamic.length,
    available: context.candidates.length,
  })

  async function selectEnvironment(environmentId: string | undefined, persistForHost: boolean): Promise<void> {
    setPending('environment')
    setError(null)
    try {
      await props.onEnvironmentSelect(environmentId, persistForHost)
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : String(selectionError))
    } finally {
      setPending(null)
    }
  }

  async function runModuleAction(action: ModuleAction, moduleId: string): Promise<void> {
    setPending(moduleId)
    setError(null)
    try {
      await props.onModuleAction(action, moduleId)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setPending(null)
    }
  }

  async function startNewContext(): Promise<void> {
    if (!props.onStartNewContext) return
    setPending('new-context')
    setError(null)
    try {
      await props.onStartNewContext()
    } catch (contextError) {
      setError(contextError instanceof Error ? contextError.message : String(contextError))
    } finally {
      setPending(null)
    }
  }

  async function applyRevision(
    objectId: string,
    targetRevision: number,
    targetContentHash: string,
  ): Promise<void> {
    if (!props.onApplyRevision) return
    setPending(`apply:${objectId}`)
    setError(null)
    try {
      await props.onApplyRevision(objectId, targetRevision, targetContentHash)
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError))
    } finally {
      setPending(null)
    }
  }

  async function keepRevision(
    objectId: string,
    latestRevision: number,
    latestContentHash: string,
  ): Promise<void> {
    if (!props.onKeepRevision) return
    setPending(`keep:${objectId}`)
    setError(null)
    try {
      await props.onKeepRevision(objectId, latestRevision, latestContentHash)
    } catch (keepError) {
      setError(keepError instanceof Error ? keepError.message : String(keepError))
    } finally {
      setPending(null)
    }
  }

  const updates = props.session.revisionUpdatesAvailable ?? []
  const envUpdate = updates.find(
    (update) => update.kind === 'environment' && update.objectId === props.session.environmentId,
  )
  const pinTitle = !props.session.hostId
    ? t('saveHostBeforeBinding')
    : t('contextUseAsHostDefault')

  return (
    <section className="chat-context-bar" aria-label={t('currentContext')}>
      <div className="chat-context-bar-row chat-context-bar-primary">
        <label className="chat-context-environment">
          <span>{t('currentEnvironment')}</span>
          <select
            value={props.session.environmentId ?? ''}
            disabled={pending !== null || props.newContextDisabled}
            title={props.newContextDisabled && props.newContextBlockReason
              ? props.newContextBlockReason
              : undefined}
            aria-label={t('currentEnvironment')}
            onChange={(event) => { void selectEnvironment(event.target.value || undefined, false) }}
          >
            <option value="">{t('noEnvironment')}</option>
            {props.session.environmentId
              && !props.environments.some((entry) => entry.id === props.session.environmentId)
              ? (
                <option value={props.session.environmentId}>{t('missingEnvironmentBinding')}</option>
              )
              : null}
            {props.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>{environment.name}</option>
            ))}
          </select>
          {envUpdate ? (
            <span className="chat-context-update-badge" title={t('revisionUpdateAvailableHint', {
              active: String(envUpdate.activeRevision),
              latest: String(envUpdate.latestRevision),
            })}>
              {t('revisionUpdateAvailable')}
            </span>
          ) : null}
        </label>
        <button
          type="button"
          className="chat-context-icon"
          title={pinTitle}
          aria-label={pinTitle}
          disabled={pending !== null || !props.session.hostId || !props.session.environmentId}
          onClick={() => { void selectEnvironment(props.session.environmentId, true) }}
        >
          <Pin size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="chat-context-icon"
          title={t('contextManageEnvironment')}
          aria-label={t('contextManageEnvironment')}
          disabled={!props.session.environmentId}
          onClick={() => {
            if (props.session.environmentId) props.onManageEnvironment(props.session.environmentId)
          }}
        >
          <ExternalLink size={14} aria-hidden="true" />
        </button>
        <details className="chat-context-knowledge">
          <summary aria-label={knowledgeSummary} title={knowledgeSummary}>
            <BookOpen size={14} aria-hidden="true" />
            <span className="chat-context-count-label" aria-hidden="true">{t('contextFixedCount', { count: context.fixed.length })}</span>
            <span className="chat-context-count-label" aria-hidden="true">{t('contextActiveCount', { count: context.dynamic.length })}</span>
            <span className="chat-context-count-label" aria-hidden="true">{t('contextAvailableCount', { count: context.candidates.length })}</span>
            <span className="chat-context-count-compact" aria-hidden="true">
              {context.fixed.length}/{context.dynamic.length}/{context.candidates.length}
            </span>
          </summary>
          <div className="chat-context-popover">
            <ContextGroup
              title={t('contextFixed')}
              entries={context.fixed}
              pending={pending}
              updates={updates}
              onAction={runModuleAction}
              onManage={props.onManage}
              onApply={applyRevision}
              onKeep={keepRevision}
            />
            <ContextGroup
              title={t('contextActive')}
              entries={context.dynamic}
              pending={pending}
              updates={updates}
              onAction={runModuleAction}
              onManage={props.onManage}
              onApply={applyRevision}
              onKeep={keepRevision}
            />
            <ContextGroup
              title={t('contextAvailable')}
              entries={context.candidates}
              pending={pending}
              updates={updates}
              onAction={runModuleAction}
              onManage={props.onManage}
              onApply={applyRevision}
              onKeep={keepRevision}
            />
            {updates.length > 0 ? (
              <RevisionUpdatesPanel
                updates={updates}
                pending={pending}
                onApply={applyRevision}
                onKeep={keepRevision}
              />
            ) : null}
            {error ? <p className="form-error" role="status">{error}</p> : null}
          </div>
        </details>
      </div>
      <div className="chat-context-bar-row chat-context-bar-secondary">
        {props.onStartNewContext ? (
          <button
            type="button"
            className="chat-context-new"
            title={props.newContextDisabled && props.newContextBlockReason
              ? props.newContextBlockReason
              : t('startNewContextHint')}
            aria-label={t('startNewContext')}
            aria-disabled={pending !== null || props.newContextDisabled}
            disabled={pending !== null || props.newContextDisabled}
            onClick={() => { void startNewContext() }}
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>{t('startNewContext')}</span>
          </button>
        ) : null}
        {props.newContextDisabled && props.newContextBlockReason ? (
          <p className="chat-context-block-reason muted" role="status">
            {props.newContextBlockReason}
          </p>
        ) : null}
        <ContextUsageMeter usage={props.session.contextUsage} />
      </div>
    </section>
  )
}

function ContextGroup({
  title,
  entries,
  pending,
  updates,
  onAction,
  onManage,
  onApply,
  onKeep,
}: {
  title: string
  entries: ChatContextEntry[]
  pending: string | null
  updates: SessionSummary['revisionUpdatesAvailable']
  onAction: (action: ModuleAction, id: string) => Promise<void>
  onManage: (id: string) => void
  onApply: (objectId: string, targetRevision: number, targetContentHash: string) => Promise<void>
  onKeep: (objectId: string, latestRevision: number, latestContentHash: string) => Promise<void>
}): JSX.Element {
  const { t } = useTranslation()
  const updateById = new Map(updates.map((update) => [update.objectId, update]))
  return (
    <section className="chat-context-group">
      <h3>{title}</h3>
      {entries.length === 0 ? <p className="muted">{t('contextNone')}</p> : entries.map((entry) => {
        const actions = availableChatContextActions(entry)
        const update = updateById.get(entry.id)
        return <div className="chat-context-module" key={entry.id}>
          <span title={entry.description}>
            {entry.name}
            {update ? (
              <span className="chat-context-update-badge" title={t('revisionUpdateAvailableHint', {
                active: String(update.activeRevision),
                latest: String(update.latestRevision),
              })}>
                {t('revisionUpdateAvailable')}
              </span>
            ) : null}
          </span>
          <div>
            <button type="button" title={t('contextManageModule')} aria-label={t('contextManageNamedModule', { name: entry.name })} onClick={() => onManage(entry.id)}>
              <ExternalLink size={13} aria-hidden="true" />
            </button>
            {actions.includes('load') ? (
              <button type="button" disabled={pending !== null} title={t('contextLoad')} aria-label={t('contextLoadNamedModule', { name: entry.name })} onClick={() => { void onAction('load', entry.id) }}><Download size={13} aria-hidden="true" /></button>
            ) : null}
            {actions.includes('pin') ? (
              <button type="button" disabled={pending !== null} title={t('contextPin')} aria-label={t('contextPinNamedModule', { name: entry.name })} onClick={() => { void onAction('pin', entry.id) }}><Pin size={13} aria-hidden="true" /></button>
            ) : null}
            {actions.includes('unload') ? (
              <button type="button" disabled={pending !== null} title={t('contextUnload')} aria-label={t('contextUnloadNamedModule', { name: entry.name })} onClick={() => { void onAction('unload', entry.id) }}><X size={13} aria-hidden="true" /></button>
            ) : null}
            {actions.includes('unpin') ? (
              <button type="button" disabled={pending !== null} title={t('contextUnpin')} aria-label={t('contextUnpinNamedModule', { name: entry.name })} onClick={() => { void onAction('unpin', entry.id) }}><PinOff size={13} aria-hidden="true" /></button>
            ) : null}
            {update ? (
              <>
                <button
                  type="button"
                  disabled={pending !== null}
                  title={t('applyRevision')}
                  aria-label={t('applyRevisionNamed', { name: entry.name })}
                  onClick={() => { void onApply(update.objectId, update.latestRevision, update.latestContentHash) }}
                >
                  {t('applyRevisionShort')}
                </button>
                <button
                  type="button"
                  disabled={pending !== null}
                  title={t('keepRevision')}
                  aria-label={t('keepRevisionNamed', { name: entry.name })}
                  onClick={() => { void onKeep(update.objectId, update.latestRevision, update.latestContentHash) }}
                >
                  {t('keepRevisionShort')}
                </button>
              </>
            ) : null}
          </div>
        </div>
      })}
    </section>
  )
}

function RevisionUpdatesPanel({
  updates,
  pending,
  onApply,
  onKeep,
}: {
  updates: SessionSummary['revisionUpdatesAvailable']
  pending: string | null
  onApply: (objectId: string, targetRevision: number, targetContentHash: string) => Promise<void>
  onKeep: (objectId: string, latestRevision: number, latestContentHash: string) => Promise<void>
}): JSX.Element {
  const { t } = useTranslation()
  // Host notes and environment updates may not appear in module lists.
  const extra = updates.filter((update) => update.kind === 'host-notes' || update.kind === 'environment')
  if (extra.length === 0) return <></>
  return (
    <section className="chat-context-group" aria-label={t('revisionUpdates')}>
      <h3>{t('revisionUpdates')}</h3>
      {extra.map((update) => (
        <div className="chat-context-module" key={update.objectId}>
          <span title={t('revisionUpdateAvailableHint', {
            active: String(update.activeRevision),
            latest: String(update.latestRevision),
          })}>
            {update.name}
            <span className="chat-context-update-badge">{t('revisionUpdateAvailable')}</span>
          </span>
          <div>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => { void onApply(update.objectId, update.latestRevision, update.latestContentHash) }}
            >
              {t('applyRevisionShort')}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => { void onKeep(update.objectId, update.latestRevision, update.latestContentHash) }}
            >
              {t('keepRevisionShort')}
            </button>
          </div>
        </div>
      ))}
    </section>
  )
}
