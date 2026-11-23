---
status: accepted
date: 2026-08-17
decision-makers: Dimo maintainers
---

# 会话辅助能力以协议事实为准，不猜测、不填零、不静默覆盖

## Context

Composer 与时间线周围的辅助能力（用量、计划、目标、压缩、草稿、会话内查找、会话配置与人格投影）直接影响用户对会话状态的判断。若将上下文占用冒充输入 token、用正则从助手自由文本反推目标或压缩状态、用 last-write-wins 静默覆盖草稿，或在快照缺失时捏造默认配置，读模型就会与真实协议事实分叉。本决定确立会话辅助能力的诚实性不变量，适用于所有客户端表面。

## Decision Drivers

1. 未知不等于零，也不等于成功。
2. 状态只来自用户显式命令、Turn 终态、持久化快照或 Agent 结构化字段。
3. 草稿冲突必须同时保留服务器版本与本机版本。

## Decision

### 1. 用量区分窗口占用与分项 token

上下文占用（`context_used` / `context_window_max`）与分项 token（`input_tokens`、`output_tokens`、`cache_*`）严格区分存储与展示。分项 token 仅在 Agent 引擎或协议明确提供结构化分项数据时写入；未提供时保持缺失，UI 不得以 0 冒充分项事实。Composer 用量环优先使用 `context_used`（缺失时仅在存在真实分项时求和）与 `context_window_max`；缺少窗口大小时隐藏比值。

### 2. Plan 按结构化条目整体替换

`AgentPlan` 完整保存每条计划项的 `content`、`status` 与 `priority`。同一回合收到计划更新时，投影以最新 Plan 块整体替换而非追加重复块；Composer 待办读取最新 Plan 块。

### 3. Codex Goal 仅响应用户 `/goal` 命令

`/goal <objective>` 设置目标，`pause` / `resume` / `complete` / `clear` 变更状态。宿主永不从助手自由文本通过正则猜测 Goal 状态；所有可见文案走 i18n。

### 4. Compact 由用户命令与 Turn 终态决定

用户消息以 `/compact` 开头即标记该回合为压缩回合。压缩状态严格取该 Turn 的生命周期相位：在途为 `running`，`Failed` / `Cancelled` / `Interrupted` 为 `failed`，`Completed` 为 `success`；禁止匹配本地化助手文本。

### 5. Composer 草稿使用单调 revision 冲突检测

`scratch` 维护单调 `revision`。每次保存必须携带 `expected_revision`（新建草稿为 0）。发生并发冲突时服务端返回最新草稿，前端同时保留本机未保存内容，由用户显式选择保留服务器版本或本机版本；仅在提交成功且 revision 仍匹配时清除草稿。

### 6. 会话内查找基于当前时间线可见文本

Conversation 面板的查找能力覆盖当前投影中的用户/助手文本、thinking 与 Plan 条目。它不是第二套 FTS；全局 FTS 仍刻意排除 thinking 与工具 I/O。

### 7. 会话配置与人格投影只认持久化快照

- 会话列表与 Composer 展示的会话配置仅来自已持久化的快照；快照缺失时保持缺失，不得从角色模板、委派默认值或界面文案补齐 `mode` 或配置项。
- 会话人格投影（Conversation persona）是创建当时的不可变快照；后续编辑角色或 bot 配置不得回写已有会话。人设不出现在 Composer 一级菜单中。
- 失效的会话默认值通过 `SessionConfigStale` 通知诚实呈现，不得假装已生效。

### 8. 明确边界

- **无工作区会话**：由 [ADR-0006](0006-workspace-less-conversation.md) 独立约束。
- **自动标题**：仅接受 Agent 返回的 `SessionInfo.title` 回填未锁定标题，不另起独立 LLM 起名。
- **`&Agent` 提及**：遵循 [ADR-0031](0031-llm-mediated-delegation-and-ampersand-agent-mentions.md)，仅作为委派建议而非强制前端创建子会话。
- **导出与 Review 评论**：保持 Markdown/HTML/bundle 导出与发送前预置 Review 评论语义；未知/较新事件保持降级显示。

## Consequences

- 用量、计划、目标、压缩、草稿冲突与会话配置均具备单一事实来源，避免多端或换语言时的状态误报。
- 助手回复中出现「Goal completed」或类似自然语言表述不会改变 Goal 指示器状态。
- 缺失数据在 UI 上保持诚实留白或「未提供」，为 [ADR-0074](0074-turn-failure-taxonomy-and-recovery-visibility.md) 与 [ADR-0075](0075-usage-accounting-from-conversation-events.md) 提供统一前提。
