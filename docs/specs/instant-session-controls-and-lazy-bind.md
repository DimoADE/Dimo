# Spec: Instant Session Controls & Lazy Turn-Start Session Bind

**Status:** Active  
**Scope:** Agent Capability Catalog, Conversation Session Lifecycle, Native Engine Initialization (`crates/agents`, `crates/conversations`, `crates/application`, `crates/server`, `shared`, `scripts`, `frontend`)

## 1. 目标

对标 T3Code 的零延迟交互体验，消除 Dimo 在 **Antigravity**、**ClaudeCode**、**Codex** 会话配置拉取与会话连接上的感知延迟：

1. **配置零延迟（Mode / Model / Effort）**：打开新建会话表单、切换 Agent/Provider Instance、或打开任意会话时，配置选项在 `< 50ms` 内直接呈现，不因缓存 TTL 过期、首次冷启动或后台探测阻塞 UI。
2. **会话秒开与零重连**：创建 Antigravity 会话后 0ms 可输入并发送消息，消除 ~10s「正在连接 Agent…」等待；离开会话超过空闲回收阈值（180s）再切回时 0ms 秒开、不触发自动重连，仅在用户发送下一条消息时于 Turn 执行阶段静默 `resume`。
3. **原生引擎去阻塞**：消除 ClaudeCode 每次初始化时额外拉起一次性 `claude` CLI 子进程探测模型（1.5–3.5s）的阻塞；消除 Codex 重复实时 `model/list` RPC 与目录刷新随机 `workspace_id` 击穿进程池的问题。

## 2. 架构不变量与范围边界

- **Single-Seam Host**：所有新增命令在 `crates/application/src/domain.rs` 与 `shared/hostCommands.ts` 同步注册，实时推送经 `HostEventBus` 发出，桌面 Electron 与 headless `dimo-server` 完全同路。
- **SQLite Single-Authority**：会话历史、离线控件选择偏好（`conversation_agent_bindings` / `agent_session_defaults`）及持久化配置目录（`agent_capability_catalog`）以 SQLite 为唯一持久化事实源。
- **Antigravity 零自动拉起铁律**：任何服务启动预热、定时健康检查或 TTL 后台 SWR 刷新**严禁**自动 spawn `agy_acp_server`（~1GB PyInstaller 自解压单文件）；Antigravity 目录仅通过被动采集（登录完成、正常会话启动/更新）或用户显式点击刷新更新。
- **非目标**：不改变 `crates/executors` 定位、不弱化跨 Agent 交接（ADR-0089）与 Turn 完整性约束（ADR-0071 / ADR-0044）、不在本阶段强行合并 ClaudeCode 多会话到单个 Node 进程（优先拔除阻塞探测）。

## 3. 分阶段改造步骤与模块边界

### Phase 1（P0-2）：Server 级零延迟 Provider Catalog（启动水合 + 静态基线 + SWR + EventBus 推送）

1. **`crates/agents`**：
   - 在 `crates/agents/src/engine/descriptor.rs` 定义 `CatalogRefreshPolicy`（`BackgroundNativeProbe` 用于 ClaudeCode/Codex/MuseCode；`PassiveOnly` 用于 Antigravity 及其他高冷启成本 ACP 引擎）并提供 `catalog_refresh_policy_for_agent(agent_id)` 查询函数。
   - 在 `crates/agents/src/engine/baseline.rs`（导出 `bundled_controls_snapshot(agent_id)`）复用 `default_claude_models()`、`default_codex_models()` 与 `native_controls.rs` 的纯控件构造逻辑，为原生引擎提供内置静态 Mode / Model / Effort 基线（无需活体进程或 `EngineHandle`）。
2. **`crates/conversations`**：
   - 在 `crates/conversations/src/capability_catalog.rs` 新增非阻塞读入口 `resolve_instant_capability_catalog_for_provider_instance`，按 **L1/L2 指纹匹配 SQLite 记录（含 TTL 过期行）→ 同 `agent_type` 最近持久化记录（仅本地默认实例且未明确登出）→ L3 静态基线 `bundled_controls_snapshot`** 顺序 0ms 返回，并给出 `CatalogResolution { snapshot, needs_background_refresh, refresh_policy }`。
   - 修复 `synthesized_offline_controls_snapshot`（`crates/conversations/src/turn/binding.rs`）：禁止调用会同步触发 `refresh_open_capability_catalog` 的旧路径，改用非阻塞 `resolve_instant_capability_catalog_for_provider_instance` + `remembered` binding + `preferences`，确保离线合成 100% 不 spawn 进程。
   - 对 `PassiveOnly` 引擎，只要存在匹配持久化记录，`capability_catalog_is_fresh` 视为新鲜，不再因 10 分钟 TTL 触发后台自动探测。
   - 在 `persist_capability_catalog` 与 `record_open_capability_catalog` 成功后触发目录更新通知。
