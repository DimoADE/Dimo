# Dimo 插件使用指南

本文对应 Dimo `v0.5.2`（Electron 桌面应用 + `dimo-server --desktop` 以及独立 `dimo-server`）的插件产品行为，遵循 [ADR-0048](../adr/0048-full-trust-plugin-execution-model.md)、[ADR-0066](../adr/0066-plugin-marketplace-authoring-and-session-honesty.md) 与 [ADR-0069](../adr/0069-everything-is-a-plugin-platform.md)。

## 插件是什么

Dimo 插件是一份可独立安装、启停、配置和更新的产品功能包。在目录列表里，每个插件展示名称、一句话简介（来自根 `README.md` 的 `summary`）、发布者、版本与启停开关；点进详情页，只有「内容」和「配置」两个主 Tab。

插件内部可以同时组合 Skill、MCP、Workflow、文件预览/编辑页、Dockview 面板、状态栏/命令或后台 Worker，但产品界面不把单个插件拆分为「平台扩展」与「Agent 扩展」。各插件彼此完全独立，不存在插件依赖插件的关系。

会话日志、Agent 进程、工作区隔离与窗口布局由 Dimo Host 统一维护；插件通过公开贡献点挂接能力，不替代 Host 核心状态机。

## 管理入口

- **产品插件目录**：打开 `/plugins`（或「设置 → 插件」），包含「已安装」和「插件市场」两个 Tab。点击任意插件进入 `/plugins/:pluginId`，在「内容」Tab 浏览文档与资源，在「配置」Tab 编辑插件根 `config.json`。
- **远程 Host**：在远程桌面客户端或浏览器 WebUI 中操作插件，作用于当前连接的远端 Host 环境，不会在本机重复安装或执行。
- **Agent 原生插件**：Codex、Claude Code 等 Agent 自有的原生插件位于「设置 → Agent → 对应 Agent」底部独立管理，与 Dimo 产品插件分离。

## 信任模型与生效规则

### Full Trust 执行模型

Dimo 插件采用 Full Trust 模型（[ADR-0048](../adr/0048-full-trust-plugin-execution-model.md)）：

> 安装后该插件以你的本机用户权限运行，不是沙箱。

安装插件前，界面会展示发布者身份、来源与 Full Trust 确认弹窗；不存在逐能力权限弹窗或二次授权。

### 默认启用策略

- **插件市场与设置页面安装**：确认 Full Trust 后立即安装并启用。
- **能力等价官方插件（Capability-Parity）**：按当前 Host 版本的固化白名单自动安装并默认启用（如内置浏览器、AI 代码补全、语音输入、提示词增强、看板视图、工作区笔记等）；用户可随时禁用或卸载。
- **CLI 安装（`dimo plugin add --web` / `--profile`）**：写入 Host catalog 后默认保持禁用，确认后通过 `dimo plugin enable <插件ID>` 或界面开关启用。

### 生效双轨（Dual Activation）

- **UI 与 Provider 贡献**（面板、文件预览/编辑、命令、状态栏、主题、设置页、Provider 接缝等）：启用后立即从当前激活代生效，禁用时原子撤下。
- **Agent 贡献**（Skill、MCP）：向兼容 Agent 投影后，在**新开或重新绑定的会话**中生效；已在运行中的 STDIO 会话不会热插或热拆工具。

## 安装插件

### 1. 从插件市场安装

在 `/plugins` 切换到「插件市场」Tab：

- 顶部置顶官方分类（`dimo-plugin.json` 登记的官方包），下方展示社区已发布条目；搜索覆盖全部已发布条目。
- 点击安装后弹出身份、摘要与 Full Trust 确认弹窗，取消则不写入 catalog。
- 离线环境下官方分类仍可使用发行包附带的快照缓存完成安装。

### 2. 导入本地 `.vxp` 包

在桌面应用或具备 `plugin.write` 能力的客户端中，可在 `/plugins` 点击「添加插件」或直接将 `.vxp` 文件拖入页面。Host 校验 `.dimo-plugin/plugin.json` 与包完整性后完成安装并启用。

若同 ID 插件已存在，界面会提示保留当前源或替换；同一产品身份（Publisher + Plugin ID）在单个 Host 上只能挂接一份来源。

### 3. 通过 `dimo plugin` CLI 安装与管理

本机运行桌面应用或 `dimo-server` 时，`dimo plugin` 直接对接同一 Host 控制面；Host 未运行时，导入请求暂存到 `~/.dimo/imports`（开发链接记录在 `~/.dimo/imports/links.jsonl`），待 Host 启动后导入。

