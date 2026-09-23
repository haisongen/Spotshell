import { useTranslation } from '../i18n'
import { hostTierClass, hostTierLabelKey, hostTierShortLabelKey, type HostTier } from '../hostTierView'

interface TierBadgeProps {
  tier: HostTier | undefined
  /** Short labels (PROD / 生产) for tight spots such as session tabs. */
  compact?: boolean
  className?: string
}

/** Coloured tier label; renders nothing for unmarked hosts. */
export function TierBadge({ tier, compact = false, className }: TierBadgeProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!tier) return null
  const label = t(hostTierLabelKey(tier))
  return (
    <span
      className={`tier-badge ${hostTierClass(tier)}${className ? ` ${className}` : ''}`}
      title={`${t('hostTier')}: ${label}`}
    >
      {compact ? t(hostTierShortLabelKey(tier)) : label}
    </span>
  )
}
