---
status: accepted
date: 2026-09-04
decision-makers: Dimo maintainers
---

# Host 能力面只有一个接缝：Host Command Registry 与 Host Event Bus

## Context

[ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md) 规定本地桌面与无头 `dimo-server` 共用同一 Application Core。若桌面壳与远程 Server 各自维护平行的命令列表或事件通道，就会导致命令覆盖率结构性漂移、推送事件在远程/WebUI 静默失效，以及 `capabilities` 宣称未实现的能力。在桌面端收敛为 Electron 壳托管本机 `dimo-server --desktop` sidecar（ADR-0090）的架构下，本 ADR 确立 **Host Command Registry** 与 **Host Event Bus** 作为所有客户端表面的唯一产品接缝。

## Decision

### 1. Host 产品命令只有一份实现，位于 `crates/server::host` 与 `crates/application`

所有面向本机桌面、浏览器 WebUI 与远程 Workstation 的产品命令（Project、Repo、Workspace、Git、PR、Session、Task、Tag、Scratch、Image、Attention、Conversation 辅助与控制、Agent 运行时与管理、Provider 预设与目录、Skill、Instruction、MCP、Plugin、Chat channel、Automation、Workflow、系统与日志设置等）全部由 `crates/application` 与 `crates/server/src/host/<domain>.rs` 唯一实现，依赖传输无关的 `HostContext`（持有 `LocalDeployment`、`AgentRuntime`、`ConversationContext`、Plugin 控制面与 Worker Runtime、PTY、本地历史导入、用量缓存与 `HostEventBus`）。桌面壳（`electron/`）不持有任何业务命令副本。

### 2. Host Command Registry 是唯一命令注册表与能力真相源

- 唯一活接缝是 `application::DomainCommand` + `RegisteredCommand`（Conversation 与 Workflow 用例由 Application Core 直接实现，其余产品域命令由 `ServerApplicationDomains` / `HOST_COMMANDS` 派发）。
- 注册表声明每个命令的名称、所需 scope、类型化参数与处理函数，统一按 camelCase JSON 反序列化并执行，错误统一规范化为带 `code` 的 `ErrorEnvelope`。
- `pnpm run generate-types` 从 `RegisteredCommand::host_command_names()` 生成 `shared/hostCommands.ts`，作为前端与契约测试的唯一命令清单。
- `ServerCapabilities.capabilities` 直接由注册表 scope 加上各传输适配器真实提供的能力派生（例如 HTTP/WS 附带 `preview.proxy`、`offline.read`、`notification.summary`），严禁出现没有对应实现的静态能力字面量。

### 3. 桌面壳命令显式隔离且互不相交

Electron 桌面应用通过 `BackendTransport` 将全部产品命令路由到本机 `dimo-server --desktop` sidecar（ADR-0090）或远程 Host 的同一注册表。仅与本机操作系统窗口/壳层强绑定的有限辅助命令（窗口与托盘管理、原生文件对话框、外部编辑器/终端/文件管理器打开、桌面自动更新、本机 Host 控制台运维）归入显式清单 `DESKTOP_SHELL_COMMANDS`，经 Electron preload IPC 执行，并受本地桌面壳 capability 门控；非桌面环境或远程连接时 UI 据此诚实隐藏或降级。

### 4. Host Event Bus 是唯一推送面

Host 发出的全部实时推送（会话时间线行操作批次 `conversation-events:{id}`、Agent 管理与失效通知、Agent 终端生命周期、注意力与工作区会话变化、设置文件变化、日志追加、本地历史导入进度）统一经 `HostEventBus::emit(channel, payload)` 发布：

- Server WebSocket 提供 `host_event { channel }` 订阅资源，按 scope 校验频道前缀；`terminal-output:*` 保留 SSE 流。
- 本机 Electron 桌面（连 `dimo-server --desktop`）、浏览器 WebUI（`WebTransport`）与远程 Workstation（`RemoteDesktopTransport`，凭据保留在受保护宿主/主进程侧）均消费同一总线契约，杜绝静默 no-op 监听。

### 5. Patch 流收敛为统一订阅资源

所有状态补丁流统一经 `patch_stream { stream, args }` 订阅资源承载，覆盖 `projects`、`project_workspaces`、`execution_processes`、`diff`、`file_tree`、`scratch`、`slash_commands`、`log` 与 `conversation`。生产者直接复用 `deployment.events()`，在客户端附着时启动、分离时释放；前端统一通过 `usePatchStream` 与 `transport.subscribe` 消费。

### 6. 会话时间线全环境同路

`conversation_detail`、`conversation_events_since`、`conversation_ensure_session_controls` 等命令全部位于 Host Command Registry；实时行操作经 `HostEventBus` 的 `conversation-events:{id}` 频道送达，原始事件 durable attach（`conversation` 资源）服务移动端 Companion 与离线缓存。所有客户端共享同一 SQLite 权威投影（ADR-0091）。

### 7. Host 文件系统语义

路径与目录选择一律针对当前绑定的 **Host** 文件系统：本地桌面连接本机 Host 时使用原生系统目录对话框，远程 Host 或浏览器 WebUI 使用基于 `list_directory` 的 `FolderPickerDialog`。时间线图片与本地附件通过 Host 注册表命令或受控 HTTP 端点读取并呈现，不假设客户端可直接访问 Host 本地文件路径。

### 8. 契约测试门禁

- Rust 测试锁定注册表命令名唯一、每个描述符可解析且带明确 scope、`capabilities` 与注册表一致。
- CI 通过 `generate-types:check` 校验 `shared/hostCommands.ts` 新鲜度。
- 前端静态扫描锁定 `frontend/src` 中的所有命令调用必须归属 `hostCommands` 或 `DESKTOP_SHELL_COMMANDS`，且两集合严格不相交。

## Consequences

- 本机桌面（Electron + `dimo-server --desktop`）、浏览器 WebUI、远程桌面 Workstation 与无头 `dimo-server` 执行完全同一份产品命令与事件总线代码，根除前后端和双端漂移。
- `crates/server` 成为统一的 Host 核心装配点，与 [ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md) 和 [ADR-0054](0054-host-family-distribution-and-client-surfaces.md) 对 Dimo Host 的定义完全一致。
- 桌面专属能力（本机更新器、原生对话框、嵌入浏览器 `<webview>` 宿主、本机控制台运维）通过 capability 显式边界化，远程客户端诚实降级。

## Considered Options

- **继续为桌面与 Server 维护两套命令处理器并按清单手工补齐**：否决。日常开发只走桌面路径时，Server 必然再次漂移。
- **由前端各自消费原始事件并自行折叠时间线**：否决。制造前后端双投影，违背单一投影权威原则。
- **按凭据类型而非注册表 scope 开放命令面**：否决。能力面必须由注册表与细粒度 scope 统一裁决。
