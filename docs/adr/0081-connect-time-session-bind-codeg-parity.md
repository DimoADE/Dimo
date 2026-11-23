---
status: accepted
date: 2026-09-17
decision-makers: Dimo maintainers
---

# 会话建立在连接时完成，Prompt 永不创建底层 Agent 会话

## Context

将 Agent 会话握手（`session/new` / `session/resume` / `session/load`）塞进第一条消息的 `start_turn`，会导致首条发送承担冷启动与握手延迟、取消握手误将已提交 Turn 标为失败、历史重开未等外部 ID 就绪便意外冷启动分叉远端线程，以及 Composer 在会话未绑定前允许点击发送。本决定将底层会话绑定严格前移到 **connect 阶段**，确保 `start_turn` / `send_prompt` 只向已绑定会话投递 prompt。本约束同时适用于独立 Agent 引擎驱动与次选 ACP 通道（[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)），并与绑定代次（[ADR-0089](0089-conversation-binding-generations-and-history-segments.md)）和 SQLite 单一权威（ADR-0091）协同工作。

## Decision

### 1. 会话建立是连接启动的一部分，而非 Turn 的一部分

Agent Runtime 在连接初始化（含 60 秒握手超时 `DEFAULT_HANDSHAKE_TIMEOUT_SECS`）完成后、进入 prompt 循环之前完成底层会话绑定（无真实原生 ID 时新建会话；有真实原生 ID 时按 `resume → load → fallback` 恢复）。

`conversation_ensure_session_controls` 是所有客户端表面（Electron 桌面、Remote、CLI、Automation、Workflow）的统一连接入口：

- 默认 **reuse-first**：若当前 Conversation 已存在活跃的已绑定连接则直接复用；仅当调用方显式传入 `reload = true` 时才先拆除旧连接重建。
- 阻塞等待直到 `SessionBindReady` 或明确的终态失败，绝不在仅完成 `initialize` 尚未完成会话绑定的中间态返回成功。

### 2. Prompt 永不创建底层会话，未绑定输入留在队列

- `send_prompt` / `start_turn` 严禁隐式调用 `session/new`；底层连接在未命中已绑定会话时必须硬失败，返回稳定码位 `acp_session_not_bound`（`AgentError::AcpSessionNotBound`，遵守 [ADR-0074](0074-turn-failure-taxonomy-and-recovery-visibility.md)）。
- 遵循 [ADR-0044](0044-conversation-control-plane-and-durable-inputs.md)，`submit` 始终先持久化输入再触发 `dispatch_next_queued_input`。若派发时会话尚未绑定，dispatcher 自动 `await conversation_ensure_session_controls`；若绑定仍未就绪，则**不 commit Turn**，持久化输入留在队列中等待下次认领，避免制造虚假失败 Turn。

### 3. `Ready` 与 `SessionBindReady` 严格分离，不提前缓冲 Prompt

- `AgentConnectionStatus::Ready` 表示进程初始化完成且命令环可运行。
- `AgentEvent::SessionBindReady` 是底层会话绑定完成的唯一解锁信号（即便 Agent 未广告任何 modes/config 也会发出）；缓存 modes 不得提前解锁发送。
- `AgentEvent::SessionLinked` 仅负责将 Agent 返回的**真实原生会话 ID**写入当前绑定代次（[ADR-0089](0089-conversation-binding-generations-and-history-segments.md)）。任何占位符（如 `dimo-new-session-*`、`prepared-*`、`pending-*`）严禁写入数据库或用于恢复。
- Composer 在 `sessionBindReady === false` 时禁用发送；后端拒绝在绑定完成前于命令通道中提前缓冲 Prompt。

### 4. 新建即建连与历史加载闸

- **新建对话**：打开新标签时先 `conversation_create`（会话行进入列表），随后立即自动 connect 建立新会话。未安装 Agent 或存在未清除 `SessionLoadFailed` 时不自动拉起。
- **历史重开闸**：打开已有 Conversation 时，仅在 `detailLoading` 期间暂停自动 connect，待历史绑定元数据加载完毕后一律传入真实 `external_session_id`（或显式 `null`）发起连接（仅当内置档案明确声明既不支持 resume 也不支持 load 时可跳过等待）。后端同步设防：对已持有非占位原生会话 ID 的绑定代次，拒绝无 ID 的新建会话请求，杜绝孤儿化 Agent 侧线程。

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
- **空闲回收与前端保活**：闲置连接默认 180 秒后自动断开（`DIMO_ACP_IDLE_TIMEOUT_SECS`，设为 `0` 关闭），回收时严格跳过存在在途 Turn、取消握手窗口或待决权限请求的连接。前端对当前活动会话每约 30 秒（严格小于空闲阈值）发送 `conversation_touch` 保活，确保活动标签即使无 Turn 也不会被误回收。
- **回放隔离**：恢复期间的 `session/load` 内容回放一律丢弃，不写入 SQLite `conversation_events`（[ADR-0071](0071-conversation-turn-integrity.md)、ADR-0091）。

## Consequences

- 首条消息与后续 follow-up 走完全一致的纯 prompt 路径，消除 Prepare+Prompt 竞态与未绑定分叉。
- 应用启动仍遵循 [ADR-0001](0001-crash-recovery-semantics.md) 不急切批量重连，仅在打开活动标签或非 UI 入口派发输入时按需建连，并由空闲回收控制常驻进程数。
- 恢复与鉴权失败提前在连接层显式暴露，减少无效 Turn 污染时间线。

## Considered Options

- **保持在 `start_turn` 内执行握手并仅在前端禁用按钮**：否决。无法解决首条消息冷启动延迟、取消握手误伤 Turn 以及非 UI 入口的竞态。
- **允许在绑定完成前于命令通道缓冲 Prompt**：否决。重新引入未绑定 Prompt 窗口；离线起草由 revisioned draft（[ADR-0058](0058-session-auxiliary-capability-honesty.md)）承担。
- **由前端绕过 Conversation 控制面直接直连 Agent**：否决。破坏 [ADR-0044](0044-conversation-control-plane-and-durable-inputs.md) 单一写入口、Remote/CLI/Automation 同路以及事件日志权威。
