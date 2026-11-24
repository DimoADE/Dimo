---
status: accepted
date: 2026-09-17
decision-makers: Dimo maintainers
---

# 延迟到首条消息时建连，Prompt 永不隐式创建底层 Agent 会话

## Context

早期实现曾把底层握手与首条消息直接耦合，导致取消握手误伤已提交 Turn 或并发分叉线程；随后又尝试在打开/新建标签时立刻通过 `conversation_ensure_session_controls` 急切建连，虽然隔离了握手与 Turn，但对于冷启动耗时较长的 Agent（例如 `antigravity` 需 8–12s）会造成「新建即等待」「切回闲置会话再次等待」与多余子进程常驻。

结合 Instant Capability Catalog（启动预热 + Bundled Baseline + 缓存即时可读，[instant-session-controls-and-lazy-bind.md](../specs/instant-session-controls-and-lazy-bind.md)），Mode/Model/Effort 控件不再依赖活进程即可 0ms 渲染。因此本决定将底层进程建连严格**延迟到首次真正发消息时（Turn-Start Lazy Bind）**，同时继续坚守「建连阶段与 `send_prompt` 严格分离、恢复链显式化、回放隔离」等核心不变量。本约束同时适用于独立 Agent 引擎驱动与次选 ACP 通道（[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)），并与绑定代次（[ADR-0089](0089-conversation-binding-generations-and-history-segments.md)）和 SQLite 单一权威（ADR-0091）协同工作。

## Decision

### 1. 建连延迟到 Turn 派发前完成，且与 `send_prompt` 严格分离

Agent Runtime 在连接初始化（含 60 秒握手超时 `DEFAULT_HANDSHAKE_TIMEOUT_SECS`）完成后、进入 prompt 循环之前完成底层会话绑定（无真实原生 ID 时新建会话；有真实原生 ID 时按 `resume → load → fallback` 恢复）。

`conversation_ensure_session_controls` 是所有客户端表面（Electron 桌面、Remote、CLI、Automation、Workflow）的统一连接入口，但**仅由以下明确时机触发**，前端在打开会话、新建空会话或切回闲置会话时**不再自动调用**：

- 发送消息 / 派发队列输入（`prepare_turn_continuation` / `dispatch_next_queued_input`）发现当前无活跃连接时按需调用；
- `steer` / `recover` / 后台显式预热（`warmup_session_process`）需要活进程时调用；
- 用户显式点击「重连 / Reload」（`reconnectAndReload`，携带 `reload = true`）时调用。

其内部契约保持不变：

- 默认 **reuse-first**：若当前 Conversation 已存在活跃的已绑定连接则直接复用；仅当调用方显式传入 `reload = true` 时才先拆除旧连接重建。
- 阻塞等待直到 `SessionBindReady` 或明确的终态失败，绝不在仅完成 `initialize` 尚未完成会话绑定的中间态返回成功。

### 2. Prompt 永不创建底层会话，未绑定输入留在队列

- `send_prompt` / `start_turn` 严禁隐式调用 `session/new`；底层连接在未命中已绑定会话时必须硬失败，返回稳定码位 `acp_session_not_bound`（`AgentError::AcpSessionNotBound`，遵守 [ADR-0074](0074-turn-failure-taxonomy-and-recovery-visibility.md)）。
- 遵循 [ADR-0044](0044-conversation-control-plane-and-durable-inputs.md)，`submit` 始终先持久化输入再触发 `dispatch_next_queued_input`。若派发时会话尚未绑定，dispatcher 自动 `await conversation_ensure_session_controls`（并在建连期间将离线选定的 Mode/Model/Effort 一次性回放到新会话）；若绑定仍未就绪，则**不 commit Turn**，持久化输入留在队列中等待下次认领，避免制造虚假失败 Turn。

### 3. 控件就绪与活进程绑定解耦，不提前缓冲 Prompt

- **0ms 控件与可输入态**：新建或打开会话时，`load_conversation_detail` 直接使用 Instant Capability Catalog（本地 SQLite 缓存 / Bundled Baseline）合成 `session_modes` 与 `session_config_options`，并将前端 `sessionBindReady` 视为就绪、Composer 立即可输入与发送。未建连期间对 Mode / Config 的修改通过 `set_session_mode` / `set_session_config_option` 的离线路径持久化到 `conversation_agent_bindings`，待首条消息建连时自动应用。
- **活连接边界**：`AgentConnectionStatus::Ready` 表示进程初始化完成且命令环可运行；`AgentEvent::SessionBindReady` 标识底层活进程会话已就绪并触发前端保活（`conversation_touch`）与控件增量校准。
- **原生会话 ID 真实性**：`AgentEvent::SessionLinked` 仅负责将 Agent 返回的**真实原生会话 ID**写入当前绑定代次（[ADR-0089](0089-conversation-binding-generations-and-history-segments.md)）。任何占位符（如 `dimo-new-session-*`、`prepared-*`、`pending-*`）严禁写入数据库或用于恢复。后端仍拒绝在绑定完成前于命令通道中提前缓冲 Prompt。

