import type { ContextSlotId, ContextUsageSnapshot } from '../../shared/ipc-types'
import { deriveContextUsageView, formatTokenCount } from '../contextUsageState'
import { useTranslation } from '../i18n'

const SLOT_LABEL_KEYS: Record<ContextSlotId, string> = {
  system: 'usageSlotSystem',
  environment: 'usageSlotEnvironment',
  hostNotes: 'usageSlotHostNotes',
  guidance: 'usageSlotGuidance',
  catalog: 'usageSlotCatalog',
  reference: 'usageSlotReference',
  userQuotes: 'usageSlotUserQuotes',
  terminal: 'usageSlotTerminal',
  chat: 'usageSlotChat',
  compactionSummary: 'usageSlotCompaction',
}

interface ContextUsageMeterProps {
  usage?: ContextUsageSnapshot
}

export function ContextUsageMeter({ usage }: ContextUsageMeterProps): JSX.Element | null {
  const { t } = useTranslation()
  const view = deriveContextUsageView(usage)
  if (!view) return null

  const summary = t('usageSummary', {
    used: formatTokenCount(view.usedInputTokens),
    budget: formatTokenCount(view.availableInputBudget),
    percent: Math.round(view.usedPercent),
  })

  return (
    <details className="context-usage-meter">
      <summary
        aria-label={summary}
        title={summary}
      >
        <span className="context-usage-bar" aria-hidden="true">
          <span
            className="context-usage-bar-fill"
            style={{ width: `${Math.min(100, view.usedPercent)}%` }}
          />
        </span>
        <span className="context-usage-summary">
          {formatTokenCount(view.usedInputTokens)}/{formatTokenCount(view.availableInputBudget)}
          {view.estimated ? ` · ${t('usageEstimated')}` : null}
        </span>
      </summary>
      <div className="context-usage-popover" role="region" aria-label={t('usageBreakdown')}>
        <p className="context-usage-budget">
          {t('usageInputBudget', {
            budget: formatTokenCount(view.availableInputBudget),
            window: formatTokenCount(view.contextWindowTokens),
          })}
          {view.estimated ? ` (${t('usageEstimated')})` : null}
        </p>
        <ul className="context-usage-slots">
          {view.slots.map((slot) => (
            <li key={slot.id}>
              <span>{t(SLOT_LABEL_KEYS[slot.id] as 'usageSlotSystem')}</span>
              <span>
                {formatTokenCount(slot.estimatedTokens)}
                {' · '}
                {Math.round(slot.sharePercent)}%
              </span>
            </li>
          ))}
        </ul>
        {view.omittedGuidance.length > 0 ? (
          <div className="context-usage-omitted">
            <h4>{t('usageOmittedGuidance')}</h4>
            <ul>
              {view.omittedGuidance.map((rule) => (
                <li key={rule.id}>{rule.moduleName ?? rule.id}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {view.conflictCount > 0 ? (
          <p className="context-usage-conflicts" role="status">
            {t('usageConflicts', { count: view.conflictCount })}
          </p>
        ) : null}
        {view.conflicts && view.conflicts.length > 0 ? (
          <ul className="context-usage-conflict-list">
            {view.conflicts.map((conflict, index) => (
              <li key={`${conflict.leftId}-${conflict.rightId}-${index}`}>
                <div>
                  <strong>{conflict.leftModuleName ?? conflict.leftId}</strong>
                  <p>{conflict.leftText}</p>
                </div>
                <div>
                  <strong>{conflict.rightModuleName ?? conflict.rightId}</strong>
                  <p>{conflict.rightText}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {view.providerUsage ? (
          <p className="context-usage-provider muted">
            {t('usageProviderActual', {
              total: formatTokenCount(view.providerUsage.totalTokens ?? 0),
            })}
          </p>
        ) : null}
      </div>
    </details>
  )
}
