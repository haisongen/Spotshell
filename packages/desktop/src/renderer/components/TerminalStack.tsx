import { AlertTriangle, LoaderCircle, RefreshCw, X } from 'lucide-react'
import type { AppTheme, SessionSummary } from '../../shared/ipc-types'
import { connectionErrorTranslationKey } from '../sessionConnectionState'
import { useTranslation } from '../i18n'
import { TerminalView } from './TerminalView'

interface TerminalStackProps {
  theme: AppTheme
  sessions: SessionSummary[]
  activeSessionId: string | null
  reconnectingSessionIds?: ReadonlySet<string>
  onReconnect?: (sessionId: string) => void
  onClose?: (sessionId: string) => void
  onAskAi?: (sessionId: string, text: string) => void
}

function showConnectionOverlay(status: SessionSummary['status']): boolean {
  return status === 'connecting' || status === 'disconnected' || status === 'error'
}

/** Keep one xterm per session mounted; hide inactive with display:none so scrollback survives. */
export function TerminalStack({
  theme,
  sessions,
  activeSessionId,
  reconnectingSessionIds = new Set(),
  onReconnect,
  onClose,
  onAskAi,
}: TerminalStackProps): JSX.Element {
  const { t } = useTranslation()
  if (sessions.length === 0) {
    return <div className="terminal-stack terminal-stack-empty" />
  }

  return (
    <div className="terminal-stack">
      {sessions.map((session) => {
        const active = session.id === activeSessionId
        const overlay = showConnectionOverlay(session.status)
        const reconnecting = reconnectingSessionIds.has(session.id)
        const connecting = session.status === 'connecting'
        return (
          <div
            key={session.id}
            className={`terminal-stack-pane${active ? ' active' : ''}`}
            style={{ display: active ? 'flex' : 'none' }}
            aria-hidden={!active}
          >
            <TerminalView
              theme={theme}
              sessionId={session.id}
              active={active && !overlay}
              onAskAi={(text) => onAskAi?.(session.id, text)}
            />
            {overlay ? (
              <div className="session-disconnect-overlay">
                <section className="session-disconnect-card" aria-live="polite">
                  <div className={`session-connection-icon status-${session.status}`}>
                    {connecting ? (
                      <LoaderCircle size={22} className="session-connection-spinner" aria-hidden />
                    ) : (
                      <AlertTriangle size={22} aria-hidden />
                    )}
                  </div>
                  <h3>
                    {connecting
                      ? reconnecting
                        ? t('reconnecting')
                        : t('connecting')
                      : session.status === 'error'
                        ? t('connectionError')
                        : t('disconnected')}
                  </h3>
                  {!connecting ? (
                    <p className={session.status === 'error' ? 'session-error-summary' : 'muted'}>
                      {session.status === 'error'
                        ? t(connectionErrorTranslationKey(session.errorKind))
                        : t('sessionDisconnected')}
                    </p>
                  ) : null}
                  {!connecting && session.errorMessage ? (
                    <details className="session-error-details">
                      <summary>{t('technicalDetails')}</summary>
                      <pre>{session.errorMessage}</pre>
                    </details>
                  ) : null}
                  <div className="session-connection-actions">
                    {!connecting && onReconnect ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={reconnecting}
                        onClick={() => onReconnect(session.id)}
                      >
                        <RefreshCw size={15} aria-hidden />
                        <span>{reconnecting ? t('reconnecting') : t('reconnect')}</span>
                      </button>
                    ) : null}
                    {onClose ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => onClose(session.id)}
                      >
                        <X size={15} aria-hidden />
                        <span>{t('closeWorkspace')}</span>
                      </button>
                    ) : null}
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
