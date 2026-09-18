# 阶段 ③ 工具定义从 zod 迁移到 TypeBox

- 工时：1 人天
- 前置：[② 消息/工具抽象层](02-agent-message-abstraction.md)
- 可并行：与 [④ Provider 迁移](04-providers-pi-ai.md) 无依赖，可同时进行
- **状态：已执行并验收通过（2026-09-18）**，改动留在工作区；真实 provider 逐工具调用待人工验证
- 上级计划：[README.md](README.md)

## 0. 执行结果摘要

`typebox@1.3.27`（精确锁定，与 pi 对齐）。schema dump 前后对比（走真实链路 `createSSHTools → toLangchainTools → convertToOpenAITool`）：**14 个工具无增减，共 37 处字段差异，全部落在 3 类可接受项**：

| 差异 | 处数 | 判定 |
| --- | --- | --- |
| `$schema: "…draft-07…"` 被丢弃 | 14 | zod-to-json-schema 的产物元数据，provider 不读，净减噪音 |
| `format:"uuid"` → `minLength/maxLength: 36` | 15 | 有意为之（见 6.3 B），校验搬进工具体 |
| `exclusiveMinimum: 0` → `minimum: 1` | 8 | `type:"integer"` 下数学等价 |

**零差异项**：全部 `description`（工具级与字段级）逐字相同、`required` 数组连顺序都一致、`enum` 表示形式一致（`{"type":"string","enum":[…]}`，未退化成 `anyOf`+`const`）、嵌套结构（`propose_knowledge_change.files` / `ask_knowledge_target.candidates`）逐字节相同、空 schema（`send_ctrl_c` / `list_knowledge_catalog`）逐字节相同、`additionalProperties: false` 全部保持。

5.4 的"省事路线"成立：`toLangchainTools()` 把 TypeBox schema 当 JSON Schema 直接交给 langchain 的 `tool()`，**没有写 TypeBox→zod 转换器**，入参校验完整保留（实跑验证：缺必填 / 类型错 / 多余字段 / minLength / maxLength / enum 非法 / maximum 越界 / 嵌套元素缺字段，全部被拒）。

## 1. 目标

把 14 个 Agent 工具的参数 schema 从 zod 换成 TypeBox，使其可以直接作为 pi 的 `AgentTool.parameters` 使用。

**工具函数体（执行逻辑）完全不动**，只改 schema 声明与类型推导。

## 2. 背景

pi 的工具定义要求 `parameters` 是 TypeBox `TSchema`：

```ts
const readFileTool: AgentTool = {
  name: 'read_file',
  label: 'Read File',
  description: "Read a file's contents",
  parameters: Type.Object({ path: Type.String({ description: 'File path' }) }),
  executionMode: 'sequential',
  execute: async (toolCallId, params, signal, onUpdate) => { /* ... */ },
}
```

TypeBox schema **本身就是 JSON Schema**，pi-ai 直接把它发给 provider，并用 `typebox/compile` 校验入参（见 `packages/ai/src/utils/validation.ts`）。这比现在 langchain 走 `zod-to-json-schema` 转一道要直接。

> 顺带：`zod-to-json-schema` 在 `packages/core/package.json` 里声明了但 `src/` 中**从未使用**，本阶段一并移除。

**zod 不会从项目里消失。** `packages/core/src/knowledge/` 的 `spaceDocument.ts` / `knowledgeRepository.ts` / `modulePackage.ts` / `environmentPackage.ts` 和 `packages/desktop/src/shared/` 的 IPC schema 继续用 zod，这些与 Agent 无关，不在本阶段范围内。

## 3. 工具清单

### 3.1 `packages/core/src/agent/tools.ts`（8 个）

