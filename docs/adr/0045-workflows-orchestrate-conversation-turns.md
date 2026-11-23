---
status: accepted
date: 2026-08-13
decision-makers: Dimo maintainers
---

# Workflow 以持久 DAG 编排真实 Conversation 与 Turn

Dimo 建立独立的 Workflow 领域（`crates/workflows`），以版本化无环依赖图（DAG）编排真实的 Conversation、Turn 与审批决策；Automation 继续专注触发与到期认领，并将目标扩展为单个 `TurnLaunchSpec` 或不可变的已发布 Workflow 版本（[ADR-0032](0032-automations-replay-versioned-turn-launch-specs.md)）。双原语 Pulse Workflow（持久 Bot 节点、BoundedLoop、WaitForEvent、UserGate 与 OutboxAction）在此基础上进一步扩展，见 ADR-0092。

## Decision

### 1. 领域实体与 Automation 协同

```text
WorkflowDefinition (published, immutable version)
  └── WorkflowRun (definition snapshot + input + policy + workspace)
        ├── StepRun ─ AgentStep ──► ConversationRelation(workflow_step) ─► Conversation ─► Turn(s)
        └── StepRun ─ ApprovalStep (durable principal decision)
```

- **Workflow Definition**：由工作区可编辑源产物（`*.dimo-workflow.json`）经显式 `publish` 校验后生成的不可变版本，声明输入、稳定 `step_id`、`depends_on` 依赖边、步骤规格、输出引用、阶段分组（`Phase`，纯展示元数据）与默认策略；修改源产物产生新版本，不影响已启动的运行。
- **Workflow Run**：绑定精确 definition version、规范化输入、工作区身份、策略快照与解析版本证据；支持暂停（停止新调度、取消在途 Turn 进入可恢复 `paused` 态）、调试断点与基于上游检查点复用的派生运行（`DerivedWorkflowRun`）。
- **Step Run**：单步在某次 Run 中的可审计执行记录，显式重试生成新 attempt 而不覆盖旧证据。
- **Agent Step 与 Approval Step**：Agent Step 通过 `ConversationControl`（内部经 `ConversationExecutorPort` 解耦以避免 `crates/workflows` 与 `crates/application` 循环依赖）创建真实子 Conversation 并执行 Turn；Approval Step 持久等待授权主体批准、拒绝或取消，不伪装成 Agent Turn。
- **Automation Target Union**：Automation 支持 `Turn(TurnLaunchSpec)` 与 `Workflow(WorkflowVersionRef, input)` 两类目标；Workflow 目标关联持久 Workflow Run 后，Host 重启仅协调原 Workflow Run 并跟随其终态，不重新触发目标（未成功建出 Workflow Run 的遗留触发才按 `Interrupted` 收尾）。

### 2. 声明式 DAG、事件日志与原始文本交接

- **声明式无环图**：通过 `depends_on` 边统一表达顺序与并行执行；发布前强制校验 ID 唯一、依赖与输出引用有效、无环且全部步骤可达。
- **事件溯源权威**：每个 Run 拥有仅追加、单调 sequence 的 Workflow Event Log（`RunStarted`、`StepReady`、`StepStarted`、`StepWaitingApproval`、`StepOutputAccepted`、`StepCompleted`、`StepFailed`、`StepCancelled`、`StepInterrupted`、`StepNeedsReview`、`RunSettled` 等）；`workflow_runs`、`workflow_step_runs` 与 ready queue 均为可重建投影，claim、事件追加与投影更新位于同一事务，Run 严格 first-terminal-wins。
- **核心接口**：Workflow Core 对外暴露简洁一致的用例面（`publish`、`start`、`decide`、`cancel`、`pause`、`resume`、`watch` 及只读查询），供桌面 Studio、Remote Protocol v1、CLI（`workflow validate|publish|run|show|wait|cancel|resume|history`）、Automation 与 `dimo-workflow-mcp` 共享。
- **原始文本步骤输出（ADR-0053）**：Agent Step 的候选输出为已完成 Turn 的最后一条非空 Assistant 原始文本（受输出字节上限保护）；可选输出 Schema 仅作为 Prompt 引导示例，不对候选输出强制执行 JSON 解析或自动修复 Turn。经自动或人工/Controller Agent 完成门接受的原始文本即可被下游 Prompt 引用。
- **零复制子会话事实**：Workflow Event Log 仅记录步骤编排事实与引用，不复制 Prompt 流、工具调用或权限细节；权限与提问直接在子 Conversation 中解决，Run 投影汇总 waiting 状态并链接原请求；Run 取消级联传播至运行中 Steps 与在途 Turns。

### 3. 预算、工作区安全与基于证据的崩溃恢复

- **策略快照与公平调度**：Run 启动时快照最大并发 Step 数、最大调用数、期限、最大输出字节数与取消/失败传播策略（硬限制在桌面与无头端一致执行；token/cost 上限仅在 Agent 提供可信 usage 时生效）。调度复用单一数据目录的 Host 所有者租约与持久 FIFO ready queue。
- **工作区访问策略**：Agent Step 默认采用 `workspace_access: native`（同时支持 `read_only_shared`、`write_serialized` 与 `write_isolated`）。禁止两个可能产生写操作的步骤并发共享同一工作区；`write_isolated` 从检查点创建独立 step worktree，完成后以 diff、Artifact 与检查点交接，绝不自动合并。`read_only` 仅在工具权限实际强制只读时成立，否则按 `mutating_unknown` 处理。
- **保守崩溃恢复**：Host 启动时先协调运行中 Run 再派发就绪 Step：
  - 已完成 Step 仅在 definition version、规范化输入摘要、运行时/工具版本证据、工作区身份与工作区检查点全部匹配时复用；
  - 等待 Approval 的 Step 保持 `waiting`，决策按 `operation_id` 幂等；
  - 崩溃时仍在途的 Agent Step 对应 Turn 按 [ADR-0001](0001-crash-recovery-semantics.md) 转为 `Interrupted`，`mutating_unknown` 步骤进入 `needs_review` 等待用户明确决策（接受现有结果、新 attempt 重试、跳过或取消），绝不自动重发；仅证明 Prompt 尚未提交的 preflight 失败可自动回到 `ready`。

## Considered Options

- **在 Automation 内直接堆叠多步骤字段**：否决。触发调度与 DAG 编排状态机、恢复与可观测需求截然不同。
- **在插件内嵌入独立 JS 引擎与私有 SQLite**：否决。会制造第二套执行事实、权限与恢复体系。
- **Workflow Step 绕过 Conversation 直接调用 Agent Runtime**：否决。丧失统一事件日志、权限审批、多端查看与 Turn 终态语义。

## Consequences

- 每个 Agent 步骤都是可打开、可追问、可取消、可审计的一等 Conversation，所有客户端消费同一 Run 订阅投影。
- 副作用安全优先于激进缓存复用，确保多步骤自动化在崩溃重启与并发执行场景下始终可解释、可控制。
