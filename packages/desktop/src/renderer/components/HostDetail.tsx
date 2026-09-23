import { Pencil, Plug } from 'lucide-react'
import type { EnvironmentSummary, HostFolder, SavedHostProfile } from '../../shared/ipc-types'
import { formatHostTarget } from '../hostManagement'
import { buildHostTree, getHostTreeFolderPath } from '../hostTree'
import { useTranslation } from '../i18n'
import { HostNotesEditor } from './HostNotesEditor'
import { TierBadge } from './TierBadge'

interface HostDetailProps {
  host: SavedHostProfile
  folders: HostFolder[]
  environments: EnvironmentSummary[]
  connecting: boolean
  onConnect: (host: SavedHostProfile) => void
  onEdit: (host: SavedHostProfile) => void
  /** Opens the one-off connection dialog for an address that is not saved. */
  onQuickConnect: () => void
  onNotesSaved: () => Promise<void> | void
}

export function HostDetail({
  host,
  folders,
  environments,
  connecting,
  onConnect,
  onEdit,
  onQuickConnect,
  onNotesSaved,
}: HostDetailProps): JSX.Element {
  const { t } = useTranslation()
  const folderPath = getHostTreeFolderPath(
    buildHostTree({ folders, hosts: [] }, { rootName: t('mainFolder') }),
    host.folderId,
  ).map((folder) => folder.name).join(' / ')
  const environment = host.environmentId
    ? environments.find((entry) => entry.id === host.environmentId)?.name ?? t('missingEnvironmentBinding')
    : t('noAutomaticEnvironment')
  const authLabel = host.authMethod === 'agent'
    ? t('sshAgent')
    : host.authMethod === 'password' || (!host.authMethod && host.hasPassword)
      ? t('password')
      : t('privateKey')

  return (
    <div className="host-detail">
      <section className="host-detail-card" aria-labelledby="host-detail-title">
        <header className="host-detail-header">
          <div className="host-detail-title">
            <h2 id="host-detail-title">{host.name}</h2>
            <TierBadge tier={host.tier} />
          </div>
          <div className="host-detail-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(host)}>
              <Pencil size={13} aria-hidden="true" />
              {t('editHost')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={connecting}
              onClick={() => onConnect(host)}
            >
              <Plug size={14} aria-hidden="true" />
              {connecting ? t('connecting') : t('connect')}
            </button>
          </div>
        </header>
        <dl className="host-detail-meta">
          <div>
            <dt>{t('hostDetailAddress')}</dt>
            <dd className="host-detail-address">{formatHostTarget(host)}</dd>
          </div>
          <div>
            <dt>{t('auth')}</dt>
            <dd>{authLabel}</dd>
          </div>
          <div>
            <dt>{t('hostDetailFolder')}</dt>
            <dd>{folderPath}</dd>
          </div>
          <div>
            <dt>{t('automaticEnvironment')}</dt>
            <dd>{environment}</dd>
          </div>
        </dl>
        <HostNotesEditor host={host} onSaved={onNotesSaved} />
      </section>
      <p className="host-detail-footer">
        <button type="button" className="link-button" onClick={onQuickConnect}>
          {t('hostDetailQuickConnect')}
        </button>
      </p>
    </div>
  )
}