| 工具 | 源码位置 | 参数复杂度 |
| --- | --- | --- |
| `execute_ssh_command` | `:100-116` | 1 个字符串 |
| `write_to_terminal` | `:118-134` | 1 个字符串 |
| `send_ctrl_c` | `:136-158` | 空对象 |
| `read_remote_file` | `:160-190` | 字符串 + 3 个可选整数（带 min） |
| `grep_remote_logs` | `:192-225` | 字符串 ×2 + 可选整数（min/max）+ 可选布尔 |
| `ask_knowledge_target` | `:227-263` | 嵌套数组对象 + enum |
| `propose_host_note` | `:265-301` | 字符串（min/max） |
| `propose_knowledge_change` | `:303-334` | enum + 嵌套数组对象 + 大 maxLength |

### 3.2 `packages/core/src/agent/knowledgeTools.ts`（6 个）

| 工具 | 源码位置 | 参数复杂度 |
| --- | --- | --- |
| `list_knowledge_catalog` | `:60-91` | 空对象 |
| `select_knowledge_module` | `:92-120` | uuid + 字符串 |
| `read_knowledge_entry` | `:121-142` | uuid + 正整数 |
| `list_knowledge_files` | `:143-191` | uuid + 正整数 |
| `search_knowledge_text` | `:192-242` | uuid + 正整数 + 字符串 |
| `read_knowledge_lines` | `:243-260` | uuid + 正整数 + 行范围 |

## 4. 转换对照表

| zod | TypeBox | 备注 |
| --- | --- | --- |
| `z.object({...})` | `Type.Object({...})` | |
| `z.object({})` | `Type.Object({})` | ⚠️ 见 6.2 |
| `z.string()` | `Type.String()` | |
| `z.string().describe(d)` | `Type.String({ description: d })` | |
| `z.string().min(1).max(500)` | `Type.String({ minLength: 1, maxLength: 500 })` | |
| `z.number().int().min(1)` | `Type.Integer({ minimum: 1 })` | |
| `z.number().int().min(1).max(N)` | `Type.Integer({ minimum: 1, maximum: N })` | |
| `z.boolean()` | `Type.Boolean()` | |
| `z.array(X)` | `Type.Array(X)` | |
| `.optional()` | `Type.Optional(X)` | 包在外层，不是链式 |
| `z.enum(['a','b','c'])` | **`StringEnum(['a','b','c'])`** | ⚠️ 见 6.1 |
| `z.string().uuid()` | `Type.String({ format: 'uuid' })` | ⚠️ 见 6.3 |
| `z.infer<typeof S>` | `Static<typeof S>` | |

### 4.1 enum 用 pi 的 `StringEnum` 而不是 `Type.Union([Type.Literal(...)])`

pi-ai 导出了 `StringEnum`（`packages/ai/src/utils/typebox-helpers.ts`），注释明确说明原因：

> Creates a string enum schema compatible with Google's API and other providers that don't support anyOf/const patterns.

`Type.Union([Type.Literal('a'), ...])` 会生成 `anyOf` + `const`，部分 provider 不接受。**两处 `z.enum(['host-notes','environment','knowledge'])`（`tools.ts:239` 与 `:310`）必须用 `StringEnum`。**

## 5. 实施步骤

1. 在 `packages/core/src/agent/` 下新增 `toolSchemas.ts`，集中放 14 个 TypeBox schema 与 `Static<>` 推导类型
2. 改 `tools.ts` / `knowledgeTools.ts`：schema 引用新文件，`execute` 的入参类型改用 `Static<>` 推导
3. 阶段 ② 定义的 `AgentToolDefinition.schema` 类型从 `z.ZodTypeAny` 改为 `TSchema`
4. `langchainAdapter.ts` 里的 `toLangchainTools()` 增加 TypeBox → zod 的桥接 —— **或者更省事：把 TypeBox schema 当 JSON Schema 直接交给 langchain 的 `tool()`**（langchain 的 `tool()` 接受 JSON Schema），避免写一个只活一个阶段的转换器
5. 移除 `packages/core/package.json` 的 `zod-to-json-schema` 依赖
6. 跑 `tools.test.ts` / `knowledgeTools.test.ts` / `knowledgeProposalTool.test.ts` / `knowledgeTargetTool.test.ts` / `noteTool.test.ts` / `fileTools.test.ts`

