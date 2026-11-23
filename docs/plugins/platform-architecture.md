# Plugin Platform Architecture

本文描述 Dimo `v0.5.2` Plugin Platform (`v4`) 的内核架构、生命周期、渲染三轨与远程执行边界。

> 23 类贡献点、155 个 `host-api` 操作与 32 个 `host.call` 能力域的实时绑定矩阵见 [`contract-bindings.md`](contract-bindings.md)。

## 1. 目标与非目标

Plugin Platform 让一个可安装包以统一身份、版本、配置和生命周期同时扩展四个层面：

- **Agent**：Skills、MCP 与 Workflows；
- **App**：文件 opener、preview provider、面板、设置页、命令、状态栏、主题与自定义界面；
- **Host**：Worker handler、事件订阅、后台服务与 Provider 接缝；
- **Runtime**：受校验并锁定的本地 CLI、Binary、MCP 或 sidecar 资源。

平台不把 Electron 主进程模块、Rust 动态库或任意未声明的前端模块加载器暴露为公共兼容面，也不把 Codex / Claude Code 原生插件强行转换为 Dimo App contribution。

## 2. 核心设计约束（ADR-0046 / 0047 / 0048 / 0069）

- **单一内核收敛**：包校验、安装快照、Runtime 锁探测、Activation Generation 发布与贡献注册收敛在 `crates/plugins`（Plugin Kernel）一个深模块内；桌面壳（Electron `electron/` + `dimo-server --desktop`）与独立 `dimo-server` 共用同一内核，不按特定插件 ID 分支。
- **单层扩展（ADR-0069）**：插件只面向宿主贡献点开发，不存在插件依赖插件、跨插件服务调用或插件自声明扩展点。
- **任意贡献即合法**：插件只需至少声明一项受支持的贡献（App-only、Theme-only、Provider-only 或 Agent-only 包均一等合法）。
- **官方插件零特权**：官方 15 个插件与第三方插件使用同一套公开 `@dimoai/plugin-sdk`、Package v4 清单与贡献点，由 CI 的 `pnpm run plugin:no-privilege` 强制校验。

## 3. 运行拓扑

```text
Plugin source / .vxp
        │
        ▼
┌──────────────────────── Dimo Host (dimo-server) ───────────┐
│ Package Inspector → Installation Store → Plugin Kernel     │
│                                          │                 │
│                 ┌────────────────────────┼─────────────┐   │
│                 ▼                        ▼             ▼   │
│     HostCapabilityBroker       Runtime Resolver   Activation│
│                 ▲                        ▲             │   │
│                 │                        │             ▼   │
│         Full Trust Worker ───────────────┘    Contribution │
│                                                 Registry   │
│                                                    │       │
│              ┌────────────────┬────────────────────┼────┐  │
│              ▼                ▼                    ▼    ▼  │
│         Agent Host     App Extension Host   Artifact  Auto-│
│                                               Host   mation│
└──────────────┬────────────────┬────────────────────────────┘
               │                │
       Remote Protocol v1   versioned worker RPC
               │
   Electron Desktop / WebUI / Remote Workstation / Mobile
```

Worker 与 Runtime 始终运行在持有数据目录的 Dimo Host 上。远程客户端只消费投影并通过 Remote Protocol v1 下发命令，不会把远端 Host 插件下载到本机执行。

## 4. 深模块与接缝

### 4.1 Plugin Kernel

Plugin Kernel 是唯一的业务接缝；Electron 桌面壳与 `dimo-server`（Axum）路由只做鉴权、DTO 转换与错误映射：

```rust
pub trait PluginKernel {
    async fn inspect(&self, source: PluginSource) -> Result<Inspection, PluginError>;
    async fn install(&self, intent: InstallIntent) -> Result<OperationId, PluginError>;
    async fn activate(&self, intent: ActivationIntent) -> Result<OperationId, PluginError>;
    async fn deactivate(&self, plugin: PluginIdentity) -> Result<OperationId, PluginError>;
    async fn update(&self, intent: UpdateIntent) -> Result<OperationId, PluginError>;
    async fn uninstall(&self, intent: UninstallIntent) -> Result<OperationId, PluginError>;
    async fn inventory(&self, query: InventoryQuery) -> Result<PluginInventory, PluginError>;
    async fn invoke(&self, invocation: ContributionInvocation)
        -> Result<InvocationResult, PluginError>;
    fn subscribe(&self, after: OperationSequence) -> PluginEventStream;
}
```

### 4.2 Package Inspector / Compiler

接收目录、`.vxp` 归档、市场制品或 linked development 源目录，只读编译为不可变 `CompiledPluginPackage`：

- 规范化 `(publisher, id)`、版本与来源锁；
- 校验 canonical manifest、`README.md` `summary`、`config.schema` 与 `content.index.json`；
- 计算 content tree / entrypoint / resource digest；
- 解析贡献声明、平台兼容条件、Runtime 依赖与完整诊断列表（单次遍历报告全部违规）。

