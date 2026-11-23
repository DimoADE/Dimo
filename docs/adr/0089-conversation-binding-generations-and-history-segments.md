---
status: accepted
date: 2026-11-13
decision-makers: Dimo maintainers
---

# Conversation 绑定代次、历史片段与跨 Agent 确定性接续

## Context

同一个 Conversation 在其生命周期中可能经历重新绑定、切换 Provider 实例、变更工作目录或切换为另一个 Coding Agent。若仅按「最新一条绑定」或「当前选中的 Agent」反查历史或直接复用原生会话 ID，就会在重绑或跨 Agent 切换时丢失历史来源、混淆不同引擎的原生会话，甚至恢复已放弃的上下文。本 ADR 与 SQLite 单一权威会话存储（ADR-0091）及连接时会话绑定（[ADR-0081](0081-connect-time-session-bind-codeg-parity.md)）共同确立绑定代次、历史片段、`continuation_key` 以及 `conversation_handoffs` 确定性跨 Agent 交接架构。完整的线协议、状态迁移与载荷规范见 [`docs/specs/cross-agent-continuation.md`](../specs/cross-agent-continuation.md)。

## Decision

### 1. 绑定代次（Binding Generations）

- 每个 Conversation 显式指向唯一的 **active binding generation**。原生会话 ID 归属特定绑定代次，同一代次永不被另一原生会话 ID 覆盖。
- **`release` 与 `rebind` 分离**：`release` 仅释放活连接与进程，保留当前代次的恢复资格；`rebind` 或跨上下文切换显式失效当前代次（保留其原生 ID 与元数据作为历史证据），并为后续运行创建新的绑定代次。
- **代次归属隔离**：每个 Turn 与运行事件记录所属绑定代次；切换写入目标前先退休旧连接路由，确保退休或迟到连接的输出绝不能污染新的代次。

### 2. 历史片段（History Segments）与单一权威

- SQLite 作为会话历史与时间线投影的单一权威（ADR-0091），统一维护 Conversation 历史片段的有序清单、来源代次、完整性证据（长度与 SHA-256）以及单调递增的 `history_revision`。
- 打开、翻页、`session_info`、搜索索引、导出、fork 与 truncate 全部按数据库中的历史片段清单读取，永不根据当前 Agent 猜测来源。
- 切换绑定、封存旧片段与发布新片段遵循原子顺序：先退休旧连接并 flush/sync 封存旧片段，再完整写入并原子发布新清单；任一步失败均保留可读的既有历史，绝不发布不完整状态。
- `fork` 与 `truncate` 生成独立片段视图并推进 `history_revision`；当切点落在其他绑定代次内时，绝不把旧代次的原生消息 ID 交给当前 Agent 执行 native fork。Bundle 导出携带可选 `transcript_turns` 并保持旧版可读。

### 3. Continuation Key 唯一界定可恢复上下文

可原生恢复的运行上下文由规范化 **`continuation_key`** 唯一标识：

```text
agent_id|provider_instance_id|working_dir
```

- 仅当目标 `continuation_key` 与当前 active binding generation 完全匹配且代次有效时，运行时才允许沿该代次的原生会话 ID 恢复上下文。
- 一旦 Agent 身份、Provider 实例或工作目录任一要素发生变化导致 `continuation_key` 不同，已保存的旧原生会话 ID 仅作历史证据，不构成复用授权，必须创建新代次并进入确定性交接流程。

### 4. `conversation_handoffs` 状态机与确定性交接

跨 Agent 或跨 `continuation_key` 接续由持久化表 `conversation_handoffs` 与显式交付 attempt 驱动，禁止依赖后台隐式猜测：

- 宿主基于已封存的权威历史片段构造自足、确定性的交接载荷（portable handoff），记录来源片段、目标绑定代次与 `continuation_key`。
- 交接按 `conversation_handoffs` 明确状态机推进（准备 → 绑定目标代次 → 显式投递与校验 → 完成或可重试失败），所有切换与重试均可审计、可幂等恢复，不会在失败时静默丢弃历史或破坏既有对话内容。
- 完整的状态机变迁、字段定义与 UI 交互契约见 [`docs/specs/cross-agent-continuation.md`](../specs/cross-agent-continuation.md)。

## Consequences

- 用户可在同一 Conversation 内无缝完成重绑、切换 Provider 或跨 Agent 接续，时间线历史完整连贯且来源清晰。
- 不同 Agent 引擎（含独立引擎驱动与 ACP 通道，[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)）之间彻底消除原生会话 ID 串用与静默上下文丢失。
- 历史改写（fork / truncate）与跨代次切换全部落在 SQLite 单一权威事务边界内，保证崩溃后依然可恢复。
