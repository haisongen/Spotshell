# 阶段 ④ Provider 层迁移到 pi-ai

- 工时：1 人天
- 前置：[⓪ Electron 升级](00-electron-upgrade.md)、[① ESM 迁移](01-esm-migration.md)、[② 消息/工具抽象层](02-agent-message-abstraction.md)
- 可并行：与 [③ 工具 TypeBox 迁移](03-tools-typebox.md) 无依赖
- 上级计划：[README.md](README.md)

## 1. 目标

把 `packages/core/src/agent/providers/` 从 `BaseChatModel` + `ChatOpenAI` / `ChatAnthropic` 换成 pi-ai 的 `Models` + `Model<Api>`。

这是本次迁移中**唯一真正引入 pi 依赖**的第一步，也是 `@langchain/openai` / `@langchain/anthropic` 两个包被删除的地方。

## 2. 前置：Electron 升级（已完成）

pi 声明 `engines: node >= 22.19`。[阶段 ⓪](00-electron-upgrade.md) 已把 Electron 升到 `44.4.2`（Node 24.21.0），本阶段开始前该前置必须已合入并验证通过。

**开工前确认一次**：在打包产物里（不是开发机）打印 `process.versions.node`，应为 `24.21.0`。开发机 Node 是 26.6.0，容易掩盖运行时版本问题。

若 ⓪ 因故未完成而本阶段必须先行，那么验收第 7 条（打包产物内跑通真实 provider 请求）就从"建议"升级为"必须"。

## 3. 范围界定：**不扩 provider 白名单**

pi-ai 支持 28+ provider。**本阶段不放开。**

原因：`ModelProviderId` 目前是个窄联合，并且被用作 **Record 的键**：

```
packages/desktop/src/shared/ipc-types.ts:195   export type ModelProviderId = 'openai' | 'anthropic'
packages/desktop/src/main/modelSettings.ts:7   MODEL_PROVIDER_IDS / DEFAULT_PROVIDER_MODELS
packages/desktop/src/main/modelSettings.ts:21  providers: Record<ModelProviderId, StoredModelProfile>
packages/desktop/src/main/modelSettings.ts:25  ProviderApiKeys { openai?, anthropic? }
```

放开到 28 家会连带改：设置存储结构（定长 Record → 动态 Map）、设置迁移、API Key 存储、设置 UI、IPC schema。**那是一个独立需求，不是本次迁移的一部分。**

本阶段保持 `'openai' | 'anthropic'` 两家不变，只把底层实现换成 pi-ai。扩 provider 留作迁移完成后的后续收益。

## 4. 设计

### 4.1 `ModelProvider` 接口改造

现状（`providers/types.ts`）：

```ts
export interface ModelProvider {
  readonly id: ModelProviderId
  readonly defaultModel: string
  createChatModel(config: ModelProviderConfig): BaseChatModel
  normalizeError(error: unknown): ModelProviderErrorInfo
}
```

改为：

```ts
import type { Api, Model } from '@earendil-works/pi-ai'

export interface ResolvedModel {
  /** 交给 Agent 的 pi-ai 模型描述 */
  model: Model<Api>
  /** 该模型对应的 Models 集合，Agent 用它拿 streamFn */
  models: Models
}

export interface ModelProvider {
  readonly id: ModelProviderId
  readonly defaultModel: string
  resolveModel(config: ModelProviderConfig): ResolvedModel
  normalizeError(error: unknown): ModelProviderErrorInfo
}
```

`ModelProviderConfig`（`provider` / `apiKey` / `model` / `baseURL` / `temperature` / `maxTokens`）**保持不变** —— 这是 `SpotShellAgent.toProviderConfig()`（`:498-511`）和 `llmProbe.ts` 的共同契约，不动可以减少涟漪。

### 4.2 baseURL：内置 provider vs 自定义端点

两条路径：

**无 `baseURL`** —— 用 pi-ai 内置 provider：

```ts
import { createModels } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'

const models = createModels()
models.setProvider(openaiProvider())
const model = models.getModel('openai', config.model)
```

注意按需 import 单个 provider，**不要用 `builtinModels()`** —— 那会把 28 家全部打进 bundle。

**有 `baseURL`** —— 用 `createProvider()` 造一个动态 provider：

```ts
import { createProvider, createModels } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

const model: Model<'openai-completions'> = {
  id: config.model,
  name: config.model,
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: config.baseURL,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: /* 见 4.3 */,
  maxTokens: /* 见 4.3 */,
}
```

