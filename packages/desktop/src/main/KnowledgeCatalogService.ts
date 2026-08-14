import {
  KnowledgeHarness,
  queryKnowledgeCatalog,
  resolveKnowledgeCatalog,
  type KnowledgeCatalogQueryResult,
  type KnowledgeCatalogSources,
  type KnowledgeCatalogQuery,
  type KnowledgeObjectHandle,
  type KnowledgeRepository,
  type ResolvedKnowledgeCatalog,
} from '@spotshell/core'
import type { ModuleAuthorizationStore } from './ModuleAuthorizationStore'

interface KnowledgeCatalogRequestContext {
  environmentId?: string
  sessionAuthorizedIds?: readonly string[]
}

export interface ResolveKnowledgeCatalogRequest extends KnowledgeCatalogRequestContext {
  catalogBudgetTokens: number
}

export interface QueryKnowledgeCatalogRequest
  extends KnowledgeCatalogQuery, KnowledgeCatalogRequestContext {}

export interface KnowledgeHarnessSessionScope {
  environmentId?: string
  pinnedModuleIds: readonly string[]
  dynamicModuleIds: readonly string[]
  /**
   * Agent-active revisions pinned by the session. Missing ids resolve to the
   * latest published revision (first activation). Activatable candidates always
   * use latest until the user selects them into the active set.
   */
  activeRevisions?: ReadonlyMap<string, number>
}

