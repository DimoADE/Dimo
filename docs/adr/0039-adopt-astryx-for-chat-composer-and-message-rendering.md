---
status: accepted
date: 2026-08-07
decision-makers: Dimo maintainers
---

# 采用 Astryx 组件体系构建会话输入、消息与工具活动渲染

会话输入与消息渲染统一采用 Meta 开源设计系统 Astryx（`@astryxdesign/core`）的 Chat 组件族，取代 Lexical WYSIWYG 与 `react-markdown`，实现“纯文本 + 结构化 Token 徽章”与流式增量渲染的单一前后端模型。

## Decision

### 1. 纯文本 + 结构化 Token 输入体系

- 会话主输入框与所有次级编辑场景（diff 行内评论、评论编辑、重试编辑、审批拒绝原因）统一采用 Astryx `ChatComposerInput`（纯文本 + 结构化 `ChatComposerToken` 徽章），草稿持久化、Markdown 发送格式与后端协议保持一致；图片以附件 chip 形式挂载而非富文本内嵌。
- Composer 触发器遵循 [ADR-0065](0065-composer-at-reference-panel.md)：`@` 负责带 Tab 的统一引用面板（文件、项目、会话、提交、指令），`/`、`$`、`&` 作为独立触发符接入 `SearchSource`；展示侧共用同一套 token 定义通过 `ChatTokenizedText` 或 `Markdown` `inlinePlugins` 渲染。
- `SessionComposerTopbar`、`ConversationStatusDock`、`ActionBar` 与会话配置选择器作为输入框兄弟组件独立演进。

### 2. 流式 Markdown、消息气泡与工具活动聚合

- **流式 Markdown**：统一使用 Astryx `Markdown`（原生 `isStreaming` 增量解析、结构化 token `inlinePlugins`、宿主路径与图片预览适配），KaTeX 数学公式与自研 `MermaidDiagram` 通过 `components.code` 自定义接入。
- **用户消息气泡**：消息流中的用户消息统一使用 `ChatMessage(sender="user")` + `ChatMessageBubble` 搭配受限 Astryx `Markdown` 与 token 内联插件，仅在主题层覆盖明暗配色（亮色 `#F3F3F4`/黑字、暗色 `#242424`/白字）、正文字号与紧凑列表缩进。
- **活动阶段聚合（`TurnActivity` + `ChatToolCalls`）**：
  - 回合内连续工具调用（命令、读取、修改、搜索、网页、计划、资源等）与思考块构成活动阶段，仅正文输出结束当前阶段；进行中阶段最多保留最近 2 项活动（连续思考计 1 项），更早活动合并为单一聚合入口，阶段结束或回合终态后全部收拢。
  - 每个回合至多展示一个过程入口：每产出一份正文，该入口收起其之前的全部过程正文与非正文活动（含运行中、失败、待交互、子智能体与图像）；展开状态按成员持久保存，分组重组不丢失用户已展开的详情。
  - 消息流末尾正在输出的思考默认展开，后续正文、工具调用或终态到达后默认收起；仅含思考的批次与展开后的思考使用独立 `ThinkingEntry`，不套用工具卡片样式。
- **结构化工具详情与状态保真**：
  - `ToolCallResultDetail` 复用各专用详情视图并省略冗余单调用标题：文件编辑呈现同次调用的多处补丁差异（不将片段偏移冒充文件行号）；文件读取保留返回内容与灰底高亮，仅在当前磁盘文件逐行吻合时补充前后 3 行上下文；终端显示完整命令、参数、stdout/stderr 与退出码；Antigravity `view_file` 映射为读取卡片。
  - 严格保留 Agent 明确报告的工具状态，独立于输出是否存在；无输出终态必须呈现，部分输出不得推断为成功。`ToolCardShell` 保留服务独立调用与审批强制展开场景，`PendingApprovalEntry` 保留承载权限与提问交互包装。

### 3. 依赖与上游补丁边界

- 移除 `lexical` / `@lexical/*`、`wysiwyg/`、`react-markdown` / `remark-*` / `rehype-katex` 与未使用的 `cmdk`；既有 shadcn/Radix 封装（含 `ScrollArea`、`Slot` 等）按需保留。
- 仓库以 pnpm patch 为 Astryx `ChatToolCalls` 补齐 `label`、`alwaysGroup` 与受控单项展开状态，由单条聚合、混合分类摘要与重组保留展开状态的回归测试约束；升级 Astryx 版本时核对并移除已上游化补丁。

## Considered Options

- **维持 Lexical WYSIWYG 与 `react-markdown`**：否决。8 个 Lexical 包维护成本高，所见即所得与“Markdown 原文 + 结构化 Token”数据模型存在语义摩擦。
- **完全自研富文本与流式 Markdown 引擎**：否决。重复造轮子并增加 IME 组合、token 光标与流式渲染维护负担。

## Consequences

- 全部编辑与展示场景共享一致的纯文本 + Token 语义，输入状态与后端序列化无额外转换损耗。
- 依赖预编译 ESM + CSS 的 Astryx，无需额外 PostCSS/Babel 构建插件，但升级需关注 Beta API 变动与 pnpm patch 兼容性。
