---
status: accepted
date: 2026-11-18
decision-makers: Dimo maintainers
---

# SQLite 单权威会话投影与双连接池并发架构

## Context

高并发多 Agent 场景下，会话事件流、时间线增量投影、全文检索、断点恢复与外部历史回放需要同时满足低延迟读取、无写锁冲突、进程崩溃后零丢数以及所有客户端（桌面、WebUI、远程工作站、移动伴随端）视图严格一致的要求。

## Decision

1. **SQLite 为会话事件与时间线投影的唯一权威**：
   - `conversation_events` 与 `conversation_timeline_rows` 共同作为会话历史与 UI 时间线的权威存储，辅以行级 `conversation_fts` 索引。
   - 所有实质性内容增量（`AssistantTextDelta`、`AssistantReasoningDelta`、`AssistantContentAppended`、`PlanUpdated`、`ToolCallUpsert` 等）全部落盘；仅瞬态 UI 提示（`PromptSuggestionUpdated`、`RequestActivityChanged`）不入库。
   - 历史 `.jsonl` 会话文件仅作为迁移回填源：通过 `backfill.rs` 的双阶段机制（打开会话时按需 `ReadPool` 探测 + `WritePool` 单事务原子回填，以及后台低优先级批处理）一次性迁入 SQLite，并由 `sessions.legacy_jsonl_migrated` 标记幂等完成。
   - ACP `session/load` 防重复回放探针（`register_acp_replay_history_probe`）直接查询 SQLite 的 `conversation_turns` 与 `conversation_events`。
2. **双连接池与提交可见性栅栏（`crates/db`）**：
   - **`WritePool(1)`**：单连接写池，统一使用 `BEGIN IMMEDIATE` 串行提交事务，从根源消除多写者竞争导致的 `SQLITE_BUSY`。
   - **`ReadPool(4)`**：只读并发读池（`read_only(true)` + `PRAGMA query_only = ON`），对意外写操作直接返回 `SQLITE_READONLY` 快速暴露缺陷。
   - **`CommitVisibilityFence`**：保证写事务提交后，同一写路径后续经 `ReadPool` 发起的读取能够稳定观察到最新 WAL 提交。
3. **流式节流合并与行级脏刷新（`crates/conversations`）**：
   - `StreamingThrottleCoalescer` 在写入前对高频文本/推理增量做边界合并（400ms Markdown 块边界 / 800ms 空闲刷新 / 64 KiB 上限，遇到非 delta 事件立即屏障冲刷）。
   - `ConversationProjector` 使用 `BatchConversationEvent`（单批上限 `64` 条事件 / `1 MiB`）与 `DirtyRowMap` 执行行级增量 upsert（`flush_dirty_rows_on_conn`），避免整条会话全量重算。

## Consequences

- 多会话并发流式输出期间，写路径零锁冲突、读路径不被长写事务阻塞，且桌面端、WebUI 与移动端在断线重连后基于单调 sequence 总是收敛到完全一致的时间线状态。
- 写后读依赖 `CommitVisibilityFence` 显式协调；所有只读查询必须走 `ReadPool`，所有状态变更必须走 `WritePool`。
