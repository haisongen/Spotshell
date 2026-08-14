import fs from 'node:fs'
import path from 'node:path'
import type { RiskLevel } from '@spotshell/core'

export interface AuditRecord {
  sessionId: string
  host: string
  tool: 'execute_ssh_command' | 'write_to_terminal'
  command: string
  risk: RiskLevel
  decision: 'auto' | 'confirmed' | 'denied' | 'timeout'
  exitCode?: number | null
  durationMs?: number
  timedOut?: boolean
}

export class AuditLog {
  constructor(
    private readonly filePath: string,
    private readonly maxBytes = 10 * 1024 * 1024
  ) {}

  append(record: AuditRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size >= this.maxBytes) {
        const rotated = `${this.filePath}.1`
        fs.rmSync(rotated, { force: true })
        fs.renameSync(this.filePath, rotated)
      }
      fs.appendFileSync(
        this.filePath,
        `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`,
        'utf8'
      )
    } catch {
      // Auditing must never interrupt command execution.
    }
  }
}