export class KnowledgeCatalogService {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly authorizations: ModuleAuthorizationStore,
  ) {}

  async resolveForRequest(
    request: ResolveKnowledgeCatalogRequest,
  ): Promise<ResolvedKnowledgeCatalog> {
    const sources = await this.sourcesForRequest(request)
    return resolveKnowledgeCatalog(sources, {
      catalogBudgetTokens: request.catalogBudgetTokens,
    })
  }

  async isAuthorizedCandidate(environmentId: string | undefined, moduleId: string): Promise<boolean> {
    const catalog = await this.resolveForRequest({
      environmentId,
      catalogBudgetTokens: Number.MAX_SAFE_INTEGER,
    })
    return catalog.candidates.entries.some((entry) => entry.id === moduleId)
  }

  /**
   * Whether the Agent may propose a change to this knowledge module in the
   * current session. Includes environment-fixed, session pinned/dynamic, and
   * authorized on-demand candidates — not "write permission" (proposals never write directly).
   */
  async isProposalAllowedModule(
    environmentId: string | undefined,
    moduleId: string,
    sessionModuleIds: readonly string[] = [],
  ): Promise<boolean> {
    if (sessionModuleIds.includes(moduleId)) return true
    const catalog = await this.resolveForRequest({
      environmentId,
      sessionAuthorizedIds: sessionModuleIds,
      catalogBudgetTokens: Number.MAX_SAFE_INTEGER,
    })
    if (catalog.fixed.some((entry) => entry.id === moduleId)) return true
    if (catalog.candidates.entries.some((entry) => entry.id === moduleId)) return true
    return false
  }

  async queryForRequest(
    request: QueryKnowledgeCatalogRequest,
  ): Promise<KnowledgeCatalogQueryResult> {
    const sources = await this.sourcesForRequest(request)
    return queryKnowledgeCatalog(sources, request)
  }

  /** Resolve the latest published revision for update-available checks. */
  async resolveLatestPublished(id: string) {
    return this.repository.resolvePublishedObject(id)
  }

  /** Read published revision files for AI proposal base materialization. */
  async readPublishedRevisionFiles(id: string, revision?: number) {
    return this.repository.readPublishedRevisionFiles(id, revision)
  }

  /** Apply an accepted AI proposal through the normal publish pipeline. */
  async applyAcceptedKnowledgeProposal(
    id: string,
    options: {
      expectedKind: 'environment' | 'knowledge'
      baseRevision: number
      baseContentHash: string
      files: readonly { relativePath: string; content: string }[]
    },
  ) {
    return this.repository.applyAcceptedKnowledgeProposal(id, options)
  }

  /** Build a read-only harness for the current session environment and loaded modules. */
  async buildHarness(scope: KnowledgeHarnessSessionScope): Promise<KnowledgeHarness> {
    const sessionAuthorizedIds = [
      ...new Set([...scope.pinnedModuleIds, ...scope.dynamicModuleIds]),
    ]
    const catalog = await this.resolveForRequest({
      environmentId: scope.environmentId,
      sessionAuthorizedIds,
      catalogBudgetTokens: Number.MAX_SAFE_INTEGER,
    })

    const objects = new Map<string, KnowledgeObjectHandle>()
    const fixedIds = new Set<string>([
      ...catalog.fixed.map((entry) => entry.id),
      ...scope.pinnedModuleIds,
    ])
    const dynamicIds = new Set(scope.dynamicModuleIds)
    const activeRevisions = scope.activeRevisions

    if (scope.environmentId) {
      const environment = await this.resolveScopedObject(scope.environmentId, activeRevisions)
      if (environment && environment.kind === 'environment') {
        objects.set(environment.id, {
          id: environment.id,
          name: environment.name,
          kind: 'environment',
          revision: environment.revision,
          contentHash: environment.contentHash,
          rootPath: environment.rootPath,
          access: 'environment',
          guidanceFiles: [],
        })
        for (const moduleId of environment.alwaysModuleIds) {
          fixedIds.add(moduleId)
        }
      }
    }

    for (const moduleId of fixedIds) {
      if (objects.has(moduleId)) continue
      const published = await this.resolveScopedObject(moduleId, activeRevisions)
      if (!published || published.kind !== 'knowledge') continue
      objects.set(published.id, {
        id: published.id,
        name: published.name,
        kind: 'knowledge',
        revision: published.revision,
        contentHash: published.contentHash,
        rootPath: published.rootPath,
        access: 'fixed',
        guidanceFiles: published.guidanceFiles,
      })
    }

    for (const moduleId of dynamicIds) {
      if (objects.has(moduleId)) continue
      const published = await this.resolveScopedObject(moduleId, activeRevisions)
      if (!published || published.kind !== 'knowledge') continue
      objects.set(published.id, {
        id: published.id,
        name: published.name,
        kind: 'knowledge',
        revision: published.revision,
        contentHash: published.contentHash,
        rootPath: published.rootPath,
        access: 'dynamic',
        guidanceFiles: published.guidanceFiles,
      })
    }

    const catalogEntries = [
      ...catalog.fixed.map((entry) => ({ ...entry, scope: entry.scope })),
      ...catalog.candidates.entries,
    ]
    const activatable: KnowledgeObjectHandle[] = []
    for (const entry of catalog.candidates.entries) {
      if (objects.has(entry.id)) continue
      // Candidates always expose the latest revision until the user selects them.
      const published = await this.repository.resolvePublishedObject(entry.id)
      if (!published || published.kind !== 'knowledge') continue
      activatable.push({
        id: published.id,
        name: published.name,
        kind: 'knowledge',
        revision: published.revision,
        contentHash: published.contentHash,
        rootPath: published.rootPath,
        access: 'dynamic',
        guidanceFiles: published.guidanceFiles,
      })
    }

    return new KnowledgeHarness({
      objects: [...objects.values()],
      catalog: catalogEntries,
      activatable,
    })
  }

  private async resolveScopedObject(
    id: string,
    activeRevisions: ReadonlyMap<string, number> | undefined,
  ) {
    const pinnedRevision = activeRevisions?.get(id)
    return this.repository.resolvePublishedObject(id, pinnedRevision)
  }

  private async sourcesForRequest(
    request: KnowledgeCatalogRequestContext,
  ): Promise<KnowledgeCatalogSources> {
    const [availableModules, eligibleModules, environments] = await Promise.all([
      this.repository.listPublished(),
      this.repository.listAutomaticCandidates(),
      request.environmentId ? this.repository.listPublishedEnvironments() : Promise.resolve([]),
    ])
    const environment = request.environmentId
      ? environments.find((candidate) => candidate.id === request.environmentId)
      : undefined
    if (request.environmentId && !environment) {
      throw new Error(`Published environment profile not found: ${request.environmentId}`)
    }
    return {
      availableModules,
      eligibleModules,
      environment,
      sessionAuthorizedIds: request.sessionAuthorizedIds,
      globalAuthorizedIds: this.authorizations.listGlobalOnDemandIds(),
    }
  }
}
