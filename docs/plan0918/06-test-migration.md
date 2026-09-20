# 阶段 ⑥ 测试迁移

- 工时：~~2 人天~~ → **已在阶段 ⑤ 内完成**
- 前置：[⑤ Agent 运行时重写](05-agent-runtime-rewrite.md)
- **状态：已完成（2026-09-20），本文档转为记录**
- 上级计划：[README.md](README.md)

## -1. 为什么本阶段被阶段 ⑤ 吸收

阶段 ⑤ 移除 `@langchain/*` 后，11 个依赖 langchain 测试替身的文件会**整体加载失败**，所以"⑤ 结束时 `npm test` 全绿"这一要求强制把本阶段的迁移一并做完了。

实际做法与本文档的设想一致：

- 共享替身收敛在 `packages/core/src/testing/fauxModelProvider.ts`，通过 **`@spotshell/core/testing` 子路径导出**（正是 3.2 节的建议），desktop 直接 `import { createFauxModelProvider, loadPiAi } from '@spotshell/core/testing'`
- 该助手记录每次请求的 `systemPrompt` / `messages` / `toolNames`，取代原先各测试自己维护的 `receivedMessages`（3.3 节的问题因此不存在）
- `registry.test.ts` 的断言对象从「传给 `ChatOpenAI` 构造函数的字段」改为 `resolveModel()` 返回的 `Model<Api>`（3.4 节）
- 第 4 节要求的 6 项新行为测试，落在 `SpotShellAgent.eventContract.test.ts`

**覆盖核对**：用例名全集 728 → 737，`SessionManager.v1Acceptance.test.ts` 的 5 个用例一个不少（第 6 节验收标准第 5 条）。详见 [05 的执行结果摘要](05-agent-runtime-rewrite.md)。

## 1. 目标

把 11 个依赖 langchain 测试替身的测试文件（约 2800 行）迁移到 pi-ai 的 `fauxProvider()`，恢复全绿。

**这是整个迁移工作量的主体。** 不要低估。

## 2. 待迁移清单

阶段 ② 已完成 `history.test.ts`(86) 与 `ContextCompaction.test.ts`(172)，剩余：

> 📌 阶段 ② 执行时的实际情况：`SpotShellAgent.runtime.test.ts` 与 `compaction.test.ts` 已被**部分**改动（边界适配：`fromLangchain()` 包装、`m.text`、`isUser`），但 **langchain 假模型（`ScriptedToolChatModel` / `FakeListChatModel`）与全部断言均原样保留**。本阶段对这两个文件的工作量不变 —— 要换掉的正是那些假模型。



### 2.1 core（527 行）

| 文件 | 行数 | 替身形式 |
| --- | --- | --- |
| `agent/providers/registry.test.ts` | 56 | `FakeListChatModel` + `ConstructorParameters<typeof ChatOpenAI>` 断言 |
| `agent/SpotShellAgent.runtime.test.ts` | 192 | 手写 `ScriptedToolChatModel extends BaseChatModel` + `FakeListChatModel` |
| `agent/SpotShellAgent.compaction.test.ts` | 277 | `FakeListChatModel` + 构造 `AIMessage` / `HumanMessage` |
| `agent/SpotShellAgent.dynamicModules.test.ts` | 279 | 手写 `BaseChatModel` 子类 + `ChatResult` |

> 注：`SpotShellAgent.*.test.ts` 三个文件合计 748 行，与上表 `registry.test.ts` 合计 804 行。

### 2.2 desktop（1776 行）

| 文件 | 行数 | 替身形式 |
| --- | --- | --- |
| `main/llmProbe.test.ts` | 95 | `FakeListChatModel` |
| `main/SessionManager.agentRuntime.test.ts` | 353 | 手写 `BaseChatModel` + `ChatResult` |
| `main/SessionManager.contextEpoch.test.ts` | 349 | 构造 `HumanMessage` |
| `main/SessionManager.dynamicModules.test.ts` | 300 | 手写 `BaseChatModel` |
| `main/SessionManager.v1Acceptance.test.ts` | 679 | 手写 `BaseChatModel` |

