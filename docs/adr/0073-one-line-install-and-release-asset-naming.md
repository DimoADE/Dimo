---
status: accepted
date: 2026-09-04
decision-makers: Dimo maintainers
---

# 一行安装：发布资产命名单一来源，install.sh / install.ps1 与 npx 共用解析

## Context

Dimo Host Family（`dimo-server`、`dimo-mcp`、`dimo-workflow-mcp` 与 `web/`）面向无头服务器和 CLI 用户提供 `install.sh`、`install.ps1` 与 `npx` 多条获取路径。若 CI 发布工作流、npm CLI、安装脚本与部署文档各自拼接资产名和平台标识，就会导致下载 URL 漂移或校验强度不一致。本决定将发布资产命名收敛到单一事实来源，并明确一行安装脚本的职责与校验边界；桌面应用继续走 Electron 安装包与自动更新（ADR-0090），不由本脚本安装。

## Decision

### 1. 发布资产命名单一来源

由单一命名模块根据版本与平台三元组推导压缩包名、摘要文件名与平台目录名；`.github/workflows/host-family-release.yml`、`npx-cli`、`install.sh`、`install.ps1` 以及 [`docs/guides/headless-server.md`](../guides/headless-server.md) 全部引用同一约定，禁止各自拼串。

资产命名与平台段统一采用 CI 发布格式（`Dimo-${VERSION}-${release_name}-server.tar.gz`，平台段如 `linux-x86_64`、`darwin-aarch64`），保证已发布 Release 资产始终可解析。本地缓存目录布局统一为 `~/.dimo/host-family/${tag}/${platform}/family/`，供安装脚本与 `npx-cli` 共同命中。

### 2. `install.sh` / `install.ps1` 的职责边界

安装脚本按固定顺序执行以下六步：

1. 探测 OS 与 CPU 架构并映射为规范平台三元组；不支持的组合立即失败并列出支持清单。
2. 解析目标版本：默认最新 Release，支持 `DIMO_VERSION` 固定版本。
3. 从 GitHub Release 下载压缩包与同名 `.sha256` 校验文件，校验压缩包摘要。
4. 解包后按包内 `SHA256SUMS` 逐文件校验；任一不匹配即中止并清理临时目录。
5. 写入 `~/.dimo/host-family/${tag}/${platform}/family/`，与 `npx-cli` 共用缓存布局。
6. 在用户可执行目录放置 `dimo` 启动器并提示 `PATH` 配置方式。

脚本明确**不做**：不安装 Coding Agent（[ADR-0060](0060-agent-installs-use-user-environment.md)：Agent 归用户环境与 Agent 管理页负责）、不安装桌面应用、不写系统级目录、不要求 root 权限、不注册开机自启服务。

### 3. 两级校验强制生效，无跳过开关

压缩包摘要校验与解包后逐文件 `SHA256SUMS` 校验均为终止条件，不提供 `--skip-verify` 等跳过参数。

### 4. 运行参数沿用 Host 既有环境变量

`DIMO_STATIC_ROOT`、`DIMO_DATA_DIR`、`DIMO_SERVER_LISTEN`、`DIMO_SERVER_ALLOW_LAN`、`DIMO_SERVER_TOKEN`、`DIMO_SERVER_ALLOWED_ORIGINS` 由 `crates/server` 与 `crates/utils` 统一读取（默认端口 `17891`，默认绑定 loopback）。安装脚本不重复定义环境变量语义，也不得默认开启 `DIMO_SERVER_ALLOW_LAN`。

### 5. 发布流水线端到端冒烟

Release 工作流对刚上传的发布资产执行端到端冒烟（「命名解析 → 下载 → 两级校验 → 启动 → 探活」），作为资产命名一致性的必选门禁。

## Consequences

- `install.sh`、`install.ps1` 与 `npx-cli` 共用本地缓存与校验强度，互为缓存命中而不重复下载。
- 资产命名演进只需修改单一命名模块并经发布冒烟验证，消除多端命名漂移。
- 一行安装后用户仍按 [ADR-0060](0060-agent-installs-use-user-environment.md) 在本机环境中准备或通过设置页安装 Coding Agent。

## Considered Options

- **修改 CI 资产名迁就旧版 `linux-x64` / `macos-arm64` 命名**：否决。已发布 Release 资产不可变，且 `linux-x86_64` / `darwin-aarch64` 更贴近 Rust target 三元组。
- **在脚本内联独立平台映射表**：否决。会制造多份命名副本并再次漂移。
- **在安装脚本中顺带安装 systemd unit 或写入系统目录**：否决。违背免 root 原则，常驻部署由可选 systemd 模板或 Docker Compose 覆盖。
