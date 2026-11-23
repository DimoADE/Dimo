---
status: accepted
date: 2026-08-02
decision-makers: Dimo maintainers
---

# ACP V2 采用双协议适配器与 Session Item 语义核心

在次选 ACP 兼容通道中（[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)），Dimo 通过统一的 `Protocol Session` 接缝并行支持 ACP V1 与 ACP V2，将协议差异收敛在适配器边界内，使 `crates/conversations`、SQLite 事件日志（ADR-0091）与前端共享一套协议无关的 Session Item 语义核心。

## Decision

### 1. 双协议适配器与版本协商

```text
ACP stdio connection ─► ProtocolNegotiator ─┬─ AcpV1Adapter ─┐
                                            └─ AcpV2Adapter ─┴─► SemanticSessionCore ─► SQLite Event Log ─► Projection
```

- **单一语义接缝**：`AcpV1Adapter` 与 `AcpV2Adapter` 将各自 wire schema、方法集合与生命周期翻译为统一的 `SessionIntent`（`Negotiate`、`NewSession`、`ResumeSession`、`ListSessions`、`DeleteSession`、`CloseSession`、`SubmitPrompt`、`RequestCancel`、`SetConfigOption`、`ForkSession`）与 `SessionObservation`（`Negotiated`、`SessionLinked`、`PromptReceipt`、`ForegroundStateChanged`、`MessagePatched` / `MessageContentAppended`、`ToolCallPatched` / `ToolCallContentAppended`、`PlanReplaced`、`TerminalPatched` / `TerminalOutputAppended`、`PermissionRequested`、`ElicitationRequested`、`ConfigOptionsReplaced`、`CommandsReplaced`、`SessionInfoPatched`、`UsageObserved`、`UnknownUpdate`、`ProtocolError`）。
- **每连接单版本协商**：仅当编译特性、运行时开关与 Agent allowlist 同时允许时才在 `initialize` 提议 V2，否则发送 V1。协商完成后同一连接禁止切换版本；若 V2 在创建任何会话前因已知兼容问题初始化失败，可终止进程并记录原因后最多以 V1 重建一次连接；一旦 V2 会话已创建或恢复，严禁静默降级为 V1，必须走正常恢复或显式 Session Rebind（[ADR-0029](0029-agent-updates-do-not-permanently-pin-conversations.md)）。V1 与 V2 长期并存。

### 2. 前台 Turn 与后台会话活动分离

- 前台状态机遵循 `Queued -> Submitted -> Running <-> RequiresAction -> Idle(stop_reason)`；同一 Conversation 同一时刻至多一个前台 Turn 在途。
- V2 `session/prompt` 响应仅产生 `PromptReceipt::Accepted`，不结束 Turn；带 `stop_reason` 的 `state_update(idle)` 才终止前台 Turn（`cancelled` → `TurnCancelled`，其余正常原因 → `TurnCompleted`）。
- `session/cancel` 仅记录 `CancelRequested` 并继续接收更新，收到 `idle(cancelled)` 才确认取消；等待期间连接丢失按可证明的失败/中断规则收尾（[ADR-0001](0001-crash-recovery-semantics.md)），绝不伪造 `Cancelled`。
- V1 Adapter 在 Prompt 发出时合成 `Running`、在 Prompt 响应返回时合成 `Idle`。
- V2 Agent 在无 active Turn 时产生的后台更新作为有效事件持久化并投影，但不自动创建、重开或完成前台 Turn。

### 3. Session Item 统一身份与三态 Patch