## 3. 迁移模式

### 3.1 手写 `BaseChatModel` 子类 → `fauxProvider()`

现状典型写法（`SpotShellAgent.runtime.test.ts:11-38`）：

```ts
class ScriptedToolChatModel extends BaseChatModel {
  readonly receivedMessages: BaseMessage[][] = []
  constructor(private readonly responses: AIMessage[]) { super({}) }
  _llmType() { return 'scripted-tool-chat-model' }
  bindTools() { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.receivedMessages.push([...messages])
    const message = this.responses[this.nextResponse++]
    if (!message) throw new Error('No scripted model response remains')
    return { generations: [{ text: ..., message }] }
  }
}
```

迁移后：

```ts
import {
  createModels, fauxProvider,
  fauxAssistantMessage, fauxText, fauxToolCall,
} from '@earendil-works/pi-ai'

const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)

faux.setResponses([
  fauxAssistantMessage([fauxToolCall('execute_ssh_command', { command: 'uname -a' })],
    { stopReason: 'toolUse' }),
  fauxAssistantMessage([fauxText('系统是 Linux 6.8.0')]),
])

const agent = new SpotShellAgent(config, executor, extras, {
  streamFn: models.streamSimple.bind(models),
  models,
})
```

### 3.2 建一个共享测试工具模块

11 个文件里有大量重复的替身搭建代码。**先写 `packages/core/src/agent/testing/fauxAgent.ts`**（或沿用仓库现有的 `*.testSupport.ts` 命名 —— `core/tsconfig.json` 的 `exclude` 已经包含 `src/**/*.testSupport.ts`，说明这个约定已存在）：

```ts
export function createFauxAgentHarness(options?: {
  responses?: AssistantMessage[]
  config?: Partial<AgentConfig>
}): {
  faux: FauxProvider
  models: Models
  deps: SpotShellAgentDependencies
  /** 断言用：模型实际收到的 transcript */
  sentTranscripts(): Message[][]
}
```