⚠️ **这是本阶段最大的实现量。** 自定义端点时 pi-ai 不知道模型元数据，`contextWindow` / `maxTokens` / `cost` / `reasoning` / `input` 全部要我们自己填。

anthropic 侧同理，用 `anthropic-messages` API。

### 4.3 `contextWindow` 的来源

pi-ai 的内置模型目录自带 `Model.contextWindow`。SpotShell 自己也有 `packages/core/src/agent/modelContext.ts`（`KNOWN_MODEL_CONTEXT_WINDOWS` 22 条硬编码 + 用户可覆盖）。

**决策：保留 `modelContext.ts`，优先级调整为**

```
用户在设置里显式配置的 contextWindowTokens
  ↓ 缺省
pi-ai 的 Model.contextWindow（内置 provider 路径）
  ↓ 缺省
modelContext.ts 的 KNOWN_MODEL_CONTEXT_WINDOWS（自定义 baseURL 路径的兜底）
  ↓ 缺省
DEFAULT_CONTEXT_WINDOW = 128_000
```

`resolveContextWindow()` 的签名增加一个可选的 `providerContextWindow?: number` 入参。`CONTEXT_WINDOW_MIN/MAX` 的边界校验保持不变。

> 不删 `modelContext.ts` 的理由：自定义 baseURL（Ollama / vLLM / 国内中转）是 SpotShell 的实际使用场景，那条路径上 pi-ai 给不出 contextWindow。

### 4.4 错误归一化：输入形状变了

现状 `errorNormalization.ts` 的 `normalizeProviderError(error: unknown)` 吃的是**抛出的异常对象**，读 `status` / `statusCode` / `code` / `message` / `cause`。

pi-ai **不抛异常**。请求失败会：

- 流里发一个 `{ type: 'error', reason: 'error' | 'aborted', error: AssistantMessage }`
- 最终 `AssistantMessage.stopReason === 'error' | 'aborted'`，细节在 `errorMessage`、`diagnostics`

**改造方式**：保留 `normalizeProviderError(error: unknown)` 不动（`llmProbe` 的直接 `streamSimple()` 调用仍会同步抛 auth 错误），**新增**一个入口：

```ts
export function normalizeAssistantFailure(
  message: AssistantMessage,
): ModelProviderErrorInfo
```

它从 `stopReason` / `errorMessage` / `diagnostics` 推导 `kind`。内部复用现有的 `hasAny()` 关键字匹配表（`authentication` / `rate_limit` / `model_not_found` / `timeout` / `network` / `unsupported_tools`），只是输入换成 `errorMessage` 字符串。

`SAFE_MESSAGES` 那张脱敏文案表**保持不变** —— 它保证 provider 原始报错（可能含 key 片段）不会泄漏到 UI，这是安全属性，不能丢。

### 4.5 `llmProbe.ts` 改造

`packages/desktop/src/main/llmProbe.ts:45-58` 现在是：

```ts
const chatModel = provider.createChatModel({ ...,  maxTokens: 8 })
await Promise.race([chatModel.invoke('ping', { signal: abort.signal }), timeout])
```

改为：

```ts
const { models, model } = provider.resolveModel({ ..., maxTokens: 8 })
const assistant = await models.complete(model, {
  messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
}, { signal: abort.signal })
if (assistant.stopReason === 'error') {
  return { ok: false, ...provider.normalizeAssistantFailure(assistant) }
}
```

注意 `LlmTestResult.errorKind` 的取值集合（`ModelProviderErrorKind`）**保持不变**，renderer 的设置页文案映射不用动。

20 秒超时逻辑（`TIMEOUT_MS`）保留，但可以改用 `AbortSignal.any([signal, AbortSignal.timeout(20_000)])` 简化 —— pi-ai 内部就是这么写的。

## 5. 范围清单

### 5.1 重写

| 文件 | 改动 |
| --- | --- |
| `core/src/agent/providers/types.ts` | `createChatModel` → `resolveModel`；去掉 `BaseChatModel` |
| `core/src/agent/providers/openaiProvider.ts` | `ChatOpenAI` → pi-ai `openaiProvider()` / `createProvider()` |
| `core/src/agent/providers/anthropicProvider.ts` | `ChatAnthropic` → pi-ai `anthropicProvider()` / `createProvider()` |
| `core/src/agent/providers/errorNormalization.ts` | 新增 `normalizeAssistantFailure()` |
| `core/src/agent/modelContext.ts` | `resolveContextWindow()` 增加 provider 兜底入参 |
| `desktop/src/main/llmProbe.ts` | `invoke('ping')` → `models.complete()` |

### 5.2 不动

