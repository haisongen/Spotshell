import type { ContextSlotId, ContextUsageSnapshot } from '../shared/ipc-types'

export interface ContextUsageRow {
  id: ContextSlotId
  estimatedTokens: number
  sharePercent: number
  estimated: true
}

export interface ContextUsageViewModel {
  contextWindowTokens: number
  availableInputBudget: number
  usedInputTokens: number
  usedPercent: number
  estimated: true
  slots: ContextUsageRow[]
  omittedGuidance: ContextUsageSnapshot['omittedGuidance']
  conflictCount: number
  conflicts: ContextUsageSnapshot['conflicts']
  providerUsage?: ContextUsageSnapshot['providerUsage']
}

const METER_SLOT_ORDER: readonly ContextSlotId[] = [
  'system',
  'environment',
  'hostNotes',
  'guidance',
  'catalog',
  'reference',
  'userQuotes',
  'terminal',
  'chat',
  'compactionSummary',
]

/** Build a stable, renderer-friendly view of a usage snapshot. */
export function deriveContextUsageView(
  usage: ContextUsageSnapshot | undefined,
): ContextUsageViewModel | null {
  if (!usage) return null
  const budget = Math.max(0, usage.availableInputBudget)
  const used = Math.max(0, usage.usedInputTokens)
  const slotMap = new Map(usage.slots.map((slot) => [slot.id, slot]))
  const slots: ContextUsageRow[] = METER_SLOT_ORDER.map((id) => {
    const slot = slotMap.get(id)
    const estimatedTokens = slot?.estimatedTokens ?? 0
    return {
      id,
      estimatedTokens,
      sharePercent: budget > 0 ? (estimatedTokens / budget) * 100 : 0,
      estimated: true as const,
    }
  }).filter((row) => row.estimatedTokens > 0 || row.id === 'system' || row.id === 'chat')

  return {
    contextWindowTokens: usage.contextWindowTokens,
    availableInputBudget: budget,
    usedInputTokens: used,
    usedPercent: budget > 0 ? Math.min(100, (used / budget) * 100) : 0,
    estimated: true,
    slots,
    omittedGuidance: usage.omittedGuidance,
    conflictCount: usage.conflictCount,
    conflicts: usage.conflicts ?? [],
    ...(usage.providerUsage ? { providerUsage: usage.providerUsage } : {}),
  }
}

export function formatTokenCount(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`
  return String(Math.round(value))
}
