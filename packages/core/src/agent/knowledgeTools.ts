import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type {
  DynamicModuleSelection,
  KnowledgeHarness,
} from '../knowledge/knowledgeHarness.js';
import { SPACE_V1_LIMITS } from '../knowledge/limits.js';
import { logger } from '../utils/logger.js';

type ToolFactory = (
  func: (input: any) => Promise<string>,
  fields: { name: string; description: string; schema: z.ZodTypeAny }
) => StructuredToolInterface;

const makeTool = tool as unknown as ToolFactory;

const objectIdSchema = z.string().uuid().describe('Knowledge object stable ID');
const revisionSchema = z.number().int().positive().describe('Active object revision number');

export interface KnowledgeToolAccess {
  /**
   * Current turn's authorization-aware harness. When undefined, knowledge tools
   * report that no personal knowledge is available for this session.
   */
  getHarness(): KnowledgeHarness | undefined;
  /**
   * Called after a successful dynamic module selection so the host can keep the
   * module active for the current Agent context segment and emit UI events.
   */
  onModuleSelected?(selection: DynamicModuleSelection): void;
}

function requireHarness(access: KnowledgeToolAccess): KnowledgeHarness {
  const harness = access.getHarness();
  if (!harness) {
    throw new Error('No personal knowledge is available for this session');
  }
  return harness;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read-only, authorization-aware knowledge tools. No SSH, write, or network. */
export function createKnowledgeTools(access: KnowledgeToolAccess): StructuredToolInterface[] {
  const listCatalog = makeTool(
    async (): Promise<string> => {
      try {
        const harness = requireHarness(access);
        const overview = harness.listSessionOverview();
        return JSON.stringify(overview, null, 2);
      } catch (error) {
        logger.warn(`Tool list_knowledge_catalog error: ${formatError(error)}`);
        return `知识目录错误: ${formatError(error)}`;
      }
    },
    {
      name: 'list_knowledge_catalog',
      description:
        '列出当前会话可读对象（含活动修订号/哈希）与合资格候选元数据。' +
        '只返回轻量目录，不含正文；读取时必须使用返回的 objectId 与 revision。' +
        '不能应用新修订；若用户已保存更新版本，只能提示用户在界面确认应用。',
      schema: z.object({}),
    }
  );

  const selectModule = makeTool(
    async ({ objectId, reason }: { objectId: string; reason: string }): Promise<string> => {
      try {
        const harness = requireHarness(access);
        const wasActive = harness.listActiveDynamicSelections()
          .some((entry) => entry.moduleId === objectId);
        const result = await harness.selectModule(objectId, reason);
        const isActive = harness.listActiveDynamicSelections()
          .some((entry) => entry.moduleId === objectId);
        if (isActive && !wasActive) {
          access.onModuleSelected?.(result.selection);
        }
        return JSON.stringify({
          selection: result.selection,
          content: result.content,
          provenance: result.provenance,
        }, null, 2);
      } catch (error) {
        logger.warn(`Tool select_knowledge_module error: ${formatError(error)}`);
        return `选择知识模块失败: ${formatError(error)}`;
      }
    },
    {
      name: 'select_knowledge_module',
      description:
        '从当前会话已授权候选目录中选择一个知识模块并加载其 SPACE.md 入口。' +
        '必须提供 objectId 与选择原因；成功后模块在当前 Agent 上下文段保持活动。' +
        '不能选择仅拥有但未授权的对象，也不能跨对象全文搜索。' +
        '后续搜索/按行读取请使用返回的 revision。',
      schema: z.object({
        objectId: objectIdSchema,
        reason: z.string().min(1).max(500)
          .describe('为什么为当前问题选择该模块（会展示给用户）'),
      }),
    }
  );

  const readEntry = makeTool(
    async ({ objectId, revision }: { objectId: string; revision: number }): Promise<string> => {
      try {
        const harness = requireHarness(access);
        const result = await harness.readEntry(objectId, revision);
        return JSON.stringify({
          content: result.content,
          provenance: result.provenance,
        }, null, 2);
      } catch (error) {
        logger.warn(`Tool read_knowledge_entry error: ${formatError(error)}`);
        return `读取入口失败: ${formatError(error)}`;
      }
    },
    {
      name: 'read_knowledge_entry',
      description:
        '读取一个已授权且已选对象的 SPACE.md 入口文档。必须提供对象 ID 与活动修订号。',
      schema: z.object({
        objectId: objectIdSchema,
        revision: revisionSchema,
      }),
    }
  );

  const listFiles = makeTool(
    async ({ objectId, revision }: { objectId: string; revision: number }): Promise<string> => {
      try {
        const harness = requireHarness(access);
        const result = await harness.listTextFiles(objectId, revision);
        return JSON.stringify(result, null, 2);
      } catch (error) {
        logger.warn(`Tool list_knowledge_files error: ${formatError(error)}`);
        return `列举文件失败: ${formatError(error)}`;
      }
    },
    {
      name: 'list_knowledge_files',
      description:
        '列举一个已授权对象内的安全文本文件（对象相对路径）。不能跨对象或访问本机绝对路径。',
      schema: z.object({
        objectId: objectIdSchema,
        revision: revisionSchema,
      }),
    }
  );

  const searchText = makeTool(
    async ({
      objectId,
      revision,
      pattern,
      mode,
      maxMatches,
      ignoreCase,
    }: {
      objectId: string;
      revision: number;
      pattern: string;
      mode?: 'literal' | 'regex';
      maxMatches?: number;
      ignoreCase?: boolean;
    }): Promise<string> => {
      try {
        const harness = requireHarness(access);
        const result = await harness.searchText(objectId, revision, {
          pattern,
          mode: mode ?? 'literal',
          maxMatches,
          ignoreCase,
        });
        return JSON.stringify({
          matches: result.matches.map((match) => ({
            relativePath: match.relativePath,
            line: match.line,
            preview: match.preview,
            provenance: match.provenance,
          })),
          truncated: result.truncated,
        }, null, 2);
      } catch (error) {
        logger.warn(`Tool search_knowledge_text error: ${formatError(error)}`);
        return `搜索失败: ${formatError(error)}`;
      }
    },
    {
      name: 'search_knowledge_text',
      description:
        '在单个已授权对象内搜索正文（字面量或受控正则）。' +
        '必须指定对象 ID 与活动修订；有超时、命中数和预览上限。不能全库搜索。',
      schema: z.object({
        objectId: objectIdSchema,
        revision: revisionSchema,
        pattern: z.string().min(1).max(SPACE_V1_LIMITS.maxRegexPatternChars)
          .describe('字面量或正则模式'),
        mode: z.enum(['literal', 'regex']).optional()
          .describe('搜索模式，默认 literal'),
        maxMatches: z.number().int().min(1).max(SPACE_V1_LIMITS.maxSearchMatches).optional()
          .describe(`最多返回命中数，默认/上限 ${SPACE_V1_LIMITS.maxSearchMatches}`),
        ignoreCase: z.boolean().optional().describe('忽略大小写'),
      }),
    }
  );

  const readLines = makeTool(
    async ({
      objectId,
      revision,
      relativePath,
      startLine,
      maxLines,
    }: {
      objectId: string;
      revision: number;
      relativePath: string;
      startLine: number;
      maxLines?: number;
    }): Promise<string> => {
      try {
        const harness = requireHarness(access);
        const result = await harness.readLines(objectId, revision, relativePath, {
          startLine,
          maxLines,
        });
        return JSON.stringify({
          content: result.content,
          startLine: result.startLine,
          endLine: result.endLine,
          hasMore: result.hasMore,
          provenance: result.provenance,
        }, null, 2);
      } catch (error) {
        logger.warn(`Tool read_knowledge_lines error: ${formatError(error)}`);
        return `按行读取失败: ${formatError(error)}`;
      }
    },
    {
      name: 'read_knowledge_lines',
      description:
        '按对象相对路径读取有限行范围。继续阅读必须显式请求下一段（提高 startLine）。' +
        `默认最多 ${SPACE_V1_LIMITS.maxReadLines} 行。`,
      schema: z.object({
        objectId: objectIdSchema,
        revision: revisionSchema,
        relativePath: z.string().min(1).max(SPACE_V1_LIMITS.maxRelativePathChars)
          .describe('对象内相对路径，例如 references/guide.md'),
        startLine: z.number().int().min(1).describe('起始行（1-based，含）'),
        maxLines: z.number().int().min(1).max(SPACE_V1_LIMITS.maxReadLines).optional()
          .describe(`最大行数，默认/上限 ${SPACE_V1_LIMITS.maxReadLines}`),
      }),
    }
  );

  return [listCatalog, selectModule, readEntry, listFiles, searchText, readLines];
}
