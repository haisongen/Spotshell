import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type { SSHExecutor } from './types.js';
import { logger } from '../utils/logger.js';
import { formatCommandResult } from './format.js';
import { createKnowledgeTools, type KnowledgeToolAccess } from './knowledgeTools.js';

type ExecuteCommandInput = { command: string };
type WriteToTerminalInput = { text: string };
type SendCtrlCInput = Record<string, never>;
type ToolFactory = (
  func: (input: any) => Promise<string>,
  fields: { name: string; description: string; schema: z.ZodTypeAny }
) => StructuredToolInterface;

const makeTool = tool as unknown as ToolFactory;

export interface KnowledgeChangeProposalRequest {
  targetKind: 'host-notes' | 'environment' | 'knowledge';
  targetId: string;
  reason: string;
  /** Terminal evidence only — host never auto-writes this as knowledge. */
  terminalEvidence?: string;
  /**
   * Proposed file bodies. Host fills `before` from the current base revision.
   * Host Notes use relativePath `"notes"`.
   */
  files: Array<{ relativePath: string; after: string }>;
}

/** One landing place the model proposes for a knowledge change. */
export interface KnowledgeTargetCandidate {
  kind: 'host-notes' | 'environment' | 'knowledge';
  targetId: string;
  /** Human-readable name shown on the choice card. */
  label: string;
  /** Why the model believes this is the right landing place. */
  reason: string;
}

export interface KnowledgeTargetQuestion {
  question: string;
  candidates: KnowledgeTargetCandidate[];
}

export interface SSHToolExtras {
  /**
   * 知识写回能力：向宿主（desktop main）提议保存一条主机备注。
   * 返回值即工具结果文本（"已保存"/"用户未确认"/"备注已满"等），由宿主决定措辞。
   */
  proposeHostNote?: (note: string) => Promise<string>;
  /**
   * Single-target knowledge change proposal (Host Notes / environment / module).
   * Agent never writes knowledge directly; host shows a review card.
   */
  proposeKnowledgeChange?: (request: KnowledgeChangeProposalRequest) => Promise<string>;
  /**
   * Ask the user which knowledge object a change should land in, and block until
   * they answer. The host renders a choice card; the returned string is fed back
   * to the model verbatim as the tool result, so the host owns the wording for
   * "chose X" / "declined" / "no answer in time".
   */
  askKnowledgeTarget?: (question: KnowledgeTargetQuestion) => Promise<string>;
  /**
   * 只读个人知识 Harness 访问器。由宿主在每次 chat 前装入当前会话授权对象。
   */
  knowledge?: KnowledgeToolAccess;
}

/** POSIX 单引号包裹：内容里的单引号转义为 '\''，其余原样（含 $、;、空格均失效为字面量） */
export function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const DEFAULT_READ_BYTES = 8_192;
const MAX_READ_BYTES = 65_536;
const GREP_OUTPUT_CAP = 16_384;
const DEFAULT_GREP_MATCHES = 100;
const MAX_GREP_MATCHES = 500;

