import type { ContextBoundaryPayload } from '../shared/ipc-types'

export type ContextBoundaryView = ContextBoundaryPayload

export function formatBoundaryTime(createdAt: string, locale: string): string {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return createdAt
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Build a user-visible label for a context boundary marker. */
export function formatContextBoundaryLabel(
  boundary: ContextBoundaryPayload,
  language: 'en' | 'zh-CN',
): string {
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en-US'
  const time = formatBoundaryTime(boundary.createdAt, locale)
  const epochLabel = language === 'zh-CN'
    ? `上下文 #${boundary.epoch}`
    : `Context #${boundary.epoch}`

  if (boundary.reason === 'environment-switch') {
    const from = boundary.fromEnvironmentName
      ?? boundary.fromEnvironmentId
      ?? (language === 'zh-CN' ? '无环境' : 'No environment')
    const to = boundary.toEnvironmentName
      ?? boundary.toEnvironmentId
      ?? (language === 'zh-CN' ? '无环境' : 'No environment')
    return language === 'zh-CN'
      ? `${epochLabel} · ${time} · 环境：${from} → ${to}`
      : `${epochLabel} · ${time} · Environment: ${from} → ${to}`
  }

  return language === 'zh-CN'
    ? `${epochLabel} · ${time} · 已开启新上下文`
    : `${epochLabel} · ${time} · New agent context`
}
