import { useState } from 'react'
import type { ToolEndEventMeta } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'

interface ToolCardProps {
  command: string
  output: string
  meta?: ToolEndEventMeta
  pending: boolean
}

export function ToolCard({ command, output, meta, pending }: ToolCardProps): JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const lines = output.split(/\r?\n/)
  const collapsible = lines.length > 3
  const visibleOutput = expanded || !collapsible ? output : lines.slice(0, 3).join('\n')
  const riskLabel = meta?.risk === 'destructive'
    ? t('riskDestructive')
    : meta?.risk === 'write'
      ? t('riskWrite')
      : t('riskReadonly')

  return (
    <div className="tool-card">
      <div className="tool-card-header">
        <code className="tool-card-command">$ {command}</code>
        <div className="tool-card-meta">
          {meta ? <span className={`tool-badge tool-risk-${meta.risk}`}>{riskLabel}</span> : null}
          {meta?.exitCode != null ? (
            <span className={`tool-badge${meta.exitCode === 0 ? '' : ' tool-exit-error'}`}>
              {t('exitCodeLabel')} {meta.exitCode}
            </span>
          ) : null}
          {meta?.durationMs != null ? (
            <span className="tool-badge">{t('durationLabel')} {(meta.durationMs / 1000).toFixed(1)}s</span>
          ) : null}
          {meta?.decision === 'denied' ? (
            <span className="tool-badge tool-exit-error">{t('decisionDenied')}</span>
          ) : null}
        </div>
      </div>
      {pending ? (
        <pre className="tool-card-output">... {t('running')}</pre>
      ) : (
        <>
          <pre className="tool-card-output">{visibleOutput}</pre>
          {collapsible ? (
            <button
              type="button"
              className="tool-card-toggle"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t('collapseOutput') : t('expandOutput')}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
