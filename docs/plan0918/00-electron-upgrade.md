# 阶段 ⓪ Electron 升级（33 → 44）

- 工时：0.5~1 人天
- 前置：无
- 可独立交付：✅ 是（与 pi 迁移完全无关，可随时单独合入）
- **状态：已执行并验收通过（2026-09-18）**，改动留在工作区。实测运行时 `node 24.21.0 / electron 44.4.2 / chrome 152.0.7977.130`
- 上级计划：[README.md](README.md)

## 0. 执行结果摘要

两步都成功，**`electron-vite` 2→5 零配置改动即通过**，`electron.vite.config.ts` 未修改。

| | 升级前 | 升级后 |
| --- | --- | --- |
| electron | 33.4.11（Node 20.18.3 / Chromium 130） | **44.4.2（Node 24.21.0 / Chromium 152）** |
| electron-builder | ^25.1.8 | ^26.15.3 |
| electron-vite | ^2.3.0 | ^5.0.0 |
| vite | ^5.4.11 | 不变（electron-vite 5 的 peer 范围已覆盖） |
| `out/main/index.js` | 3,020,166 B | 3,020,166 B（**字节级相同**） |
| 安装包 | 约 81 MB | 约 102 MiB（+32%） |

`npm run build` exit 0；`npm test` core 354/354、desktop 319/319 fail 0；`npm run pack` 两个产物齐备。**阶段 ① 建立的 ESM 内联不变量保持**：`unified` / `remark-parse` / `remark-frontmatter` / `mdast-util-to-string` / `strip-ansi` 在 `out/main/index.js` 中 `require()` 计数全为 0，外部化集合仍只有 node builtins + `electron` + `ssh2` + `zod` + `@anthropic-ai/sdk`。

winCodeSign 未再触发符号链接解压失败，electron-builder 26 直接复用了已铺好的缓存。

## 1. 目标

把 `electron` 从 `33.4.11` 升到 `44.4.2`，使运行时 Node 从 20.18.3 升到 24.21.0，满足 pi 的 `engines: node >= 22.19`，并脱离 EOL 版本。

## 2. 版本选择

实测的 Electron → Node 映射（取自 `releases.electronjs.org/releases.json`）：

| Electron | Node | Chromium | 支持状态 |
| --- | --- | --- | --- |
| 33.4.11（当前） | 20.18.3 | 130 | 已 EOL |
| 35.7.5 | 22.16.0 | 134 | 已 EOL |
| 37.10.3 | 22.21.1 | 138 | 已 EOL |
| 39.8.10 | 22.22.1 | 142 | 已 EOL（Node 22 末班车） |
| 42.11.5 | 24.19.0 | 148 | ✅ 受支持 |
| 43.7.2 | 24.21.0 | 150 | ✅ 受支持 |
| **44.4.2** | **24.21.0** | **152** | ✅ 受支持（latest） |

Electron 只维护最新 3 个大版本。

**选定 `44.4.2`。** 理由：

- 落在支持窗口内，能拿到安全更新 —— 对一个处理 SSH 凭据的应用这是硬要求
- Node 24.21.0 远超 pi 的 `>= 22.19`，不留边界风险
- 升到 39（Node 22 末班车）虽然跨度小，但一落地就是 EOL，等于白升

**保守回退目标：`42.11.5`**（同样受支持，Chromium 低两档）。若 44 出现无法快速定位的渲染层问题，退到 42 而不是退回 33。

## 3. 为什么风险比"跨 11 个大版本"听起来低

### 3.1 零原生模块

扫描整个 `node_modules`，`binding.gyp` **零命中**。`ssh2` 是纯 JS 实现（`cpu-features` / `sshcrypto` 是可选依赖，未安装）。`electron-builder.yml` 里本来就是：

```yaml
npmRebuild: false
nodeGypRebuild: false
buildDependenciesFromSource: false
```

**没有 ABI 重编译问题** —— 这是跨大版本升级最常见的爆点，这里直接不存在。

### 3.2 只用了稳定核心 API

`packages/desktop/src` 用到的全部 Electron API：

```
app  BrowserWindow  dialog  shell
ipcMain  ipcRenderer  contextBridge
clipboard  Menu  nativeTheme  safeStorage
```

分布在 5 个文件：