## 6. 需要注意的语义差异

### 6.1 校验严格度：pi 会做类型强制转换

pi-ai 的 `validation.ts` 里有 `coercePrimitiveByType()`，会把 `"123"` 强制成 `123`。langchain 的 zod 校验是严格的，会直接拒绝。

**影响**：模型把 `maxBytes` 传成字符串时，现在是报错让模型重试，改造后会被静默接受。对 SpotShell 来说这是**行为放宽，不是收紧**，可接受，但要在 `tools.test.ts` 里去掉"传错类型应报错"这类断言（如果有）。

### 6.2 空对象 schema

`send_ctrl_c` 和 `list_knowledge_catalog` 用 `z.object({})`。TypeBox 的 `Type.Object({})` 生成 `{"type":"object","properties":{},"required":[]}`，与现状等价。

但部分 provider（尤其 Google、某些 OpenAI 兼容端点）对空参数工具处理不一致。**验收时必须用真实 provider 至少跑通一次 `send_ctrl_c`。**

### 6.3 `uuid` format

`knowledgeTools.ts:18` 的 `z.string().uuid()` 是**实际生效的运行时校验**。TypeBox 的 `format: 'uuid'` 在 JSON Schema 里是**注解性的**，需要向 TypeBox 的 `FormatRegistry` 注册才会真正校验。

两个选择：

- **(A) 注册 format**：在 core 初始化时 `FormatRegistry.Set('uuid', v => UUID_RE.test(v))`。保持校验强度，但引入一个全局副作用
- **(B) 降级为 `Type.String({ minLength: 36, maxLength: 36, description: '...' })`，在工具体内部自行校验并返回友好错误文本**

**推荐 (B)。** 理由：工具体本来就要处理"对象不存在"的情况（`knowledgeTools.ts` 已有 `loadReasonForAccess` 这类错误路径），把 uuid 格式错误归入同一条错误返回路径，反馈给模型的信息比 schema 校验失败更有用。

### 6.4 `label` 字段

pi 的 `AgentTool` 有个 `label`（UI 展示用）。现有 14 个工具没有这个概念，renderer 里的工具名展示走的是自己的映射。**本阶段不加 `label`**，阶段 ⑤ 接 pi 时再决定是否复用。

## 7. 验收标准

1. `npm run build` + `npm test` 全绿
2. `packages/core/src/agent/` 下不再 import `zod`
3. `packages/core/src/knowledge/` 与 `packages/desktop/src/shared/` 的 zod 用法**未被改动**
4. `zod-to-json-schema` 从 `packages/core/package.json` 移除
5. 用真实 provider 手工验证：每个工具至少被模型成功调用一次，重点是 `send_ctrl_c`（空 schema）、`propose_knowledge_change`（嵌套数组 + enum）、`read_knowledge_entry`（uuid）
6. 生成的 JSON Schema 与改造前对比无实质差异：临时加一段脚本把 14 个工具的 schema dump 成 JSON，改造前后 diff

## 8. 风险

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| enum 用了 `Type.Union` 导致部分 provider 拒绝 | 中 | 中 | 强制用 `StringEnum`，在 review 清单里列为必查项 |
| 嵌套数组对象（`propose_knowledge_change.files`）转换出错 | 中 | 高 | 第 6 条的 schema dump diff 就是为这个准备的 |
| uuid 校验降级后出现脏数据进入知识库读取路径 | 低 | 中 | 采用 6.3 的 (B) 方案时，工具体内必须显式校验，不能只靠下游 |
| `Type.Optional` 位置写错（包在 `Type.Integer` 里而非外） | 中 | 低 | tsc 会报，schema dump diff 也会暴露 |

## 9. 回滚

单个 commit `refactor(core): Agent 工具 schema 迁移到 TypeBox`。由于工具体未动，回滚只影响 schema 声明。
