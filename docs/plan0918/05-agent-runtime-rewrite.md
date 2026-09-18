# 阶段 ⑤ SpotShellAgent 运行时重写

- 工时：1.5 人天
- 前置：[② 抽象层](02-agent-message-abstraction.md)、[③ TypeBox](03-tools-typebox.md)、[④ pi-ai Provider](04-providers-pi-ai.md)
- 可独立交付：❌ 否（与阶段 ④ 同分支连续交付）
- 上级计划：[README.md](README.md)

## 1. 目标

把 `packages/core/src/agent/SpotShellAgent.ts`（557 行）的执行内核从 LangGraph `StateGraph` 换成 pi 的 `Agent` 类，删除 `@langchain/langgraph` 与 `@langchain/core` 依赖。

**对外契约一行不改。** `AgentRuntime` 接口、`AgentStreamEvent` 事件联合、`AgentCancelledError`、以及 `SessionManager` 通过 `instanceof SpotShellAgent` 调用的那组方法，全部保持原样。

## 2. 必须保持不变的契约

`packages/desktop/src/main/SessionManager.ts` 依赖以下全部内容，**任何一条变了都会连带改 desktop**：

### 2.1 `AgentRuntime` 接口

```ts
chatStream(userInput, context, opts): Promise<string>
chat(userInput, context): Promise<string>
getHistory(): AgentHistory
setHistory(messages: AgentHistory): void
clearHistory(): void
```

### 2.2 `AgentStreamEvent` 事件联合（`agent/types.ts`）

```ts
| { type: 'token'; text: string }
| { type: 'context_usage'; usage: ContextAssemblyResult }
| { type: 'final'; text: string; provenance?: KnowledgeProvenanceRecord[] }
| { type: 'context_compaction'; summary: CompactionSummaryRecord }
| { type: 'context_compaction_failed'; error: string }
| { type: 'context_over_limit'; reason: CompactionOverLimitReason }
```

消费方：`SessionManager.ts:738-771`。

### 2.3 `SpotShellAgent` 的额外方法（`instanceof` 分支使用）

| 方法 | 调用点 |
| --- | --- |
| `setKnowledgeContext()` | `SessionManager.ts:722` `:728` `:890` `:893` |
| `updateModel()` | `SessionManager.ts:840` |
| `updateContextWindow()` | `SessionManager.ts:868` |
| `updateAllowAutoContextCompaction()` | `SessionManager.ts:869` |
| `recomputeContextUsage()` | `SessionManager.ts:896` |
| `getCompactionSummaries()` / `getLastContextAssembly()` | 上下文用量面板 |

### 2.4 取消语义

`SessionManager.ts:792-796`：

```ts
catch (err) {
  if (err instanceof AgentCancelledError || abort.signal.aborted) {
    this.emitAgentEvent(s, { type: 'cancelled' }, turnEpoch)
    return ''
  }
  ...
}
```

**`AgentCancelledError` 必须仍然被抛出。** pi 不抛异常（走 `stopReason: 'aborted'`），所以这里要显式转换。

### 2.5 错误语义

`SpotShellAgent.ts:296-302` 当前的行为是：请求失败时**不抛异常**，而是 `return` 一句本地化文案（`AI 处理错误: ...` / `AI processing error: ...`）。这个行为要保持 —— UI 把它当作一条普通助手回复渲染。

## 3. 概念映射

| 现状（LangGraph） | pi 实现 |
| --- | --- |
| `buildGraph()` `:178-215` | `new Agent({ initialState, convertToLlm, transformContext, streamFn, ... })` |
| `graph.stream(..., streamMode: ['values','messages'])` `:246-253` | `agent.subscribe(handler)` + `await agent.prompt(userInput)` |
| `meta.langgraph_node === 'agent' && msgChunk.content` `:258-263` | `event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta'` → `event.assistantMessageEvent.delta` |
| `lastValues.messages` 取终值 `:264-276` | `event.type === 'agent_end'` 的 `event.messages`，或 `turn_end.message` |
| `finalMessages.slice(baseline.length)` 提取新消息 `:278-280` | 同上，用 `agent_end.messages` 减去投入的 baseline 长度 |
| `capToolMessage(message, 2000)` `:279` | **`afterToolCall` 钩子**（更正的位置，见 4.4） |
| `recursionLimit` `:251` | **无等价物**，用 `shouldStopAfterTurn` 自己数 turn（见 4.5） |
| `opts.signal` 透传 | `agent.abort()`，并监听外部 `AbortSignal` |
| 两条 `SystemMessage`（systemPrompt + contextMessage）`:238-243` | 前导 `SystemMessage` + 每轮用 `sections` 替换上下文段（见 4.2） |
| `sanitizeToolCallHistory()` | **保留**，改跑在 `AgentMessage` 上（阶段 ② 已完成） |
| `trimHistoryToBudget()` | 保留，在 `transformContext` 里调用（见 4.3） |

## 4. 设计要点

