# SpotShell Desktop

Electron desktop client for SpotShell - multi-session SSH with an AI agent sidebar.

## 安装（Windows）

产物目录：`packages/desktop/release/`

| 文件 | 用途 |
|------|------|
| **`SpotShell 1.1.0.exe`** | **便携版（推荐先试）**：双击即用，不用安装 |
| **`SpotShell Setup 1.1.0.exe`** | **安装包**：向导安装，可改目录，带卸载入口 |

### 便携版

1. 双击 `SpotShell 1.1.0.exe`
2. 设置里填 API Key
3. 左侧加主机 → Connect

数据目录：`%APPDATA%\SpotShell\`

### 安装包

1. 双击 `SpotShell Setup 1.1.0.exe`
2. 选安装路径 → 完成
3. 从开始菜单启动 SpotShell

## 开发

```bash
npm install
npm run dev -w @spotshell/desktop
```

## 打包

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run pack -w @spotshell/desktop
```

输出：`packages/desktop/release/`（portable + NSIS）。

## CLI（同 monorepo）

```bash
npm run dev -w @spotshell/cli -- user@host
```
