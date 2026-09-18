# 阶段 ② 引入 SpotShell 自有的 AgentMessage / AgentTool 抽象层

- 工时：1.5~2 人天
- 前置：[① ESM 迁移](01-esm-migration.md)
- 可独立交付：✅ 是（不引入 pi 依赖，LangGraph 仍在跑，功能零变化）
- 上级计划：[README.md](README.md)

## 1. 目标

把 `@langchain/core` 的消息类型从 `@spotshell/core` 的**公共 API 与内部算法**中彻底赶出去，收敛到 `SpotShellAgent` 一个边界文件里。

完成后：

- `history.ts`、`ContextCompaction.ts`、`agent/types.ts`、`index.ts` 不再 import `@langchain/*`
- `AgentHistory` 不再是 `BaseMessage[]`
- LangGraph 仍然在跑，**用户视角零变化**
- 后续换 pi（或任何框架）只需要改 `SpotShellAgent.ts` + 一个 adapter 文件

**这一步单独做就有价值。** 即使 pi 迁移中途放弃，收益也是实的。

## 2. 为什么不直接上 pi 的类型

pi 的 `Message` 类型有两个 SpotShell 现有算法依赖、而它**没有**的东西：

| SpotShell 依赖 | langchain 提供 | pi 提供 |
| --- | --- | --- |
| `message.id`（`ensureMessageIds` 合成，`CompactionSummaryRecord.coveredMessageIds` 引用） | `BaseMessage.id` | ❌ 无，只有 `timestamp: number` |
| `message.additional_kwargs.spotshellCompaction`（`isCompactionSummaryMessage`） | `additional_kwargs` | ❌ 无 |

而且 pi 的 `AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]` —— 声明合并只能**新增 role**，**不能给标准 role 加字段**。

另外 pi 的 `AssistantMessage` 是个重类型，必填 `api` / `provider` / `model` / `usage` / `stopReason`：

```ts
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api; provider: ProviderId; model: string;
  usage: Usage; stopReason: StopReason;
  // ...
}
```

直接拿它当内部数据结构，会让压缩算法、测试构造、历史裁剪全部被迫填一堆无关字段。

**所以：先定义 SpotShell 自己的轻量消息类型，两边都做适配。**

## 3. 设计

### 3.1 新增 `packages/core/src/agent/message.ts`

```ts
export interface AgentToolCall {
  id: string
  name: string
  arguments: unknown
}

interface AgentMessageBase {
  /** 稳定标识，由内容派生，见 3.2 */
  id: string
  /** Unix ms，与 pi 对齐 */
  timestamp: number
}

export interface AgentSystemMessage extends AgentMessageBase {
  role: 'system'
  text: string
}

export interface AgentUserMessage extends AgentMessageBase {
  role: 'user'
  text: string
}

export interface AgentAssistantMessage extends AgentMessageBase {
  role: 'assistant'
  text: string
  toolCalls: AgentToolCall[]
}

export interface AgentToolResultMessage extends AgentMessageBase {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  text: string
  isError: boolean
}

export type AgentMessage =
  | AgentSystemMessage
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolResultMessage
```

配套判定与工具函数（替代 `X.isInstance()`）：

```ts
export const isSystem = (m: AgentMessage): m is AgentSystemMessage => m.role === 'system'
export const isUser = (m: AgentMessage): m is AgentUserMessage => m.role === 'user'
export const isAssistant = (m: AgentMessage): m is AgentAssistantMessage => m.role === 'assistant'
export const isToolResult = (m: AgentMessage): m is AgentToolResultMessage => m.role === 'toolResult'
export function messageText(m: AgentMessage): string
export function makeMessageId(m: Omit<AgentMessage, 'id'>): string
```

**判别联合取代 `instanceof`** —— 这是本阶段最大的简化，`ContextCompaction.ts:186-199` 和 `history.ts` 里一堆 `AIMessage.isInstance(...)` 全部变成 `m.role === 'assistant'`。