### 4.1 谁持有历史：SpotShell，不是 pi

pi 的 `Agent` 是有状态的，`prompt()` 会往 `agent.state.messages` 追加。而 SpotShell 现在是**每轮重建 baseline**（`:238-243`）：system prompt + 本轮上下文消息 + 预算裁剪后的历史 + 用户输入。

**保持现状：`SpotShellAgent.conversationHistory` 仍是唯一真相源。** 每轮调用前：

```ts
this.agent.state.messages = toPiMessages(baseline)
await this.agent.prompt(userInput)
```

理由：

- 与现有 `getHistory()` / `setHistory()` / `clearHistory()` / 换模型保留历史 / 重连恢复历史 全部 1:1 对应，风险最低
- 预算裁剪是**出站单向**的（`:234-237` 注释写得很清楚：soft-trim 只影响发出去的请求，不丢本地历史），让 pi 持有历史会破坏这个性质

> 让 pi 持有 transcript、只用 `transformContext` 裁剪，是更"原生"的写法，但那是**迁移完成之后的优化**，不要塞进本阶段。

### 4.2 System prompt 与每轮上下文

现状每轮塞两条 `SystemMessage`。pi 的 transcript 模型更好：前导 system message 是基础 prompt，后续 system message 用 `sections: Record<string, string | null>` **按名替换**段落。

```ts
initialState: { systemPrompt: this.systemPrompt, model, tools }
// 每轮：
{ role: 'system', content: '', sections: { spotshellContext: contextMessage }, timestamp: Date.now() }
```

好处：上下文段每轮被替换而不是累积，历史里不会堆积 N 份过期的终端快照。

⚠️ 但这改变了发给模型的消息结构。**`buildBudgetedContextMessage()` 的产物内容不变，只是承载方式变了。** 验收时要对比一次实际请求体。

> 保守方案：仍然每轮插两条独立 system message。先按 `sections` 实现，如果 provider 兼容性出问题再退回。

### 4.3 `transformContext` 的用途

```ts
transformContext: async (messages, signal) => {
  // 预算裁剪（出站单向）
  return toPiMessages(trimHistoryToBudget(fromPiMessages(messages), budget))
}
```

本阶段只放裁剪。`ContextAssembler` 的装配仍在 `chatStream()` 里做（因为它要产出 `context_usage` 事件给 UI，时机在 prompt 之前）。

### 4.4 工具结果截断改用 `afterToolCall`

现状 `:278-280` 在一轮结束后统一对 `ToolMessage` 做 `capToolMessage(msg, 2000)`。这有个缺陷：**截断发生在消息已经进过模型上下文之后**，只影响后续轮次。

pi 的 `afterToolCall` 在工具结果进入 transcript **之前**触发：

```ts
afterToolCall: async ({ toolCall, result, isError }) => {
  const capped = capToolContent(result.content, 2000)
  return capped === result.content ? undefined : { content: capped }
}
```

**这是一个行为改进**（当轮就生效，省 token），但也是**行为变更**。需要在验收里确认：单条超长工具输出（如 `cat` 大文件）不再把当轮上下文撑爆。

### 4.5 `recursionLimit` 的替代

pi 没有直接等价物。用 `shouldStopAfterTurn` 自己数：

```ts
let turnCount = 0
agent.shouldStopAfterTurn = async () => {
  turnCount += 1
  return this.recursionLimit !== undefined && turnCount >= this.recursionLimit
}
```

⚠️ 语义有差：LangGraph 的 `recursionLimit` 触顶会**抛 `GraphRecursionError`**；`shouldStopAfterTurn` 是**优雅停止**，会正常发 `agent_end`。

对 SpotShell 更好（用户看到的是一个截断的回答而不是一条报错），但 `SpotShellAgent.runtime.test.ts` 里如果有断言递归超限报错的用例，需要改。**每轮开始前重置 `turnCount = 0`。**

### 4.6 取消路径

```ts
opts.signal?.addEventListener('abort', () => this.agent.abort(), { once: true })
await this.agent.prompt(userInput)
// agent_end 后检查最后一条 assistant 消息
if (lastAssistant?.stopReason === 'aborted') throw new AgentCancelledError()
```

关键：**取消后不能把半截消息写进 `conversationHistory`**。现状靠 `catch` 里直接抛错、跳过 `:284-288` 的历史写回实现。新实现要显式判断 `stopReason`，在写回历史之前抛出。

### 4.7 错误路径

```ts
if (lastAssistant?.stopReason === 'error') {
  const normalized = this.provider.normalizeAssistantFailure(lastAssistant)
  return this.language === 'en'
    ? `AI processing error: ${normalized.message}`
    : `AI 处理错误: ${normalized.message}`
}
```

`normalizeAssistantFailure()` 在[阶段 ④](04-providers-pi-ai.md) 4.4 定义。注意仍然是 `return` 而不是 `throw`（见 2.5）。

### 4.8 `provenance` 收集

