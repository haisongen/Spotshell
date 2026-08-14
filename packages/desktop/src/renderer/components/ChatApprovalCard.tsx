import { useEffect, useState } from 'react'
import type {
  ApprovalItem,
  KnowledgeProposalApprovalItem,
  KnowledgeTargetApprovalItem,
} from '../chatApprovals'
import { useTranslation } from '../i18n'
import { UnifiedDiffView } from './UnifiedDiffView'

interface ChatApprovalCardProps {
  item: ApprovalItem
  responding?: boolean
  onRespond: (item: ApprovalItem, approved: boolean, options?: ApprovalRespondOptions) => void
}

export interface KnowledgeProposalRespondOptions {
  reason?: string
  files?: Array<{ relativePath: string; before: string; after: string }>
  promoteToGuidance?: boolean
  terminalEvidence?: string
}

export interface ApprovalRespondOptions extends KnowledgeProposalRespondOptions {
  /** Which landing place the user picked on a knowledge-target card. */
  optionIndex?: number
}

export function ChatApprovalCard({ item, responding = false, onRespond }: ChatApprovalCardProps): JSX.Element {
  if (item.kind === 'knowledge-proposal') {
    return (
      <KnowledgeProposalCard
        item={item}
        responding={responding}
        onRespond={onRespond}
      />
    )
  }

  if (item.kind === 'knowledge-target') {
    return (
      <KnowledgeTargetCard
        item={item}
        responding={responding}
        onRespond={onRespond}
      />
    )
  }

  const { t } = useTranslation()
  const pending = item.status === 'pending'
  const destructive = item.kind === 'command-approval' && item.risk === 'destructive'
  const title = item.kind === 'note-approval'
    ? t('noteProposalTitle')
    : t(destructive ? 'dangerousCommand' : 'writeCommand')
  const hint = item.kind === 'note-approval'
    ? t('noteProposalHint')
    : t(destructive ? 'dangerousCommandHint' : 'writeCommandHint')
  const status = statusLabel(t, item.status)

  return (
    <section
      className={`chat-approval-card chat-approval-${
        item.kind === 'note-approval' ? 'note' : item.risk
      }${pending ? '' : ' chat-approval-resolved'}`}
      aria-label={title}
    >
      <div className="chat-approval-heading">
        <strong>{title}</strong>
        <span className="chat-approval-status" role="status">{status}</span>
      </div>
      <p className="chat-approval-hint">{hint}</p>
      <pre className="chat-approval-content">
        {item.kind === 'command-approval' ? item.command : item.note}
      </pre>
      {pending ? (
        <div className="chat-approval-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={responding}
            onClick={() => onRespond(item, false)}
          >
            {t(item.kind === 'command-approval' ? 'rejectCommand' : 'rejectNote')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={responding}
            onClick={() => onRespond(item, true)}
          >
            {t(item.kind === 'command-approval' ? 'allowCommand' : 'saveNote')}
          </button>
        </div>
      ) : null}
    </section>
  )
}

function KnowledgeTargetCard({
  item,
  responding,
  onRespond,
}: {
  item: KnowledgeTargetApprovalItem
  responding: boolean
  onRespond: (item: ApprovalItem, approved: boolean, options?: ApprovalRespondOptions) => void
}): JSX.Element {
  const { t } = useTranslation()
  const pending = item.status === 'pending'
  const title = t('knowledgeTargetTitle')
  const chosen = item.chosenIndex === undefined ? undefined : item.candidates[item.chosenIndex]

  return (
    <section
      className={`chat-approval-card chat-approval-target${pending ? '' : ' chat-approval-resolved'}`}
      aria-label={title}
    >
      <div className="chat-approval-heading">
        <strong>{title}</strong>
        <span className="chat-approval-status" role="status">{statusLabel(t, item.status)}</span>
      </div>
      <p className="chat-approval-hint">{t('knowledgeTargetHint')}</p>
      <p className="chat-approval-reason">{item.question}</p>
      {chosen ? (
        <p className="chat-approval-message" role="status">
          {t('knowledgeTargetChosen', { label: chosen.label })}
        </p>
      ) : null}
      <ul className="chat-approval-target-list">
        {item.candidates.map((candidate, index) => (
          <li key={`${candidate.kind}:${candidate.targetId}`}>
            <button
              type="button"
              className={`btn btn-sm${item.chosenIndex === index ? ' btn-primary' : ' btn-choice'}`}
              disabled={responding || !pending}
              onClick={() => onRespond(item, true, { optionIndex: index })}
            >
              <span className="chat-approval-target-kind">{candidateKindLabel(t, candidate.kind)}</span>
              <span className="chat-approval-target-label">{candidate.label}</span>
            </button>
            <p className="chat-approval-target-reason">{candidate.reason}</p>
          </li>
        ))}
      </ul>
      {pending ? (
        <div className="chat-approval-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={responding}
            onClick={() => onRespond(item, false)}
          >
            {t('knowledgeTargetDecline')}
          </button>
        </div>
      ) : null}
    </section>
  )
}

function candidateKindLabel(
  t: Translate,
  kind: KnowledgeTargetApprovalItem['candidates'][number]['kind'],
): string {
  if (kind === 'host-notes') return t('knowledgeTargetKindHostNotes')
  if (kind === 'environment') return t('knowledgeTargetKindEnvironment')
  return t('knowledgeTargetKindKnowledge')
}

function KnowledgeProposalCard({
  item,
  responding,
  onRespond,
}: {
  item: KnowledgeProposalApprovalItem
  responding: boolean
  onRespond: (item: ApprovalItem, approved: boolean, options?: ApprovalRespondOptions) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState(item.proposal.reason)
  const [afterByPath, setAfterByPath] = useState<Record<string, string>>(() =>
    Object.fromEntries(item.proposal.files.map((file) => [file.relativePath, file.after])),
  )
  const [promoteToGuidance, setPromoteToGuidance] = useState(item.proposal.promoteToGuidance)
  const pending = item.status === 'pending' || item.status === 'conflict' || item.status === 'validation-failed'

  useEffect(() => {
    setReason(item.proposal.reason)
    setAfterByPath(Object.fromEntries(item.proposal.files.map((file) => [file.relativePath, file.after])))
    setPromoteToGuidance(item.proposal.promoteToGuidance)
  }, [item.proposal])

  const title = t('knowledgeProposalTitle')
  const status = statusLabel(t, item.status)

  function buildOptions(): KnowledgeProposalRespondOptions {
    return {
      reason,
      promoteToGuidance,
      terminalEvidence: item.proposal.terminalEvidence,
      files: item.proposal.files.map((file) => ({
        relativePath: file.relativePath,
        before: file.before,
        after: afterByPath[file.relativePath] ?? file.after,
      })),
    }
  }

  return (
    <section
      className={`chat-approval-card chat-approval-knowledge${pending ? '' : ' chat-approval-resolved'}`}
      aria-label={title}
    >
      <div className="chat-approval-heading">
        <strong>{title}</strong>
        <span className="chat-approval-status" role="status">{status}</span>
      </div>
      <p className="chat-approval-hint">{t('knowledgeProposalHint')}</p>
      <dl className="chat-approval-meta">
        <div>
          <dt>{t('knowledgeProposalTarget')}</dt>
          <dd>{item.proposal.targetName} ({item.proposal.targetKind})</dd>
        </div>
        <div>
          <dt>{t('knowledgeProposalBase')}</dt>
          <dd>
            r{item.proposal.baseRevision} · {item.proposal.baseContentHash.slice(0, 12)}
          </dd>
        </div>
      </dl>
      {item.proposal.conflict ? (
        <p className="chat-approval-conflict" role="alert">
          {t('knowledgeProposalConflict', {
            revision: String(item.proposal.conflict.currentRevision),
          })}
        </p>
      ) : null}
      {item.message ? (
        <p className="chat-approval-message" role="status">{item.message}</p>
      ) : null}

      {editing ? (
        <label className="chat-approval-field">
          <span>{t('knowledgeProposalReason')}</span>
          <textarea
            value={reason}
            rows={2}
            onChange={(event) => setReason(event.target.value)}
            disabled={responding || !pending}
          />
        </label>
      ) : (
        <p className="chat-approval-reason">
          <strong>{t('knowledgeProposalReason')}: </strong>
          {item.proposal.reason}
        </p>
      )}

      {item.proposal.terminalEvidence ? (
        <details className="chat-approval-details">
          <summary>{t('knowledgeProposalEvidence')}</summary>
          <pre className="chat-approval-content">{item.proposal.terminalEvidence}</pre>
        </details>
      ) : null}

      {item.proposal.knowledgeSources.length > 0 ? (
        <details className="chat-approval-details">
          <summary>{t('knowledgeProposalSources')}</summary>
          <ul>
            {item.proposal.knowledgeSources.map((source) => (
              <li key={`${source.objectId}:${source.relativePath ?? ''}:${source.startLine ?? 0}`}>
                {source.objectName}
                {source.relativePath ? ` / ${source.relativePath}` : ''}
                {source.revision !== undefined ? ` @ r${source.revision}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <details className="chat-approval-details" open>
        <summary>{t('knowledgeProposalDiff')}</summary>
        {editing
          ? item.proposal.files.map((file) => (
            <label key={file.relativePath} className="chat-approval-field">
              <span>{file.relativePath}</span>
              <textarea
                value={afterByPath[file.relativePath] ?? file.after}
                rows={8}
                onChange={(event) => setAfterByPath((current) => ({
                  ...current,
                  [file.relativePath]: event.target.value,
                }))}
                disabled={responding || !pending}
              />
            </label>
          ))
          : (
            <UnifiedDiffView
              className="chat-approval-content"
              diff={item.unifiedDiff}
              aria-label={t('knowledgeProposalDiff')}
            />
          )}
      </details>

      {item.proposal.targetKind === 'knowledge' ? (
        <label className="chat-approval-checkbox">
          <input
            type="checkbox"
            checked={promoteToGuidance}
            disabled={responding || !pending}
            onChange={(event) => setPromoteToGuidance(event.target.checked)}
          />
          <span>{t('knowledgeProposalPromoteGuidance')}</span>
        </label>
      ) : null}

      {pending ? (
        <div className="chat-approval-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={responding}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? t('knowledgeProposalDoneEdit') : t('knowledgeProposalEdit')}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={responding}
            onClick={() => onRespond(item, false)}
          >
            {t('knowledgeProposalReject')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={responding}
            onClick={() => onRespond(item, true, buildOptions())}
          >
            {t('knowledgeProposalAccept')}
          </button>
        </div>
      ) : null}
    </section>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

function statusLabel(
  t: Translate,
  status: ApprovalItem['status'],
): string {
  if (status === 'pending') return t('approvalPending')
  if (status === 'approved') return t('approvalApproved')
  if (status === 'rejected') return t('approvalRejected')
  if (status === 'cancelled') return t('approvalCancelled')
  if (status === 'expired') return t('approvalExpired')
  if (status === 'conflict') return t('knowledgeProposalConflictStatus')
  return t('knowledgeProposalValidationFailed')
}
