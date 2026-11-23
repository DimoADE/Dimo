---
status: accepted
date: 2026-10-21
decision-makers: Dimo maintainers
---

# Kiro、Auggie、TRAE、Command Code 与 ZCode 通过 ACP 兼容管线接入

## Context

Kiro、Auggie、TRAE 与 Command Code 提供官方原生 ACP 协议支持；ZCode 无官方 ACP，可通过固定版本的社区桥 `zcode-acp-server@0.72.0`（启动参数 `server`）接入。按照 [ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md) 的主次分层策略，五者作为内置一等档案进入 `AgentKind` 与 `BuiltInProfileCatalog`，通过次选 ACP 兼容管线复用安装、鉴权、会话控制、取消握手与错误分类机制，不复制凭据。

## Decision

### 1. 分发与运行时发现

- **Auggie 与 Command Code**：采用标准 npm 托管安装（同 [ADR-0072](0072-qoder-first-class-agent.md) 形态）。Command Code 在 Windows 上探测 `command-code`、`cmdc`、`commandcode`，不探测裸 `cmd`。
- **Kiro**：托管 Linux zip 归档；macOS DMG 与 Windows MSI 不由通用归档安装器解包，也不执行未签名的远端安装脚本，但两平台均列入可运行平台，支持直接发现并启动用户 `PATH` 上的 `kiro-cli acp`。
- **TRAE**：公开产物为单文件 gzip；安装器采用通用单文件 gzip 解压能力处理，不为 TRAE 编写专用安装器，也不额外下载 `code_mode_host` 旁路文件。
- **ZCode**：社区桥由 npm 托管安装；官方 ZCode 运行时独立发现（优先桌面安装包内 `zcode.cjs`，否则 `PATH` 上的 `zcode`）。桥的启动文件解析到 JavaScript 入口并交由已验证的 Node.js 22（含 `node:sqlite`）执行；不将裸 `zcode` 当作 ACP 服务，也不探测缺失 `server` 参数的桥。

### 2. 鉴权边界

- **Kiro**：同时支持官方账号登录与 `KIRO_API_KEY`；选择官方账号模式时清除 API Key 覆盖。
- **Auggie 与 TRAE**：`AUGMENT_SESSION_AUTH` 与 `TRAECLI_PERSONAL_ACCESS_TOKEN` 均为对应账号的无浏览器个人令牌，并非独立官方 API Key 模式，因此不作为 API Key 模式呈现。
- **Command Code**：仅提供官方登录模式，不虚构未核实的 BYOK 文件格式。
- **ZCode**：仅提供官方订阅模式，登录流程留在官方 ZCode 应用中，不发明额外登录命令或环境变量令牌。

### 3. 会话行为与能力边界

- **ZCode 显式模式确认**：ZCode 的 `session/new` 仅作占位；新建会话在发送第一条 prompt 前必须发送 `session/set_config_option` 显式确认 `mode`（优先使用已保存且仍被通告的模式，否则默认 `build`）。若确认超过 60 秒、模式未被通告或应答与请求不一致，则会话失败且不发送 prompt。恢复与加载会话不重复该确认，且不设置进程级 `ZCODE_ACP_MODE`。
- **能力诚实边界**：五者的 Fork、附件等能力严格跟随 ACP 实时能力通告，不扫描 ZCode 内部 SQLite 数据库。

## Consequences

- 五个 CLI Agent 纳入 `AgentKind` 与内置名册，统一受 [ADR-0060](0060-agent-installs-use-user-environment.md) 用户环境安装与 [ADR-0081](0081-connect-time-session-bind-codeg-parity.md) 连接时会话绑定约束。
- 单文件 gzip 解压成为通用安装器能力，后续同类分发可直接复用。
- 若未来任一 Agent 发布官方原生 SDK 或服务协议，可按 [ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md) 平滑升级为独立引擎驱动，而无需改变其 `AgentKind` 身份。
