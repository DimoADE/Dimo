---
status: accepted
date: 2026-09-04
decision-makers: Dimo maintainers
---

# 一切皆插件：壳层贡献点、宿主 Provider 缝与无特权官方插件

## Context

Dimo 的基座定位是 **多 Agent 会话 + 隔离工作区 + 可信历史**。在此之上的可见 UI 区域、非身份核心能力与可替换宿主提供者，都应通过公开的贡献点与 Provider 缝交付，确保官方功能与第三方插件走完全同一条路。本决定将「一切皆插件」落实为可验收的平台架构契约，衔接 [ADR-0046](0046-full-stack-plugin-platform-and-isolated-sdk.md)、[ADR-0047](0047-product-centric-plugin-package-and-content-model.md)、[ADR-0048](0048-full-trust-plugin-execution-model.md) 与 [ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md)。

## Decision

### 1. 分层模型与内核边界

- **L0 基座（不插件化）**：Electron 桌面壳与 `dimo-server --desktop` sidecar（ADR-0090）、Application Core / `HostRuntime`、SQLite 单一权威会话与时间线核（ADR-0091）、Agent Runtime（独立引擎优先 + ACP 兼容层，[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)）、Git worktree 隔离与 Git 引擎、审批与权限流、协作空间（内置宿主能力，见 [ADR-0055](0055-official-product-mcp-activation.md)）、设备配对与凭据、以及 Plugin Kernel 自身。工作区本身（含默认会话、Git、Diff、终端与文件树面板）属于 L0 结构，但其内部槽位对插件开放。
- **L1 宿主能力缝（Provider Seam）**：由「服务定义（Rust trait + wire DTO）+ 提供者（内置默认与插件贡献同权）+ 消费者」构成，涵盖外部供应商导入、供应商模板目录追加、用量数据源、外部编辑器 opener、远程 Host 供给器与系统浏览器宿主。
- **L2 UI 扩展面（Slot）**：插件直接参与壳层组成，包括顶级 Tab、看板视图、工作区 Dockview 面板、设置页面、右侧栏区块、Composer 动作以及六个宿主壳层槽位。
- **L3 官方插件**：看板视图（固定看板、四栏看板、计量统计看板、无限画布看板）、Notes、提示词优化、浏览器（`dimo.browser`）、Remote SSH（`dimo.remote-ssh`）、Office、会话增强、Workflow Creator 等 15 个官方 Full-Trust v4 插件（`@dimoai/plugin-sdk` `^2.0.0`），与第三方插件完全同权。

### 2. 八项平台铁律

1. **官方插件无特权**：官方插件只能使用公开 `@dimoai/plugin-sdk`、公开贡献点与公开 `host.call` API；宿主代码严禁按官方插件 ID 分支特判，由 CI 门禁 `pnpm run plugin:no-privilege` 强制校验。任何第三方用同一套 SDK 均可开发功能等价的插件。
2. **孔位与官方消费者同批验收**：新贡献点必须与首个官方消费者同批完成 CLI `validate`、Host `inspect`、真实 UI/Agent 消费、作者文档与 `dimo plugin test --host`，否则不得进入稳定面。
3. **生效语义双轨且诚实**：Agent 侧贡献（Skill / MCP / Hook）遵循「新建或重绑会话后生效」（[ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md)）；UI 贡献与 Provider 贡献随 Activation Generation **启用即生效、禁用即原子撤下**。
4. **渲染三轨，按交互密度选择**：
   - **宿主渲染 Descriptor**：状态栏项、命令、工具栏、斜杠命令、设置区块、时间线卡片与供应商目录，由宿主组件原生渲染并回调 `invokeContribution`，零插件代码进入渲染热路径。
   - **Module Federation 2.0 面板**：`app.tab`、`app.panel`、`app.kanban.view`、`app.settings.page` 的默认渲染轨；宿主使用 MF 2.0 纯 runtime（`createInstance` / `registerRemotes` / `loadRemote`）共享 React singleton，每面板包裹 `DockviewPanelErrorBoundary` 隔离崩溃，开发期经 `dimo-plugin dev` 享受 Vite HMR。
   - **iframe App Surface**：保留给文档型与富媒体 UI（如 `artifact.editor`、`plugin.detail.panel`）。
5. **单层扩展，禁止插件叠加**：插件只能面向宿主贡献点开发，永不支持 `dependencies.kind = plugin`、跨插件服务调用或插件自声明扩展点。复用他人插件的唯一路径是**派生（fork）**——通过 `dimo-plugin fork` 复制源码、换新 `Publisher + Plugin ID` 并记录 `derivedFrom` 溯源元数据，形成独立插件与独立存储。
6. **确定性同槽冲突解析**：多个插件贡献同一槽位或 Provider 缝时，可聚合的按确定顺序聚合（状态项、用量数据、目录模板、面板并列），需单选的由用户显式选择（编辑器默认 opener、文件 opener 优先级），绝不按安装顺序静默覆盖。
7. **内核最小化纪律**：新增宿主行为须优先指向文档化扩展点；只有涉及身份核心或必须与宿主锁版本的 L0 能力（如协作空间）才留在内核，并在下表登记。
8. **安全基线不可省略**：在 Full Trust（[ADR-0048](0048-full-trust-plugin-execution-model.md)）执行模型下，强制执行 SHA-256 供应链校验、来源锁与知情确认、按 `Publisher + Plugin ID` 的数据隔离、Activation Generation 原子切换与回滚、敏感操作（如 `provider.presets.bind`）宿主确认与无秘密审计日志。

### 3. 插件接管面总表

