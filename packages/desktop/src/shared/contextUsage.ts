import type { ContextAssemblyResult } from '@spotshell/core'
import type { ContextUsageSnapshot } from './ipc-types'

/** Project assembler output into a renderer-safe usage snapshot. */
export function toContextUsageSnapshot(assembly: ContextAssemblyResult): ContextUsageSnapshot {
  return {
    contextWindowTokens: assembly.contextWindowTokens,
    outputReserveTokens: assembly.outputReserveTokens,
    safetyReserveTokens: assembly.safetyReserveTokens,
    availableInputBudget: assembly.availableInputBudget,
    usedInputTokens: assembly.usedInputTokens,
    estimated: true,
    slots: assembly.slots.map((slot) => ({
      id: slot.id,
      estimatedTokens: slot.estimatedTokens,
      shareOfInputBudget: slot.shareOfInputBudget,
      estimated: true as const,
    })),
    omittedGuidance: assembly.omittedGuidance.map((rule) => ({
      id: rule.id,
      moduleName: rule.moduleName,
      sourceLayer: rule.sourceLayer,
    })),
    conflictCount: assembly.conflicts.length,
    conflicts: assembly.conflicts.map((conflict) => ({
      leftId: conflict.left.id,
      leftText: conflict.left.text,
      leftModuleName: conflict.left.moduleName,
      rightId: conflict.right.id,
      rightText: conflict.right.text,
      rightModuleName: conflict.right.moduleName,
    })),
    ...(assembly.providerUsage
      ? {
          providerUsage: {
            promptTokens: assembly.providerUsage.promptTokens,
            completionTokens: assembly.providerUsage.completionTokens,
            totalTokens: assembly.providerUsage.totalTokens,
          },
        }
      : {}),
  }
}
