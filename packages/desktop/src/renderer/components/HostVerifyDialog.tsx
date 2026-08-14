import type { HostVerifyRequest } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'

interface HostVerifyDialogProps {
  request: HostVerifyRequest | null
  onRespond: (ok: boolean) => void
}

export function HostVerifyDialog({ request, onRespond }: HostVerifyDialogProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!request) return null

  const target = `${request.host}:${request.port}`
  const changed = Boolean(request.knownFingerprint)

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>{changed ? t('hostKeyChangedTitle') : t('hostKeyNewTitle')}</h2>
        </div>
        <div className="modal-body">
          <p className={changed ? 'form-error' : 'hint'}>
            {changed
              ? t('hostKeyChangedHint', { host: target })
              : t('hostKeyNewHint', { host: target })}
          </p>
          {changed ? (
            <pre className="host-verify-fingerprint">
              {t('hostKeyKnown')}: {request.knownFingerprint}
            </pre>
          ) : null}
          <pre className="host-verify-fingerprint">{request.fingerprint}</pre>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onRespond(false)}>
              {t('cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onRespond(true)}>
              {changed ? t('hostKeyTrustNew') : t('hostKeyTrust')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
