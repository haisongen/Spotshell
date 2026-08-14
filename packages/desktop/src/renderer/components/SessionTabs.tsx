import type { SessionSummary } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'
import { connectionErrorTranslationKey } from '../sessionConnectionState'

interface SessionTabsProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onContextMenu?: (target: {
    sessionId: string
    x: number
    y: number
    returnFocusTo: HTMLElement
  }) => void
  /** Focus host list / start a new connection */
  onNew?: () => void
}

function statusDotClass(status: SessionSummary['status']): string {
  switch (status) {
    case 'ready':
      return 'session-status ready'
    case 'connecting':
      return 'session-status connecting'
    case 'error':
      return 'session-status error'
    default:
      return 'session-status disconnected'
  }
}

export function SessionTabs({
  sessions,
  activeSessionId,
  onSelect,
  onClose,
  onContextMenu,
  onNew,
}: SessionTabsProps): JSX.Element | null {
  const { t } = useTranslation()
  if (sessions.length === 0 && !onNew) return null

  return (
    <div className="session-tabs" role="tablist" aria-label={t('sessions')}>
      {sessions.map((session) => {
        const active = session.id === activeSessionId
        const statusTitle =
          session.status === 'error'
            ? t(connectionErrorTranslationKey(session.errorKind))
            : session.title
        return (
          <div
            key={session.id}
            className={`session-tab${active ? ' active' : ''}`}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(session.id)}
            onContextMenu={(event) => {
              event.preventDefault()
              onSelect(session.id)
              onContextMenu?.({
                sessionId: session.id,
                x: event.clientX,
                y: event.clientY,
                returnFocusTo: event.currentTarget,
              })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(session.id)
              }
            }}
          >
            <span className={statusDotClass(session.status)} aria-hidden />
            <span className="session-tab-title" title={statusTitle}>
              {session.title}
            </span>
            <button
              type="button"
              className="session-tab-close"
              title={t('closeSession', { name: session.title })}
              aria-label={t('closeSession', { name: session.title })}
              onClick={(e) => {
                e.stopPropagation()
                onClose(session.id)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      {onNew ? (
        <button
          type="button"
          className="session-tab-new"
          title={t('newConnection')}
          aria-label={t('newConnection')}
          onClick={onNew}
        >
          +
        </button>
      ) : null}
    </div>
  )
}