3. **`crates/application` + `crates/server` + `shared`**：
   - 在 `crates/server/src/host/events.rs` 注册 `agent-capability-catalog-updated` 事件频道。
   - 在 `crates/application/src/domain.rs`、`shared/hostCommands.ts`、`crates/server/src/domains/automation_and_projects.rs` 中：
     - `agent_capability_catalog` 改为走 `resolve_instant_capability_catalog_for_provider_instance`（0ms 返回；仅当 `needs_background_refresh && BackgroundNativeProbe` 时后台 `tokio::spawn` 去重 SWR 刷新并经 `HostEventBus` 推送）。
     - `agent_refresh_capability_catalog` 完成后向 `HostEventBus` 广播 `agent-capability-catalog-updated`。
     - 新增 `agent_capability_catalogs_snapshot` 批量返回当前所有已启用 Agent 的即时目录快照。
   - 在 `crates/server/src/composition.rs` 启动阶段后台预热：仅对已启用、认证就绪且策略为 `BackgroundNativeProbe` 的原生引擎异步刷新一次缺失/过期目录并广播，显式跳过 `PassiveOnly`（Antigravity）。
   - 在 `crates/server/src/host/surface.rs` 中，`agent_set_session_defaults` 优先用即时目录校验；`after_agent_native_model_change` 将目录刷新异步化并推送更新。
4. **`frontend`**：
   - 新增 `frontend/src/features/agents/capabilityCatalogSync.ts`（在 `App.tsx` / `MainAppShell.tsx` 挂载）：启动时批量拉取 `agent_capability_catalogs_snapshot` 写入 TanStack Query cache，并监听 `agent-capability-catalog-updated` 原地更新缓存。
   - 修改 `frontend/src/features/agents/sessionControlsQuery.ts`：移除 `loadAgentSessionControlsCatalog` 中「缓存缺失即同步 `await refreshCapabilityCatalog()`」的阻塞链，直接返回后端 0ms 即时目录。
   - 修改 `frontend/src/components/sessions/SessionCreationForm.tsx`：移除每次打开表单以 `staleTime: 0` 触发 `refreshCapabilityCatalog` 的副作用。
   - 修改 `frontend/src/components/tasks/follow-up/useComposerSessionControlsQuery.ts`：目录 query 使用长缓存，由 `HostEventBus` 推送更新。

### Phase 2（P0-1）：会话与 Agent 进程彻底解耦（Lazy Bind on Turn Start）

1. **`crates/conversations` & `crates/server`**：
   - `crates/server/src/host/conversation.rs` 的 `load_conversation_detail` 使用 `resolve_instant_capability_catalog_for_provider_instance` 合成并叠加历史/预绑定偏好，保证无论是否有活体进程，`conversation_detail` 均一次返回完整准确的 `session_modes` 与 `session_config_options`。
   - 保持 `ensure_session_controls_locked_with_provider_instance` 作为真实进程建连/恢复实现，仅在 Turn 启动（`prepare_turn_continuation`）、`steer`、`recover`、显式 `reload=true` 重连时执行；`conversation_ensure_session_controls(reload: false)` 保持复用活连接，避免误伤显式预热/CLI/自动化调用。
   - 确认新会话未发送首条消息前修改 Mode / Model / Effort 时，通过 `set_session_mode` / `set_session_config_option` 的离线分支持久化至 `conversation_agent_bindings`，在首条 Turn 建连时准确重放。
   - 当 `complete_committed_turn` → `prepare_turn_continuation` 成功建连时，被动调用 `record_open_capability_catalog` 并广播 `agent-capability-catalog-updated`。
2. **`frontend`**：
   - 修改 `frontend/src/features/conversation/conversationTimelineRegistry.ts`：
     - 移除 `retainConversationTimeline`、`loadDetail`、`applyOptimisticTurnAdd`、`completeConversationEngineHandoff`、`syncConversationSelectedAgent` 中的自动 `scheduleBind` / `beginBind` 调用。
     - 保留 `reconnectAndReload` 专用于用户显式点击「重连」或故障恢复。
     - 仅当后端事件流表明该会话已存在真实活连接（`connectionStatus === 'ready'`）时才启动 `startKeepalive`，避免对未建连或已休眠会话发无效心跳。
     - 空闲未发消息会话默认 `connecting = false`、`sessionBindReady = true`，不再在打开或切回会话时拉起进程或显示「正在连接 Agent…」。
   - 修改 `frontend/src/features/conversation/inlineRuntimeStatus.ts`：
     - 非 Turn 执行中且非手动重连时，不将空闲回收（`idle_timeout` / `closed`）或无活连接状态渲染为 Composer 顶部阻断/连接中状态。
   - 同步更新 `frontend/src/features/conversation/UseConversationTimeline.test.tsx` 验证懒绑定与显式重连契约。

