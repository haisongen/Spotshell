import type { TSchema } from 'typebox';
import type { AgentToolDefinition } from './types.js';
import type {
  DynamicModuleSelection,
  KnowledgeHarness,
} from '../knowledge/knowledgeHarness.js';
import { SPACE_V1_LIMITS } from '../knowledge/limits.js';
import { logger } from '../utils/logger.js';
import {
  listKnowledgeCatalogSchema,
  listKnowledgeFilesSchema,
  readKnowledgeEntrySchema,
  readKnowledgeLinesSchema,
  searchKnowledgeTextSchema,
  selectKnowledgeModuleSchema,
  type ListKnowledgeFilesInput,
  type ReadKnowledgeEntryInput,
  type ReadKnowledgeLinesInput,
  type SearchKnowledgeTextInput,
  type SelectKnowledgeModuleInput,
} from './toolSchemas.js';

type ToolFactory = (
  func: (input: any) => Promise<string>,
  fields: { name: string; description: string; schema: TSchema }
) => AgentToolDefinition;

const makeTool: ToolFactory = (func, fields) => ({ ...fields, execute: func });

/**
 * Same acceptance set as the zod `.uuid()` check this replaced: hex 8-4-4-4-12,
 * version-agnostic, nil UUID included.
 */
const OBJECT_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * TypeBox's `format: 'uuid'` is only an annotation unless a format is registered
 * globally, so the objectId shape is validated here instead (plan 6.3 B). The
 * throw lands in each tool's existing catch, which turns it into the same kind
 * of readable tool result the model already gets for missing objects.
 */
function assertObjectId(objectId: string): void {
  if (!OBJECT_ID_PATTERN.test(objectId)) {
    throw new Error(
      `objectId 不是合法的 UUID: ${JSON.stringify(objectId)}。` +
      '请使用 list_knowledge_catalog 返回的 objectId。'
    );
  }
}

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
export function createKnowledgeTools(access: KnowledgeToolAccess): AgentToolDefinition[] {
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
      schema: listKnowledgeCatalogSchema,
    }
  );

  const selectModule = makeTool(
    async ({ objectId, reason }: SelectKnowledgeModuleInput): Promise<string> => {
      try {
        assertObjectId(objectId);
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
      schema: selectKnowledgeModuleSchema,
    }
  );

  const readEntry = makeTool(
    async ({ objectId, revision }: ReadKnowledgeEntryInput): Promise<string> => {
      try {
        assertObjectId(objectId);
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
      schema: readKnowledgeEntrySchema,
    }
  );

  const listFiles = makeTool(
    async ({ objectId, revision }: ListKnowledgeFilesInput): Promise<string> => {
      try {
        assertObjectId(objectId);
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
      schema: listKnowledgeFilesSchema,
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
    }: SearchKnowledgeTextInput): Promise<string> => {
      try {
        assertObjectId(objectId);
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
      schema: searchKnowledgeTextSchema,
    }
  );

  const readLines = makeTool(
    async ({
      objectId,
      revision,
      relativePath,
      startLine,
      maxLines,
    }: ReadKnowledgeLinesInput): Promise<string> => {
      try {
        assertObjectId(objectId);
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
      schema: readKnowledgeLinesSchema,
    }
  );

  return [listCatalog, selectModule, readEntry, listFiles, searchText, readLines];
}