所有路径在规范化包根目录内解析，拒绝绝对路径、`..` 穿越、符号链接逃逸与大小写碰撞。

### 4.3 Installation Store

- 普通安装物化不可变快照；linked development 引用开发者目录，每次变动后重新 inspect、计算摘要并走候选激活代流程。
- 安装快照目录对 Worker 只读；插件持久化数据写入独立 data root。
- Store 保留当前版本及可回滚的上一验证版本；删除安装快照不会删除用户文件、Artifact、Conversation 或插件数据（除非用户显式选择清除数据）。

### 4.4 Contribution Registry

保存当前已发布激活代的只读运行时目录（`ContributionRecord` 包含 `identity`、`package_version`、`package_digest`、`generation_id`、`kind`、`declaration`、`handler_route?`、`required`、`readiness`、`diagnostics`）。

Agent 会话装配、Composer / Automation 动作解析、文件 opener / preview 解析、UI 槽位渲染、Provider 接缝与 Remote Protocol 能力发现共用同一份目录。Registry 发布以整个 generation 为单位原子替换，消费者永远观察不到半个插件。

### 4.5 Activation Manager

管理 candidate-first 事务与旧 generation drain：

```text
installed → resolving → preparing_runtime → starting_candidate
          → validating_candidate → publishing → active
                                             ↘ active_degraded

发布前任一环节失败 → 保持 installed / previous_active
active → draining → disabled
```

每次调用在开始时绑定 generation lease；新代发布后，旧 lease 允许完成当前调用但不允许派生新子调用，超时后取消并记录 `generation_drain_timeout`。Activation Manager 核对全部 required handlers、清单声明匹配、Runtime probe 结果与 SDK 版本兼容后才原子切换目录。

### 4.6 HostCapabilityBroker

在 Full Trust 模型（[ADR-0048](../adr/0048-full-trust-plugin-execution-model.md)）下，`HostCapabilityBroker` 为 Worker 与 `protocol: "2.0"` App 提供结构化的宿主能力 API（涵盖 `storage.kv`、`storage.settings`、`secrets`、`files`、`network.fetch`、`exec`、`runtime.*`、`artifact.*`、`conversation.*`、`collaboration.*`、`browser.*`、`remote.*`、`provider.presets.*`、`events`、`blob.*`、`app.notify.toast`、`log.*`、`plugin.self`；完整绑定见 [`contract-bindings.md`](contract-bindings.md)）。

Broker 校验 plugin identity、generation、请求参数 Schema、文件根目录约束与 Runtime lock，用于保障生命周期一致性与结构化诊断，而不是权限审批门禁。

### 4.7 Worker Host

Worker 作为独立 OS 进程运行，支持 **Node**、**Python（CPython 3.12）** 与 **Native（Rust）** 三种运行时，统一使用 stdio JSON-RPC `1.1` 协议：

- 继承当前用户的本机权限，同时具有有界帧/消息上限（默认 32 MiB 单帧、64 MiB 逻辑消息 + `blob.*` 流式传输）、心跳与结构化日志；
- 独立进程提供崩溃隔离、热更新与 generation drain，并非安全沙箱；
- 单个 Worker 崩溃只影响该插件当前激活代的可执行贡献，采用有上限的指数退避重启，超预算后停止自动重启并记录崩溃证据供界面与 `dimo-plugin doctor` 排查。

### 4.8 Runtime Resolver

根据 `depends/runtimes/*.json` 解析出精确的 `RuntimeLock`（`runtime_id`、`version`、`target`、`source`、`digest`、`absolute_entrypoint`、`probe_evidence`、`ownership`）：

- 托管 Runtime 先下载到 staging 目录、校验 SHA-256 摘要并执行有界 probe，通过后原子发布；
- 多个版本可并存；`gc-runtimes` 仅回收没有任何 installation、generation 或运行租约引用的托管 Runtime；
- 外部 Runtime 每次使用前重新校验完整性。

### 4.9 App Extension Host（渲染三轨）

按交互密度提供三条渲染轨道（[ADR-0069](../adr/0069-everything-is-a-plugin-platform.md)）：

1. **宿主渲染 Descriptor（`L1`）**：`app.command`、`app.toolbar`、`app.status`、`app.composer.slash`、`app.composer.action`、`app.rail.section`、`app.timeline.card`、`app.settings.section`、`file.opener` / `artifact.preview`。由宿主原生组件和 Design Tokens 渲染，图标受 `@dimo/plugin-contract/catalog/icons` 校验。
2. **Module Federation / 宿主内 App（`protocol: "2.0"`）**：面向 `app.panel`、`app.tab`、`app.kanban.view`、`app.settings.page`、Turn Hook 与 Cordis 风格 IoC 服务；在宿主 React 树内高频交互渲染，开发态由 `dimo plugin run dev` 提供 Vite HMR，卸载时经 `EffectScope` 零残留清理。
3. **Full Trust 独立 HTML Surface（`protocol: "1.0"`）**：面向 `plugin.detail.panel` 与 `artifact.editor` 等文档型/富媒体页面；使用 iframe 作为挂载与生命周期接缝（非安全沙箱），通过带一次性 surface token 与 generation 绑定的 `postMessage` / `MessagePort` 桥接调用 Worker 与 `bridge.artifact`。

