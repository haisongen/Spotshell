# LangGraph → Pi Agent 迁移总计划

- 计划日期：2026-09-18
- 影响工作区：`@spotshell/core`、`@spotshell/cli`、`@spotshell/desktop`
- 目标框架：[`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) `0.85.1` + `@earendil-works/pi-ai` `0.85.1`
- 本地参考仓库：`F:\myProjects\pi`（仅作 API 参考，依赖走 npm）
- 预估总工时：**8.5~10 人天**（含 Electron 升级 0.5~1d）

## 0. 迁移已完成 ✅

**LangChain / LangGraph 已从仓库彻底移除**（2026-09-20）。`grep -rn '@langchain' packages/` 零结果。

| 阶段 | 状态 | 关键产出 |
| --- | --- | --- |
| ⓪ Electron 升级 | ✅ 已提交 | 33.4.11 → 44.4.2（Node 20.18.3 → 24.21.0） |
| ① ESM 迁移 | ✅ 已提交 | core/cli 转 ESM，顺带修掉既有的 `ERR_REQUIRE_ESM` 缺陷 |
| ② 消息抽象层 | ✅ 已提交 | 自有 `AgentMessage` 判别联合，langchain 收敛到边界 |
| ③ 工具 TypeBox | ✅ 已提交 | 14 个工具 schema 迁移，dump diff 证明零语义漂移 |
| ④ Provider → pi-ai | ✅ 已提交 | `resolveModel` 接入 pi-ai，`createChatModel` 过渡保留 |
| ⑤ 运行时重写 | ✅ 已提交 | pi `Agent` 取代 `StateGraph`，langchain 全部移除 |
| ⑥ 测试迁移 | ✅ 并入 ⑤ | 见 [06 文档](06-test-migration.md) 的说明 |

最终状态：`npm run build` exit 0；`npm test` **core 377/377、desktop 321/321 fail 0**；`SessionManager.ts` 全程零改动；用例名全集 **零覆盖丢失**；`out/main` 体积较迁移前**减少 33%**，主 bundle 减少 61%。

### 已决策事项

| 决策 | 结论 | 日期 |
| --- | --- | --- |
| Electron 是否升级 | ✅ **升级**，目标 `44.4.2`（Node 24.21.0），见 [00-electron-upgrade.md](00-electron-upgrade.md) | 2026-09-18 |
| pi 依赖引入方式 | ✅ **npm 正式版**，锁定 `0.85.1`，不用 `^` | 2026-09-18 |

### 遗留待办（不属本次迁移）

1. **⚠️ `safeStorage` 同步 API 在 Electron 45 弃用、46 移除** —— `hostsStore.ts` / `settingsStore.ts` 用的正是这三个，下次大版本升级会编译不过。迁移不涉及数据迁移。见 [00 第 9.1 节](00-electron-upgrade.md)
2. **Electron 44 取消了 postinstall 自动下载二进制** —— 干净环境 `npm install` 后 `node_modules/electron/dist/` 为空。见 [00 第 9.2 节](00-electron-upgrade.md)
3. **安装包内含 pi-ai 的未用 SDK**（`@aws-sdk` / `@smithy` / `protobufjs`），JS 产物里为 0 但 asar 里仍在。可在 `electron-builder.yml` 的 `files` 加排除项。见 [04 第 0.1 节](04-providers-pi-ai.md)
4. **扩 provider 白名单** —— pi-ai 支持 28+ 家，当前仍限 `openai` / `anthropic`。放开需改设置存储结构、IPC schema 与设置 UI，是独立需求
5. **接入 thinking level** —— pi 原生支持，当前固定 `'off'`

## 1. 目标

把 SpotShell 的 Agent 核心从 `@langchain/langgraph` + `@langchain/core` 迁移到 Pi Agent Harness，换取：

- **多 Provider**：从当前的 openai / anthropic 两家扩展到 pi-ai 支持的 28+ 家（含 DeepSeek、Moonshot、ZAI、Qwen、OpenRouter、任意 OpenAI 兼容端点）
- **原生 thinking level**：`off | minimal | low | medium | high | xhigh | max`，当前 LangGraph 路径没有统一抽象
- **`beforeToolCall` 预检钩子**：命令风险确认（`risk.ts` + IPC 审批）可以从工具函数体内部上移到框架钩子，语义更正
- **更干净的流式事件**：`message_update` / `tool_execution_*` 是一等公民，取代现在靠 `meta.langgraph_node === 'agent'` 字符串判断的过滤逻辑
- **`transformContext` 钩子**：正好是 `ContextAssembler` + `trimHistoryToBudget` 的官方插入点

## 2. 现状盘点

### 2.1 LangGraph 本身用得很浅

真正依赖 `@langchain/langgraph` 的只有一个文件：

| 位置 | 内容 | 行数 |
| --- | --- | --- |
| `packages/core/src/agent/SpotShellAgent.ts:178-215` | `buildGraph()`：agent 节点 + `ToolNode` + 条件边 | 38 |
| `packages/core/src/agent/SpotShellAgent.ts:246-267` | `graph.stream()` 双模式（`values` + `messages`）消费循环 | 22 |
| `packages/core/src/agent/SpotShellAgent.ts:62,158,222` | `graph` 字段与失效重建 | 3 |

**合计约 60 行。** 换掉图本身不是成本大头。

### 2.2 真正的耦合是 `@langchain/core`

源码侧 9 个文件：

| 文件 | 行数 | 耦合内容 |
| --- | --- | --- |
| `core/src/agent/SpotShellAgent.ts` | 557 | 全部四类耦合 |
| `core/src/context/ContextCompaction.ts` | 334 | `BaseMessage` 贯穿全部导出签名 |
| `core/src/agent/tools.ts` | 334 | `tool()` + `StructuredToolInterface` + zod |
| `core/src/agent/knowledgeTools.ts` | 260 | 同上 |
| `core/src/agent/history.ts` | 104 | `AIMessage` / `ToolMessage` 实例判定 |
| `core/src/agent/types.ts` | — | `AgentHistory = BaseMessage[]`（**已泄漏到公共 API**） |
| `core/src/agent/providers/types.ts` | — | `createChatModel(): BaseChatModel` |
| `core/src/agent/providers/openaiProvider.ts` | — | `ChatOpenAI` |
| `core/src/agent/providers/anthropicProvider.ts` | — | `ChatAnthropic` |

测试侧 11 个文件，约 **2800 行**，全部依赖 `FakeListChatModel` 或手写 `BaseChatModel` 子类：

- core：`history.test.ts`(86)、`providers/registry.test.ts`(56)、`ContextCompaction.test.ts`(172)、`SpotShellAgent.runtime.test.ts`(192)、`SpotShellAgent.compaction.test.ts`(277)、`SpotShellAgent.dynamicModules.test.ts`(279)
- desktop：`llmProbe.test.ts`(95)、`SessionManager.agentRuntime.test.ts`(353)、`SessionManager.contextEpoch.test.ts`(349)、`SessionManager.dynamicModules.test.ts`(300)、`SessionManager.v1Acceptance.test.ts`(679)

> 注意：`packages/desktop/src` 的**非测试**代码没有任何 `@langchain` 直接 import，只通过 `@spotshell/core` 的类型间接依赖。这是好消息，desktop 主进程改动面很小。

### 2.3 完全不受影响的部分

`ContextAssembler.ts`(441)、`knowledge/**`（约 8000 行）、`risk.ts` / `danger.ts` / `commandParse.ts` / `format.ts`、`ssh/**`、renderer UI、`shared/` 的 IPC zod schema —— 全部不动。

**没有数据迁移。** Agent 历史只存在内存，`SessionManager.ts:641` 与 `:842-844` 在重连/换模型时从旧 agent 手递给新 agent，既不落盘也不过 IPC。

## 3. 概念映射

| SpotShell 现状 | Pi 对应 | 难度 |
| --- | --- | --- |
| `StateGraph` + `ToolNode` | `Agent` 类 / `agentLoop()` | 低，代码量减少 |
| `meta.langgraph_node === 'agent'` 过滤 token | `message_update` + `assistantMessageEvent.type === 'text_delta'` | 低，更干净 |
| `trimHistoryToBudget` + 上下文注入 | `transformContext(messages, signal)` | 低，官方插入点 |
| 命令风险确认（工具体内拦截） | `beforeToolCall` 返回 `{ block: true, reason }` | 低，语义更正 |
| `BaseMessage` / `AIMessage` / `HumanMessage` / `ToolMessage` / `SystemMessage` | `AgentMessage`（`user` / `assistant` / `toolResult` / `system`），自定义 role 用声明合并 | **高**，形状全变 |
| `tool()` + **zod** schema | `AgentTool` + **TypeBox** `Type.Object` | 中，14 个工具定义 |
| `BaseChatModel` + `ChatOpenAI` / `ChatAnthropic` | pi-ai `Models` + `Model` + `createProvider()` | 中，4 个文件重写 |
| `modelContext.ts` `resolveContextWindow` | pi-ai `Model.contextWindow` 自带 | 低，可删一批硬编码 |
| `FakeListChatModel` / 手写子类 | `fauxProvider()` + `fauxAssistantMessage` / `fauxToolCall` | 中，量大 |
| `recursionLimit` | **无直接等价物**，需用 `shouldStopAfterTurn` 自行计数 | 中，要补实现 |
| `AgentCancelledError`（catch 异常） | 不抛异常，走 `stopReason: 'aborted'` | 中，取消路径改写 |
| `config.baseURL` 字符串 | `createProvider()` + `Model.baseUrl` | 中，要自行构造 `Model` 对象 |

## 4. 结构性障碍

### 4.1 ESM / CJS —— 最容易被低估的一块

- pi 全部包是 **ESM-only**：`"type": "module"`，`exports` 只声明 `import` 条件，没有 `require`
- `@spotshell/core` 当前 `module: NodeNext` 且 package.json 无 `"type"` → **产出 CommonJS**（已验证：`packages/core/dist/index.js` 含 42 处 `require(`）
- CJS 模块 `import` 一个 ESM-only 包，`tsc` 会报 TS1479，编译层面就过不去

**但这不是纯粹为 pi 付的成本。** core 目前**已经**在 CJS 产物里 `require()` 四个 ESM-only 包：

```
packages/core/dist/knowledge/spaceDocument.js:16  require("unified")
packages/core/dist/knowledge/spaceDocument.js:17  require("remark-frontmatter")
packages/core/dist/knowledge/spaceDocument.js:18  require("remark-parse")
packages/core/dist/knowledge/spaceDocument.js:19  require("mdast-util-to-string")
```

`unified` / `remark-parse` / `strip-ansi` / `mdast-util-to-string` 都是 `"type": "module"` 的纯 ESM 包。这在 Node 20 上会直接 `ERR_REQUIRE_ESM`。目前没暴露是因为：desktop 由 rollup 打包把 ESM 内联了，而开发机 Node 是 26.6.0（支持 `require(esm)`）。**CLI 的 `npm start` 在 Node 20 上碰到知识库解析路径就会崩。**

→ **结论：ESM 迁移是本来就该做的技术债，不应记在 pi 头上。** 详见 [01-esm-migration.md](01-esm-migration.md)。

### 4.2 Node 版本 —— 已通过阶段 ⓪ 解决

pi 声明 `engines: node >= 22.19`，而 Electron `33.4.11` 携带 Node 20.18.3。

**决策：升级 Electron 到 `44.4.2`（Node 24.21.0）**，作为独立的[阶段 ⓪](00-electron-upgrade.md) 前置完成。

选 44 而不是 Node 22 末班车（Electron 39，Node 22.22.1）的原因：Electron 只维护最新 3 个大版本（42/43/44），39 一落地就是 EOL。对一个处理 SSH 凭据的应用，留在支持窗口内是硬要求。

升级风险低于预期：整个依赖树**零原生模块**（`binding.gyp` 零命中，`ssh2` 是纯 JS，`electron-builder.yml` 本来就 `npmRebuild: false`），desktop 只用了 11 个稳定核心 API。唯一需要专项验证的是 `safeStorage` 加密的主机凭据能否跨版本解密 —— 详见 [00-electron-upgrade.md](00-electron-upgrade.md) 5.3。

### 4.3 依赖体积

`pi-agent-core` 会拉进 `@earendil-works/chord`、`pi-telemetry`、`typebox`、`yaml`、`diff`、`ignore`。移除 langchain 省下的和新增的大致抵消，**不要期待 `out/main/index.js` 那 3.7MB 明显变小**。

### 4.4 pi 仍在 0.85.1

pre-1.0，API 可能变动。如果 SpotShell 近期要发版，见第 6 节的分支策略。

## 5. 阶段拆分

```
⓪  Electron 33 → 44                      0.5~1d   ← 独立价值，与 pi 无关
         ┆（只阻塞 ④）
①  ESM 迁移（core + cli）                1~1.5d   ← 独立价值，与 pi 无关
         ↓
②  AgentMessage / AgentTool 抽象层         1.5~2d   ← 独立价值，隔离 langchain
         ↓
    ┌────┴────┐
③  工具 → TypeBox   ④  Provider → pi-ai    各 1d    ← 可并行
    └────┬────┘
         ↓
⑤  SpotShellAgent 主体重写                 1.5d
         ↓
⑥  测试迁移（11 文件 / ~2800 行）           2d
```

⓪ 与 ① 相互独立，可并行或任意顺序。

| 阶段 | 计划文档 | 工时 | 前置 | 可独立交付 |
| --- | --- | --- | --- | --- |
| ⓪ Electron 升级 | [00-electron-upgrade.md](00-electron-upgrade.md) | 0.5~1d | — | ✅ 是 |
| ① ESM 迁移 | [01-esm-migration.md](01-esm-migration.md) | 1~1.5d | — | ✅ 是 |
| ② 消息/工具抽象层 | [02-agent-message-abstraction.md](02-agent-message-abstraction.md) | 1.5~2d | ① | ✅ 是 |
| ③ 工具 schema → TypeBox | [03-tools-typebox.md](03-tools-typebox.md) | 1d | ② | ⚠️ 部分 |
| ④ Provider → pi-ai | [04-providers-pi-ai.md](04-providers-pi-ai.md) | 1d | ⓪①② | ⚠️ 部分 |
| ⑤ Agent 运行时重写 | [05-agent-runtime-rewrite.md](05-agent-runtime-rewrite.md) | 1.5d | ②③④ | ❌ 否 |
| ⑥ 测试迁移 | [06-test-migration.md](06-test-migration.md) | 2d | ⑤ | ❌ 否 |

**①② 不依赖 pi，单独做就有价值，且全程保持可构建可运行。** 中途放弃的损失仅仅是"把耦合解开了"。

## 6. 分支与发版策略

- 在 `feat/pi-agent-migration` 上推进，每个阶段一个或多个 conventional commit
- **⓪①② 完成后可以先合回 `main`**（它们不引入 pi 依赖）
- ③④⑤⑥ 建议整体合入，中间态不合 `main`
- 如果近期要发版：先只做 ⓪①②，把 LangGraph 收敛到一个边界文件，等 pi 到 1.0 再切 ③④⑤⑥

> ⓪ 单独合入还有个附带好处：Electron 升级的回归（如果有）会在引入 pi 之前暴露，不会和 Agent 迁移的问题混在一起。

## 7. 依赖引入方式 —— 已决策

**走 npm 正式版，版本锁死不用 `^`：**

```jsonc
// packages/core/package.json
"dependencies": {
  "@earendil-works/pi-agent-core": "0.85.1",
  "@earendil-works/pi-ai": "0.85.1"
}
```

理由：pi 仍在 0.85.1（pre-1.0），小版本间 API 可能变动，`^` 会让 `npm install` 在无人察觉时把运行内核换掉。仓库现有 `@langchain/langgraph: "1.0.15"` 也是精确版本，与这个做法一致。

本地 `F:\myProjects\pi` **仅作为 API 参考与问题定位**，不通过 `file:` 链接。需要验证某个 pi 行为时，去本地仓库读源码或跑它自己的测试，不要把它接进 SpotShell 的依赖图。

## 8. 全局验收标准

迁移完成时必须满足：

1. `npm run build` 全工作区通过
2. `npm test` 全部通过（core + desktop）
3. `npm run pack -w @spotshell/desktop` 产出可运行的 portable 与 NSIS 安装包
4. 手工冒烟：连接 SSH → 提问 → 流式输出逐字可见 → 触发只读命令工具 → 触发写命令并弹出审批 → 拒绝后 Agent 正确收尾
5. 取消：生成中点"停止"，不产生半截消息污染历史，下一轮对话正常
6. 上下文压缩：长对话触发一次自动压缩，`context_compaction` 事件到达 UI，压缩后对话可继续
7. 换模型：对话中途切换 provider/model，历史保留，新模型可继续
8. 重连：`SessionManager.reconnect()` 后 Agent 历史完整
9. `@langchain/*` 从 `packages/core/package.json` 与 `packages/desktop/package.json` 中彻底移除
10. `packages/core/dist/` 中不再出现 `require("unified")` 一类对 ESM-only 包的 `require`

## 9. 决策点

### 已决（见第 0 节）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | Electron 是否升级 | ✅ 升到 `44.4.2`，拆为独立的[阶段 ⓪](00-electron-upgrade.md) |
| 2 | pi 依赖引入方式 | ✅ npm 正式版，精确锁 `0.85.1` |

### 待确认

| # | 问题 | 建议 | 阻塞阶段 |
| --- | --- | --- | --- |
| 3 | 自定义 baseURL 的模型，`contextWindow` 从哪来 | 保留 `modelContext.ts` 作为兜底，pi-ai 目录优先 | ④ |
| 4 | 是否顺势启用 pi 的 thinking level | 阶段 ⑤ 只做透传，UI 单开一个需求 | ⑤ |
| 5 | 是否用 pi 自带的 `harness/compaction` 替换自研 `ContextCompaction` | **不换**，自研版本与 ContextAssembler 预算耦合太紧 | ② |
| 6 | 命令风险审批是否从 `PolicyExecutor` 上移到 `beforeToolCall` | **不动**，现有设计迁移后原样工作；作为后续优化 | ⑤ |

> 3/4/5/6 都是"按建议默认执行"即可的技术选型，不阻塞开工 —— 只有在实施中发现建议不成立时才需要回头讨论。
