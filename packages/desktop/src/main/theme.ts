import { nativeTheme, type BrowserWindow } from 'electron'
import type { AppTheme } from '../shared/ipc-types'

export const NATIVE_WINDOW_BACKGROUND: Record<AppTheme, string> = {
  dark: '#0f1115',
  light: '#f4f6f8',
}

export const TITLE_BAR_HEIGHT = 40

export const NATIVE_TITLE_BAR_OVERLAY: Record<
  AppTheme,
  { color: string; symbolColor: string; height: number }
> = {
  dark: { color: '#161a22', symbolColor: '#e6e6e6', height: TITLE_BAR_HEIGHT },
  light: { color: '#ffffff', symbolColor: '#18202b', height: TITLE_BAR_HEIGHT },
}

export function applyNativeTheme(theme: AppTheme, window?: BrowserWindow | null): void {
  nativeTheme.themeSource = theme
  window?.setBackgroundColor(NATIVE_WINDOW_BACKGROUND[theme])
  window?.setTitleBarOverlay(NATIVE_TITLE_BAR_OVERLAY[theme])
}
