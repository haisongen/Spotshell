import {
  ensureOfficialSeedModules,
  listOfficialSeedStatuses,
  previewRestoreOfficialSeed,
  restoreAllOfficialSeeds,
  restoreOfficialSeed,
  type KnowledgeRepository,
  type ModuleImportConflictResolution,
  type SeedEnsureResult,
  type SeedModuleStatus,
  type SeedRestorePreview,
  type SeedRestoreResult,
} from '@spotshell/core'
import type { ModuleAuthorizationStore } from './ModuleAuthorizationStore'

async function grantGlobalOnDemandIfEligible(
  repository: KnowledgeRepository,
  authorizations: ModuleAuthorizationStore,
  moduleId: string,
): Promise<void> {
  const candidates = await repository.listAutomaticCandidates()
  if (candidates.some((candidate) => candidate.id === moduleId)) {
    authorizations.setGlobalOnDemand(moduleId, true)
  }
}

/** One-time seed of the seven diagnostic knowledge modules (ADR-051/052). */
export async function runOfficialSeedMigration(
  repository: KnowledgeRepository,
  rootPath: string,
  authorizations: ModuleAuthorizationStore,
): Promise<SeedEnsureResult> {
  return ensureOfficialSeedModules({
    repository,
    rootPath,
    onCreated: async (_seed, result) => {
      await grantGlobalOnDemandIfEligible(repository, authorizations, result.id)
    },
  })
}

export async function listSeedModuleStatuses(
  repository: KnowledgeRepository,
  rootPath: string,
): Promise<SeedModuleStatus[]> {
  return listOfficialSeedStatuses({ repository, rootPath })
}

export async function previewSeedModuleRestore(
  repository: KnowledgeRepository,
  rootPath: string,
  seedKey: string,
): Promise<SeedRestorePreview> {
  return previewRestoreOfficialSeed({ repository, rootPath, seedKey })
}

export async function restoreSeedModule(
  repository: KnowledgeRepository,
  rootPath: string,
  authorizations: ModuleAuthorizationStore,
  request: {
    seedKey: string
    conflictResolution?: ModuleImportConflictResolution
    authorizeGlobalOnDemand?: boolean
  },
): Promise<SeedRestoreResult> {
  const authorize = request.authorizeGlobalOnDemand !== false
  return restoreOfficialSeed({
    repository,
    rootPath,
    seedKey: request.seedKey,
    conflictResolution: request.conflictResolution,
    onRestored: authorize
      ? async (_seed, id) => {
        await grantGlobalOnDemandIfEligible(repository, authorizations, id)
      }
      : undefined,
  })
}

export async function restoreAllSeedModules(
  repository: KnowledgeRepository,
  rootPath: string,
  authorizations: ModuleAuthorizationStore,
  request: {
    conflictResolution?: ModuleImportConflictResolution
    authorizeGlobalOnDemand?: boolean
  } = {},
): Promise<SeedRestoreResult[]> {
  const authorize = request.authorizeGlobalOnDemand !== false
  return restoreAllOfficialSeeds({
    repository,
    rootPath,
    conflictResolution: request.conflictResolution,
    onRestored: authorize
      ? async (_seed, id) => {
        await grantGlobalOnDemandIfEligible(repository, authorizations, id)
      }
      : undefined,
  })
}
