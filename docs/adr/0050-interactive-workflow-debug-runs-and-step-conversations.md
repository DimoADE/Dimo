---
status: accepted
date: 2026-08-14
decision-makers: Dimo maintainers
---

# 交互式 Workflow 调试运行与步骤会话

## Context

[ADR-0045](0045-workflows-orchestrate-conversation-turns.md) 将 Agent step 映射为真实 Child Conversation 与 Turn。为支持用户在步骤节点内持续对话、冻结下游、单独测试单节点，或在运行到下游步骤后修改上游配置并复用既有证据，Workflow 执行引擎需要区分 Turn 完成与 Step 完成，并为并行 DAG 提供交互式调试、暂停恢复与派生运行语义。

## Decision

1. **步骤持久会话**：每个 Agent step 拥有一个持久 Child Conversation，并可包含多个不可变 Turn。初始 Prompt 自动发送；用户或 Controller Agent 可执行 Steering、取消当前 Turn、发送后续输入并查看完整证据。
2. **取消语义**：取消 Turn 使该 Turn 到达 `Cancelled`。继续对话创建新 Turn，不宣称恢复已终止的生成过程。
3. **原始文本候选与接受门（ADR-0053）**：已完成的 Turn 提出其最后一条非空 Assistant 原始文本作为 Candidate step output；输出 Schema 仅作为 Prompt 示例，不对候选做 JSON 解析或 Schema 校验。经 `automatic` 或 `manual` 完成策略接受后的候选成为 Accepted step output，下游步骤只读取 accepted output。
4. **完成策略**：Agent step 支持 `automatic` 与 `manual` completion policy。`manual` step 在候选产生后进入 `awaiting_acceptance`；Human 或与 worker 分离的 Controller Agent 可继续对话或接受候选。Worker Agent 默认不能自我批准。
5. **定义门与调试断点分离**：Workflow definition 中的 Completion gate 是持久语义；Debug breakpoint 是单次 Debug run 的临时覆盖，两者独立建模，断点不修改或发布 definition。
6. **运行暂停与终止**：Workflow run 包含 `pausing` 与 `paused` 非终态。暂停先关闭新步骤 claim，再取消全部在途 Turn；已发生的文件或外部副作用不回滚。终止（cancel）仍是独立、不可恢复的终态操作。
7. **恢复与派生**：未修改 definition、input 与 checkpoint 时，恢复原 Run、原 Step attempt 与原 Child Conversation，并创建新 Turn。配置变化必须发布新 version 并创建 Derived workflow run。
8. **统一 Debug run**：Debug run 统一承载「测试此节点」与「从此节点重新运行」：前者仅执行选中步骤，后者继续传递下游，两者共享隔离、Conversation、事件与审计语义。
9. **派生运行复用约束**：Derived run 保留 parent relationship，仅复用 definition、input、output contract 与 Workspace checkpoint 均可证明一致的上游 Accepted output；原 Run 永远保持只读。
10. **调试隔离与副作用确认**：Preview/Debug 默认使用隔离 worktree。外部发布、部署或消息等副作用需要幂等证据、补偿策略或当次显式确认。
11. **事件溯源与订阅契约**：Run、step、candidate、approval、pause、resume、fork 与 Conversation relationship 全部写入持久事件日志。Workflow subscription 使用 `snapshot → replay → high-water → live` 契约，不以客户端轮询状态作为运行事实。

## Consequences

- Dispatcher 严格区分「Turn completed」与「Step completed」，仅在候选被完成策略接受后推进下游。
- UI 顶部区分「暂停运行」与「终止运行」；节点会话中区分 Steering、停止 Turn 与停止 Step。
- 并行节点在全局 `paused` 状态仍可分别继续节点对话，但 scheduler 保持关闭，直到恢复运行。
- 历史 attempts 归档在节点详情中；DAG 进度按 definition step 数量与每个 step 的最新 attempt 计算。

## Considered Options

- **覆盖原 Run 的下游步骤**：否决。破坏审计、复现与副作用证据。
- **真正暂停并恢复同一个 Turn**：否决。多 Agent Runtime 不提供一致的生成进程快照能力，且违背 Turn 终态不变量。
- **所有节点默认人工确认**：否决。导致无人值守 Automation 无法运行。
