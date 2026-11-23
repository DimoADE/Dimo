---
status: accepted
date: 2026-07-06
decision-makers: Dimo maintainers
---

# 无工作区会话：可空 `workspace_id` 与专用临时工作目录

Dimo 支持不挂靠任何 Project 或 Workspace 的纯聊天/咨询会话（Workspace-less Conversation，术语见 [CONTEXT.md](../../CONTEXT.md)）。其事件日志、Turn 生命周期、崩溃恢复与中断语义与常规会话完全一致，仅在数据归属和默认工作目录上采用专门约束。

## Decision

### 1. 数据模型：`sessions.workspace_id` 可空

- `sessions.workspace_id` 在数据库与领域模型中建模为可空（`Option<Uuid>`），如实表达“该会话不归属任何工作区”。
- 事件溯源与控制面相关表（events、turns、tool_calls、permissions、timeline rows）均外键到 `sessions(id)`，无需因无工作区而引入第二套存储结构。
- 按 Workspace 归属的查询默认过滤 `workspace_id IS NULL` 的会话；无工作区会话在独立的非项目入口与会话列表中呈现，界面不挂载 Git 与 Worktree 面板。

### 2. Agent 工作目录：每会话专用临时目录

- 无工作区会话的 Agent 文件与终端工具工作目录（`working_dir`）固定为 `~/.dimo/scratch/<conversation_id>/`（首次启动 Turn 时按需创建），并跳过 Git 容器与仓库校验。
- 该目录提供默认受限、可丢弃、可审查的相对根目录，避免把 `$HOME` 暴露给纯聊天会话，同时保留 Agent 工具运行所需的文件系统 CWD。
- 该目录仅约束默认工作目录，并非 OS 级安全沙箱（Agent 仍可能通过绝对路径访问本机其它位置）；因此无工作区会话定性为能力受限的轻量模式，MCP 文件根同样受此目录范围约束。

## Considered Options

- **Sentinel 占位 Workspace**：否决。保留 `NOT NULL` 并创建伪造的 project / task / branch 会把假对象泄漏进所有按 Workspace 查询与 UI 分支。
- **使用 `$HOME` 作为工作目录**：否决。把整个用户家目录直接暴露给纯聊天 Agent 存在明显误操作与安全风险。
- **完全不提供 `working_dir` 或彻底禁用全部工具**：否决。Agent 运行链路依赖有效的文件系统 CWD，且完全禁用工具会削弱实用性。

## Consequences

- 常规会话与无工作区会话共享同一 `ConversationControl`、SQLite 事件日志、投影与恢复路径，无双轨分叉。
- 无工作区会话可自由清理其对应的 `~/.dimo/scratch/<conversation_id>/` 目录，不影响任何用户代码仓库。
