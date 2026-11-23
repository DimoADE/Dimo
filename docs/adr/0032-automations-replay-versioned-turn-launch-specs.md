---
status: accepted
date: 2026-07-29
decision-makers: Dimo maintainers
---

# 自动化重放版本化启动规格并产生真实会话与运行

Automation 不是后台执行任意 shell 的 cron 包装器，而是一份版本化的触发配置，在满足 `manual` 或 `schedule` 条件时启动真实执行：单个 `TurnLaunchSpec`（产生真实 Conversation 与 Turn）或精确发布版本的 Workflow（见 [ADR-0045](0045-workflows-orchestrate-conversation-turns.md)）。

## Decision

### 1. 版本化目标与启动规格

- Automation 在创建时确定不可切换的目标类别（`AutomationTarget`）：
  - **`Turn(TurnLaunchSpec)`**：单次会话自动化，保存结构化 prompt blocks、附件/引用、`AgentKind` 选择意图、mode 与 session config overrides、Skills/Workflow/工具引用、Project/root folder、目标 branch、隔离方式（`worktree_per_run` 或 `shared_in_root`）以及可读 label snapshot。
  - **`Workflow(WorkflowVersionRef, input)`**：绑定不可变的已发布 Workflow 版本与输入，不自动跟随源产物后续编辑。
- 每次执行前按当前可用环境重新解析 Agent、插件与工具安装，并在运行记录中保存实际使用的运行时、插件版本与安装锁证据；延续 [ADR-0029](0029-agent-updates-do-not-permanently-pin-conversations.md) 不永久锁定旧安装的语义。
- `AutomationRun` 仅作为调度、列表与保留策略的索引摘要；真实执行事实归属对应 Conversation 事件日志或 Workflow Run 事件日志。

### 2. 调度、隔离与恢复语义

- **时区与到期认领**：调度器持久化 UTC `next_run_at`，cron 按保存的 IANA timezone 解释；到期认领在同一数据库事务中原子推进 `next_run_at` 并创建 Run，杜绝重复调度。
- **停机追赶与非重叠**：Engine 停机期间错过的多个定时点在恢复后**至多追赶一次**，不逐条补跑。同一 Automation 默认不重叠运行，重叠触发写入 `skipped` Run 而非静默丢弃。
- **默认隔离与副作用边界**：默认采用 `worktree_per_run` 为每次 Run 创建独立 Git worktree；`shared_in_root` 必须显式选择，并取得 per-root 锁、校验目标分支及工作区干净状态。自动化只产出工作结果与 Artifact，绝不自动 merge、push、publish 或 deploy。
- **取消与终态**：手动取消在认领、创建工作区、建立连接与提交执行的每个窗口复检；Run 终态由关联 Turn（Completed / Failed / Cancelled / Interrupted）或关联 Workflow Run 的终态决定。
- **崩溃恢复**：Host 启动时，孤立的 direct-Turn running Run 与对应 Turn 转为 `interrupted`（绝不自动重放，见 [ADR-0001](0001-crash-recovery-semantics.md)）；已关联持久 Workflow Run 的 Automation Run 协调原 Workflow Run 并跟随其终态，不重新触发目标。
- **保留与清理**：terminal Run 及其独立 worktree 默认保留 30 天并受每数据目录 10 GiB 配额约束，按完成时间从旧到新清理（running Run 永不清理，目录计量不跟随符号链接）。

### 3. 单一 Engine 所有权

- 同一数据目录同一时刻只能有一个 Automation Engine 所有者：桌面宿主（Electron 拉起的 `dimo-server --desktop`）与独立无头 `dimo-server` 竞争同一数据库租约；未持有租约的进程可读写配置但不得调度。
- Engine 启动后先完成 Run reconciliation 再认领到期项，并结合事件监听与周期性持久化协调，确保事件丢失不会导致 Run 永久停留在 running。

## Considered Options

- **简单 `cron + prompt + shell` 模型**：否决。无法忠实重放 Composer 结构化意图、Agent 配置、插件引用与工作区隔离。
- **自动化绕过 Conversation 直接调 Agent**：否决。产生不可审计、不可恢复且无法在多端查看的平行执行路径。
- **默认在项目根目录直接运行**：否决。未监督的定时任务应默认隔离，避免污染用户工作树。

## Consequences

- 自动化编辑器复用 Composer blocks、Agent 配置、分支选择、时区/cron 构建与模板起点，与常规会话能力一致。
- 所有定时任务具备完整的版本证据、隔离边界与多端可观测性。
