---
status: accepted
date: 2026-07-29
decision-makers: Dimo maintainers
---

# Agent 更新不让 Conversation 永久锁定旧版本

每个 Turn 记录实际执行时使用的 Agent 引擎/运行时与适配器版本，但 Conversation 本身不永久绑定历史版本；版本升级后的上下文不兼容通过显式 Session Rebind 处理。

## Decision

- **平滑切向当前版本**：Agent 完成更新后，新 Conversation 以及当前无存活 Agent 进程的既有 Conversation 均在下次执行时使用当前版本。正在运行中的进程不被热切换，待其在途 Turn 自然到达终态后再释放旧进程。
- **禁止单会话版本分叉**：若需要回退旧版本，用户以整个 Agent 为粒度执行降级或切换，不为单个 Conversation 维护永久并存的历史版本树。
- **诚实处理恢复失败**：更新后若新版本无法加载或恢复旧的原生/ACP 会话，Dimo 严禁静默宣称恢复成功，也不得自动伪造历史重放。SQLite 中的完整会话历史与绑定代次记录（见 [ADR-0089](0089-conversation-binding-generations-and-history-segments.md) 与 ADR-0091）保持不变。
- **显式 Session Rebind**：仅在用户明确确认后才执行 Session Rebind——使用相同工作目录创建冷启动 Agent 会话，并在时间线写入带新版本信息的显式绑定边界。Dimo 不自动重放旧 Prompt、工具调用、权限响应、终端输出或文件操作，也不在后台隐式生成摘要 Turn。确认界面明确告知用户“可见历史仍在，但 Agent 侧隐藏上下文已断开”，并允许用户在下一次发送前编辑一段上下文交接说明随新消息一同发送。

## Consequences

- Agent 更新后无需为旧会话长期保留多份过时运行时副本，与用户环境安装模型（[ADR-0060](0060-agent-installs-use-user-environment.md)）保持一致。
- 上下文连续性与历史可见性边界清晰，用户始终知晓 Agent 当前掌握的真实上下文。
