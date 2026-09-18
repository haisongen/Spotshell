/**
 * TypeBox parameter schemas for the 14 Agent tools.
 *
 * TypeBox schemas *are* JSON Schema, so these objects are handed to the model
 * (and to the runtime validator) verbatim — no zod-to-json-schema step.
 *
 * Every object schema sets `additionalProperties: false` to preserve the strict
 * behaviour the previous zod schemas had.
 */

import { Type, type Static, type TUnsafe } from 'typebox';
import { SPACE_V1_LIMITS } from '../knowledge/limits.js';

/**
 * A plain `{ type: 'string', enum: [...] }` schema.
 *
 * Deliberately not `Type.Union([Type.Literal(...)])`: that emits `anyOf` +
 * `const`, which Google's API and several OpenAI-compatible endpoints reject.
 * Mirrors pi-ai's `StringEnum` helper.
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] }
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: 'string',
    enum: values as unknown as string[],
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.default ? { default: options.default } : {}),
  });
}

const strictObject = { additionalProperties: false } as const;

const knowledgeTargetKindSchema = StringEnum(
  ['host-notes', 'environment', 'knowledge'] as const,
  { description: '落点层级' }
);

// ---------------------------------------------------------------------------
// tools.ts
// ---------------------------------------------------------------------------

export const executeSshCommandSchema = Type.Object(
  {
    command: Type.String({ description: '要执行的 shell 命令' }),
  },
  strictObject
);
export type ExecuteCommandInput = Static<typeof executeSshCommandSchema>;

export const writeToTerminalSchema = Type.Object(
  {
    text: Type.String({ description: '要发送到终端的文本' }),
  },
  strictObject
);
export type WriteToTerminalInput = Static<typeof writeToTerminalSchema>;

export const sendCtrlCSchema = Type.Object({}, strictObject);
export type SendCtrlCInput = Static<typeof sendCtrlCSchema>;

export const readRemoteFileSchema = Type.Object(
  {
    path: Type.String({ description: '远程文件绝对路径' }),
    startLine: Type.Optional(
      Type.Integer({ minimum: 1, description: '起始行（1-based，含）' })
    ),
    endLine: Type.Optional(
      Type.Integer({ minimum: 1, description: '结束行（含）；省略则读到文件尾' })
    ),
    maxBytes: Type.Optional(
      Type.Integer({ minimum: 1, description: '返回字节上限，默认 8192' })
    ),
  },
  strictObject
);
export type ReadRemoteFileInput = Static<typeof readRemoteFileSchema>;

export const MAX_GREP_MATCHES = 500;

export const grepRemoteLogsSchema = Type.Object(
  {
    path: Type.String({ description: '远程文件绝对路径' }),
    pattern: Type.String({ description: '搜索模式（grep 基础正则）' }),
    maxMatches: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_GREP_MATCHES,
        description: '最多返回多少个匹配，默认 100',
      })
    ),
    ignoreCase: Type.Optional(Type.Boolean({ description: '忽略大小写' })),
  },
  strictObject
);
export type GrepRemoteLogsInput = Static<typeof grepRemoteLogsSchema>;

export const askKnowledgeTargetSchema = Type.Object(
  {
    question: Type.String({
      minLength: 1,
      maxLength: 500,
      description: '一句话说明要沉淀什么内容，供用户判断落点',
    }),
    candidates: Type.Array(
      Type.Object(
        {
          kind: knowledgeTargetKindSchema,
          targetId: Type.String({
            minLength: 1,
            maxLength: 200,
            description: 'Host id（host-notes）或对象稳定 UUID（environment/knowledge）',
          }),
          label: Type.String({
            minLength: 1,
            maxLength: 120,
            description: '展示给用户的名称，例如环境档案或模块名',
          }),
          reason: Type.String({
            minLength: 1,
            maxLength: 300,
            description: '为什么建议写到这里',
          }),
        },
        strictObject
      ),
      {
        minItems: 1,
        maxItems: 6,
        description: '建议的落点候选；用户也可以一个都不选',
      }
    ),
  },
  strictObject
);
export type AskKnowledgeTargetInput = Static<typeof askKnowledgeTargetSchema>;

export const proposeHostNoteSchema = Type.Object(
  {
    note: Type.String({
      minLength: 1,
      maxLength: 500,
      description: '一句话结论，不含敏感信息（密码/密钥/token）',
    }),
  },
  strictObject
);
export type ProposeHostNoteInput = Static<typeof proposeHostNoteSchema>;

export const proposeKnowledgeChangeSchema = Type.Object(
  {
    targetKind: StringEnum(['host-notes', 'environment', 'knowledge'] as const, {
      description: '唯一写入层级；必须与用户已确认的选择一致',
    }),
    targetId: Type.String({
      minLength: 1,
      description: 'Host id（host-notes）或对象稳定 UUID（environment/knowledge）',
    }),
    reason: Type.String({ minLength: 1, maxLength: 1000, description: '修改理由' }),
    terminalEvidence: Type.Optional(
      Type.String({
        maxLength: 4000,
        description: '支撑修改的终端输出摘录（证据，不会自动写入知识）',
      })
    ),
    files: Type.Array(
      Type.Object(
        {
          relativePath: Type.String({
            minLength: 1,
            maxLength: 240,
            description: '对象内相对路径；Host Notes 使用 notes；入口用 SPACE.md',
          }),
          after: Type.String({
            maxLength: 200_000,
            description: '提议的完整新内容（不是 unified diff 片段）',
          }),
        },
        strictObject
      ),
      { minItems: 1, maxItems: 20 }
    ),
  },
  strictObject
);
export type ProposeKnowledgeChangeInput = Static<typeof proposeKnowledgeChangeSchema>;

// ---------------------------------------------------------------------------
// knowledgeTools.ts
// ---------------------------------------------------------------------------

/**
 * Canonical UUID length. The previous zod schema used `.uuid()`, whose runtime
 * check TypeBox's `format: 'uuid'` annotation would *not* reproduce without a
 * global `FormatRegistry` side effect. Per plan 6.3 (B) the format constraint is
 * dropped from the schema and the tool bodies validate the value themselves,
 * returning a readable error to the model (see `knowledgeTools.ts`).
 */
