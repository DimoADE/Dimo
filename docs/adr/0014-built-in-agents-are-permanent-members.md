---
status: accepted
date: 2026-07-28
decision-makers: Dimo maintainers
---

# 内置 Agent 永久保留，其他 Agent 可以移除

20 个内置 Agent（`BuiltInProfileCatalog::bundled()`：Claude Code、Codex、Pi、OpenCode、Grok、Cursor、DeepSeek Harness、Google Antigravity、Cline、OpenClaw、Hermes、CodeBuddy、Kimi Code、Qoder、Kiro CLI、Auggie、TRAE CLI、Command Code、ZCode 与 OMP）永久属于 Dimo Agent 集合，不可从 Agent 导航带移除。

## Decision

- **内置成员不可移除**：用户可禁用任意内置 Agent、清除其 Dimo 配置或按显式操作卸载其本地包（遵循 [ADR-0060](0060-agent-installs-use-user-environment.md) 的用户环境安装边界），但不能将其从 Agent 导航带移除。
- **非内置成员可移除**：官方 ACP Registry Agent 与用户声明 Agent（见 [ADR-0036](0036-user-declared-acp-agents-use-locked-distributions.md)）可由用户从 Dimo 移除。若仍存在于上游 Registry，移除后重新出现在“可添加”列表；若已下架或为用户声明条目，则从本地界面消失。
- **保护历史与在途运行**：移除 Agent 绝不删除其创建的历史 Conversation；历史会话保留 Agent 身份与只读记录，但在该 Agent 重新添加并就绪前不能继续对话。存在活动会话或在途 Turn 时禁止移除，必须先结束相关运行。

## Consequences

- 用户对核心内置生态始终拥有稳定、可发现的入口，无需担心误删后难以找回。
- 移除第三方或自定义 Agent 安全可逆，不造成会话历史丢失或中断正在执行的任务。
