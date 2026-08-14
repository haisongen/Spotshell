import { splitCodeBlocks } from '../../shared/chatSegments'
import type { KnowledgeProvenanceRecord } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'

interface AssistantMessageProps {
  content: string
  provenance?: KnowledgeProvenanceRecord[]
  onInsert?: (command: string) => void
  onRun?: (command: string) => void
  onOpenKnowledge?: (objectId: string) => void
}

function dedupeProvenance(
  records: readonly KnowledgeProvenanceRecord[],
): KnowledgeProvenanceRecord[] {
  const seen = new Set<string>()
  const unique: KnowledgeProvenanceRecord[] = []
  for (const record of records) {
    const key = [
      record.objectId,
      record.revision,
      record.relativePath,
      record.startLine,
      record.endLine,
      record.contentType,
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(record)
  }
  return unique
}

function formatLocation(record: KnowledgeProvenanceRecord): string {
  if (record.startLine === record.endLine) {
    return `${record.relativePath}:${record.startLine}`
  }
  return `${record.relativePath}:${record.startLine}-${record.endLine}`
}

export function AssistantMessage({
  content,
  provenance,
  onInsert,
  onRun,
  onOpenKnowledge,
}: AssistantMessageProps): JSX.Element {
  const { t } = useTranslation()
  const segments = splitCodeBlocks(content)
  const sources = provenance && provenance.length > 0
    ? dedupeProvenance(provenance)
    : []

  return (
    <div className="assistant-message">
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <pre key={index} className="chat-bubble-body">{segment.content}</pre>
        ) : (
          <div key={index} className="command-block">
            <pre className="command-block-code">{segment.content}</pre>
            <div className="command-block-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => void window.spotshell.clipboardWriteText(segment.content)}
              >
                {t('copyCommand')}
              </button>
              {onInsert ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => onInsert(segment.content)}
                >
                  {t('insertCommand')}
                </button>
              ) : null}
              {onRun ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => onRun(segment.content)}
                >
                  {t('runCommand')}
                </button>
              ) : null}
            </div>
          </div>
        )
      )}
      {sources.length > 0 ? (
        <div className="knowledge-provenance" aria-label={t('knowledgeUsedThisTurn')}>
          <div className="knowledge-provenance-title">{t('knowledgeUsedThisTurn')}</div>
          <ul className="knowledge-provenance-list">
            {sources.map((record) => (
              <li key={[
                record.objectId,
                record.revision,
                record.relativePath,
                record.startLine,
                record.endLine,
              ].join(':')}
              >
                {onOpenKnowledge ? (
                  <button
                    type="button"
                    className="knowledge-provenance-link"
                    onClick={() => onOpenKnowledge(record.objectId)}
                    title={`${record.objectName} · r${record.revision} · ${formatLocation(record)}`}
                  >
                    <span className="knowledge-provenance-name">{record.objectName}</span>
                    <span className="knowledge-provenance-meta">
                      {`r${record.revision} · ${formatLocation(record)}`}
                    </span>
                  </button>
                ) : (
                  <span className="knowledge-provenance-static">
                    <span className="knowledge-provenance-name">{record.objectName}</span>
                    <span className="knowledge-provenance-meta">
                      {`r${record.revision} · ${formatLocation(record)}`}
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
