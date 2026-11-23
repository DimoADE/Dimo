---
status: accepted
date: 2026-08-28
decision-makers: Dimo maintainers
---

# 插件市场、单路作者工具链与会话生效诚实性

## Context

Dimo 插件平台需要一条对用户与作者都完整闭环的产品路径：统一的市场发现与更新通道、诚实的 Full Trust 安装确认、开箱即可在 Host 运行的脚手架与单一 CLI 开发测试链路，以及对「已有会话不会热挂 Agent 工具」的清晰产品表达。本决定衔接 [ADR-0046](0046-full-stack-plugin-platform-and-isolated-sdk.md)、[ADR-0047](0047-product-centric-plugin-package-and-content-model.md)、[ADR-0048](0048-full-trust-plugin-execution-model.md)、[ADR-0051](0051-host-managed-plugin-scoped-mcp-runtimes.md)、[ADR-0055](0055-official-product-mcp-activation.md) 与 [ADR-0069](0069-everything-is-a-plugin-platform.md)。

## Decision

### 1. 会话生效边界诚实表达

设置 → 插件页遵循双轨生效语义（[ADR-0069](0069-everything-is-a-plugin-platform.md)）：

- **Agent 侧贡献**（Skill、托管 MCP、Hook）仅作用于**新建或重新绑定**的 Agent session，不在已有活会话上热挂载 STDIO MCP；插件目录页以清晰副标题提示该生效边界。
- **UI 贡献与 Provider 贡献**随 Activation Generation 启用即生效、禁用即原子撤下。
- 不在首次进入插件页时批量推销启用普通官方插件。

### 2. 官方插件分发与安装启用语义

- **普通官方插件**（如 `dimo.office`、`dimo.session-enhance`、`dimo.workflow-creator`、`dimo.plugin-development` 等）上架官网市场的**官方分类**，均可自由卸载。Host 发行物附带的官方包快照仅作为离线安装缓存，仍须经预览与 Full Trust 确认流程。
- **安装后启用语义**：在桌面/WebUI 设置页通过插件市场弹窗确认 Full Trust 安装时，插件**立即启用**；命令行 `dimo plugin add` 与底层 `plugin_marketplace_install` 默认仅导入为禁用态，由调用方显式启用。
- **能力等价插件例外**：从宿主内置能力迁出的能力等价官方插件按 Host 固化白名单自动安装并默认启用，但用户仍可随时禁用或卸载（见 [ADR-0069](0069-everything-is-a-plugin-platform.md)）。
- 官方 MCP 二进制（`dimo-mcp`、`dimo-workflow-mcp`）仍随 Host 家族分发，其激活边界遵循 [ADR-0055](0055-official-product-mcp-activation.md)。

### 3. 设置 → 插件市场 Tab 与 Full Trust 安装预览

设置 → 插件目录页分为**已安装**与**插件市场**两个 Tab；插件详情页保持「内容」与「配置」双 Tab（[ADR-0047](0047-product-centric-plugin-package-and-content-model.md)）。

市场 Tab 消费官网只读版本化 Catalog API（`/api/marketplace/v1/`：`official`、`community?limit=50&offset=0`、`search?q=`、`listing/{owner}/{plugin}`、`listing/{owner}/{plugin}/versions`、`artifact/{owner}/{plugin}`），仅展示已审核发布的条目：

- 官方分类独立全量拉取并默认置顶；社区列表默认分页 50 条，搜索覆盖全量已发布目录。
- 市场安装、拖入 `.vxp`、CLI 远程安装与离线官方缓存安装均须经**安装预览弹窗**，展示安装物身份、摘要、用户可见能力与来源 URL，并要求不可省略的 Full Trust 确认：

> 安装后该插件以你的本机用户权限运行，不是沙箱。

### 4. 安装物身份、来源锁与可更新判定

- **产品身份**：`Publisher + Plugin ID`（[ADR-0046](0046-full-stack-plugin-platform-and-isolated-sdk.md)），同 ID 不同 Publisher 不继承权限与数据；同一 Host 对同一产品身份仅保留一份 membership。
- **安装物身份与来源锁**：四元组 `owner / plugin-name / tag / version` 搭配 `sourceKind`（`marketplace`、`github` 或 `official-snapshot`）、远端 URL 与 SHA-256 digest。更新严格沿来源锁通道拉取；链接开发目录（`developerLink`）不显示「可更新」。
- 远端存在更新 tag 或更大 semver 时标记为可更新；更新再次经过预览弹窗，当 digest、publisher 或可执行入口变化时重新确认 Full Trust，保留用户 `config.json` 并按新 schema 校验。检查更新失败时保持状态未知，不得谎称「已是最新」。

### 5. 单路 CLI 作者工具链与可运行脚手架

开发、校验、链接、调试与测试收口为单一 CLI 路径，不保留半截开发 MCP：

```text
dimo-plugin init | dev | build | validate | test | pack | fork | toolchain | doctor
dimo plugin add --dev . | --profile | --web
dimo plugin test --host
```

- `dimo-plugin init` 产出的包（声明 `@dimoai/plugin-sdk` `^2.0.0`）必须直接通过 `build` / `validate` / `test` 并可在真实 Host 激活；Node/TS 模板提供标准 `runStdioPluginWorker` 入口，测试面向定义模块而非构建产物。
- `dimo plugin add --dev .` 通过本机 Host 凭据调用 `plugin_control_import`（`developerLink`）并监视 digest，Host 未运行时写入 `~/.dimo/imports/links.jsonl`，永不删除开发目录。

### 6. 公共稳定面与 Host 旅程完成门

任何对作者公开的 contribution kind 或 `host.call` 能力进入稳定面，必须同时通过四项验证：CLI `validate`、Host `inspect`、至少一个真实 UI 或 Agent 消费者（含官方参考包）、以及作者文档与 Skill；且必须通过最短真实 Host 旅程 `dimo plugin test --host`（链接/安装 → 启用 → 行使声明能力 → 禁用/卸载且开发目录完好）。

- 稳定面涵盖内容贡献（`content.skill` / `content.mcp` / `workflow.binding`）、文件与产物编辑/预览、后台服务（`host.service`）、六个宿主壳层槽位（`app.command` / `app.toolbar` / `app.status` / `app.composer.slash` / `app.timeline.card` / `app.settings.section`）、结构 UI 槽位与 Provider 缝（完整登记见 [ADR-0069](0069-everything-is-a-plugin-platform.md)）。
- `dependencies.kind = plugin` 长期排除出平台契约（单层扩展原则，[ADR-0069](0069-everything-is-a-plugin-platform.md)）。

## Consequences

- 用户在市场安装、更新与卸载官方及第三方插件时具备一致的身份、来源锁与 Full Trust 认知。
- 作者只需掌握一套 CLI 与 SDK，禁止把静态校验通过等同于真实 Host 能力可用。
- Companion 客户端不具备插件写入 scope（[ADR-0054](0054-host-family-distribution-and-client-surfaces.md)），远程插件操作始终在 Host 上执行。

## Considered Options

- **保留开发 MCP 作为 Agent 调试面**：否决。半截工具缺乏凭据签发闭环，直接运行 CLI 更短且可靠。
- **安装时不弹 Full Trust 确认**：否决。引入开放市场后必须向用户显式告知本机权限语义。
- **继续将所有官方插件锁定为不可卸载的 builtin**：否决。剥夺用户自主权并混淆「未选择」与「已安装未启用」。
