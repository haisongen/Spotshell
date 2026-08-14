import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  CircleCheck,
  BookOpen,
  KeyRound,
  Moon,
  Settings,
  SquareTerminal,
  Sun,
  TriangleAlert,
} from 'lucide-react'
import type { AppMenuId, AppTheme } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'
import { APP_MENU_IDS, getMenuKeyAction, getMenuPopupRequest } from '../titleBarMenu'

interface AppTitleBarProps {
  hasApiKey: boolean
  theme: AppTheme
  themeSaving: boolean
  onToggleTheme: () => void
  onOpenSettings: () => void
  onMenuError: (message: string) => void
  activeWorkspace: 'terminal' | 'knowledge'
  onChangeWorkspace: (workspace: 'terminal' | 'knowledge') => void
}

const MENU_LABEL_KEYS: Record<AppMenuId, 'menuFile' | 'menuEdit' | 'menuView' | 'menuWindow' | 'menuHelp'> = {
  file: 'menuFile',
  edit: 'menuEdit',
  view: 'menuView',
  window: 'menuWindow',
  help: 'menuHelp',
}

export function AppTitleBar({
  hasApiKey,
  theme,
  themeSaving,
  onToggleTheme,
  onOpenSettings,
  onMenuError,
  activeWorkspace,
  onChangeWorkspace,
}: AppTitleBarProps): JSX.Element {
  const { language, t } = useTranslation()
  const [focusedMenuId, setFocusedMenuId] = useState<AppMenuId>('file')
  const [activeMenuId, setActiveMenuId] = useState<AppMenuId | null>(null)
  const triggerRefs = useRef<Partial<Record<AppMenuId, HTMLButtonElement | null>>>({})

  const focusMenu = useCallback((menuId: AppMenuId): void => {
    setFocusedMenuId(menuId)
    triggerRefs.current[menuId]?.focus()
  }, [])

  const openMenu = useCallback(async (menuId: AppMenuId): Promise<void> => {
    if (activeMenuId) return
    const trigger = triggerRefs.current[menuId]
    if (!trigger) return

    setFocusedMenuId(menuId)
    setActiveMenuId(menuId)
    try {
      await window.spotshell.popupApplicationMenu(getMenuPopupRequest(menuId, trigger.getBoundingClientRect()))
    } catch (error: unknown) {
      onMenuError(error instanceof Error ? error.message : String(error))
    } finally {
      setActiveMenuId(null)
      if (document.hasFocus() && trigger.isConnected) trigger.focus()
    }
  }, [activeMenuId, onMenuError])

  useEffect(() => {
    const handleF10 = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'F10' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      focusMenu('file')
    }
    window.addEventListener('keydown', handleF10)
    return () => window.removeEventListener('keydown', handleF10)
  }, [focusMenu])

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLButtonElement>, menuId: AppMenuId): void => {
    const action = getMenuKeyAction(menuId, event.key)
    if (!action) return
    event.preventDefault()
    if (action.type === 'focus') focusMenu(action.menuId)
    else void openMenu(menuId)
  }

  const apiStatusText = hasApiKey ? t('apiKeySet') : t('apiKeyMissing')
  const themeActionText = theme === 'dark' ? t('switchToLightTheme') : t('switchToDarkTheme')

  return (
    <header className="app-title-bar">
      <div className="title-bar-brand">
        <SquareTerminal size={16} aria-hidden="true" />
        <span>SpotShell</span>
      </div>

      <nav className="title-bar-menubar" role="menubar" aria-label={t('applicationMenu')} lang={language}>
        {APP_MENU_IDS.map((menuId) => (
          <button
            key={menuId}
            ref={(element) => {
              triggerRefs.current[menuId] = element
            }}
            type="button"
            className={`title-bar-menu-trigger${activeMenuId === menuId ? ' is-open' : ''}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeMenuId === menuId}
            tabIndex={focusedMenuId === menuId ? 0 : -1}
            onFocus={() => setFocusedMenuId(menuId)}
            onKeyDown={(event) => handleMenuKeyDown(event, menuId)}
            onClick={() => {
              void openMenu(menuId)
            }}
          >
            {t(MENU_LABEL_KEYS[menuId])}
          </button>
        ))}
      </nav>

      <div className="title-bar-workspace-switch" role="group" aria-label={t('workspaceSwitcher')}>
        <button
          type="button"
          className={activeWorkspace === 'terminal' ? 'active' : ''}
          aria-pressed={activeWorkspace === 'terminal'}
          aria-label={t('terminalWorkspace')}
          title={t('terminalWorkspace')}
          onClick={() => onChangeWorkspace('terminal')}
        >
          <SquareTerminal size={14} aria-hidden="true" />
          {t('terminalWorkspace')}
        </button>
        <button
          type="button"
          className={activeWorkspace === 'knowledge' ? 'active' : ''}
          aria-pressed={activeWorkspace === 'knowledge'}
          aria-label={t('knowledgeWorkspace')}
          title={t('knowledgeWorkspace')}
          onClick={() => onChangeWorkspace('knowledge')}
        >
          <BookOpen size={14} aria-hidden="true" />
          {t('knowledgeWorkspace')}
        </button>
      </div>

      <div className="title-bar-drag-space" aria-hidden="true" />

      <div className="title-bar-actions">
        <span
          className={`api-key-status ${hasApiKey ? 'is-configured' : 'is-missing'}`}
          role="status"
          aria-label={apiStatusText}
          title={apiStatusText}
        >
          <KeyRound className="api-key-icon" size={16} aria-hidden="true" />
          {hasApiKey ? (
            <CircleCheck className="api-key-status-mark" size={11} aria-hidden="true" />
          ) : (
            <TriangleAlert className="api-key-status-mark" size={11} aria-hidden="true" />
          )}
        </span>
        <button
          type="button"
          className="title-bar-icon-button"
          title={themeActionText}
          aria-label={themeActionText}
          disabled={themeSaving}
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? (
            <Sun size={16} aria-hidden="true" />
          ) : (
            <Moon size={16} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="title-bar-icon-button"
          title={t('settings')}
          aria-label={t('settings')}
          onClick={onOpenSettings}
        >
          <Settings size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
