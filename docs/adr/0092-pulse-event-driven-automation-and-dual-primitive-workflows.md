---
status: accepted
date: 2026-11-15
decision-makers: Dimo maintainers
---

# Pulse 事件驱动自动化引擎与双原语工作流

## Context

Dimo 已具备隔离会话、持久化协作 Bot、群组空间和版本化 DAG 工作流，但缺少统一的事件接入层、跨源路由规则与防失控护栏，使外部 Webhook（GitHub、Jira、飞书、自定义 SDK）与定时/SLA 触发器能够安全、可审计地驱动多智能体自动化。

## Decision

1. **独立事件引擎 Crate 与 SDK（`crates/pulse`、`packages/pulse-sdk`）**：
   - `PulseEngine` 以规范化的 `EventEnvelope` 作为全系统统一事件载体，包含 `eventType`、`source`（`GitHub` / `Jira` / `Feishu` / `CustomSdk` / `Temporal` / `Internal`）、`trustLevel`、`actor`（含 `isSelf`）、`trace`（`hopCount`、`rootEventId`、`parentEventId`）、`threadKey` 与 `payload`。
   - 规则匹配采用受限 AST + JSON Pointer 过滤引擎（`MAX_FILTER_CONDITIONS` 与 `REGEX_SIZE_LIMIT_BYTES` 防止 ReDoS），并支持无副作用 `dry_run_rule` 演练。
2. **五类受控路由目标（`PulseTargetSpec`）**：
   - 每条规则显式绑定一种目标：`Session`（隔离临时工作区/会话）、`Bot`（持久化协作助手会话，配合 `BotTurnMailbox` 并发策略）、`Group`（协作空间多 Bot 阶段）、`User`（交互通知/确认门）或 `Workflow`（不可变发布版本的 DAG 运行）。
3. **安全网关与三层防死循环护栏**：
   - `StandardWebhookGateway` 强制校验标准 HMAC 签名头（`webhook-id`、`webhook-timestamp`、`webhook-signature`）、重放窗口（`WEBHOOK_REPLAY_WINDOW_SECS`）与负载大小上限（`MAX_WEBHOOK_PAYLOAD_BYTES`）。
   - 三层防循环：`actor.isSelf` 自触发抑制、`trace.hopCount` 最大跳数限制（`DEFAULT_MAX_HOP_COUNT`）、以及按 `threadKey` 生效的 `ChainRateBreaker`。
   - 授权溯源护栏（`enforce_mandate_origin`）：来自不可信外部事件的变更不能自动激活高权限规则或指令，必须以 `Draft` / `Shadow` 态等待用户显式确认。
4. **统一时间事件源（`TemporalSource`）**：
   - Cron 周期调度、一次性定时器与 `InactivitySlaTracker` 均向同一 `EventEnvelope` 总线发射事件，与外部事件共享过滤、护栏和审计语义。
5. **双原语工作流扩展（`crates/workflows` + `Dimo-superagent-mcp`）**：
   - 工作流图支持在同一 DAG 中组合临时 `SessionStepSpec`、持久化 `BotStepSpec`（配 `BotMailboxPolicy`）、`GroupStageStepSpec`、`UserGateStepSpec`、`BoundedLoopStepSpec`、`WaitForEventStepSpec`、`OutboxActionStepSpec` 与 `ConditionBranchStepSpec`，并提供 `WorkflowGraphPatch` 增量修改和 5 种内置拓扑预设（`DirectReflex`、`HybridPipeline`、`EventSaga`、`WindowAggregator`、`SuperagentRouter`）。
   - Pulse 与工作流的观测、演练、编辑和调度通过统一的 `Dimo-superagent-mcp` 暴露给受控 Agent。

## Consequences

- 外部 Webhook、定时/SLA 事件与内部多智能体编排共用同一事件模型、安全边界和可观测轨迹。
- 详细字段契约、护栏参数与 MCP 工具清单维护在 [docs/specs/pulse-automation-engine.md](../specs/pulse-automation-engine.md)。
