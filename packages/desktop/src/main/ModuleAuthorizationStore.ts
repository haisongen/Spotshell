import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const moduleIdSchema = z.string().uuid()
const authorizationFileSchema = z.object({
  version: z.literal(1),
  globalOnDemand: z.array(moduleIdSchema),
}).strict()

export class ModuleAuthorizationStore {
  constructor(private readonly filePath: string) {}

  listGlobalOnDemandIds(): string[] {
    return [...this.readIds()].sort((left, right) => left.localeCompare(right, 'en-US'))
  }

  isGlobalOnDemand(moduleId: string): boolean {
    return this.readIds().has(moduleIdSchema.parse(moduleId))
  }

  setGlobalOnDemand(moduleId: string, authorized: boolean): void {
    const id = moduleIdSchema.parse(moduleId)
    const ids = this.readIds()
    if (authorized) ids.add(id)
    else ids.delete(id)
    this.writeIds(ids)
  }

  private readIds(): Set<string> {
    if (!fs.existsSync(this.filePath)) return new Set()
    try {
      const parsed = authorizationFileSchema.parse(
        JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      )
      return new Set(parsed.globalOnDemand)
    } catch {
      return new Set()
    }
  }

  private writeIds(ids: ReadonlySet<string>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    const data = {
      version: 1 as const,
      globalOnDemand: [...ids].sort((left, right) => left.localeCompare(right, 'en-US')),
    }
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      fs.renameSync(temporaryPath, this.filePath)
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true })
      throw error
    }
  }
}
