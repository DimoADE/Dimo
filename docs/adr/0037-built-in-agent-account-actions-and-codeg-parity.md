---
status: accepted
date: 2026-08-05
decision-makers: Dimo maintainers
---

# Built-in Agent 白名单账号动作、原生配置与生态管理

Built-in Agent Profile（20 个内置 Agent，见 [ADR-0014](0014-built-in-agents-are-permanent-members.md)）在遵循统一安装与会话管线（[ADR-0020](0020-built-in-agents-share-the-universal-pipeline.md)）和用户环境安装模型（[ADR-0060](0060-agent-installs-use-user-environment.md)）的前提下，通过编译期声明的白名单动作、结构化原生配置、只读历史导入以及原生 MCP/Skills 适配器提供完整的生态管理能力。

## Decision

### 1. 编译期白名单账号动作与凭据隔离

- 用户在“设置 → Agent”显式点击后，Dimo 仅可执行两类编译期声明的档案动作：（1）在可见终端启动官方 CLI 程序与固定参数；（2）在系统浏览器打开官方订阅或账号 URL。交互式认证绝不在安装或后台探测中自动触发（[ADR-0012](0012-agent-installation-and-authentication-are-separate.md)）。
- 动作请求仅携带 `(agent_id, action_id)`；后端必须从 Built-in Agent Profile 重新解析完整命令、参数与 URL，并从当前安装锁或用户 `PATH` 解析官方可执行文件。用户声明 Agent、Registry 元数据、配置文件与前端均不可提供或覆盖命令、参数、URL 或 shell 片段；未知动作 fail-closed。
- CLI 的 OAuth、设备码与注销交互由官方程序持有，Dimo 不截获 stdin/stdout 或写入诊断日志。Codex 例外提供设置页内官方 device-auth 流程：前端仅接收短期设备码、验证 URL 与状态，access/id/refresh token 仅在 Rust 后端交换并直接写入官方 `auth.json`，绝不经过 IPC、日志或数据库。
- 敏感原生配置文件预览由后端执行结构化脱敏：保留完整键名与嵌套结构、将全部值替换为固定掩码（无法无歧义解析时返回空内容）；前端默认模糊并在悬停/聚焦时解除模糊，原始凭据永不进入前端 DOM 或状态。

### 2. 结构化原生配置与 Model Provider 预设

- **按 Agent 适配原生配置**：对已适配的内置 Agent 提供结构化配置编辑，保存时保留文档中未知键并避免回显 API Key（留空更新保留已有凭据）：
  - **Codex**：简单审批策略与细粒度开关互斥保存；支持基于官方 bundled catalog 创建自定义模型与 sidecar，并识别外部 `model_catalog_json`（8 MiB 上限内只读解析，不擅自改写外部文件）。
  - **OpenCode**：结构化读写 `auth.json` 与 `opencode.json` 中的 Provider 凭据、SDK 包、端点与模型映射，支持 `enabled_providers`/`disabled_providers`；Provider 目录优先读取 `models.dev/api.json`（24 小时缓存 + 随应用内置快照回退）；插件管理仅安装已声明包并保护 `@opencode-ai/*` 保留包。
  - **Kimi Code**：API 模式下若无真实凭据则仅写入固定本地门禁标记（不覆盖真实凭据，切回订阅登录时仅移除自身标记）；模型列表可探测当前草稿端点的 `/models`（API Key 仅用于当次请求不入缓存）。
  - **Pi**：支持内置与动态自定义 Provider 写入 `auth.json`/`models.json`；支持在 `PATH` 与经验证的自定义可执行文件间切换，并按规范化路径增量维护 `trust.json`（不覆盖既有 `false`/`null` 或不可解析文件，`PI_ACP_TRUST_WORKSPACE=0` 仅作宿主策略变量不透传子进程）。
  - **Grok / Cursor / Hermes / OpenClaw**：Grok 与 Cursor 强制执行订阅/密钥模式隔离（订阅模式清除继承环境中的冲突 API Key，Cursor 不透传不支持的自定义 Base URL）；Hermes 仅展示当前 Provider 相关字段；配置保存后同步转换为对应 CLI 启动参数而不篡改静态安装锁。
- **Model Provider 预设**：支持将本地预设投影至适配 Agent 的官方原生配置（首次绑定前精确备份受管字段，解绑时无损恢复并保留期间新增的其它原生字段；含凭据与备份的预设文件在 Unix 上以 `0600` 原子写入，仍被绑定的预设不可删除）。任何原生配置、catalog、鉴权模式或 Provider 变更均向该 Agent 存活会话发送 `config-stale` 事件提示重启生效。

### 3. 预检查依赖、附加环境变量与有序日志

- 预检查除 Runtime/引擎与握手外，按档案逐项检查 Node.js、npm、uv、Python、鉴权模式凭据及 OpenCode 声明插件；缺少必需依赖进入需修复，缺少所选模式凭据进入待认证。Hermes 优先使用 `PATH` 中的 `uv`，缺失时按平台固定 SHA-256 下载校验并由 `uv` 在私有目录管理 Python 3.13。
- 每个 Agent 提供独立附加环境变量编辑器，后端校验变量名、大小与条数，凭据类变量脱敏返回、空值保留旧值，读写采用修订号 compare-and-set 防覆盖，变更触发 `config-stale`。
- 安装/更新/修复通过统一有序流推送最近 200 行脱敏日志，取消操作立即终止子进程；只读环境诊断仅输出安全白名单环境项与依赖解析结果，不遍历输出任意环境变量。受支持的非 `uvx` 内置 Agent 允许显式请求匹配 `[0-9A-Za-z.+-]` 的具体点分版本（仅替换 Runtime，保持适配器锁定）。

### 4. 只读历史导入、全局 MCP 与 Skills 管理

- 内置 Agent 声明只读官方历史源（SQLite、事件流、JSON/JSONL 等），导入时保留结构化 reasoning、tool call/result 与可用模型/Token/费用元数据，绝不修改外部文件；会话创建页合并展示本地历史与远端会话列表。
- 全局 MCP 管理按各 Agent 原生存储适配精确增删目标（跳过不支持原生 MCP 或拒绝透传的目标，Codex 拒绝 SSE），市场支持官方 Registry 与 Smithery 并保留已有的隐藏/退役目标，输入密钥不入日志。
- Skills 管理遵循各 CLI 原生目录语义（全局/项目作用域），共享物理目录按规范化路径合并写入，防止未选中适配器反向删掉另一适配器仍需的文件；用户声明 Agent 必须显式声明共享 `~/.agents/skills` 或绝对专属目录，否则一律 fail-closed。

## Consequences

- 内置 Agent 获得安全、可恢复的登录、供应商配置、MCP、Skills 与历史导入体验，同时严守编译期白名单与凭据不出 Rust 后端的安全底线。
- 任意自定义脚本、动态 URL 或非白名单本地命令执行仍被禁止，如需开放必须另行建立独立签名与审计模型。