### 4. 新建、切回与历史恢复闸

- **新建对话与切回闲置对话**：打开新标签或切回已被空闲回收的会话时，前端仅拉取 `conversation_detail` 并立即可用，不展示「正在连接 Agent…」，也不展示空闲断开的红色报错横幅；仅当用户在会话中发起下一条消息时，才在消息流内联展示连接进度并透明建立或恢复底层会话。
- **历史恢复防分叉闸**：在首条后续消息触发懒建连时，后端严格从 SQLite 读取当前绑定代次的真实 `external_session_id`（有则走 `resume → load`，无则新建）；对已持有非占位原生会话 ID 的绑定代次，拒绝无 ID 的新建会话请求，杜绝孤儿化 Agent 侧线程。

### 5. 恢复链与错误分类决策

存在可恢复的原生会话 ID 时按固定顺序恢复：若支持 `resume` 则先尝试 `resume`（任何失败静默落入 `load`）；若未广告 `load` 则视同 `method_not_found`。`load` 失败严格区分协议码位与局部 load 观测，不污染通用 Turn 失败分类（[ADR-0074](0074-turn-failure-taxonomy-and-recovery-visibility.md)）：

| 条件 | 行为 |
| --- | --- |
| 鉴权错误（`-32000` 码位或引擎原生鉴权失败，不做文本匹配） | 连接转 `Failed` 并触发既有认证 UI；不发 `SessionLoadFailed`，不建 Turn，不 `session/new` |
| `session_busy`（任意 Agent），或内置 Agent 的 `resource_not_found` / `session_unavailable` / `session_archived` | 展示连接级 `SessionLoadFailed` 横幅，提供「Reload（重试同一会话 ID）」与「新对话（新建 Conversation UUID）」，**永不**在失败 ID 上静默 `session/new`；`session_archived` 可附带恢复命令提示 |
| `method_not_found` / 未广告 `load`，或用户自定义 Agent 的非 busy 遗失会话 | 在同一 Conversation 上创建新绑定代次（[ADR-0089](0089-conversation-binding-generations-and-history-segments.md)）并记录 `AgentBindingRecovered { CreatedNewSession }` |
| 其它非预期 `load` 失败 | 先展示非终态错误提示，随后在同一 Conversation 上新建绑定代次 |

### 6. 取消保活、连接隔离与空闲回收

- **连接隔离与取消保活**：保持「一个 Conversation 一个连接」（[ADR-0071](0071-conversation-turn-integrity.md)），对同一 Conversation 的并发 connect 去重。取消握手在 10 秒窗口内收到确认时保留活进程、连接与绑定代次，下一条消息直接 `send_prompt` 而非重新恢复；仅取消超时才退役活连接（保留 DB 中的原生会话 ID 供下次恢复）。
- **空闲回收与按活连接保活**：闲置连接默认 180 秒后自动断开（`DIMO_ACP_IDLE_TIMEOUT_SECS`，设为 `0` 关闭），回收时严格跳过存在在途 Turn、取消握手窗口或待决权限请求的连接。前端仅在当前会话已存在真实活跃连接（`connectionStatus === 'ready'`）时每约 30 秒发送 `conversation_touch` 保活；空闲断开（`closed`）在无在途 Turn 且无显式错误通知时保持 UI 静默，下次发消息时无缝重连恢复。
- **回放隔离**：恢复期间的 `session/load` 内容回放一律丢弃，不写入 SQLite `conversation_events`（[ADR-0071](0071-conversation-turn-integrity.md)、ADR-0091）。

## Consequences

- 新建与切回会话达到 0ms 即时可输入与 0ms 控件渲染，不再因冷启动慢的 Agent（如 Antigravity）阻塞打开或切回流程，且不会为空会话常驻无用子进程。
- 首条消息与后续 follow-up 仍走完全一致的「先 `ensure_session_controls` 再 `send_prompt`」路径，消除 Prepare+Prompt 竞态与未绑定分叉。
- 应用启动遵循 [ADR-0001](0001-crash-recovery-semantics.md) 不急切批量重连，仅在发消息或显式重连时按需建连，并由空闲回收控制常驻进程数。

## Considered Options

- **打开或新建会话即自动调用 `ensureSessionControls` 急切建连**：否决。对冷启动耗时长的 Agent（如 Antigravity 8–12s）会阻塞用户进入和切回体验，并在用户仅浏览历史或创建草稿时浪费子进程资源。
- **允许在绑定完成前于命令通道缓冲 Prompt**：否决。重新引入未绑定 Prompt 窗口；离线起草由 revisioned draft（[ADR-0058](0058-session-auxiliary-capability-honesty.md)）承担。
- **由前端绕过 Conversation 控制面直接直连 Agent**：否决。破坏 [ADR-0044](0044-conversation-control-plane-and-durable-inputs.md) 单一写入口、Remote/CLI/Automation 同路以及事件日志权威。
