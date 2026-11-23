# Dimo 官方插件全景

遵循 [ADR-0069（一切皆插件）](../adr/0069-everything-is-a-plugin-platform.md)，Dimo 的 **15 个官方插件**源码全部位于仓库 [`plugins/`](../../plugins/) 目录，与第三方插件共享完全相同的公开 `@dimoai/plugin-sdk`（v2.0.0）、Package v4 清单规范与 **23 类贡献点**（实时绑定清单见 [`contract-bindings.md`](contract-bindings.md)，CI 通过 `pnpm run plugin:no-privilege` 强校验宿主零官方插件 ID 特判）。

## 分发与生效规则

- **官方市场与仓库登记**：仓库根 [`dimo-plugin.json`](../../dimo-plugin.json) 登记了通过 [官方插件市场](https://dimo-ai.com/marketplace/) 与独立 GitHub Release 分发的核心官方包；Host 优先从市场拉取，离线时回退至发行包快照缓存，并支持本地 `.vxp` 导入或 `dimo plugin add --dev` 链接源码目录。
- **能力等价官方插件（Capability-Parity）**：面向高频工作台体验的等价官方插件按当前 Host 版本的固化白名单自动安装并默认启用，用户可随时禁用或卸载。
- **生效双轨（Dual Activation）**：UI 面板、主题、右键菜单与 Provider 接缝**启用立即生效、禁用原子撤下**；向 Agent 注入的 **Skill 与 MCP 仅对启用后新开或重新绑定的会话生效**。
- **单层独立**：15 个官方插件彼此完全独立，不存在插件依赖插件；关闭任一插件按反序回收其当前激活代（Activation Generation）。

---

## 一、核心官方插件（`dimo-plugin.json` 官方市场分类）

### 1. 内置浏览器（`dimo.browser`）

- **源码**：[`plugins/browser`](../../plugins/browser)
- **定位**：带持久化 Cookie Profile、页面元素移交（DOM Handoff）与可选 Agent 自动化工具的工作台内置浏览器。
- **核心能力**：
  - 在 Dockview / 空间画布内打开多实例持久化登录态网页或本地开发预览，支持 `app.panel`、`app.rail.section` 与独立 `app.settings.page`；
  - 点选页面 DOM 元素，将组件层级、选择器、Computed CSS 与局部截图直接注入会话输入框；
  - 按需向新开 Agent 会话注入受控页面读取与交互 MCP 工具（支持按 Origin 记住分享级别与 JS 执行审批）。

### 2. Dimo Office（`dimo.office`）

- **源码**：[`plugins/office`](../../plugins/office)
- **定位**：在 Dimo 中创建、编辑、分析和实时预览 `DOCX`、`XLSX` 与 `PPTX` 文件。
- **核心能力**：
  - **只读实时预览**：`file.opener` + `artifact.preview` 接管 `.docx` / `.xlsx` / `.pptx`，通过锁定校验的本地 `officecli` 拉起最多 4 路并发预览租约（默认空闲超时 10 分钟）；
  - **10 项专业 Skill + 6 条 Composer Workflow**：包含 `pptx`、`word`、`excel`、`morph-ppt`、`morph-ppt-3d`、`pitch-deck`、`academic-paper`、`data-dashboard`、`financial-model`、`word-form` 与 6 条文档/演示/表格工作流，调用受锁定的 `officecli` 原地增量编辑文档并保留公式与版式。

### 3. 电脑控制（`dimo-plugin-computer-use`）

- **源码**：[`plugins/computer-use`](../../plugins/computer-use)
- **定位**：桌面窗口与应用的感知和自动化控制，覆盖无障碍树、截图、键鼠输入、窗口级授权与全局紧急停止。
- **核心能力**：
  - 提供独立设置页（`app.settings.page`）与状态栏快捷入口（`status.after-mcp`），支持按单窗口、单应用或全屏粒度授权并区分「仅查看」与「允许控制」；
  - 启用后向新会话注入 Computer-Use MCP 与 Skill；内置全局紧急停止（Kill Switch），可瞬间撤销全部授权并中断执行动作。

### 4. Dimo Workflow Creator（`dimo.workflow-creator`）

- **源码**：[`plugins/workflow-creator`](../../plugins/workflow-creator)
- **定位**：从 Agent 对话与可视化编辑页中设计、检查、调试并安全改写 `*.dimo-workflow.json` DAG 工作流。
- **核心能力**：
  - 通过 `file.opener` + `app.surface(slot: artifact.editor)` 打开 `*.dimo-workflow.json` 进入 **Workflow Studio** 可视化编排器，按修订号保存防盲覆盖，显式 `publish` 生成不可变版本；
  - 投影 `dimo-workflow-creator` Skill，并配合宿主家族 [`dimo-workflow-mcp`](../../packages/dimo-workflow-mcp/README.md) 向 Agent 暴露完整的读写、校验、发布、断点调试、暂停恢复与候选输出接受工具。

### 5. 会话增强（`dimo.session-enhance`）

- **源码**：[`plugins/session-enhance`](../../plugins/session-enhance)
- **定位**：向 Agent 会话提供结构化提问、实时中途纠偏、跨会话只读查询与子会话控制。
- **核心能力**：配置页提供 4 个独立开关（默认全开），映射宿主 `dimo-mcp` 对应工具：
  - `question` → `ask_user_question`（遇到关键分歧时弹出多选卡片等待用户决策）；
  - `feedback` → `check_user_feedback`（阶段性拉取用户的实时备注纠偏）；
  - `sessionInfo` → `get_session_info`（解析 `@会话` 引用并只读查询上下文）；
  - `sessionControl` → `send_session_input` / `cancel_session_turn` / `wait_for_session`（在同工作区会话与子会话范围内编排输入与等待）。

### 6. AI 代码补全（`dimo.code-completion`）

- **源码**：[`plugins/code-completion`](../../plugins/code-completion)
- **定位**：Monaco 编辑器内联 Ghost Text / FIM 代码补全，支持 OpenAI Chat Completions、OpenAI FIM 与 Anthropic Messages 协议，提供自动防抖/快捷键触发、文件忽略规则与状态栏快捷开关。

### 7. AI 语音输入（`dimo.voice-input`）

- **源码**：[`plugins/voice-input`](../../plugins/voice-input)
- **定位**：面向会话输入框与全局快捷键（默认 `Alt+V`）的实时流式语音听写，支持 Hybrid / Whisper / Groq / 多模态音频识别与浏览器语音引擎、自定义技术术语热词表、实时字幕悬浮胶囊与听写后智能去口水词润色。

### 8. Remote SSH（`dimo.remote-ssh`）

- **源码**：[`plugins/remote-ssh`](../../plugins/remote-ssh)
- **定位**：注册 `provider.remote.provisioner`（`provisionKind: "ssh"`，见 [ADR-0070](../adr/0070-ssh-provisioned-remote-server.md)），通过本机系统 SSH（密钥 / `ssh-agent` / 可选密码，不拷贝私钥）探测远端架构、安装并启动 `dimo-server`、建立隧道并完成一键配对。

### 9. 科学研究（`dimo.science`）

- **源码**：[`plugins/science`](../../plugins/science)
- **定位**：经过许可证审计的 **146 项科研技能**，按 10 个学科领域分组开关（默认仅启用 `general` 通用科研方法 13 项，其余 `literature`、`writing`、`stats`、`infra`、`singlecell`、`genomics`、`chemistry`、`medicine`、`physics` 在配置页按需勾选投影）。

### 10. 插件开发（`dimo.plugin-development`）

- **源码**：[`plugins/plugin-development`](../../plugins/plugin-development)
- **定位**：向 Codex、Claude Code 及通用 ACP Agent 投影 `dimo-plugin-development` 与 `dimo-plugin-creator` Skill，指导 Agent 直接调用本机 `dimo-plugin` CLI 与 `@dimoai/plugin-sdk` 完成插件初始化、校验、测试、构建与 `--dev` 链接。

---

## 二、工作台与体验扩展插件（`plugins/*`）

| 插件 ID | 源码目录 | 核心作用 |
| --- | --- | --- |
| `dimo.prompt-enhancer` | [`plugins/prompt-enhancer`](../../plugins/prompt-enhancer) | Composer 提示词优化器（提供 `/enhance` 斜杠、`@enhance` 动作与可选 `beforeTurn` 自动增强），结合仓库上下文补齐验收标准与边界条件。 |
| `dimo.kanban-views` | [`plugins/kanban-views`](../../plugins/kanban-views) | 任务看板多维视图扩展（Triage Matrix、Sprint Velocity、Event Pulse Deck）与看板筛选命令。 |
| `dimo.notes` | [`plugins/notes`](../../plugins/notes) | 工作区随手记（Workspace Notes 侧栏面板）、快捷新建笔记、Markdown 导出与会话摘录。 |
| `dimo.tauri-ui-debugger` | [`plugins/tauri-ui-debugger`](../../plugins/tauri-ui-debugger) | 开发构建专用的前端 UI 元素调试器（当前目录与插件 ID 为 `plugins/tauri-ui-debugger` / `dimo.tauri-ui-debugger`），在开发模式下悬浮点选 Dimo React 界面元素，将源码行列、组件链与关键样式作为结构化 token 插入会话输入框。 |
| `dimo.ayu-theme` | [`plugins/ayu-theme`](../../plugins/ayu-theme) | 为窗口壳层、代码编辑器、终端与语法高亮提供 Ayu Light、Ayu Mirage 与 Ayu Dark 三套声明式主题。 |

---

## 三、宿主内置能力：协作空间（非插件）

**协作空间（Collaboration Space）** 与 `&Agent` 委派属于 **Dimo Host 内置核心能力**（开关位于「设置 → 常规 → 协作空间」，默认开启，无需安装插件）：

- 开启后，新建或重绑定的会话自动获得 `delegate_to_agent` / `create_conversation` 等协同工具，Composer 可通过 `&` 点名已就绪的 Agent；
- 协作空间中的「助手（Bot）」是持久身份（`collaboration_members`），维护一对一私聊隐藏会话（`direct:<member_id>`）与每个群组座位的独立隐藏会话，群聊经共享房间日志与逐收件人投递回执（`DeliveryReceipt`）协同。详细身份与架构见 [`docs/architecture.md#collaboration-member-identity`](../architecture.md#collaboration-member-identity)。
