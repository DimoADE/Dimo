---
status: accepted
date: 2026-10-07
decision-makers: Dimo maintainers
---

# OMP 作为原生 ACP 内置 Agent 接入

## Context

OMP（`@oh-my-pi/pi-coding-agent`）自带原生 stdio ACP server（`omp acp`）。它拥有独立的配置目录、凭据库与运行时依赖，不是 Pi 的第二套适配器，也不经由 `pi-acp` 运行。

## Decision

- **内置身份**：`AgentKind::Omp`（规范串 `"omp"`）为永久内置成员；输入别名 `oh-my-pi` 归一化到同一身份。`registry_id = "omp"` 仅用于将未来同名 Registry 条目绑定到该内置档案，避免重复注册。
- **拓扑与分发**：拓扑为 `NativeAcp`。托管安装锁定 `@oh-my-pi/pi-coding-agent@18.8.0`，启动参数仅为 `acp`，外部检测名为 `omp`。发布物 shebang 依赖 Bun，预检查要求 `bun >= 1.3.14`，Node/npm 仅负责将包写入用户环境。
- **认证与凭据判定**：登录动作为 `omp login`，设置面支持官方订阅与供应商模式（无单一官方 API 端点，因此不展示官方 API Key 输入框；密钥不走环境变量）。活凭据位于 `~/.omp/agent/agent.db` 的 `auth_credentials`，自定义端点 `apiKey` 位于 `models.yml`；空的 `auth.json` 不等同于未登录，存在 OAuth 记为账号登录、仅有 API Key 记为密钥模式，两者皆缺时预检查失败。
- **通用认证解析与登出优先**：账号状态统一经通用的 `resolve_observed_authentication` 解析，`crates/server/src/host/management.rs` 不包含 OMP 特判分支；显式 `omp logout` 优先于 `agent.db` 中残留的 OAuth 行，保证用户登出后准确显示未登录。
- **供应商绑定与原生配置**：绑定供应商时写入 `models.yml` 的 `providers`，并将 `config.yml` 的 `modelRoles.default` 设为 `供应商/模型`，保留其它角色、主题与既有供应商；原生配置同时支持深色主题与自动压缩开关。
- **目录隔离**：启动子进程时将 `PI_CODING_AGENT_DIR` 固定到 Dimo 写入的 OMP 配置目录（默认 `~/.omp/agent`），不继承环境中指向 `~/.pi/agent` 的值，且不向子进程透传 Pi 的 `PI_ACP_*` 环境变量，防止 OMP 与 Pi 配置互相覆盖。
- **MCP、Skills 与原生历史**：
  - MCP：ACP 会话通过 `session/new.mcpServers` 注入生效；设置中分配给 OMP 的 MCP 写入 `~/.omp/agent/mcp.json`（不写入 Pi 目录），并在新建或恢复会话时注入。
  - Skills：写入 `~/.omp/agent/skills`（受 `PI_CODING_AGENT_DIR` 覆盖），项目级为 `.agents/skills`。
  - 历史：位于 `~/.omp/agent/sessions/<编码工作区>/*.jsonl`，记录结构与 Pi 的 `session` / `message` 一致，标题取自首条 `title` 记录。

## Consequences

- OMP 与 Pi 在同一台机器上完全隔离，配置、MCP、Skills 与凭据互不串扰。
- 认证状态完全收敛到通用 `resolve_observed_authentication`，避免特判分支破坏登出语义。
