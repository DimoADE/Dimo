---
status: accepted
date: 2026-09-04
decision-makers: Dimo maintainers
---

# Conversation Turn 完整性：取消、恢复回放、连接隔离与终态可达

## Context

在 SQLite 单一权威的事件溯源会话核心中（[ADR-0044](0044-conversation-control-plane-and-durable-inputs.md)、ADR-0091），`conversation_events` 是唯一权威事实来源，`conversation_timeline_rows` 投影只是它的确定性函数。若恢复回放被当作新事实重复写入、取消不等待 Agent 确认、连接跨 Conversation 复用、用户权限配置在重连时静默回退，或行操作发布在并发 settle 窗口丢失终态，UI 就会出现消息粘连、中断失效、并行串话、权限回退与按钮卡死。本 ADR 确立六条从 Turn 发出到终态可达的硬约束，配合 [ADR-0001](0001-crash-recovery-semantics.md)、[ADR-0061](0061-host-local-safety-and-performance-baseline.md) 与 [ADR-0089](0089-conversation-binding-generations-and-history-segments.md) 共同保证会话记账正确性。

## Decision

### 1. 会话恢复回放不进入事件日志

连接管理器显式追踪正在恢复的会话窗口（如 `session/load` / `session/resume` 期间）。在恢复窗口内，所有内容类更新（assistant 消息、思考、工具调用与更新、计划）一律丢弃，不得重复写入 `conversation_events`；仅保留控制类更新（mode、config options、available commands）以反映会话当前能力。宿主事件日志已是完整历史权威（ADR-0091），Agent 侧回放永不构成新事实。

### 2. 取消是与 Agent 的握手，孤立更新永不归属上一轮

发出取消请求后必须等待 Agent 对在途 prompt 给出终态确认（如 `StopReason::Cancelled`），收到确认后才宣布 `PromptFinished { cancelled }`。等待设置上限（10 秒）；超时则强制收尾并**退役该活连接/进程**（保留 DB 中的持久化原生会话 ID，见 [ADR-0081](0081-connect-time-session-bind-codeg-parity.md)），防止失控进程向后续回合吐出无归属输出。

Turn 归属只有两个合法答案：当前活跃在途 Turn，或「无归属」。仅在途有意义的事件（消息增量、思考、工具调用、计划）在无活跃在途 Turn 时必须丢弃并记录诊断，严禁回落归属到上一个已终结 Turn。

### 3. 一个 Conversation 一个连接，并发冲突显式报错

`ensure_session` 严禁将另一 Conversation 正在使用的连接跨会话复用，即使 workspace、agent 与 working directory 完全相同。连接命令环在已有活跃 prompt 时收到新的 `Prompt` 命令，必须显式返回错误（`prompt_conflict`）使服务端将 Turn 标为可重发失败，严禁静默丢弃导致 Turn 永不到达终态。

### 4. 用户选择的 mode / config 持久记忆并在首次广播前应用

用户显式设置的 `preferred_mode_id` 与 `preferred_config_values` 在会话建立/恢复完成时、首次向 UI 广播 `session_modes` / `session_config_options` 之前应用，并拦截建立期间的中间默认值广播，杜绝权限或模式先闪回默认再覆盖的窗口。

记忆分两层按 key 合并，权威始终在 Host SQLite 而非浏览器 `localStorage`：

1. **Conversation binding 层**：该对话的权威记忆；每次显式 `set_mode` / `set_config_option` 成功后按 key 合并写入，Agent 默认广播不得回写。
2. **Agent last-used 层**：同步 upsert 至 `agent_session_default`，供新建会话继承；已有会话中 binding 层按 key 覆盖 last-used 层。

每个 Turn 按「profile / slash 默认 ← last-used ← binding 记忆 ← 本轮显式选择」合并覆盖；权限相关配置不得因重连或重绑静默回退到 Agent 默认值（[ADR-0058](0058-session-auxiliary-capability-honesty.md)）。

### 5. Binding 状态类型收口与原子截断顺序

`conversation_agent_bindings.status` 只能通过与数据库 `CHECK` 约束严格对齐的 Rust 枚举写入（`pending` / `connecting` / `ready` / `recovering` / `failed` / `closed`），禁止裸字符串写入。涉及历史截断（`truncate_to_turn`）的操作必须先失效当前会话绑定再截断事件，失效失败则中止截断，不留半提交状态。

### 6. 投影器缓存有界保留，发布路径单一临界区

时间线行操作的发布路径（读游标 → 读事件 → 载入投影器 → apply）在同一临界区内原子执行。Turn settle 后不丢弃投影器，而是使用有界容量缓存按最久未用淘汰，彻底消除冷载入并发竞态导致的终态 row-op 丢失窗口，并满足 [ADR-0061](0061-host-local-safety-and-performance-baseline.md) 的性能基线。

## Consequences

- 恢复窗口屏蔽内容回放要求宿主 SQLite 历史本身完整可靠，[ADR-0001](0001-crash-recovery-semantics.md) 崩溃恢复与 ADR-0091 单一权威成为强前置条件。
- 取消存在最长 10 秒的握手延迟，UI 呈现「正在取消」中间态；拒绝确认取消的 Agent 会被退役活连接，下一轮冷重连恢复。
- 连接不跨 Conversation 复用会增加同工作区多会话的进程数，但彻底消灭交叉写入同一底层会话的串话故障。
- `prompt_conflict` 成为标准可重发失败码，保证任何 Turn 都能确定到达终态。
- 10 秒取消上限与投影器缓存容量属于工程参数，可按实测调整，但不得取消握手或退回 settle 即弃。
