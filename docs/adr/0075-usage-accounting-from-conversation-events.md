---
status: accepted
date: 2026-09-04
decision-makers: Dimo maintainers
---

# 计量以 conversation_events 为归属权威，厂商日志降级为分项 token 补充来源

## Context

仅依赖扫描少数厂商的本地 JSONL 日志并按目录路径字符串匹配项目，会导致覆盖率仅限于少数 Agent、目录与 worktree 归属静默错配，且无法反映全部 20 个内置 Agent 的真实使用情况。在 SQLite 单一权威会话模型（ADR-0091）下，Dimo 自身拥有完整的会话关系表与 `UsageUpdated` 事件日志。本决定遵循 [ADR-0058](0058-session-auxiliary-capability-honesty.md) 与 [ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)，将用量归属收口到宿主数据库，并将厂商日志降级为受约束的分项补充证据。

## Decision

### 1. `conversation_events` 与 `sessions` 是归属与口径的唯一权威

用量报表的行集合、维度归属与会话计数全部由 Dimo SQLite 数据库决定，而非由厂商日志文件决定：

- **按目录**：通过 `sessions.workspace_id → workspaces.project_id / container_ref` 关系归属，不再做易出错的路径字符串比对。
- **按 Agent**：按规范 `AgentKind`（`sessions.agent_id`）归属，覆盖全部内置与自定义 Agent。
- **按模型**：取自会话事件中 Agent 上报的模型标识。

一个会话是否计入报表仅取决于它属于该项目，与厂商是否落盘日志无关；未上报分项 token 的 Agent 会在报表中如实呈现为覆盖缺口，而不是彻底消失。

### 2. 数值携带来源标记，不同来源永不相加

计量数值区分两类来源：

| 来源 | 数据通道 | 角色 |
| --- | --- | --- |
| `protocol` | 独立 Agent 引擎一手分项与缓存计费（[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)）、ACP `PromptResponse.usage`、`UsageUpdate` 及 `_meta` 写入的 `UsageUpdated` 事件 | 会话内权威 |
| `vendor_log` | 厂商本地会话日志增量解析 | 分项 token 补充对照 |

- UI 严禁将 `protocol` 与 `vendor_log` 的数值相加为单一总计；同一维度两来源并存时展示 `protocol` 并以 `vendor_log` 对照，存在差异时如实显示。
- `context_used` / `context_window_max` 属于上下文窗口占用，任何情况下不得与输入/输出/缓存分项 token 相加（[ADR-0058](0058-session-auxiliary-capability-honesty.md)）。

### 3. 厂商日志严格按会话标识对齐并增量物化

厂商日志条目仅通过 `sessions.external_session_id`（及对应绑定代次的原生会话 ID）与 Dimo 会话对齐；无法对齐的条目**不得进入项目报表**，仅允许计入独立的「未归属」统计。日志解析按文件 `mtime` / `size` 增量写入 `vendor_usage_sessions`，与会话物化快照 `conversation_usage_snapshots` 共同服务查询，满足 [ADR-0061](0061-host-local-safety-and-performance-baseline.md) 的性能要求（仪表盘打开不重扫全量日志或重放全量事件）。

### 4. 缺失保持缺失，不填零、不估算

未提供分项 token 的维度显示为「未提供」而非 `0`，明确告知用户该 Agent 未通过协议或引擎上报分项数据。费用（`cost_amount`）仅在引擎/协议直接给出或本地费率表明确覆盖该模型时展示，未覆盖模型不做估算。

### 5. 订阅额度与 token 计量保持分离

`AgentPlanUsage`（`provider.usage`）反映的是订阅周期额度窗口占用，与单会话 token 消耗不可叠加，在看板与仪表盘中保持独立视图，不并入 token 报表总计。

## Consequences

- 用量报表覆盖所有 20 个内置 Agent 与外部自定义 Agent，目录/worktree 归属精确无歧义。
- 随独立 Agent 引擎适配（[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)）与 ACP 端到端 usage 推进，`protocol` 来源逐步成为绝大多数主力 Agent 的精确分项数据来源。
- 预聚合物化表 `conversation_usage_snapshots` 与 `vendor_usage_sessions` 保证长历史下仪表盘读取维持低延迟。

## Considered Options

- **完全废弃厂商日志**：否决。对于尚未提供端到端协议分项数据的兼容层会话，厂商日志仍提供有价值的分项补充对照。
- **继续以厂商日志为归属主源**：否决。日志缺乏 Dimo workspace 与跨 Agent 身份，无法提供可靠的多目录与全 Agent 视图。
- **用 `context_used` 或费率估算填补缺失分项**：否决。直接违反 [ADR-0058](0058-session-auxiliary-capability-honesty.md)，混淆观测事实与猜测值。