export const OBJECT_ID_LENGTH = 36;

const objectIdSchema = Type.String({
  minLength: OBJECT_ID_LENGTH,
  maxLength: OBJECT_ID_LENGTH,
  description: 'Knowledge object stable ID',
});

const revisionSchema = Type.Integer({
  minimum: 1,
  description: 'Active object revision number',
});

export const listKnowledgeCatalogSchema = Type.Object({}, strictObject);
export type ListKnowledgeCatalogInput = Static<typeof listKnowledgeCatalogSchema>;

export const selectKnowledgeModuleSchema = Type.Object(
  {
    objectId: objectIdSchema,
    reason: Type.String({
      minLength: 1,
      maxLength: 500,
      description: '为什么为当前问题选择该模块（会展示给用户）',
    }),
  },
  strictObject
);
export type SelectKnowledgeModuleInput = Static<typeof selectKnowledgeModuleSchema>;

export const readKnowledgeEntrySchema = Type.Object(
  {
    objectId: objectIdSchema,
    revision: revisionSchema,
  },
  strictObject
);
export type ReadKnowledgeEntryInput = Static<typeof readKnowledgeEntrySchema>;

export const listKnowledgeFilesSchema = Type.Object(
  {
    objectId: objectIdSchema,
    revision: revisionSchema,
  },
  strictObject
);
export type ListKnowledgeFilesInput = Static<typeof listKnowledgeFilesSchema>;

export const searchKnowledgeTextSchema = Type.Object(
  {
    objectId: objectIdSchema,
    revision: revisionSchema,
    pattern: Type.String({
      minLength: 1,
      maxLength: SPACE_V1_LIMITS.maxRegexPatternChars,
      description: '字面量或正则模式',
    }),
    mode: Type.Optional(
      StringEnum(['literal', 'regex'] as const, { description: '搜索模式，默认 literal' })
    ),
    maxMatches: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: SPACE_V1_LIMITS.maxSearchMatches,
        description: `最多返回命中数，默认/上限 ${SPACE_V1_LIMITS.maxSearchMatches}`,
      })
    ),
    ignoreCase: Type.Optional(Type.Boolean({ description: '忽略大小写' })),
  },
  strictObject
);
export type SearchKnowledgeTextInput = Static<typeof searchKnowledgeTextSchema>;

export const readKnowledgeLinesSchema = Type.Object(
  {
    objectId: objectIdSchema,
    revision: revisionSchema,
    relativePath: Type.String({
      minLength: 1,
      maxLength: SPACE_V1_LIMITS.maxRelativePathChars,
      description: '对象内相对路径，例如 references/guide.md',
    }),
    startLine: Type.Integer({ minimum: 1, description: '起始行（1-based，含）' }),
    maxLines: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: SPACE_V1_LIMITS.maxReadLines,
        description: `最大行数，默认/上限 ${SPACE_V1_LIMITS.maxReadLines}`,
      })
    ),
  },
  strictObject
);
export type ReadKnowledgeLinesInput = Static<typeof readKnowledgeLinesSchema>;
