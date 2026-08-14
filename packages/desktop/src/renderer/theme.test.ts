import assert from 'node:assert/strict'
import test from 'node:test'
import { getNextTheme, TERMINAL_THEMES } from './theme'

const LIGHT_TERMINAL_FOREGROUND_KEYS = [
  'foreground',
  'cursor',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

function relativeLuminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i)
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  )
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

test('getNextTheme switches symmetrically between the two supported themes', () => {
  assert.equal(getNextTheme('dark'), 'light')
  assert.equal(getNextTheme('light'), 'dark')
  assert.equal(getNextTheme(getNextTheme('dark')), 'dark')
})

test('each terminal theme defines its core surface and selection colors', () => {
  for (const theme of Object.values(TERMINAL_THEMES)) {
    assert.ok(theme.background)
    assert.ok(theme.foreground)
    assert.ok(theme.cursor)
    assert.ok(theme.selectionBackground)
  }

  assert.notEqual(TERMINAL_THEMES.dark.background, TERMINAL_THEMES.light.background)
  assert.notEqual(TERMINAL_THEMES.dark.foreground, TERMINAL_THEMES.light.foreground)
})

test('every light terminal foreground color meets WCAG AA contrast', () => {
  const theme = TERMINAL_THEMES.light
  assert.ok(theme.background)

  for (const key of LIGHT_TERMINAL_FOREGROUND_KEYS) {
    const color = theme[key]
    assert.ok(color, `${key} must be defined`)
    const ratio = contrastRatio(color, theme.background)
    assert.ok(
      ratio >= 4.5,
      `${key} must have at least 4.5:1 contrast, received ${ratio.toFixed(2)}:1`
    )
  }
})