`collectProvenance()`（`:493-496`）从 `knowledgeHarness.takeProvenance()` 取。时机不变：在 `final` 事件发出前调用。pi 的 `agent_end` 订阅者是 awaited 的，在那里调用即可。

### 4.9 依赖注入接口（给阶段 ⑥ 用）

```ts
export interface SpotShellAgentDependencies {
  /** 替代原 model?: BaseChatModel */
  streamFn?: StreamFn
  models?: Models
  providerResolver?: (id: ModelProviderId) => ModelProvider
  summarizer?: ContextCompactionSummarizer
}
```

阶段 ⑥ 的测试通过 `fauxProvider()` 注入 `streamFn`。

## 5. 不在本阶段范围

- **命令风险审批不动。** 现有设计是 `SessionManager` 用 `PolicyExecutor` 包装 `SSHExecutor`（`classifyCommand` + `PendingConfirms`，见 `SessionManager.ts:1711-1730`），审批发生在 `executor.execute()` 内部，与 Agent 框架无关，**迁移后原样工作**。搬到 `beforeToolCall` 是可选的后续优化，收益是能拿到工具名和结构化参数，但不是必需。
- **thinking level 不接 UI。** `agent.state.thinkingLevel` 本阶段固定 `'off'`，保持现有行为。启用它是独立需求。
- **steering / follow-up 队列不用。**
- **不换 `ContextCompaction`** 为 pi 的 `harness/compaction`（见总计划决策点 5）。

## 6. 范围清单

| 文件 | 改动 |
| --- | --- |
| `core/src/agent/SpotShellAgent.ts` | 主体重写，557 → 预计 480 行左右 |
| `core/src/agent/piAdapter.ts` | **新增**，`AgentMessage` ↔ pi `Message` 双向转换 + 工具定义转换，~160 行 |
| `core/src/agent/langchainAdapter.ts` | **删除**（阶段 ② 的临时文件） |
| `core/src/agent/types.ts` | `SpotShellAgentDependencies` 改造 |
| `core/package.json` | 移除 `@langchain/core`、`@langchain/langgraph`；新增 `@earendil-works/pi-agent-core`（精确 `0.85.1`，不用 `^`） |
| `desktop/package.json` | 移除 devDependency `@langchain/core` |

`SessionManager.ts` **不改**（这是本阶段的成功标志之一）。

## 7. 验收标准

1. `npm run build` 通过
2. `grep -rn '@langchain' packages/ --include=*.ts --include=*.json`（排除 node_modules）**零结果**
3. `SessionManager.ts` 的 git diff 为空
4. 手工冒烟全通过：
   - 流式：逐字输出可见，无卡顿、无重复、无丢字
   - 工具：只读命令直接执行；写命令弹审批；批准后执行；拒绝后 Agent 正确收尾
   - 多轮工具：一轮内多个工具调用，结果顺序正确
   - 取消：生成中点"停止" → UI 显示 cancelled；历史无半截消息；下一轮正常
   - 错误：拔网线 / 改错 key → UI 显示 `AI 处理错误: ...`，且**不含 key 片段**
   - 压缩：长对话触发一次自动压缩，`context_compaction` 到达 UI，压缩后可继续
   - 换模型：对话中途切 provider，历史保留
   - 重连：`reconnect()` 后历史完整
   - 新上下文：`startNewContext` 后 epoch 隔离正常
   - 知识工具：`select_knowledge_module` → `read_knowledge_entry` 链路通，provenance 正确回传
5. 工具输出截断：让模型 `cat` 一个大文件，确认单条工具结果被截到 2000 字符且**当轮**生效
6. 轮次上限：构造一个会反复调用工具的场景，确认 `recursionLimit` 生效且是优雅停止

## 8. 风险

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| `sections` 方式的 system prompt 在某些 provider 上表现异常 | 中 | 中 | 4.2 的保守方案（两条独立 system message）随时可退回 |
| 取消时半截 assistant 消息污染历史 | 中 | 高 | 4.6 显式 `stopReason` 判断；验收第 4 条专项验证 |
| `agent_end.messages` 与 baseline 的差集算错，导致历史重复或丢失 | 中 | 高 | 用消息 id（阶段 ② 的内容派生 id）做差集，不要用长度切片 |
| pi 的 `message_update` 在某些 provider 下不发 `text_delta`（只在 `message_end` 给全文） | 中 | 中 | 兜底：`message_end` 时若本条未发过任何 token，补发一次全文 token 事件 |
| `afterToolCall` 截断改变模型行为（信息更少） | 低 | 低 | 2000 字符阈值不变；验收第 5 条观察 |
| pi 0.85.1 的 API 在小版本间变动 | 中 | 中 | `package.json` 锁精确版本 `0.85.1`，不用 `^` |

## 9. 回滚

本阶段与[阶段 ④](04-providers-pi-ai.md) 同分支连续交付，回滚粒度是"④+⑤ 整体 revert"。这也是为什么 ①②③ 要先独立合入。