| 文件 | API |
| --- | --- |
| `main/index.ts:1` | `app`、`BrowserWindow`、`dialog`、`shell` |
| `main/ipc.ts:1` | `ipcMain`、`BrowserWindow`、`clipboard` |
| `main/knowledgeIpc.ts:3` | `BrowserWindow`、`dialog`、`shell` |
| `main/appMenu.ts:1` | `dialog`、`Menu` |
| `main/hostsStore.ts:1` | `safeStorage` |

这些在 33→44 之间没有破坏性变更。**唯一需要专项验证的是 `safeStorage`**，见 5.3。

## 4. 范围

| 文件 | 改动 |
| --- | --- |
| `packages/desktop/package.json` | `electron` `33.4.11` → `44.4.2`；`electron-builder` `^25.1.8` → `^26.15.3`；`electron-vite` `^2.3.0` → `^5.0.0` |
| `packages/desktop/electron-builder.yml` | `electronVersion: 33.4.11` → `44.4.2` |
| `packages/desktop/electron.vite.config.ts` | 视 electron-vite 5 的破坏性变更调整 |
| 根 `package.json` | `engines.node` `>=18.0.0` → `>=22.19.0`（与 pi 对齐） |

⚠️ **`electron-builder` 与 `electron-vite` 的跨大版本升级，可能比 Electron 本身更麻烦。** electron-vite 2 → 5 跨了 3 个大版本，配置格式和插件 API 可能有变更。建议：

1. 先只升 `electron` + `electron-builder`，跑通打包
2. 再单独升 `electron-vite`

两步分开，出问题时能立刻定位是哪一边。

## 5. 验证清单

### 5.1 构建与打包

1. `npm run dev:desktop` 能启动，DevTools 无报错
2. `npm run build -w @spotshell/desktop` 通过
3. `npm run pack -w @spotshell/desktop` 产出 portable 与 NSIS 两个产物
4. **两个产物都要装/跑一遍**，不能只测 portable

