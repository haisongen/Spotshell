import type { KnowledgeModuleAccessSummary, SessionSummary } from '../shared/ipc-types'

export type ChatContextAction = 'load' | 'pin' | 'unload' | 'unpin' | 'manage'
type ChatContextEntryAction = Exclude<ChatContextAction, 'pin'>

export interface ChatContextEntry {
  id: string
  name: string
  description: string
  action: ChatContextEntryAction
}

export interface ChatContextGroups {
  fixed: ChatContextEntry[]
  dynamic: ChatContextEntry[]
  candidates: ChatContextEntry[]
}

export function availableChatContextActions(entry: ChatContextEntry): ChatContextAction[] {
  if (entry.action === 'manage') return ['manage']
  if (entry.action === 'load') return ['manage', 'load', 'pin']
  if (entry.action === 'unload') return ['manage', 'pin', 'unload']
  return ['manage', 'unpin']
}

export function deriveChatContext(
  session: SessionSummary,
  modules: readonly KnowledgeModuleAccessSummary[],
): ChatContextGroups {
  const pinnedIds = new Set(session.pinnedModuleIds)
  const dynamicIds = new Set(session.dynamicModuleIds)
  const fixed: ChatContextEntry[] = []
  const dynamic: ChatContextEntry[] = []
  const candidates: ChatContextEntry[] = []

  for (const module of modules) {
    const environmentAlways = module.environmentAlways.some((entry) => entry.id === session.environmentId)
    const environmentOnDemand = module.environmentOnDemand.some((entry) => entry.id === session.environmentId)
    if (environmentAlways) {
      fixed.push(toEntry(module, 'manage'))
    } else if (pinnedIds.has(module.id)) {
      fixed.push(toEntry(module, 'unpin'))
    } else if (dynamicIds.has(module.id)) {
      dynamic.push(toEntry(module, 'unload'))
    } else if (module.automaticCandidateEligible && (module.globalOnDemand || environmentOnDemand)) {
      candidates.push(toEntry(module, 'load'))
    }
  }

  return {
    fixed: sortEntries(fixed),
    dynamic: sortEntries(dynamic),
    candidates: sortEntries(candidates),
  }
}

function toEntry(
  module: KnowledgeModuleAccessSummary,
  action: ChatContextEntryAction,
): ChatContextEntry {
  return {
    id: module.id,
    name: module.name,
    description: module.description,
    action,
  }
}

function sortEntries(entries: ChatContextEntry[]): ChatContextEntry[] {
  return entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
}