### Phase 3（P1）：拔除 ClaudeCode & Codex 原生引擎初始化阻塞

1. **ClaudeCode（`scripts/claude-native-driver.mjs`、`scripts/claude-native-models.mjs`、`crates/agents/src/engine/claude.rs`）**：
   - `handleInitialize` 支持 `skipModelProbe: true`（会话启动默认开启）：仅解析本地 `~/.claude/settings.json` 与已配置模型（`< 20ms`），**不再同步调用 `probeSdkSupportedModels()`（消除每次拉起一次性 `claude` CLI 子进程的 3s 阻塞）与 `fetchGatewayModels()`（1.5s 阻塞）**。
   - 新增独立 JSON-RPC 方法 `models/list`，专供 Provider 级后台目录刷新或用户显式刷新调用。
   - 在 `prompt/send` 真实运行 `sdk.query()` 时，若 SDK 返回 `supportedModels()`，异步上报 `models/updated` 通知被动更新缓存。
   - 在 Rust 侧 `ClaudeNativeDriver` 缓存 Provider 级已发现模型，会话 `initialize` 传 `skipModelProbe: true`，并提供独立的 `probe_models(spec)` 供目录刷新使用。
2. **Codex（`crates/agents/src/engine/codex.rs`、`crates/conversations/src/capability_catalog.rs`）**：
   - 为 `CodexAppServer` 增加实例级 `models_cache: RwLock<Option<Vec<EngineModelInfo>>>`：`list_models()` 命中即 0ms 返回；仅首次或显式强制刷新时发送 `model/list` JSON-RPC；`invalidate_codex_servers()` 时清空缓存。
   - 新增 Provider 级 `probe_models_for_provider(spec)`：优先复用 `global_codex_servers()` 中 `(provider_instance_id, auth_fingerprint, native_config_fingerprint)` 匹配的任意存活实例执行 `model/list`；无存活实例时使用固定 `Uuid::nil()` 探针键而非随机 `Uuid::new_v4()`，根治连接池击穿。
3. **原生引擎轻量目录刷新通路（`crates/agents/src/runtime.rs`、`crates/conversations/src/capability_catalog.rs`）**：
   - `refresh_open_capability_catalog_uncached` 对原生引擎（ClaudeCode / Codex）直接调用轻量 `probe_native_provider_controls`（跳过临时目录创建 + `Uuid::new_v4()` + 完整 `prepare_session` + `discard_prepared_session` 重型模板）。

## 4. 验收标准

### 自动化测试与门禁
1. **Rust 单测与集成测试**：
   - `agents`：`bundled_controls_snapshot` 对 ClaudeCode/Codex 返回完整 Mode/Model/Effort；`CatalogRefreshPolicy` 将 Antigravity 归类为 `PassiveOnly`；Codex 连续两次 `list_models()` 仅发 1 次 `model/list` RPC；Claude `initialize` 传 `skipModelProbe: true` 不触发 SDK 探测。
   - `conversations`：过期 TTL 目录仍 0ms 返回；空库下 ClaudeCode/Codex 返回静态基线；`synthesized_offline_controls_snapshot` 永不触发 `prepare_session`；离线修改控件在首次 Turn 建连时正确重放。
   - `scripts`：Node 单测验证 `claude-native-driver.mjs` 的 `initialize({ skipModelProbe: true })` 与 `models/list` 行为。
2. **Frontend 单测**：
   - `UseConversationTimeline.test.tsx`：验证挂载会话、切回会话、乐观发送消息均不再自动调用 `ensureSessionControls`；仅显式 `reconnectAndReload` 调用 `ensureSessionControls(..., { reload: true })`。
   - `sessionControlsQuery` / `capabilityCatalogSync` 测试：验证无阻塞读取与 `agent-capability-catalog-updated` 事件原地更新。
3. **工程门禁**：
   - `pnpm run check`、`pnpm run lint`、`pnpm run arch:check`、`pnpm --filter ./frontend test`、`cargo test -p agents -p conversations -p server`。
   - 如有命令/协议变更，运行 `pnpm run remote-protocol-schema` 保持 `docs/protocol/v1/` 同步。

### 对标 T3Code 体验验收
- **Antigravity**：新建会话 0ms 显示完整 Mode/Model/Effort 且立即可发消息（无 10s「正在连接 Agent…」）；离开 >4 分钟切回历史会话 0ms 秒开、无重连提示，发下一条消息在 Turn 内无缝 `resume`。
- **ClaudeCode / Codex**：重启或新开表单 0ms 呈现完整 Mode/Model/Effort；首轮会话启动不再因 `probeSdkSupportedModels()` 或重复 `model/list` 产生额外 1.5–3.5s 阻塞。
