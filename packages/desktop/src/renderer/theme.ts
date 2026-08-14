import type { ITheme } from '@xterm/xterm'
import type { AppTheme } from '../shared/ipc-types'

export const TERMINAL_THEMES: Record<AppTheme, ITheme> = {
  dark: {
    background: '#0f1115',
    foreground: '#e6e6e6',
    cursor: '#e6e6e6',
    cursorAccent: '#0f1115',
    selectionBackground: 'rgba(91, 140, 255, 0.35)',
    selectionInactiveBackground: 'rgba(91, 140, 255, 0.2)',
    black: '#171b22',
    red: '#ff6b6b',
    green: '#5bd6a2',
    yellow: '#e6b84d',
    blue: '#7aa2ff',
    magenta: '#c792ea',
    cyan: '#79d8ff',
    white: '#e6e6e6',
    brightBlack: '#6d7787',
    brightRed: '#ff8a8a',
    brightGreen: '#7ce8ba',
    brightYellow: '#f1cc70',
    brightBlue: '#9abaff',
    brightMagenta: '#ddb0f3',
    brightCyan: '#9ce5ff',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#fbfcfe',
    foreground: '#17202a',
    cursor: '#17202a',
    cursorAccent: '#fbfcfe',
    selectionBackground: 'rgba(53, 106, 230, 0.28)',
    selectionInactiveBackground: 'rgba(53, 106, 230, 0.16)',
    black: '#18202b',
    red: '#b52f3f',
    green: '#0f7059',
    yellow: '#765000',
    blue: '#2456c7',
    magenta: '#7a329b',
    cyan: '#08717d',
    white: '#5b6878',
    brightBlack: '#526071',
    brightRed: '#c43d4b',
    brightGreen: '#147d64',
    brightYellow: '#8a5d00',
    brightBlue: '#356ae6',
    brightMagenta: '#9147b5',
    brightCyan: '#087985',
    brightWhite: '#3d4a5a',
  },
}

export function getNextTheme(theme: AppTheme): AppTheme {
  return theme === 'dark' ? 'light' : 'dark'
}

export function getTerminalTheme(theme: AppTheme): ITheme {
  return TERMINAL_THEMES[theme]
}
