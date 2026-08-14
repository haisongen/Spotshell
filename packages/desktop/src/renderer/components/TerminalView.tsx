import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getAskAiSelection } from '../../shared/terminalSelection'
import type { AppTheme } from '../../shared/ipc-types'
import { useTranslation } from '../i18n'
import { getTerminalTheme } from '../theme'

interface TerminalViewProps {
  theme: AppTheme
  sessionId: string
  /** When true, terminal is visible — re-fit and focus on activate. */
  active?: boolean
  onAskAi?: (text: string) => void
}

interface ContextMenuPosition {
  x: number
  y: number
  canPaste: boolean
  askAiSelection: string | null
}

export function TerminalView({
  theme,
  sessionId,
  active = true,
  onAskAi,
}: TerminalViewProps): JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null)

  const copySelection = useCallback(() => {
    const selection = termRef.current?.getSelection() ?? ''
    if (selection) void window.spotshell.clipboardWriteText(selection)
  }, [])

  const pasteClipboard = useCallback(async () => {
    const text = await window.spotshell.clipboardReadText()
    if (text) termRef.current?.paste(text)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      theme: getTerminalTheme(theme),
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fitRef.current = fit
    termRef.current = term

    try {
      fit.fit()
      if (term.cols > 0 && term.rows > 0) {
        window.spotshell.termResize(sessionId, term.cols, term.rows)
      }
    } catch {
      // container may not be laid out yet
    }

    if (active) {
      term.focus()
    }

    const dataDisp = term.onData((data) => {
      window.spotshell.termInput(sessionId, data)
    })

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true

      if (event.code === 'KeyC' && term.hasSelection()) {
        void window.spotshell.clipboardWriteText(term.getSelection())
        return false
      }
      if (event.code === 'KeyV') {
        void window.spotshell.clipboardReadText().then((text) => {
          if (text) term.paste(text)
        })
        return false
      }
      return true
    })

    const handleMouseUp = (event: MouseEvent): void => {
      if (event.button === 0 && term.hasSelection()) {
        void window.spotshell.clipboardWriteText(term.getSelection())
      }
    }
    container.addEventListener('mouseup', handleMouseUp)

    const handleContextMenu = async (event: MouseEvent): Promise<void> => {
      event.preventDefault()

      const clipboardText = await window.spotshell.clipboardReadText()
      if (!term.hasSelection()) {
        if (clipboardText) term.paste(clipboardText)
        term.focus()
        return
      }

      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        canPaste: Boolean(clipboardText),
        askAiSelection: getAskAiSelection(term.hasSelection(), term.getSelection()),
      })
    }
    container.addEventListener('contextmenu', handleContextMenu)

    // Keep writing while hidden so scrollback stays current
    const offOut = window.spotshell.onTermOutput(({ sessionId: id, data }) => {
      if (id === sessionId) term.write(data)
    })

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return
      // Skip zero-size (display:none) so we don't send bogus dimensions
      if (containerRef.current.clientWidth === 0 || containerRef.current.clientHeight === 0) {
        return
      }
      try {
        fit.fit()
        if (term.cols > 0 && term.rows > 0) {
          window.spotshell.termResize(sessionId, term.cols, term.rows)
        }
      } catch {
        // container may be detaching
      }
    })
    ro.observe(containerRef.current)

    return () => {
      dataDisp.dispose()
      offOut()
      ro.disconnect()
      container.removeEventListener('mouseup', handleMouseUp)
      container.removeEventListener('contextmenu', handleContextMenu)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // sessionId is stable per mounted instance; remount only when session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = getTerminalTheme(theme)
  }, [theme])

  useEffect(() => {
    if (!contextMenu) return

    const closeMenu = (): void => setContextMenu(null)
    const handlePointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) closeMenu()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeMenu()
        termRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('resize', closeMenu)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('resize', closeMenu)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!contextMenu || !menuRef.current) return

    const rect = menuRef.current.getBoundingClientRect()
    const edgeGap = 8
    const x = Math.min(contextMenu.x, window.innerWidth - rect.width - edgeGap)
    const y = Math.min(contextMenu.y, window.innerHeight - rect.height - edgeGap)
    if (x !== contextMenu.x || y !== contextMenu.y) {
      setContextMenu({
        x: Math.max(edgeGap, x),
        y: Math.max(edgeGap, y),
        canPaste: contextMenu.canPaste,
        askAiSelection: contextMenu.askAiSelection,
      })
    }
  }, [contextMenu])

  // Re-fit + focus when this pane becomes the active tab
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    const el = containerRef.current
    if (!term || !fit || !el) return

    // Defer so display:flex has applied and dimensions are real
    const id = requestAnimationFrame(() => {
      try {
        if (el.clientWidth === 0 || el.clientHeight === 0) return
        fit.fit()
        if (term.cols > 0 && term.rows > 0) {
          window.spotshell.termResize(sessionId, term.cols, term.rows)
        }
        term.focus()
      } catch {
        // ignore fit errors during transitions
      }
    })
    return () => cancelAnimationFrame(id)
  }, [active, sessionId])

  return (
    <div className="terminal-view" ref={containerRef}>
      {contextMenu && (
        <div
          ref={menuRef}
          className="terminal-context-menu"
          role="menu"
          aria-label={t('terminalActions')}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              copySelection()
              setContextMenu(null)
              termRef.current?.focus()
            }}
          >
            <span>{t('copy')}</span>
            <kbd>Ctrl+Shift+C</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!contextMenu.canPaste}
            onClick={() => {
              void pasteClipboard()
              setContextMenu(null)
              termRef.current?.focus()
            }}
          >
            <span>{t('paste')}</span>
            <kbd>Ctrl+Shift+V</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!contextMenu.askAiSelection || !onAskAi}
            onClick={() => {
              if (contextMenu.askAiSelection) onAskAi?.(contextMenu.askAiSelection)
              setContextMenu(null)
              termRef.current?.focus()
            }}
          >
            <span>{t('askAi')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