所有插件 UI 均包裹在独立 Error Boundary 内，单面异常仅卸载对应视图并展示恢复/诊断入口，不影响整个工作台。

### 4.10 Artifact Host

路径规范化、预览租约（`ArtifactPreviewLease`）、进程引用计数、loopback 代理与空闲回收属于通用 Artifact Host，不耦合任何具体插件：

```ts
type RenderDescriptor =
  | { kind: "web"; capabilityUrl: string; title?: string }
  | { kind: "hostDocument"; renderer: string; payload: JsonValue }
  | { kind: "pluginSurface"; surfaceId: string; sessionId: string };
```

打开文件时按 `用户默认 → priority → 稳定 identity` 解析贡献，当前已打开租约不会在后台被静默替换。

## 5. 身份、信任与数据模型

- **产品身份**：由 `(publisher, plugin_id)` 唯一标识；未签名本地包标记为 `local-unverified`，不能冒充市场发布者。
- **Full Trust**：安装或启用即授予本机用户权限；`publisher`、`packageDigest` 与 `generation` 用于更新来源校验、回滚、诊断与生命周期绑定。
- **数据隔离**：每个插件身份拥有独立的 `config.json`、KV 命名空间、SQLite 文件、OS Keychain secrets 命名空间、data/cache 目录与结构化日志流。卸载默认保留数据，重新安装且 `(publisher, plugin_id)` 匹配时恢复挂载。
- **供应链完整性**：`.vxp` 为确定性归档；安装过程只校验并解包，从不在终端用户机器上执行包内 build / lifecycle 脚本。

## 6. 持久状态与状态机

Plugin Kernel 持久化权威表包括：`plugin_packages`、`plugin_installations`、`plugin_activation_intents`、`plugin_generations`、`plugin_contributions`、`plugin_runtime_locks`、`plugin_runtime_refs`、`plugin_bindings`、`plugin_settings`、`plugin_operations` 与 `plugin_audit`。Worker PID、内存 handler 与打开的 stdio 管道属于瞬态投影，Host 重启后依据完整 generation 证据重建，未完成操作标记为 `interrupted`。

插件汇总状态：`not_installed` | `installed_disabled` | `preparing_runtime` | `activating` | `active` | `active_degraded` | `incompatible` | `failed` | `updating` | `rolling_back`；单项贡献状态为 `ready` | `unavailable` | `degraded` | `incompatible`。错误统一通过包含稳定 `code`、`operationId`、`pluginIdentity`、`generation` 与诊断引用的信封返回。

## 7. 远程 Host 与多客户端

远程客户端通过版本化 Remote Protocol v1 获取 Host 上的插件目录、激活状态、客户端可渲染的 surface 类型、操作进度以及短期 preview / surface capability URL：

- Web 与远程客户端不读取 Host 本机绝对路径，文件交互使用 Project / Workspace / Artifact 身份；
- 预览代理只转发已登记租约的 loopback endpoint，不作为任意网络代理；
- 主访问 token 不进入 iframe URL、插件消息或日志。

## 8. 产品信息架构契约

- `/plugins` 保留全局设置侧栏，提供「已安装」与「插件市场」两个 Tab；市场与设置安装经 Full Trust 确认后立即启用；能力等价官方插件按版本白名单自动安装并默认启用（用户可禁用或卸载）。
- `/plugins/:pluginId` 仅设「内容」（README 与校验后的 `contents/`）与「配置」（基于 `config.schema` 原子读写 `config.json`）两个主 Tab。
- 诊断信息（generation、contribution、runtime lock、崩溃记录、stdout/stderr 日志）集中展示在「运行状况」与 `dimo-plugin doctor`。
- Agent 原生插件在「设置 → Agent → 对应 Agent」底部独立呈现，与 Dimo 产品插件生命周期解耦。

## 9. 内核不变量

1. 单个 `(publisher, plugin_id)` 在同一 Host 上至多只有一个当前 installation 与一个已发布 generation。
2. Contribution Registry 永远不暴露未完成验证的 candidate 或部分 generation。
3. 单层扩展：插件间零依赖，核心消费者只按 contribution kind 与 identity 解析，不识别具体插件 ID。
4. 更新失败保留上一完整 generation 与原有 `config.json`。
5. 禁用不删除 Artifact、Conversation、Automation 或插件数据。
6. Runtime GC 不回收仍被 installation、generation 或运行租约引用的运行时。
7. 同一激活代下 Agent、App、Host 与 Runtime 贡献共享精确一致的 package version 与 digest。
8. Agent 原生插件与 Dimo 产品插件保持独立生命周期，互不替代启停状态。
