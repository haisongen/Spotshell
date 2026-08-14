import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { useTranslation } from '../i18n'

export interface AppNotice {
  tone: 'success' | 'error'
  message: string
}

interface AppNoticeBannerProps {
  notice: AppNotice
  onDismiss: () => void
}

export function AppNoticeBanner({ notice, onDismiss }: AppNoticeBannerProps): JSX.Element {
  const { t } = useTranslation()
  const StatusIcon = notice.tone === 'success' ? CircleCheck : CircleAlert

  return (
    <div
      className={`app-notice app-notice-${notice.tone}`}
      role={notice.tone === 'success' ? 'status' : 'alert'}
    >
      <StatusIcon className="app-notice-icon" size={17} aria-hidden="true" />
      <span className="app-notice-message">{notice.message}</span>
      <button
        type="button"
        className="app-notice-dismiss"
        title={t('dismissMessage')}
        aria-label={t('dismissMessage')}
        onClick={onDismiss}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  )
}
