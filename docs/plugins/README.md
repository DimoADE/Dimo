# Dimo Plugin Platform (`v4`)

Dimo Plugin 是以统一产品身份、版本、配置和生命周期扩展 Dimo 的完整功能包（[ADR-0069：一切皆插件](../adr/0069-everything-is-a-plugin-platform.md)）。一个插件可以同时连接 **Agent**（Skill、MCP、Workflow）、**App**（文件预览/编辑器、Dockview 面板、工具栏、状态栏、命令、设置、主题、右键菜单）、**Host**（Worker、后台服务、Provider 接缝）与 **Runtime**（受校验并锁定的本地二进制）。官方插件与第三方插件共享完全相同的公开 SDK、清单规范和 **23 类贡献点**，零私有 API、零插件 ID 特判。

## 面向用户与插件作者

- [插件使用指南](user-guide.md) — 在设置与 `dimo plugin` CLI 中发现、安装、启用、配置、更新与卸载插件。
- [插件开发指南](developer-guide.md) — 端到端插件创作流程、渲染三轨选择、本地热更新调试（`dimo plugin run dev`）与打包分发。
- [官方插件全景](official-plugins.md) — 仓库内置的 15 个官方插件（`plugins/*`）及宿主内置协作空间说明。

## 平台规范与契约

- [Package v4 规范](package-v4.md) — `.dimo-plugin/plugin.json`、根 `README.md`（`summary` frontmatter）、`contents/`、`depends/`、`config.json` 与 `.vxp` 打包规范。
- [SDK 与 CLI 参考](sdk-and-cli.md) — `@dimoai/plugin-sdk`（v2.0.0，11 个导出子路径）、Python / Rust Worker SDK、Worker 协议 `1.1`、`dimo-plugin` 与 `dimo plugin` CLI 命令参考。
- [平台内核架构](platform-architecture.md) — Plugin Kernel、Activation Generations、Full Trust Worker / App 渲染三轨与远程 Host 执行边界。
- [23 类贡献点与 Host API 绑定表](contract-bindings.md) — 由 `scripts/plugin-contract-report.mjs` 自动生成的权威绑定矩阵（155 个 `host-api` 操作、32 个 `host.call` 能力域与 23 类贡献点状态）。

## 用户入口

- `/plugins`：产品插件目录，包含「已安装」与「插件市场」两个 Tab；
- `/plugins/:pluginId`：独立插件详情页，仅设「内容」（`README.md` 与经过校验的 `contents/`）与「配置」（基于 Schema 原子读写根 `config.json`）两个主 Tab；
- Agent 原生插件（Codex、Claude Code 等 Agent 自有格式）：位于「设置 → Agent → 对应 Agent」底部独立管理，不混入 Dimo 产品插件目录。

## 核心架构决策（ADR）

- [ADR-0046](../adr/0046-full-stack-plugin-platform-and-isolated-sdk.md) — 统一插件内核生命周期、进程管理与版本化 SDK；
- [ADR-0047](../adr/0047-product-centric-plugin-package-and-content-model.md) — 以产品为中心的 Package v4 包结构、内容与配置模型；
- [ADR-0048](../adr/0048-full-trust-plugin-execution-model.md) — Full Trust 本机执行模型；
- [ADR-0066](../adr/0066-plugin-marketplace-authoring-and-session-honesty.md) — 插件市场、来源锁更新与新会话生效诚实性；
- [ADR-0069](../adr/0069-everything-is-a-plugin-platform.md) — 一切皆插件：单层扩展、壳层贡献点、渲染三轨、Provider 接缝与无特权官方插件；
- [ADR-0070](../adr/0070-ssh-provisioned-remote-server.md) — `provider.remote.provisioner` 远程主机供给接缝。