export function createSSHTools(
  executor: SSHExecutor,
  extras: SSHToolExtras = {}
): StructuredToolInterface[] {
  const executeCommand = makeTool(
    async ({ command }: ExecuteCommandInput): Promise<string> => {
      try {
        logger.info(`Tool execute_ssh_command: ${command}`);
        const result = await executor.execute(command);
        const formatted = formatCommandResult(result);
        logger.debug(`Tool execute_ssh_command output:\n${formatted}`);
        return formatted;
      } catch (error) {
        logger.warn(`Tool execute_ssh_command error: ${(error as Error).message}`);
        return `执行错误: ${(error as Error).message}`;
      }
    },
    {
      name: 'execute_ssh_command',
      description: '在远程 SSH 服务器上执行命令并返回输出。用于执行 shell 命令、查看文件、检查状态等。',
      schema: z.object({
        command: z.string().describe('要执行的 shell 命令'),
      }),
    }
  );

  const writeToTerminal = makeTool(
    async ({ text }: WriteToTerminalInput): Promise<string> => {
      try {
        const ok = await executor.write(text);
        return ok ? `已发送: ${text}` : '发送被拒绝或失败（用户未确认，或连接不可用）';
      } catch (error) {
        return `发送失败: ${(error as Error).message}`;
      }
    },
    {
      name: 'write_to_terminal',
      description: '向终端发送文本（不自动添加换行符）。用于交互式输入或发送特定按键序列。',
      schema: z.object({
        text: z.string().describe('要发送到终端的文本'),
      }),
    }
  );

  const sendCtrlC = makeTool(
    async (_: SendCtrlCInput): Promise<string> => {
      try {
        const ok = await executor.write('\x03');
        return ok ? '已发送 Ctrl+C' : '发送被拒绝或失败（用户未确认，或连接不可用）';
      } catch (error) {
        return `发送失败: ${(error as Error).message}`;
      }
    },
    {
      name: 'send_ctrl_c',
      description: '向终端发送 Ctrl+C 信号，用于中断正在运行的命令。',
      schema: z.object({}),
    }
  );

  const readRemoteFile = makeTool(
    async ({ path, startLine, endLine, maxBytes }: {
      path: string; startLine?: number; endLine?: number; maxBytes?: number;
    }): Promise<string> => {
      try {
        const cap = Math.min(maxBytes ?? DEFAULT_READ_BYTES, MAX_READ_BYTES);
        const quotedPath = shellQuoteArg(path);
        const command = startLine
          ? `sed -n ${shellQuoteArg(`${startLine},${endLine ?? '$'}p`)} -- ${quotedPath} | head -c ${cap}`
          : `head -c ${cap} -- ${quotedPath}`;
        logger.info(`Tool read_remote_file: ${command}`);
        const result = await executor.execute(command);
        return formatCommandResult(result);
      } catch (error) {
        return `读取失败: ${(error as Error).message}`;
      }
    },
    {
      name: 'read_remote_file',
      description:
        '只读读取远程文件内容（可指定行范围与字节上限，默认 8KB、最大 64KB）。' +
        '读文件优先用本工具而不是 cat（自动限量、任何策略下免确认）。',
      schema: z.object({
        path: z.string().describe('远程文件绝对路径'),
        startLine: z.number().int().min(1).optional().describe('起始行（1-based，含）'),
        endLine: z.number().int().min(1).optional().describe('结束行（含）；省略则读到文件尾'),
        maxBytes: z.number().int().min(1).optional()
          .describe('返回字节上限，默认 8192'),
      }),
    }
  );

  const grepRemoteLogs = makeTool(
    async ({ path, pattern, maxMatches, ignoreCase }: {
      path: string; pattern: string; maxMatches?: number; ignoreCase?: boolean;
    }): Promise<string> => {
      try {
        const limit = Math.min(maxMatches ?? DEFAULT_GREP_MATCHES, MAX_GREP_MATCHES);
        const flags = `-n ${ignoreCase ? '-i ' : ''}-m ${limit}`;
        const command =
          `grep ${flags} -e ${shellQuoteArg(pattern)} -- ${shellQuoteArg(path)}` +
          ` | head -c ${GREP_OUTPUT_CAP}`;
        logger.info(`Tool grep_remote_logs: ${command}`);
        const result = await executor.execute(command);
        return formatCommandResult(result);
      } catch (error) {
        return `搜索失败: ${(error as Error).message}`;
      }
    },
    {
      name: 'grep_remote_logs',
      description:
        '在远程文件中搜索文本（带行号，命中数与输出大小有上限）。' +
        '注意：exit_code=1 表示无匹配，不是失败，不要重试。',
      schema: z.object({
        path: z.string().describe('远程文件绝对路径'),
        pattern: z.string().describe('搜索模式（grep 基础正则）'),
        maxMatches: z.number().int().min(1).max(MAX_GREP_MATCHES).optional()
          .describe('最多返回多少个匹配，默认 100'),
        ignoreCase: z.boolean().optional().describe('忽略大小写'),
      }),
    }
  );

  const tools = [executeCommand, writeToTerminal, sendCtrlC, readRemoteFile, grepRemoteLogs];
  const proposeHostNote = extras.proposeHostNote;
  const proposeKnowledgeChange = extras.proposeKnowledgeChange;
  const askKnowledgeTarget = extras.askKnowledgeTarget;

  if (askKnowledgeTarget) {
    tools.push(makeTool(
      async (input: KnowledgeTargetQuestion): Promise<string> => {
        try {
          logger.info(
            `Tool ask_knowledge_target: ${input.candidates.length} candidates`,
          );
          return await askKnowledgeTarget({
            question: input.question,
            candidates: input.candidates,
          });
        } catch (error) {
          return `提问失败: ${(error as Error).message}`;
        }
      },
      {
        name: 'ask_knowledge_target',
        description:
          '询问用户这条知识应该沉淀到哪里，并等待用户在界面上选择。' +
          '调用 propose_knowledge_change / propose_host_note 之前必须先调用本工具，' +
          '除非用户在本轮对话里已经明确点名了落点。' +
          '不要用普通回复文字提问代替本工具——那样不会真正等待用户。' +
          '候选项应来自 list_knowledge_catalog 等工具看到的真实对象；' +
          '本工具只用于选择落点，不要拿它问别的问题。',
        schema: z.object({
          question: z.string().min(1).max(500)
            .describe('一句话说明要沉淀什么内容，供用户判断落点'),
          candidates: z.array(z.object({
            kind: z.enum(['host-notes', 'environment', 'knowledge'])
              .describe('落点层级'),
            targetId: z.string().min(1).max(200)
              .describe('Host id（host-notes）或对象稳定 UUID（environment/knowledge）'),
            label: z.string().min(1).max(120)
              .describe('展示给用户的名称，例如环境档案或模块名'),
            reason: z.string().min(1).max(300)
              .describe('为什么建议写到这里'),
          })).min(1).max(6)
            .describe('建议的落点候选；用户也可以一个都不选'),
        }),
      }
    ));
  }

  if (proposeHostNote) {
    tools.push(makeTool(
      async ({ note }: { note: string }): Promise<string> => {
        try {
          logger.info(`Tool propose_host_note: ${note}`);
          return await proposeHostNote(note);
        } catch (error) {
          return `保存失败: ${(error as Error).message}`;
        }
      },
      {
        name: 'propose_host_note',
        description:
          '仅当用户已明确选择写入主机备注（Host Notes）、且内容是本机独有长期事实时使用。' +
          '若可能属于环境档案或可复用知识模块，先问用户落点，不要默认用本工具。' +
          '只写持久事实，不写一次性状态；不能直接写知识；终端输出只作证据。',
        schema: z.object({
          note: z.string().min(1).max(500)
            .describe('一句话结论，不含敏感信息（密码/密钥/token）'),
        }),
      }
    ));
  }

  if (proposeKnowledgeChange) {
    tools.push(makeTool(
      async (input: {
        targetKind: 'host-notes' | 'environment' | 'knowledge';
        targetId: string;
        reason: string;
        terminalEvidence?: string;
        files: Array<{ relativePath: string; after: string }>;
      }): Promise<string> => {
        try {
          logger.info(
            `Tool propose_knowledge_change: ${input.targetKind} ${input.targetId} (${input.files.length} files)`,
          );
          return await proposeKnowledgeChange({
            targetKind: input.targetKind,
            targetId: input.targetId,
            reason: input.reason,
            terminalEvidence: input.terminalEvidence,
            files: input.files,
          });
        } catch (error) {
          return `提案失败: ${(error as Error).message}`;
        }
      },
      {
        name: 'propose_knowledge_change',
        description:
          '提议对唯一目标的知识变更（需用户在 Chat 审阅）。' +
          '调用前必须先问清用户落点：环境档案(environment)还是知识模块(knowledge)；仅本机例外时才用 host-notes。' +
          '用户未明确选择前不要调用本工具。每次只改一个目标；提供完整 after 内容、修改理由与终端证据。' +
          '不能直接写知识、批量改写、改授权或自动提升 Guidance。终端输出只作证据。',
        schema: z.object({
          targetKind: z.enum(['host-notes', 'environment', 'knowledge'])
            .describe('唯一写入层级；必须与用户已确认的选择一致'),
          targetId: z.string().min(1)
            .describe('Host id（host-notes）或对象稳定 UUID（environment/knowledge）'),
          reason: z.string().min(1).max(1000)
            .describe('修改理由'),
          terminalEvidence: z.string().max(4000).optional()
            .describe('支撑修改的终端输出摘录（证据，不会自动写入知识）'),
          files: z.array(z.object({
            relativePath: z.string().min(1).max(240)
              .describe('对象内相对路径；Host Notes 使用 notes；入口用 SPACE.md'),
            after: z.string().max(200_000)
              .describe('提议的完整新内容（不是 unified diff 片段）'),
          })).min(1).max(20),
        }),
      }
    ));
  }

  if (extras.knowledge) {
    tools.push(...createKnowledgeTools(extras.knowledge));
  }

  return tools;
}