- **统一身份**：Message、Thought、Tool Call、Plan 与 Display Terminal 统一建模为 **Session Item**，由 `(conversation_id, agent_session_binding_id, item_kind, agent_owned_item_id)` 标识；协议 ID 均按 opaque string 保存，`foreground_turn_id` 为可选属性而非身份组成部分。V2 用户消息 ack 将本地 prompt ID 映射到 Agent `messageId` 以防重放重复；V1 缺失 ID 的对象使用标记 `synthesized_v1` 的本地合成 ID，绝不发回 Agent。
- **三态 `FieldPatch<T>`**：核心显式区分 `Unchanged`（wire omitted）、`Clear`（wire `null`）与 `Set(T)`（具体值），严禁以 `Option<T>` + `COALESCE` 模糊语义。chunk append 与 replace/clear 分开建模；Tool Call 首次出现即建空项并应用 patch；Plan 按 `planId` 整体替换；Terminal 每个 base64 chunk 独立解码为字节后追加。
- **事件溯源与幂等投影**：SQLite 事件日志保存规范化语义事件（有界 `raw_json` 仅作诊断），投影以 Item ID 幂等 upsert、以事件 sequence 作为行修订号。已知 discriminator 的畸形 payload 判定为协议错误，真正未知的 variant 与受限 `_meta` 保留并安全降级；旧事件永久可读且不做破坏性重写。

### 4. Resume Replay 隔离 Epoch

- V2 `session/resume` 区分无重放重连与 `replayFrom: { type: "start" }` 全量重放。
- 带 `replayFrom` 恢复时创建隔离 `ReplayEpoch`：在空状态上折叠重放通知，以 `session/resume` 响应作为屏障，按 Item ID 与 SQLite 权威状态差异协调（仅追加缺失或变化事实，避免重复追加 chunk，不重开已终态 Turn 或已结束的权限/提问），屏障之后才转入 live reducer；重放失败则整批丢弃不污染事件日志。

### 5. 能力归一化、终端分离、MCP 工具与统一配置

- **能力归一化**：`NegotiatedProtocol` 按 dialect 归一化记录能力快照；V2 存在 `capabilities.session` 即承诺基础会话方法，对象存在性表示支持，`null`/缺失均为 unsupported；Draft/unstable 特性需独立 capability 或开关授权。
- **内容无损**：Text、Image、Audio、Resource Link、Embedded Resource 在事件日志、投影、生成类型与前端间端到端结构化保留，不再将 Resource 静默降级为 URI 文本；未知内容与未知 Slash Command input 以只读安全形式展示。
- **终端与客户端工具分离**：V1 Client Terminal（Agent 请求宿主执行的进程）与 V2 Display Terminal（Agent 拥有、Dimo 只读展示的 Session Item，无 stdin/kill/wait 控件且输出受缓冲上限保护）严格隔离为不同模块。V2 不暴露 `fs/*` 与 `terminal/*` Client RPC；客户端能力与委派统一通过 `SessionEnvironment` 中的有作用域 MCP servers（stdio/HTTP，受工作区与 [ADR-0006](0006-workspace-less-conversation.md) scratch 目录及权限策略约束）提供；SSE 仅留于 V1 兼容面。
- **Diff、Permission 与 Mode**：ACP 报告的结构化 `FileChangeSet` 与工作区 Git/checkpoint diff 分别保存互不覆盖；Permission 开放 subject（`tool_call` / `command` / unknown）对未知 subject 或 outcome 一律 fail-closed 并执行本地/远程 first-terminal-wins；Session Modes 统一归一化为 `category = mode` 的 Config Option（V1 Adapter 负责在 `session/set_mode` 间双向翻译）。
- **扩展性与传输正交**：自定义枚举值以 `_` 开头；stdio 解码器限制 JSON-RPC batch 长度与字节数，生命周期消息不批处理；本地 `stdio` 进程边界、Registry、安装锁与 `LaunchGate`（[ADR-0034](0034-harden-acp-registry-and-adopt-auth-status.md)）均与 ACP dialect 正交。

## Considered Options

- **在原有 manager 中直接叠加 V2 条件分支**：否决。协议差异会泄漏至 Conversation 与 UI，破坏可测试性。
- **将 V2 事件降级映射为 V1 `AgentEvent`**：否决。丢失 `messageId`/`planId`、三态 patch、后台 Item、Prompt ack 与 Display Terminal 语义。
- **为 V2 建立第二套 Runtime 与 Conversation 管线**：否决。破坏单一事件日志、单一 Turn 状态机与统一前端投影。

## Consequences

- 协议演进被隔离在薄 Adapter 内，核心领域围绕稳定的 Session Item 与前台/后台状态事实演进。
- 短期需同时维护 V1/V2 协议 fixture 与协调模块，但避免了对既有 V1 Agent 与历史数据的任何破坏性迁移。
