import type { HostProfile, HostStore, KnowledgeRepository } from '@spotshell/core'
import type { SessionEnvironmentAccess } from './SessionManager'

export class HostEnvironmentBindings implements SessionEnvironmentAccess {
  constructor(
    private readonly hostStore: HostStore,
    private readonly knowledgeRepository: KnowledgeRepository,
  ) {}

  getBoundEnvironmentId(hostId: string): string | undefined {
    return this.hostStore.get(hostId)?.environmentId
  }

  async environmentExists(environmentId: string): Promise<boolean> {
    try {
      await this.knowledgeRepository.getEnvironment(environmentId)
      return true
    } catch {
      return false
    }
  }

  async assertEnvironmentExists(environmentId: string): Promise<void> {
    if (!await this.environmentExists(environmentId)) {
      throw new Error(`Environment profile not found: ${environmentId}`)
    }
  }

  setBoundEnvironmentId(hostId: string, environmentId: string | undefined): void {
    this.hostStore.update(hostId, { environmentId })
  }

  async getEnvironmentName(environmentId: string): Promise<string | undefined> {
    try {
      const environment = await this.knowledgeRepository.getEnvironment(environmentId)
      return environment.name
    } catch {
      return undefined
    }
  }

  listHosts(environmentId: string): HostProfile[] {
    return this.hostStore.listByEnvironmentId(environmentId)
  }
}
