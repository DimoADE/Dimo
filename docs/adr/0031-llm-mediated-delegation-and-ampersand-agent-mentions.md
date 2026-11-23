---
status: accepted
date: 2026-07-29
decision-makers: Dimo maintainers
---

# 多 Agent 异步委派与 `&Agent` Mention

Dimo 的多 Agent 即席协作采用内置宿主能力的 LLM-mediated 异步委派：父 Agent 通过宿主托管的 `dimo-mcp` 调用委派工具，由 `crates/delegation` Broker 经统一会话控制面（[ADR-0044](0044-conversation-control-plane-and-durable-inputs.md)）创建并管理受控子 Conversation。

## Decision

### 1. 异步委派与派生会话区分

协作空间与委派是 Dimo Host 内置能力（在“设置 → 通用 → 协作空间”开关控制，默认开启），由 `crates/delegation`、`crates/delegation-proto` 与 `crates/dimo-mcp` 提供：

- **一次性委派（`delegate_to_agent`）**：立即返回 `task_id`，异步创建一等子 Conversation（`ConversationRelation(delegation)`），持久化父会话、父工具调用与 delegation ID。子任务为 one-shot，首个 Turn 到达终态即完成；父连接退出时级联取消仍在运行的子任务；Broker 严格执行 first-terminal-wins。
- **状态查询与取消**：`get_delegation_status` 支持批量查询与有界/无限等待；`cancel_delegation` 终止指定子任务。支持并行 fan-out、深度限制、并发与调用上限、期限、结果大小上限与持久化状态回退。
- **持久化派生会话（`create_conversation`）**：不属于一次性委派。它在工作区创建保留的一等 `spawned` Conversation，仅建立导航关系，不级联取消、不套用 first-terminal-wins、不写入委派调用身份；若指定角色（Role），直接使用角色自身的 Agent 与配置。
- **能力驱动注入**：所有支持 MCP 注入的父 Agent（独立引擎或 ACP `mcp_servers`）共用同一注入管线，不按 Agent 名称硬编码成功假象。`ask_user_question`、`check_user_feedback` 与 `get_session_info` 属于独立的官方 `dimo.session-enhance` 插件 MCP，按该插件启用与工具开关单独暴露。

### 2. `&Agent` Mention 语法与语义

- Composer 中 Agent Mention 的独立触发符为 `&`（如 `&Codex`），与 `@` 引用面板（[ADR-0065](0065-composer-at-reference-panel.md)）正交；仅在协作空间开启且当前会话尚未绑定或已在开启后完成投递时出现。
- 编辑器保存结构化 `AgentMention { agent_kind, display_name }`，不依赖显示名模糊匹配；发送时序列化为稳定可读格式，如 `[&Codex](dimo://agent/codex)`。
- `&` 仅在 token 边界触发；普通文本中的 `A&B`、URL 查询参数与代码块不会被自动转换。
- Mention 仅表示用户建议父 Agent 考虑将工作委派给目标 Agent，不是前端直接创建子会话的隐式命令。若父 LLM 未实际调用 `delegate_to_agent`，UI 如实反映，不虚报子任务已启动。

### 3. 安全、生命周期与编排边界

- `dimo-mcp` 与 Broker 通过 UDS / Windows Named Pipe 通信，采用长度前缀帧与消息大小上限。
- 每个父会话使用短期随机 token，绑定父连接与允许的工作目录根；父连接 teardown 时吊销 token 并级联取消在途委派。子任务工作目录不得超出父会话允许的根范围。
- 委派生命周期全部持久化为 SQLite Conversation 事件（ADR-0091），内存状态仅为加速缓存。
- 确定性多步骤编排由独立的 Workflow 领域承担（[ADR-0045](0045-workflows-orchestrate-conversation-turns.md)、ADR-0092），不混入 Delegation API。

## Considered Options

- **前端识别多个 `&Agent` 后直接并发创建子会话**：否决。改变了主 Agent 统筹职责，实质是确定性图编排而非 LLM 委派。
- **使用 `@` 作为 Agent Mention**：否决。`@` 承担文件/项目/会话/提交/指令统一引用面板，`&` 保持语义正交。
- **按不同父 Agent 编写独立委派实现**：否决。所有具备 MCP 能力的 Agent 走同一宿主注入与 Broker 管线。

## Consequences

- LLM-mediated delegation 天然非确定性，产品文案与测试均以真实工具调用发生后的可观测事件为准。
- 一次性委派、派生会话与确定性 Workflow 三者职责边界清晰，共享同一 `ConversationControl` 控制面。
