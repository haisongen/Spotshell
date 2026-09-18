# 阶段 ① core + cli 迁移到 ESM

- 工时：1~1.5 人天
- 前置：无
- 可独立交付：✅ 是（不引入任何 pi 依赖，完成后可单独合入 `main`）
- **状态：已执行并验收通过（2026-09-18）**，改动留在工作区未提交；GUI 验证（SSH 连接 / 知识库工作区）待人工补
- 上级计划：[README.md](README.md)

## 1. 目标

把 `@spotshell/core` 与 `@spotshell/cli` 从 CommonJS 产物切换为 ESM 产物，为引入 ESM-only 的 pi 包扫清编译层障碍，**同时修掉一个已经存在的运行时缺陷**。

## 2. 为什么必须做

### 2.1 pi 的硬约束

`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 的 package.json 都是：

```json
{ "type": "module", "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } } }
```

**只有 `import` 条件，没有 `require`。** 在 `module: NodeNext` 的 CJS 文件里 `import` 它们，`tsc` 直接报 TS1479，编译就过不去。

### 2.2 已经存在的缺陷（本阶段的独立价值）

`@spotshell/core` 目前 `tsconfig.json` 是 `module: NodeNext`，而 `package.json` 没有 `"type"` 字段 → **产物是 CommonJS**。但 core 依赖了四个纯 ESM 包：

| 包 | package.json `type` |
| --- | --- |
| `unified` | `module` |
| `remark-parse` | `module` |
| `remark-frontmatter` | `module` |
| `mdast-util-to-string` | `module` |
| `strip-ansi` | `module` |

结果是编译产物里出现了对 ESM-only 包的 `require`：

```
packages/core/dist/knowledge/spaceDocument.js:16  const unified_1 = require("unified");
packages/core/dist/knowledge/spaceDocument.js:17  const remark_frontmatter_1 = __importDefault(require("remark-frontmatter"));
packages/core/dist/knowledge/spaceDocument.js:18  const remark_parse_1 = __importDefault(require("remark-parse"));
packages/core/dist/knowledge/spaceDocument.js:19  const mdast_util_to_string_1 = require("mdast-util-to-string");
```

这在 **Node 20.18 及更早**版本上是 `ERR_REQUIRE_ESM`。

> 📌 执行时修正：`require(esm)` 在 **Node 20.19.0** 被 backport，所以 Node 20.19+ 上 `require("unified")` 是成功的。原文"这在 Node 20 上是 ERR_REQUIRE_ESM"说得过宽。
>
> 但缺陷依然成立：**Electron 33.4.11 恰好携带 Node 20.18.3**，正好落在有问题的区间。已在真实 Node 20.18.3 下实测确认：
> ```
> require('unified') FAILED: ERR_REQUIRE_ESM     ← Node 20.18.3
> require('unified') OK                          ← 开发机 Node 26.6.0
> ```

目前没暴露，因为：

- desktop 由 electron-vite/rollup 打包，ESM 在构建期被内联
- 开发机 Node 是 26.6.0，支持 `require(esm)`

但 `@spotshell/cli` 的 `npm start`（`node dist/index.js`，无打包）在 Node 20 上，只要走到知识库解析路径就会崩。`packages/core/src/context/ContextBuffer.ts:1-6` 已经用动态 `import('strip-ansi')` 打了个补丁 —— 那就是这个问题的第一次现形。

**换句话说：这一步是本来就欠的技术债，不是为 pi 付的成本。**

## 3. 范围

| 工作区 | 源文件数 | 测试文件数 |
| --- | --- | --- |
| `packages/core` | 96 | 46 |
| `packages/cli` | 6 | 0 |

好消息：

- 全部相对 import **已经带 `.js` 扩展名**（AGENTS.md 强制要求），NodeNext ESM 直接可用
- core 与 cli 的源码中**没有任何** `__dirname` / `__filename` / `require(`
- 没有 JSON import（`resolveJsonModule` 开着但没用上）

## 4. 实施步骤

### 4.1 core 切 ESM

1. `packages/core/package.json` 增加 `"type": "module"`
2. `exports` 字段保持不变（`types` + `default` 已够用）
3. `npm run build:core`，逐个消化 tsc 报错

### 4.2 处理 CJS 依赖的具名导入

ESM 里从 CJS 包做具名 import，依赖 Node 的 `cjs-module-lexer` 能静态识别导出。已核对的依赖：

| 依赖 | 导出形式 | 具名 import 可行性 |
| --- | --- | --- |
| `ssh2` | `module.exports = { Client: ..., Server: ..., utils: {...} }` 对象字面量 | ✅ 可识别 |
| `shell-quote` | `exports.quote = ...; exports.parse = ...` | ✅ 可识别 |
| `yaml` | `exports` 条件导出，CJS 入口 | ✅ |
| `zod` | 双格式发布 | ✅ |
| `commander` / `dotenv` | 双格式发布 | ✅ |
| `inquirer` v12 | 已是 ESM | ✅ |

**但"可识别"要实测，不要只看代码。** 验证方式见 5.2。

如果某个包具名 import 失败，降级写法：

```ts
import ssh2 from 'ssh2';
const { Client } = ssh2;
```

### 4.3 回收 strip-ansi 的动态 import 补丁

`packages/core/src/context/ContextBuffer.ts:1-6` 的动态 `import('strip-ansi')` 在 ESM 下不再必要，改回静态 import。这一步会顺带简化 `ContextBuffer` 的异步初始化逻辑 —— **注意它可能影响调用方的 await 时序，改完必须跑 `ContextBuffer.test.ts`**。

### 4.4 cli 切 ESM

1. `packages/cli/package.json` 增加 `"type": "module"`
2. `packages/cli/src/index.ts:1` 的 `#!/usr/bin/env node` shebang 保持不变
3. `import 'dotenv/config'` 在 ESM 下仍可用
4. `import * as fs from 'fs'` 建议统一改为 `node:fs` 前缀（非必须，但和 pi 风格一致）

### 4.5 desktop 构建配置复核

`packages/desktop/electron.vite.config.ts` 的 main 段当前有：

```ts
build: {
  commonjsOptions: {
    include: [/node_modules/, /packages[\\/]core[\\/]dist/],
  },
}
```

`packages/core/dist` 这一条是为了把 core 的 **CJS** 产物转成 ESM 供 rollup 处理。core 切 ESM 后该条目失效，**应当移除**，否则 `@rollup/plugin-commonjs` 会对已经是 ESM 的文件做无意义扫描。

同时确认 `externalizeDepsPlugin({ exclude: ['@spotshell/core'] })` 行为不变：core 仍然被打进 bundle，core 的传递依赖（`unified` 等）也随之内联。

### 4.6 测试脚本

`tsx --test src/**/*.test.ts` 在 ESM 下继续可用，无需改动。但要确认 tsx 对 ESM 测试文件的 glob 展开行为在 Windows PowerShell 下一致（当前由 npm 传给 tsx，由 tsx 自己展开）。

## 5. 验收标准

### 5.1 构建与测试

1. `npm run build` 全工作区通过
2. `npm test` 全部通过
3. `packages/core/dist/index.js` 顶部不再有 `"use strict"; Object.defineProperty(exports, ...)`，而是 `export { ... }`
4. `grep -rn 'require("unified")' packages/core/dist` 无结果

### 5.2 运行时实测（关键，不可跳过）

5. **CLI 在 Node 20 下跑通**：用 `npx -p node@20 node packages/cli/dist/index.js --help` 之类方式，验证 `ssh2` / `shell-quote` 的具名 import 在真实 Node 20 ESM 下解析成功
6. **CLI 走到知识库路径**：至少触发一次 `parseSpaceDocument`，确认 `unified` 链路不再报 `ERR_REQUIRE_ESM`
7. `npm run pack -w @spotshell/desktop` 产物可启动，能连 SSH、能开知识库工作区

## 6. 风险

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| `ssh2` 具名 import 在 Node 20 ESM 下失败 | 中 | 高（SSH 全挂） | 4.2 的 default import 降级写法；必须用真实 Node 20 验证，不能只看开发机 Node 26 |
| `ContextBuffer` 去掉动态 import 后时序变化 | 中 | 中 | 改完立刻跑 `ContextBuffer.test.ts` + `ShellIntegration.test.ts` |
| electron-vite main 产物格式变化导致 Electron 启动失败 | 低 | 高 | 保留 `commonjsOptions` 改动为独立 commit，便于单独回滚 |
| 46 个 core 测试中某些依赖 CJS 求值时序 | 低 | 中 | 逐个跑，不要只看汇总 |

## 7. 回滚

三个独立 commit，任一可单独 revert：

1. `refactor(core): 切换到 ESM 产物`
2. `refactor(cli): 切换到 ESM 产物`
3. `build(desktop): 移除 core dist 的 commonjs 转换配置`

## 8. 完成后的状态

- `packages/core` 与 `packages/cli` 产出 ESM
- 可以直接 `import` 任何 ESM-only 包，pi 的引入不再有编译障碍
- CLI 在 Node 20 上不再有 `ERR_REQUIRE_ESM` 隐患
- **LangGraph 仍在使用，功能零变化** —— 这一步对用户完全不可见