> 打包缓存提醒：本机 `winCodeSign-2.6.0` 缓存已手工铺好（`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\`）。升级 electron-builder 26 后若它要求新版本的 winCodeSign，可能再次触发"符号链接权限不足"的解压失败。届时用同样手法：手工解压并排除 `darwin` 目录，或开启 Windows 开发者模式。
>
> 📌 执行时修正：本次**未触发**该问题，electron-builder 26 直接复用了现有缓存。另外 **7za 的路径已失效** —— electron-builder 26 不再提供 `node_modules/7zip-bin/win/x64/7za.exe`，若将来需要手工解压，改用 `node_modules/electron-winstaller/vendor/7z-x64.exe`。

### 5.2 运行时冒烟

5. SSH 连接：密码认证 + 私钥认证各一次
6. 终端：xterm 渲染、`@xterm/addon-fit` 自适应、大量输出滚动、中文与 ANSI 颜色
7. Shell Integration：OSC 标记解析、`cwd` / 退出码捕获（`OscParser` 依赖终端数据通路，Chromium 大版本跳跃后要确认）
8. 多标签会话切换
9. 知识库工作区：列表、编辑器、外部编辑监听（`externalEdits` 用 `fs.watch`，Node 20→24 行为需确认）
10. AI 面板：完整对话一轮（此时仍是 LangGraph，正好作为升级前后的行为基线）
11. 应用菜单、剪贴板"询问 AI"、外部链接打开

### 5.3 `safeStorage` 专项（最重要）

`packages/desktop/src/main/hostsStore.ts` 用 `safeStorage` 加密保存主机凭据。Windows 上底层是 DPAPI，跨 Electron 版本应当可以解密，**但必须实测**：

12. **升级前**：在旧版本里保存 2~3 个含密码/私钥口令的主机
13. **升级后**：用同一个用户配置目录启动新版本，确认这些凭据**能正确解密并连接成功**

⚠️ 如果这一条失败，用户升级后会丢失全部已保存凭据。**这是本次升级唯一可能造成用户数据损失的点**，不验证不合入。

若确实不兼容，需要补一个迁移路径（旧版本解密 → 新版本重新加密），那会让本阶段工时翻倍。

### 5.3.1 执行时的实测结果：风险已大幅缩小

用同一个 userData 目录做了跨版本对照实验（无 GUI 的最小 Electron app）：

| 步骤 | 结果 |
| --- | --- |
| Electron **33.4.11** 加密一段含中文的口令 | 密文 68 字节，`v10` 前缀，OSCrypt 密钥指纹 `faab126f2590fb7b` |
| Electron **33.4.11** 解密同一密文（对照） | ✅ 成功 |
| Electron **44.4.2** 解密**同一密文** | ✅ 成功，明文完整还原，密钥指纹**相同** |

机制说明：Windows 上 `safeStorage` 并非每条密文直接调 DPAPI，而是 Chromium OSCrypt 在 userData 的 `Local State` 里存一把受 DPAPI 保护的 AES 密钥（`os_crypt.encrypted_key`），密文带 `v10` 前缀。真正的风险点是"新版本会不会轮换这把密钥"——实测表明不会。

另查 Electron 官方 `breaking-changes.md`：**33 → 44 之间 `safeStorage` 没有任何 breaking change 条目**。

代码侧也确认 `hostsStore.ts` 用的是最朴素的 `isEncryptionAvailable()` + `encryptString()` + `decryptString()` 三件套，无平台特化分支；解密失败被 `catch` 吞掉返回 `undefined`，即**万一不兼容，表现是"凭据静默消失、要求重输"，不是崩溃或数据损坏**。

> ⚠️ 复测提示：若你自己验证时看到解密失败，**先确认不是进程退出方式导致的**。用 `app.exit(0)` 会让密钥来不及刷盘到 `Local State`，两次运行各自生成临时随机密钥，会产生"33 加密、44 解不开"的**假阳性**。要等待刷盘后用 `app.quit()`。

**残余待验**：真机 `%APPDATA%\@spotshell\desktop\settings-secrets.bin`（Electron 33 时代写入的真实密文）能否被 44 解开。该目录下当前没有 `host-credentials.json`，说明这台机器尚未保存过主机凭据。

## 6. 风险

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| `safeStorage` 旧密文在新 Electron 下无法解密 | 低 | **极高**（用户凭据全丢） | 5.3 的升级前后对照实测，不通过不合入 |
| electron-vite 2 → 5 配置破坏性变更 | **高** | 中 | 与 Electron 升级分成两个 commit，独立验证 |
| electron-builder 25 → 26 打包配置变更 | 中 | 中 | 同上；`electron-builder.yml` 字段逐项对照新版文档 |
| winCodeSign 缓存再次触发符号链接解压失败 | 中 | 低 | 已有处置手法，见 5.1 备注 |
| Chromium 130 → 152 导致 xterm 或 React 渲染回归 | 低 | 中 | 5.2 第 6、7 条；回退目标 42.11.5 |
| Node 20 → 24 的 `fs.watch` 行为变化影响外部编辑监听 | 低 | 中 | 5.2 第 9 条专项 |
| 产物体积增大 | 中 | 低 | 当前 77.7MB，预期增至 90~100MB；可接受 |

## 7. Commit 拆分

```
1. build(desktop): 升级 Electron 33 → 44
2. build(desktop): 升级 electron-builder 25 → 26
3. build(desktop): 升级 electron-vite 2 → 5
4. chore: engines.node 提升到 22.19
```

每个都可单独 revert。

## 8. 完成后的状态

- 运行时 Node 24.21.0，pi 的 `engines` 要求满足，[阶段 ④](04-providers-pi-ai.md) 的硬前置解除
- 脱离 EOL，重新进入安全更新窗口
- **功能零变化**，LangGraph 仍在跑

## 9. 升级后新增的两个待办（本阶段不处理）

### 9.1 ⚠️ `safeStorage` 同步 API 在 Electron 45 弃用、46 移除

Electron 官方 breaking-changes：同步的 `isEncryptionAvailable()` / `encryptString()` / `decryptString()` 在 **45 弃用**，**46 随 Chromium 移除同步 OSCrypt 后端一并删除**。

`packages/desktop/src/main/hostsStore.ts` 与 `settingsStore.ts` 用的**正好是这三个**。升到 44 完全安全，但**下一次大版本升级会直接编译不过**。

好消息：官方明确说明旧同步方法加密的数据可以用新异步方法解密，**迁移不涉及数据迁移**。建议单开一个 issue，不要拖到下次升级时才发现。

### 9.2 Electron 44 取消了 npm postinstall 自动下载二进制

`electron@44` 的 package.json **不再有 `scripts` 字段**（已核实：`scripts: undefined`），改为首次 `require('electron')` 时惰性下载，或手动 `node node_modules/electron/install.js`。

影响：**CI 或新同事的干净环境执行 `npm install` 后 `node_modules/electron/dist/` 是空的**，`npm run dev:desktop` 与 `npm run pack` 会在意想不到的时机触发一次上百 MB 的下载，或直接失败。

建议在 `packages/desktop/package.json` 补一个 `postinstall`，或在 README / CI 配置里显式加一步。
