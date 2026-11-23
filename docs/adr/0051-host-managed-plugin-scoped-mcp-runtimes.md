---
status: accepted
date: 2026-08-14
decision-makers: Dimo maintainers
---

# Host 托管的插件域 MCP Runtime

## Context

静态 `content.mcp` 配置仅能投影外部 MCP 描述，无法引用插件托管的本地 Runtime、注入按作用域隔离的 Host 凭据或绑定当前 Workspace 与父 Conversation。与此同时，协作空间（内置宿主能力，由 `dimo-mcp` 支撑）、Workflow Creator（`dimo-workflow-mcp`）、会话增强（`dimo.session-enhance`）以及第三方插件拥有各自独立的发布周期与工具目录，平台需要统一的 Host 托管 MCP Runtime seam，而非将所有产品工具堆入单一内置 MCP。

## Decision

1. **插件域独立身份**：每个携带 MCP 的产品插件独立拥有 MCP identity、tool catalog、protocol compatibility、Runtime 与 Agent binding（例如 `dimo.workflow-creator` 拥有 `dimo-workflow-mcp`）。协作空间与官方插件 MCP 的激活边界遵循 [ADR-0055](0055-official-product-mcp-activation.md)。
2. **Manifest 显式声明**：Plugin manifest 的 `content.mcp` 区分 `static` 与 `managed` 两类明确 descriptor；managed descriptor 可引用插件托管 Runtime 或官方 `hostFamilyBinary`，并声明 STDIO transport、支持的 MCP protocol revisions 与所需 Host scopes。
3. **Host 托管启动与连接上下文注入**：Host 解析 Runtime 锁并按 Agent session 启动 MCP 进程，注入绑定 Workspace、父 Conversation 与 Plugin generation 的连接上下文。插件不得持久保存 Server URL、管理员 token 或 device credential。凭据默认采用按会话最小 scope；面向宿主协作或会话增强等长驻产品 MCP，按启用生命周期签发独立拆分的最小 scope 凭据（见 [ADR-0055](0055-official-product-mcp-activation.md)）。
4. **协议版本协商**：Host 托管的新 MCP 以 protocol revision `2026-07-28` 为主，实现 `server/discover`、逐请求版本声明与不支持版本错误，并按协商兼容 Host SDK 支持的旧 revision。
5. **长操作契约**：长耗时操作立即返回稳定业务 ID；客户端协商 Tasks extension 时同时提供 task handle，否则使用常规 `tools/read/wait` 轮询。MCP Tasks 不是 Workflow 运行事实源。
6. **默认全 Agent 绑定意图**：默认 Agent binding 为「所有当前及未来兼容 Agent，减去显式排除项」。插件设置页与 Agent/MCP 设置页编辑同一份 binding 事实。
7. **不兼容诚实呈现**：不支持 MCP 或无法协商协议的 Agent 显示为 incompatible，不得伪装为已配置。
8. **全链路统一通道**：Plugin SDK、CLI validator、Host parser、Runtime resolver、Agent projection 与 testing harness 统一支持该 contribution；插件不得直接调用未公开的内部 Host HTTP/IPC 接口绕过该 seam。

## Consequences

- `content.mcp` 使用 `managed` / `static` 显式判别结构，避免靠启发式猜测资源 JSON。
- 现有活跃会话不能热挂载 STDIO MCP；binding 或启停变化只作用于新建或重新绑定的 Agent session，Host 向用户提示重建会话。
- Full Trust（[ADR-0048](0048-full-trust-plugin-execution-model.md)）决定执行信任模型，但动态身份、短期凭据与 activation generation 生命周期仍由 Host 统一托管以保证正确性与可撤销性。

## Considered Options

- **将所有产品工具并入单一内置 `dimo-mcp`**：否决。会使独立产品插件的生命周期、版本演进与工具目录强耦合。
- **由插件自行持久保存 Server URL 与 token**：否决。无法可靠管理凭据寿命、撤销与 Workspace scope 隔离。
- **仅提供远程 HTTP MCP**：否决。本地桌面与无头 Host 的首要场景是随 Agent session 生命周期管理的 STDIO MCP。