desktop 侧同样需要一个 —— 但 desktop 不能 import core 的 `testSupport`（被 tsconfig 排除、不进 dist）。**从 `@spotshell/core` 正式导出一个 `testing` 子路径**，或在 desktop 侧复制一份精简版。推荐前者：

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./testing": { "types": "./dist/testing/index.d.ts", "default": "./dist/testing/index.js" }
}
```

**这一步先做，能省掉后面一半工作量。**

### 3.3 `receivedMessages` 断言的替代

多个测试断言"模型收到了什么"（上下文注入、知识模块装载、system prompt 内容）。`fauxProvider` 是否暴露收到的 context 需要确认；若不暴露，包一层：

```ts
const sent: Message[][] = []
const streamFn: StreamFn = (model, context, options) => {
  sent.push(structuredClone(context.messages))
  return models.streamSimple(model, context, options)
}
```

这个包装放进 3.2 的 harness 里。

### 3.4 `registry.test.ts` 的特殊处理

现状断言的是"传给 `ChatOpenAI` 构造函数的字段"：

```ts
let fields: ConstructorParameters<typeof import('@langchain/openai').ChatOpenAI>[0]
```

迁移后该断言对象变成 `provider.resolveModel(config)` 返回的 `Model<Api>`。断言项改为：`model.id`、`model.baseUrl`、`model.api`、`model.provider`、`model.contextWindow`。

**重点覆盖[阶段 ④](04-providers-pi-ai.md) 4.2 的两条路径**：无 `baseURL` 走内置 provider、有 `baseURL` 走 `createProvider()`。这是 ④ 的主要实现量，也是最需要测试兜住的地方。

### 3.5 `llmProbe.test.ts`

`FakeListChatModel` → `fauxProvider`。同时补上[阶段 ④](04-providers-pi-ai.md) 4.4 的 `normalizeAssistantFailure()` 覆盖：对每个 `ModelProviderErrorKind`（`authentication` / `rate-limit` / `model-not-found` / `timeout` / `network` / `unsupported-tools` / `unknown`）构造一个 `stopReason: 'error'` 的 `AssistantMessage`，断言归一化结果与**脱敏文案**。

## 4. 需要新增的测试

迁移过程中顺带补上阶段 ⑤ 引入的新行为：

| 新行为 | 来源 | 测试点 |
| --- | --- | --- |
| 取消不污染历史 | [05](05-agent-runtime-rewrite.md) 4.6 | `stopReason: 'aborted'` → 抛 `AgentCancelledError` 且 `getHistory()` 长度不变 |
| 错误返回本地化文案不抛异常 | [05](05-agent-runtime-rewrite.md) 4.7 | `stopReason: 'error'` → 返回 `AI 处理错误: ...`，且不含原始报错 |
| `recursionLimit` 优雅停止 | [05](05-agent-runtime-rewrite.md) 4.5 | 脚本化 N+1 轮工具调用，断言只执行 N 轮且正常收尾 |
| `afterToolCall` 当轮截断 | [05](05-agent-runtime-rewrite.md) 4.4 | 超长工具输出 → 下一次请求的 transcript 里该条已被截到 2000 |
| `sections` 上下文替换不累积 | [05](05-agent-runtime-rewrite.md) 4.2 | 三轮对话后，transcript 里只有一份上下文段 |
| `message_end` 兜底补发 token | [05](05-agent-runtime-rewrite.md) 风险表 | 脚本化一个不发 `text_delta` 的响应，断言 `token` 事件仍然到达 |

## 5. 实施步骤

1. 先写 3.2 的共享 harness（core + `./testing` 导出），并用 `SpotShellAgent.runtime.test.ts` 试跑通一条
2. `registry.test.ts`（最小，先摸清 `resolveModel` 断言形状）
3. `SpotShellAgent.runtime.test.ts` → `compaction` → `dynamicModules`
4. `llmProbe.test.ts`
5. desktop 四个 `SessionManager.*.test.ts`，按 `agentRuntime` → `contextEpoch` → `dynamicModules` → `v1Acceptance` 顺序（复杂度递增）
6. 补第 4 节的新增测试
7. 删除所有 `@langchain` import，从两个 `package.json` 移除依赖

## 6. 验收标准

1. `npm test` 全绿（core + desktop）
2. `grep -rn '@langchain' packages/` 零结果（排除 `node_modules`、`package-lock.json`）
3. `@langchain/core` 从 `packages/desktop/package.json` 的 devDependencies 移除
4. 第 4 节的 6 项新增测试全部存在且通过
5. `SessionManager.v1Acceptance.test.ts` 的**验收场景数量不减** —— 这是 v1 的行为基线，迁移不允许顺手删用例
6. 测试运行时间不显著劣化（`fauxProvider` 有 `tokensPerSecond` 选项，测试里应设为不限速或高值，避免人为拖慢）

## 7. 风险

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| `v1Acceptance.test.ts`(679 行) 迁移中顺手弱化断言 | **高** | 高 | 迁移前后对比 `test(` 计数与用例名清单，逐条核对；这一条要在 review 里专门看 |
| `fauxProvider` 不暴露收到的 transcript，断言无处落 | 中 | 中 | 3.3 的 `streamFn` 包装兜底 |
| 工具调用 id 生成方式不同，导致配对断言失败 | 中 | 中 | 断言改为"配对关系正确"而非"id 等于某字面量" |
| core 新增 `./testing` 导出被误当作公共 API | 低 | 低 | 子路径命名 + README 注明仅供测试；不在主 `index.ts` 导出 |
| desktop 测试依赖 core 的 dist，改 core 后要先 build | 中 | 低 | 已是现状（`@spotshell/core` 走 dist），注意 watch 流程 |

## 8. 完成后的状态

- LangChain / LangGraph 从仓库彻底消失
- 测试替身从"手写 `BaseChatModel` 子类"变成官方 `fauxProvider`，后续维护成本下降
- 总计划第 8 节的 10 条全局验收标准全部满足