| 扩展面 | 贡献点 / Host API | 形态与说明 |
| --- | --- | --- |
| Agent 能力 | `content.skill` / `content.mcp` / `workflow.binding` | 稳定面；安装/启用时支持自动解析并安装声明的本地运行时依赖 |
| 文件与产物 | `file.opener` + `artifact.preview` / `app.surface(artifact.editor)` | 稳定面；只读 watch 预览或可编辑文件 Tab |
| 详情配置页 | `app.surface(plugin.detail.panel)` | 稳定面；插件自身 `config.json` 的自定义配置面 |
| 后台服务 | `host.service` | 稳定面；由 Host 托管生命周期的 Worker 后台服务 |
| 宿主壳层槽位 | `app.command` / `app.toolbar` / `app.status` / `app.composer.slash` / `app.timeline.card` / `app.settings.section` | 稳定面；宿主渲染 descriptor，`app.status` 支持溢出菜单且只增不删内置项 |
| 顶级 Tab | `app.tab` | 稳定面；中央 Tab 栏新增独立顶级 Tab，禁用原子撤下并回退工作区 Tab |
| 看板视图 | `app.kanban.view` | 稳定面；宿主看板容器聚合所有已启用视图，全禁用时自动隐藏看板 Tab |
| 工作区结构面板 | `app.panel` | 稳定面；接入合成 `PanelRegistry`（`plugin:<pluginId>/<panelId>`），支持 `center` / `left`，禁用保留占位 |
| 设置页面 | `app.settings.page` | 稳定面；独立设置侧栏导航条目与整页（federation / iframe） |
| 右侧栏区块 | `app.rail.section` | 稳定面；与内置活动/进程区块同权渲染 |
| Composer 动作 | `app.composer.action` | 稳定面；提交前提示词变换等动作 |
| 供应商预设与导入 | `provider.model.importSource` + `host.call provider.presets.list/save/bind` | 稳定面；导入不自动绑定，`bind` 须宿主 UI 确认并审计（[ADR-0063](0063-model-provider-presets-not-cc-switch.md)） |
| 供应商模板目录 | `provider.model.catalog` + `provider_catalog_list`（`plugin.read`） | 稳定面；Host 内置预置（[ADR-0088](0088-built-in-provider-presets.md)），插件仅追加模板（[ADR-0079](0079-provider-catalog-templates-are-not-import-sources.md)） |
| 用量数据源 | `provider.usage` | 稳定面；统一 `UsageSnapshot` 聚合，遵循 [ADR-0058](0058-session-auxiliary-capability-honesty.md) 诚实性 |
| 编辑器 Opener | `provider.editor.opener` | 稳定面；与内置编辑器同列并由用户单选 |
| 远程 Host 供给器 | `provider.remote.provisioner` + `host.call remote.profile.* / remote.connect` | 稳定面；支撑 `dimo.remote-ssh` 及第三方远程供给器（[ADR-0070](0070-ssh-provisioned-remote-server.md)） |
| 嵌入浏览器 | `crates/browser-host`（Electron `<webview>`）+ `host.call browser.*` | 稳定面；官方插件 `dimo.browser` 消费，由宿主统一管理页面生命周期与预览桥接 |
| 协作与工作区聚焦 | `host.call collaboration.role.* / team.* / space.*` + `workspace.focusConversation` | 稳定面；协作空间为内置 L0 能力，接口面向插件开放 |
| 派生开发 | `dimo-plugin fork` + `derivedFrom` 元数据 | 稳定面；源码派生与独立身份打包 |

### 4. 能力等价插件分发与默认启用

从内置功能迁出的官方插件（如看板视图、Notes、提示词优化、浏览器、Remote SSH 等）归为**能力等价插件**，作为 [ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md)「市场按需安装」策略的唯一明确例外：

- Host 携带受版本固化的官方白名单（不可被市场响应或外部配置扩充），首次启动或版本升级时自动安装并默认启用，离线时回退发行物内置快照，所有自动安装同样经过 SHA-256 校验与审计记录。
- 用户对能力等价插件拥有完整主权：随时可禁用、可卸载，卸载后可从市场官方分类重新安装，且卸载不删除 Host 领域记录。

### 5. 开发者体验全链路闭环

所有官方与第三方作者共享同一套端到端工具链：`dimo-plugin init` → `dimo-plugin dev`（MF 面板 HMR / iframe 热替换）→ `dimo-plugin validate` / `test` → `dimo plugin add --dev .` → `dimo plugin test --host` → `dimo-plugin pack` / `fork`，配合设置页内置的插件运行诊断面（Worker 存活、崩溃恢复、stdout/stderr 日志与 readiness 证据）。

## Consequences

- 中央 Tab 栏仅固定「工作区」一员；看板 Tab 随已启用的 `app.kanban.view` 存在而出现，第三方可自由贡献顶级 Tab、看板视图、面板与 Provider。
- 官方插件与第三方同面使安全审查面与 SDK 契约唯一，不存在隐蔽官方后门 API。
- React singleton 共享要求 SDK `engines` 声明兼容窗口，并在宿主大版本升级时同步公告；原生 ESM + import map 保留为技术降级路线。

## Considered Options

- **整体迁移 Eclipse Theia / code-oss 或引入 Cordis 运行时**：否决。与 Dimo 运行期热安装、Activation Generation 及多进程 Worker 架构冲突。
- **支持插件依赖插件（`dependencies.kind = plugin`）与跨插件服务调用**：否决。会破坏单层归因、故障隔离与卸载确定性；以源码派生（`fork`）替代。
- **所有插件 UI 统一走 iframe**：否决。高频工作区面板与看板视图的启动与交互延迟不可接受，必须按交互密度分层渲染。
- **保留特权内置官方插件**：否决。削弱平台可信度并分裂扩展面。
