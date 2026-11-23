---
status: accepted
date: 2026-07-04
decision-makers: Dimo maintainers
---

# 崩溃恢复：只恢复上下文，绝不重放在途 Turn

SQLite `conversation_events` 是会话控制面与历史的单一权威存储（见 ADR-0091），但 Agent 运行在本地子进程中（独立原生引擎或次选 ACP 进程，见 [ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)）。宿主进程异常退出或重启时，正在运行的 Turn 的生成过程物理上不可恢复。

## Decision

- **启动协调**：宿主启动时，恢复协调器扫描所有孤立的在途 Turn，向事件日志追加 `TurnInterrupted` 终态事件，并同步作废其孤立的 pending 权限请求与提问请求，使会话回到可发起新 Turn 的一致状态。
- **惰性恢复上下文**：会话上下文不在启动时批量重连，而是在惰性时机（打开会话或下次发送时）通过对应 Agent 引擎的原生会话恢复或 ACP `session/resume` / `session/load` 重载进新 Agent 进程。
- **绝不自动重发**：被中断的 Turn 只向用户提供显式一键重试，绝不自动重发。Agent 崩溃前可能已产生文件修改、命令执行等副作用，是否重跑只能由能观察工作区状态的用户决定。

## Considered Options

- **启动时直接 UPDATE Turn 状态、不写事件**：否决。破坏“状态只由事件推进”的不变量，导致事件日志出现无法解释的状态跳变。
- **恢复后自动重发原 Prompt**：否决。存在重复执行已发生副作用的风险。
- **启动时急切重连所有最近活跃会话**：否决。启动时批量拉起多个 Agent 子进程代价高且多数用不到，惰性恢复即可满足交互需求。

## Consequences

- `Interrupted` 是 Turn 的第四个终态，与 `Completed`、`Failed`（Agent 报错）和 `Cancelled`（用户取消）互斥，见 [CONTEXT.md](../../CONTEXT.md)。
- 读取事件日志必须具备前向容错能力（`event_version` 列 + 未知事件 `Unknown { kind, raw }` 包装兜底），确保新增事件变体在版本回退时不会破坏整条时间线。
