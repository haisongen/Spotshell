import {
  classifyCommand,
  formatCommandResult,
  type CommandResult,
  type ExecPolicy,
  type RiskLevel,
  type SSHExecutor,
} from '@spotshell/core'
import type { AuditRecord } from './AuditLog'

export type ToolName = 'execute_ssh_command' | 'write_to_terminal'

export interface ToolEndMeta {
  risk: RiskLevel
  decision: 'auto' | 'confirmed' | 'denied' | 'timeout'
  exitCode?: number | null
  durationMs?: number
  timedOut?: boolean
}

export type ToolEventSink = (
  phase: 'start' | 'end',
  name: ToolName,
  command: string,
  output?: string,
  meta?: ToolEndMeta
) => void

export interface PolicyExecutorDeps {
  getPolicy: () => ExecPolicy
  requestConfirm: (command: string, risk: RiskLevel) => Promise<boolean>
  onTool?: ToolEventSink
  /**
   * Fired around an allowed remote exec (not during confirm wait).
   * Used to gate new-context while a side-effecting SSH command is running.
   */
  onAgentCommandRunning?: (running: boolean) => void
  audit?: (record: Omit<AuditRecord, 'sessionId' | 'host'>) => void
}

const OUTPUT_PREVIEW_LIMIT = 4000

interface Decision {
  allowed: boolean
  risk: RiskLevel
  decision: ToolEndMeta['decision']
  reason?: string
}

export class PolicyExecutor implements SSHExecutor {
  constructor(
    private readonly inner: SSHExecutor,
    private readonly deps: PolicyExecutorDeps
  ) {}

  async execute(command: string): Promise<CommandResult> {
    const tool = 'execute_ssh_command'
    this.deps.onTool?.('start', tool, command)
    const decision = await this.decide(command)

    if (!decision.allowed) {
      const denied: CommandResult = {
        command,
        stdout: '',
        stderr: decision.reason ?? '用户取消了命令执行',
        exitCode: null,
        durationMs: 0,
        timedOut: false,
      }
      const meta = this.resultMeta(decision, denied)
      this.deps.onTool?.('end', tool, command, denied.stderr, meta)
      this.audit(tool, command, meta)
      return denied
    }

    // Confirmed commands already bumped the busy gate in requestConfirm on approve.
    // Auto-allowed commands (readonly / auto policy) need the gate here.
    const alreadyGated = decision.decision === 'confirmed'
    if (!alreadyGated) this.deps.onAgentCommandRunning?.(true)
    try {
      const result = await this.inner.execute(command)
      const meta = this.resultMeta(decision, result)
      this.deps.onTool?.(
        'end',
        tool,
        command,
        formatCommandResult(result).slice(0, OUTPUT_PREVIEW_LIMIT),
        meta
      )
      this.audit(tool, command, meta)
      return result
    } finally {
      // Always release: confirmed path decrements the pre-approve bump.
      this.deps.onAgentCommandRunning?.(false)
    }
  }

  async write(data: string): Promise<boolean> {
    const tool = 'write_to_terminal'
    this.deps.onTool?.('start', tool, data)
    const decision = await this.decide(data)

    if (!decision.allowed) {
      const output = decision.reason ?? '用户取消了终端输入'
      const meta: ToolEndMeta = { risk: decision.risk, decision: decision.decision }
      this.deps.onTool?.('end', tool, data, output, meta)
      this.audit(tool, data, meta)
      return false
    }

    const ok = await this.inner.write(data)
    const meta: ToolEndMeta = { risk: decision.risk, decision: decision.decision }
    this.deps.onTool?.('end', tool, data, ok ? '已写入终端' : '写入失败（连接不可用）', meta)
    this.audit(tool, data, meta)
    return ok
  }

  private async decide(command: string): Promise<Decision> {
    const risk = classifyCommand(command)
    const policy = this.deps.getPolicy()
    if (risk === 'readonly') return { allowed: true, risk, decision: 'auto' }
    if (policy === 'readonly') {
      return {
        allowed: false,
        risk,
        decision: 'denied',
        reason: '当前会话为只读策略，已拒绝写入类命令',
      }
    }
    if (policy === 'auto' && risk === 'write') return { allowed: true, risk, decision: 'auto' }
    const ok = await this.deps.requestConfirm(command, risk)
    return ok
      ? { allowed: true, risk, decision: 'confirmed' }
      : { allowed: false, risk, decision: 'denied', reason: '用户取消了命令执行' }
  }

  private resultMeta(decision: Decision, result: CommandResult): ToolEndMeta {
    return {
      risk: decision.risk,
      decision: decision.decision,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    }
  }

  private audit(tool: ToolName, command: string, meta: ToolEndMeta): void {
    this.deps.audit?.({ tool, command, ...meta })
  }
}