```bash
# 从 GitHub / Git 仓库安装（建议用 #tag / #commit 钉住版本）
dimo plugin add --web https://github.com/DimoADE/Dimo-plugin-office#v2.0.0 -y
dimo plugin add --web github:DimoADE/Dimo-plugin-office#v2.0.0 -y

# 从本地 .vxp / .zip 安装
dimo plugin add --profile ~/plugins/my-plugin.vxp

# 链接本地开发目录（立即返回；如需监听与热更新请运行 dimo plugin run dev）
dimo plugin add --dev ./my-plugin

# 查看、启停、更新、卸载与清理未引用运行时
dimo plugin list
dimo plugin enable acme.search
dimo plugin disable acme.search
dimo plugin update acme.search --ref v1.3.0 --yes
dimo plugin remove acme.search
dimo plugin remove acme.search --delete-data
dimo plugin gc-runtimes
```

## 更新与回滚

- **自动检测与手动检查**：Host 启动约 30 秒后检查一次更新，此后每 6 小时检查一次；状态栏会提示可更新数量，也可在 `/plugins` 手动点击「检查更新」。网络异常时显示错误并保留上次观察结果，不会误报为已是最新。
- **来源锁（Source Lock）**：市场安装的包从市场检测更新，GitHub 安装的包从对应仓库检测稳定 Release / semver tag（不自动跟随分支或任意 commit）；开发链接和无远端来源的本地包不参与自动检测。
- **预览确认与原子切换**：点击「可更新」后，Host 先下载并校验候选包，展示身份、版本、摘要与变更信息；确认有效期为 10 分钟（期间修改配置或启停状态需重新预览）。
- **配置保留与失败回退**：更新默认保留用户的 `config.json`、启用状态与既有 Agent 绑定；若新版本 Schema 拒绝当前配置或候选代启动失败，Host 拒绝切换并完整保留上一激活代。可在详情页执行「恢复上一版」回滚到已保留的上一个可验证版本。

```bash
dimo plugin update acme.search
dimo plugin update acme.search --ref v1.3.0 --yes
```

## 启用、配置与日常使用

启用插件时：

- Host 会自动解析、下载、校验并探测插件声明的本地 Runtime（例如 Dimo Office 所需的 `officecli`）；Runtime 就绪后原子发布新的激活代。
- 带有 Skill 或 MCP 的插件在首次启用时默认向当前及后续兼容 Agent 建立绑定意图，可在「设置 → MCP」或对应 Agent 设置中精细调整。
- 在插件详情页的「内容」Tab 可查看完整 README 与经过校验的 `contents/` 资源；「配置」Tab 依据 `config.schema` 渲染表单并原子写回根 `config.json`。

常见官方插件使用示例（完整列表见 [官方插件全景](official-plugins.md)）：

- **Dimo Office**：直接点击工作区 `.docx` / `.xlsx` / `.pptx` 打开实时预览，或在对话中使用 Office Skills / Workflows 创建与修改文档。
- **会话增强**：启用后，新开或重绑定的会话可使用结构化提问、实时反馈、跨会话只读查询与子会话控制；配置页提供四个独立开关。
- **Workflow Creator**：打开 `*.dimo-workflow.json` 进入 Workflow Studio 可视化编排器，并在新会话中使用 `dimo-workflow-mcp` 校验、发布与断点调试工作流。
- **插件开发**：向兼容 Agent 投影 `dimo-plugin-development` 与 `dimo-plugin-creator` Skill，配合 `dimo-plugin` CLI 完成插件脚手架、校验与调试。
- **内置协作空间**：协作空间与 `&Agent` 委派属于 Dimo Host 内置能力（「设置 → 常规 → 协作空间」，默认开启），无需安装插件。

## 禁用与卸载

- **禁用**：关闭插件开关后，Host 按反序原子拆除当前激活代——停止后台服务与 Worker、撤回 UI / Provider 贡献，并从后续新会话的 Skill / MCP 清单中移除。禁用不会删除安装包或 `config.json`。
- **卸载**：在详情页点击「卸载」，或执行 `dimo plugin remove <插件ID>`。卸载会移除 catalog 记录、Agent 绑定与 Skill 投影；默认保留用户的 `config.json`，传入 `--delete-data`（或在 UI 勾选清理数据）才会一并清除 Host 管理的插件数据。已生成的 Artifact、会话与自动化历史不受影响。
- **开发链接目录**：卸载链接开发插件只移除 Dimo 侧登记，绝不删除你的本地源码目录。

## 常见问题排查

- **启用带 MCP 的插件后，当前会话没有出现新工具**：Agent 侧 MCP / Skill 遵循新会话生效原则；结束当前会话或重新绑定 Agent 后新建会话即可使用。
- **文档预览（如 Office）无法打开**：在插件详情页的「运行状况」区域或执行 `dimo-plugin doctor` 检查声明的本地 Runtime 是否已完成锁定与探测（Office 预览进程默认空闲 10 分钟后自动回收，下次打开会按需重启）。
- **安装同 ID 插件提示冲突**：同一 Host 上单个插件 ID 只能绑定一份来源，按提示选择保留现有源或替换。
- **远程客户端修改插件未影响本机**：所有插件安装、启停与配置均作用在当前窗口绑定的远程 Host 上，不影响本机实例。