| 文件 | 原因 |
| --- | --- |
| `core/src/agent/providers/registry.ts` | 白名单不变，只是内部 provider 实例换了实现 |
| `desktop/src/main/modelSettings.ts` | 见第 3 节，白名单不扩 |
| `desktop/src/shared/ipc-types.ts` | `ModelProviderId` / `LlmTestResult` 契约不变 |
| renderer 设置页 | 完全不动 |

### 5.3 依赖变更

```
+ @earendil-works/pi-ai       0.85.1    (core dependencies, 精确版本不用 ^)
- @langchain/openai
- @langchain/anthropic
```

`@langchain/core` 与 `@langchain/langgraph` **本阶段还不能删** —— `SpotShellAgent.ts` 还在用，阶段 ⑤ 才删。

## 6. 实施步骤

1. 确认[阶段 ⓪](00-electron-upgrade.md) 已合入：打包产物内 `process.versions.node` 为 `24.21.0`
2. 加 `@earendil-works/pi-ai` 依赖，确认 `npm run build -w @spotshell/core` 不因 ESM 报错（阶段 ① 已铺好路）
3. 改 `providers/types.ts` 接口
4. 实现 openai provider 的两条路径（内置 / 自定义 baseURL）
5. 实现 anthropic provider 的两条路径
6. 加 `normalizeAssistantFailure()`
7. 改 `resolveContextWindow()` 优先级
8. `SpotShellAgent.ts` 里 `this.model` 的类型临时用 adapter 兜住 —— **本阶段 SpotShellAgent 还跑在 LangGraph 上**，需要一个 `Model<Api>` → `BaseChatModel` 的临时桥接，或者**接受本阶段 core 暂时构建不过、与阶段 ⑤ 合并交付**
9. 改 `llmProbe.ts`
10. 跑 `providers/registry.test.ts` + `llmProbe.test.ts`（这两个会红，属于阶段 ⑥ 范围，本阶段先让它们编译通过）

> ⚠️ **第 8 步是本阶段的"部分可交付"折扣所在。** pi-ai 的 `Model` 和 langchain 的 `BaseChatModel` 没有合理的桥接方式。实践中建议：④ 和 ⑤ 在同一个分支上连续做，中间态不要求 `npm test` 全绿，只要求 `npm run build` 通过。

## 7. 验收标准

1. `npm run build` 通过
2. **真实 provider 连通性**（不可用 mock 代替）：
   - OpenAI 官方端点 + 官方 key → `测试连接` 成功
   - Anthropic 官方端点 + 官方 key → `测试连接` 成功
   - 自定义 baseURL（如本地 Ollama 或国内中转）→ `测试连接` 成功
3. 错误归一化：故意填错 key → UI 显示 `authentication` 对应文案，**且日志/UI 中不出现 key 片段或 provider 原始报错**
4. 超时：把 baseURL 指向不可达地址 → 20 秒后返回 `network` 或 `timeout`
5. `contextWindow`：自定义 baseURL 且未配置 `contextWindowTokens` 时，上下文用量条读数与 `modelContext.ts` 兜底值一致
6. `@langchain/openai` 与 `@langchain/anthropic` 从 `packages/core/package.json` 移除
7. **在打包产物内**（不是 `npm run dev`）跑通第 2 条的全部三项 —— 开发机 Node 26 会掩盖运行时版本问题

## 8. 风险

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| pi 在 Electron 44 的 Node 24 下有未发现的不兼容 | 低 | 高 | Node 24.21 远超 pi 要求的 22.19；验收第 7 条强制在打包产物里验证 |
| 自定义 baseURL 路径的 `Model` 元数据填错，导致请求体异常 | 中 | 高 | 用本地 Ollama / vLLM 实测，不要只测中转 |
| `maxTokens` 语义在 pi-ai 与 langchain 间不一致（输出上限 vs 总量） | 中 | 中 | 对照 `packages/ai/src/api/openai-completions.ts` 的请求构造确认 |
| `normalizeAssistantFailure` 漏掉某类错误 → 全部落到 `unknown` | 中 | 低 | 保留现有关键字表；对每个 `kind` 至少构造一个用例 |
| 按需 import provider 写错，`builtinModels()` 把 28 家打进 bundle | 中 | 中 | 打包后检查 `out/main/index.js` 体积增量，超过 1MB 就是拉多了 |
| pi 0.85.1 小版本漂移换掉运行内核 | 中 | 高 | `package.json` 精确锁 `0.85.1`，不用 `^`；`package-lock.json` 纳入 review |

## 9. 回滚

- Electron 升级：独立 commit
- provider 迁移：与阶段 ⑤ 同分支，整体 revert