### 3.2 `id` 的处置

现状 `ContextCompaction.ts:90-97` 的 `ensureMessageIds` 用 `hist-${index}-${hash}` 合成 id —— **带下标，不稳定**：同一条消息在历史裁剪后下标变了，id 就变了，而 `CompactionSummaryRecord.coveredMessageIds` 还引用着旧 id。

本阶段顺手修掉：**id 改为纯内容派生**（`role` + `text` + `toolCallId` 的 hash），不含下标。`ensureMessageIds` 从"后补 id"降级为"构造时即有 id"，函数可以整个删掉。

> 注意：这会改变 `CompactionSummaryRecord.coveredMessageIds` 的取值。因为压缩摘要**不持久化**（只在内存的 `compactionSummaries` 数组里），没有兼容性负担。

### 3.3 `spotshellCompaction` 标记的处置

`ContextCompaction.ts:196-199` 的 `isCompactionSummaryMessage` 读 `additional_kwargs.spotshellCompaction`。核查现状：压缩摘要**从不作为消息进入 `conversationHistory`** —— 它走 `SpotShellAgent.compactionSummaries` 数组，经 `formatCompactionSummariesForContext` 注入到 system context message。

所以这个判定在现有代码路径上恒为 `false`，是防御性残留。**本阶段删除它**，同时删除 `CompactionPlan` 里相关分支，并在 `ContextCompaction.test.ts` 里补一条断言：摘要不进 `retain`。

> 如果评审认为需要保留这个防御，退路是在 `AgentMessageBase` 上加 `readonly kind?: 'compaction-summary'` 字段。但建议先删，YAGNI。

### 3.4 新增 `packages/core/src/agent/langchainAdapter.ts`（临时文件）

```ts
export function toLangchain(messages: readonly AgentMessage[]): BaseMessage[]
export function fromLangchain(messages: readonly BaseMessage[]): AgentMessage[]
```

只在 `SpotShellAgent.chatStream()` 调 `graph.stream()` 的进出边界使用。

**这个文件在阶段 ⑤ 会被 `piAdapter.ts` 取代然后删除。** 写的时候就按"用完即弃"对待，不要过度设计。

### 3.5 工具接口

`tools.ts` / `knowledgeTools.ts` 本阶段**只改类型签名，不改 schema 库**：

```ts
// 本阶段：仍然是 zod，但不再暴露 StructuredToolInterface
export interface AgentToolDefinition<TInput = unknown> {
  name: string
  description: string
  schema: z.ZodTypeAny
  execute: (input: TInput) => Promise<string>
}
```

zod → TypeBox 的转换留到 [阶段 ③](03-tools-typebox.md)。`langchainAdapter.ts` 里增加 `toLangchainTools(defs): StructuredToolInterface[]`。

## 4. 范围

### 4.1 新增文件

| 文件 | 预估行数 | 生命周期 |
| --- | --- | --- |
| `core/src/agent/message.ts` | ~150 | 长期 |
| `core/src/agent/langchainAdapter.ts` | ~140 | 阶段 ⑤ 删除 |
| `core/src/agent/message.test.ts` | ~120 | 长期 |

### 4.2 改造文件

| 文件 | 现行数 | 改动性质 |
| --- | --- | --- |
| `core/src/agent/history.ts` | 104 | 签名全改；`isInstance` → role 判别；`estimateTokens` / `capToolMessage` / `sanitizeToolCallHistory` / `trimHistoryToBudget` 四个导出 |
| `core/src/context/ContextCompaction.ts` | 334 | 签名全改；删 `ensureMessageIds` / `isCompactionSummaryMessage` |
| `core/src/agent/types.ts` | — | `AgentHistory = AgentMessage[]`；去掉 `@langchain` import |
| `core/src/agent/tools.ts` | 334 | 返回类型改 `AgentToolDefinition[]`，工具体不动 |
| `core/src/agent/knowledgeTools.ts` | 260 | 同上 |
| `core/src/agent/SpotShellAgent.ts` | 557 | 内部历史改 `AgentMessage[]`；graph 边界加 adapter 转换 |
| `core/src/index.ts` | 404 | 导出新类型，移除 langchain 类型再导出 |
| `desktop/src/main/SessionManager.ts` | — | 仅类型跟随，`AgentHistory` 用法不变（`:608` `:613` `:641` `:842-844`） |

