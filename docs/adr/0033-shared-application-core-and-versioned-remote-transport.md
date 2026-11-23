---
status: accepted
date: 2026-07-29
decision-makers: Dimo maintainers
---

# 共享 Application Core 与版本化远程传输架构

Dimo 所有客户端形态——Electron 桌面应用、浏览器 WebUI、远程桌面 Workstation 以及原生 iOS / Android Companion——共享同一套 Rust `ApplicationCore` 与版本化 Remote Protocol v1；客户端本身不直接运行本地 Agent、Git Worktree 或插件 Worker，一切业务执行均收敛在单一 **Dimo Host** 上。

## Decision

### 1. Single-Seam Host 与模块边界

```text
React UI / Mobile Clients
        │
        ▼
BackendTransport / Remote Protocol v1 (HTTP + WS / WebRTC E2EE)
        │
        ▼
dimo-server (--desktop 或 headless daemon)
  └── HostCommandRegistry + HostEventBus (ADR-0078)
        └── ApplicationCore / HostRuntime (crates/application)
              └── conversations / agents / delegation / workflows / automations / plugins / git
```

- **Electron 桌面与无头守护进程同源**：桌面应用由 Electron 壳（`electron/`）拉起本机 `dimo-server --desktop`（见 ADR-0090），与独立运行的无头 `dimo-server` 共享同一 Axum HTTP/WS 服务、单一 `HostCommandRegistry` 与 `HostEventBus`（[ADR-0078](0078-host-command-registry-single-seam.md)）。
- **传输无关的核心**：`crates/application` 不依赖 Electron、浏览器窗口或 Axum extractor。每个业务用例只有一个核心入口；传输适配器只负责认证、参数转换、错误映射与事件推送。
- **单一数据目录所有者**：同一 Dimo 数据目录同一时刻仅允许一个 Host 运行实例，确保 SQLite 单写者（ADR-0091）、Automation 调度、Workflow 分发、Agent 子进程与插件 Worker 拥有唯一权威。
- **前端统一传输抽象**：React 功能模块不直接写死底层通道，所有命令与事件订阅统一通过 `BackendTransport` 分发；嵌入式浏览器由 Electron `<webview>` + `crates/browser-host` + `dimo.browser` 插件承接，非桌面端按 capabilities 如实隐藏或使用受限预览代理。

### 2. Server Profile、窗口归属与设备配对

- **Server-bound Window**：客户端以 Host 稳定身份（[ADR-0059](0059-host-identity-and-pairing-invitation.md)）而非 URL 合并管理多个 Server Profile（本机实例为默认 Local Profile）。每个应用窗口在生命周期内严格绑定一个 Server Profile，禁止在同一窗口混用多个 Host 的 Project、Workspace、Conversation、Agent 或运行状态；访问另一 Host 必须使用另一窗口。
- **设备配对生命周期**：常规远端连接通过 5 分钟一次性 pairing secret 兑换长期、最小作用域的 device credential，由系统凭据存储独立保护（不进普通数据库、前端状态、URL 或日志）。管理员 token 轮换不得使已配对设备失效。
- **三类正交连接动作**：
  - `Remote disconnect`：仅关闭当前网络连接，保留档案、只读缓存、凭据与配对关系（关闭窗口、退出应用、临时断网仅执行此语义）；
  - `Forget server`：删除本地档案、只读缓存与系统凭据（Host 可达时先请求撤销本设备，不可达时明确提示用户稍后在服务端撤销）；
  - `Device revocation`：在 Host 上终止长期信任并立即断开已有 WebSocket 与后续请求。

### 3. 单一所有者模型与设备权限预设

- Dimo Host 是单一所有者（Server owner）、多台可信设备的本地优先服务，不提供多用户注册或多租户数据隔离。每台配对设备拥有独立 credential、scopes、审计身份与撤销生命周期。
- 配对界面提供两类面向用户的设备预设（见 [ADR-0054](0054-host-family-distribution-and-client-surfaces.md)），服务端鉴权始终以版本化细粒度 scopes 为准，新增 scope 不自动扩大旧预设：
  - **Workstation Device**：覆盖桌面远程开发闭环（Project/Workspace/Worktree、Conversation 与 Turn 交互、文件读写/搜索/Diff、Git、远程终端、Agent 状态与会话启动配置），不包含本机 Host Console 运维动作（管理员 token 轮换、撤销其他设备、网络暴露配置、升级备份等）。
  - **Companion Device**：面向移动端观察、沟通与决策（多 Server Profile、会话时间线/实时流/持久重放、只读离线缓存、创建/追问/取消/重试 Turn、权限审批、结构化问题答复，以及文件/Diff/Git 只读查看），由服务端 scopes 与 capabilities 强制限制写文件、Git 写操作与任意终端访问。

### 4. 版本化远程协议与安全边界

- **协议契约**：`/api/v1/capabilities` 从 `HostCommandRegistry` 派生返回服务端版本、协议版本、最低客户端版本与可用能力；HTTP 使用稳定 error envelope 与 `operation_id`；单条 WebSocket 复用多资源订阅，Conversation attach 携带 `conversation_id` 与 `after_sequence`，服务端基于 SQLite 持久序列返回 snapshot/replay 与 `high_water_mark` 后推送实时事件。未知事件必须安全保留或忽略，不破坏反序列化。协议 Schema 由 `crates/remote-protocol` 生成，供 TypeScript、Swift 与 Kotlin 客户端共享。
- **多端 Companion 边界**：原生 Android（[ADR-0041](0041-native-kotlin-compose-android-companion.md)）与原生 iOS（[ADR-0084](0084-native-swiftui-ios-companion.md)）均复用同一 Remote Protocol v1，实时与写操作要求目标 Host 在线，离线时仅展示带同步时间戳的只读缓存并禁用写操作；不接入第三方云推送中继，持续监控通知仅含不含正文/路径/凭据的元数据摘要。
- **网络安全**：默认仅绑定 loopback；LAN/公网暴露需显式开启并强制高熵 access token（HTTP Bearer / WS subprotocol）与 CORS 白名单；远程文件 API 仅接受注册的 Project/Workspace/Artifact ID 与作用域内相对路径；预览与插件代理使用逐租约 capability token 并限定已注册本地目标，严禁 SSRF 或向 iframe 泄漏主 token；超出可信 loopback/LAN 必须经 TLS 或 E2EE WebRTC 保护。

## Considered Options

- **为 Web 或移动端维护独立后端与第二套 UI**：否决。产生持续功能漂移与双倍验收面。
- **在移动设备本地运行 Coding Agent**：否决。移动端定位为观察与决策 Companion，执行权威集中在 Host。

## Consequences

- 桌面、Web、远程 Workstation 与双端移动端天然具备一致的领域行为、并发语义与版本化协议演进能力。
- 本机专属管理面（Host Console、原生系统对话框、Electron `<webview>`）通过 capabilities 明确隔离，不在远程端伪装等价能力。