### 4.3 本阶段迁移的测试（仅 2 个）

| 文件 | 行数 |
| --- | --- |
| `core/src/agent/history.test.ts` | 86 |
| `core/src/context/ContextCompaction.test.ts` | 172 |

**`SpotShellAgent.*.test.ts`（748 行）与 desktop 的 5 个测试本阶段不动** —— 它们通过 `langchainAdapter` 继续工作。重头戏在 [阶段 ⑥](06-test-migration.md)。

## 5. 实施步骤

1. 写 `message.ts` + `message.test.ts`，先把类型和判别函数立住
2. 改 `history.ts`，跑 `history.test.ts`（先改测试再改实现，四个函数逐个来）
3. 改 `ContextCompaction.ts`，跑 `ContextCompaction.test.ts`；这一步顺带处理 3.2 / 3.3 两个决定
4. 写 `langchainAdapter.ts` + 往返转换测试（`fromLangchain(toLangchain(x))` 等价）
5. 改 `types.ts` / `tools.ts` / `knowledgeTools.ts` 签名
6. 改 `SpotShellAgent.ts`：内部状态改 `AgentMessage[]`，在 `:246` 的 `graph.stream()` 前后插 adapter
7. 改 `index.ts` 导出
8. `npm run build` + `npm test` 全绿

## 6. 验收标准

1. `grep -rn '@langchain' packages/core/src --include=*.ts` 的结果**只剩** `SpotShellAgent.ts`、`langchainAdapter.ts`、`providers/*.ts`、以及尚未迁移的 `SpotShellAgent.*.test.ts`
2. `packages/core/src/index.ts` 不再导出任何 langchain 类型
3. `npm run build` + `npm test` 全绿
4. 往返转换测试：任意 `AgentMessage[]` 经 `toLangchain` → `fromLangchain` 语义等价（id、tool_call 配对、内容完整）
5. 手工冒烟：连 SSH → 多轮对话带工具调用 → 换模型 → 重连，历史完整
6. 长对话触发一次自动压缩，压缩后可继续对话

## 7. 风险

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| `sanitizeToolCallHistory` 改写后 tool_call 配对逻辑出错，OpenAI 报 400 | 中 | 高 | 这是最需要测试覆盖的函数；保留并扩充 `history.test.ts` 里的部分批次 / 孤儿 tool 结果用例 |
| id 从"含下标"改为"纯内容派生"后，内容完全相同的两条消息 id 撞车 | 中 | 中 | id 里混入 `timestamp`；或接受撞车（`coveredMessageIds` 只用于展示/去重，不用于寻址） |
| `capToolMessage` 丢失 langchain `ToolMessage` 的 `artifact` / `metadata` / `response_metadata` | 低 | 低 | 核查现状：这些字段 SpotShell 从未读取，确认后直接丢弃 |
| adapter 往返丢信息导致流式 token 不完整 | 低 | 中 | 往返测试 + 手工冒烟第 5 条 |

## 8. 回滚

单个 commit `refactor(core): 抽出 SpotShell 自有 Agent 消息类型`，revert 即可。建议把 3.2 / 3.3 两个行为变更拆成独立 commit，便于单独回退。

## 9. 完成后的状态

- LangGraph 与 langchain 类型被关在 `SpotShellAgent.ts` + `langchainAdapter.ts` + `providers/` 里
- 公共 API 干净，`@spotshell/core` 的消费者（desktop / cli）看不到任何 langchain 类型
- 阶段 ⑤ 换 pi 时，只需把 `langchainAdapter.ts` 换成 `piAdapter.ts`
