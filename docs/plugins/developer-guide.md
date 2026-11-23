# Dimo 插件开发指南

本文面向插件作者，带你从零完成 Dimo `v0.5.2` 插件的初始化、编写、本地联调、测试与分发。

- 清单与包布局规范见 [Package v4 规范](package-v4.md)；
- SDK 完整导出与 CLI 命令参数见 [SDK 与 CLI 参考](sdk-and-cli.md)；
- 23 类贡献点与 155 个 `host-api` 操作实时矩阵见 [契约绑定表](contract-bindings.md)。

## 1. 开发前需要了解的四条平台原则

1. **Full Trust 本机执行（[ADR-0048](../adr/0048-full-trust-plugin-execution-model.md)）**：用户安装或链接你的插件即授予与 Dimo Host 相同的本机用户权限。独立 Worker 进程与 App frame 仅用于崩溃隔离、热更新和激活代回收，不是安全沙箱。请在 `README.md` 如实说明网络访问、磁盘读写与外部进程行为。
2. **官方插件零特权（[ADR-0069](../adr/0069-everything-is-a-plugin-platform.md)）**：官方插件与第三方插件共享同一套 `@dimoai/plugin-sdk`（v2.0.0）、Package v4 清单与 23 类贡献点，宿主不按插件 ID 做特判（由 CI `pnpm run plugin:no-privilege` 强校验）。
3. **单层扩展，无插件间依赖（[ADR-0069](../adr/0069-everything-is-a-plugin-platform.md)）**：插件只面向宿主贡献点开发，不支持 `depends.kind = "plugin"` 或跨插件调用。复用他人插件的路径是派生源码并以新的 `(publisher, id)` 打包（可附加 `derivedFrom` 溯源元数据）。
4. **生效双轨与诚实文案（[ADR-0066](../adr/0066-plugin-marketplace-authoring-and-session-honesty.md)）**：UI / Provider 贡献启用即生效、禁用即原子撤下；Agent 贡献（Skill、MCP）仅在启用后新开或重新绑定的会话中生效。

## 2. 快速上手（从初始化到热更新）

先启动本机 Dimo Desktop（Electron + `dimo-server --desktop`）或独立 `dimo-server`（默认监听 `127.0.0.1:17891`），然后按顺序执行：

```bash
# 1. 查看本机工具链路径与可用模板
dimo-plugin toolchain

# 2. 绑定正在运行的 Host（写入 ~/.dimo/pluginrc）
dimo plugin run server --http://127.0.0.1:17891 --token <token>

# 3. 用模板初始化插件（支持 16 种模板，默认 full）
dimo-plugin init my-notes --publisher you --template full
cd my-notes

# 4. 离线校验、构建与单元测试
dimo-plugin validate
dimo plugin run build
dimo plugin run test

# 5. 链接到本机 Host（仅链接并立即返回）
dimo plugin add --dev .

# 6. 启动监听与热更新（Worker 切候选代，Module Federation 走 Vite HMR）
dimo plugin run dev
```

在 Dimo 界面打开 `/plugins` 找到 `my-notes` 并启用开关，即可实时验证所有声明的贡献。若某次保存导致构建或校验失败，Host 会保留上一个完整激活代对外服务，不会中断现有功能。

## 3. 组织包结构与清单

核心文件结构与字段约束见 [Package v4 规范](package-v4.md)，开发时重点维护四处：

1. **`README.md`**：在顶部 YAML frontmatter 写一句简明准确的 `summary`（纯文本，≤ 200 字符），描述插件完成的一件事，避免营销口号。
2. **`.dimo-plugin/plugin.json`**：声明身份 `(publisher, id)`、`engines`、`config.schema`、`entrypoints`、`dependencies`（仅本地 Runtime）与 `integrations`。
3. **`.dimo-plugin/content.index.json`**：登记 `contents/` 下面向用户和 Agent 的 Skill、MCP、Workflow 与资源文件。
4. **`config.json`**：提供初始默认配置；用户在「配置」Tab 所做修改会按 Schema 校验后原子写回该文件。

## 4. 常见能力编写指南

### 4.1 编写 Worker（Node / Python / Rust）

Worker 负责后台计算、文件/网络操作、Runtime 调用与状态持久化，使用协议 `1.1`（stdio JSON-RPC）：

```ts
// runtime/worker.ts
import { definePluginWorker } from '@dimoai/plugin-sdk/worker';
import { runStdioPluginWorker } from '@dimoai/plugin-sdk/stdio';

const worker = definePluginWorker((registrar, env) => {
  registrar.handle('notes.list', async (_input, callEnv) => {
    const items = await callEnv.host.call('storage.kv', 'list', { prefix: 'note:' });
    return { items };
  });

  registrar.onDispose(() => {
    // 关闭句柄；业务状态在请求处理时立即落盘
  });
});

export default worker;
await runStdioPluginWorker(worker);
```

- Handler ID 必须与 `plugin.json` 中的 `integrations` 一一对应。
- 大于单帧上限（默认 32 MiB，可在 `entrypoints.worker.maxFrameMiB` 调整至 `1..128`）的消息由 SDK 自动分片；视频等大文件使用 `blob.create` / `blob.append` / `blob.finish`（上限 4 GiB）。
- Python（`sdk/python/`，`dimo-plugin@2.0.0`）与 Rust（`crates/plugin-sdk/`，`dimo-plugin-sdk@2.0.0`）的对应示例见 [SDK 与 CLI 参考](sdk-and-cli.md)。

### 4.2 选择合适的 UI 渲染轨道

按交互密度选择渲染三轨之一：

| 轨道 | 适用贡献点 | 编写方式 |
| --- | --- | --- |
| **L1 宿主渲染 Descriptor** | `app.command`、`app.toolbar`、`app.status`、`app.composer.slash`、`app.composer.action`、`app.rail.section`、`app.timeline.card`、`app.settings.section` | 在 `plugin.json` 声明 descriptor 与 Worker `handler`（图标必须取自 `@dimo/plugin-contract/catalog/icons`）；状态栏与工具栏只可追加，不改动宿主自带项。 |
| **L3 Module Federation（`protocol: "2.0"`）** | `app.panel`、`app.tab`、`app.kanban.view`、`app.settings.page`、Turn Hook 与 IoC 服务 | `entrypoints.app` 指向 `app/main.js`（`protocol: "2.0"`），使用 `defineDimoPlugin((ctx) => ...)` 注册 `ctx.ui.*` / `ctx.hooks.*` / `ctx.services.*`，并经 `ctx.host.*` 或 `invoke(handler, input)` 调用 Worker；禁止直接调用宿主内部 Electron API。 |
| **L3 独立 HTML Surface（`protocol: "1.0"`）** | `app.surface`（`slot: "plugin.detail.panel"` 或 `slot: "artifact.editor"`） | `entrypoints.app` 指向 `dist/app/index.html`（`protocol: "1.0"`），使用 `definePluginApp(({ root, bridge, signal }) => ...)`。可编辑文件 Tab 通过 `file.opener.editorSurface` 绑定，使用 `bridge.artifact.readText()` 与 `writeText(content, expectedRevision)` 防盲覆盖。 |

> `dimo-plugin init my-chrome --template host-chrome` 可一次生成六个常用宿主槽位示例；`--template panel`、`--template kanban-view` 与 `--template editor-tab` 分别对应面板、看板视图与可编辑文件 Tab。

### 4.3 编写插件 MCP（`content.mcp`）

插件通过 `content.mcp` 向 Host MCP 管理器登记工具，禁止插件自行改写 Agent 的本地配置文件。在 `contents/mcps/<name>.json` 中选择适合的形状（`workerHttp`、`managedRuntime.entrypoint` 或静态 `command` + `args`），并在资源中声明 `tools` 清单以便状态栏在连接前展示工具名。

自建 STDIO MCP 需实现：

- `server/discover`（`2026-07-28` 协议修订：`resultType`、`supportedVersions`、`capabilities`、`_meta['io.modelcontextprotocol/serverInfo']`）；
- 握手期的 `initialize`（兼容 `2024-11-05` / `2025-03-26` / `2025-06-18` / `2025-11-25`）、`notifications/initialized`、`tools/list` 与 `tools/call`；
- 同时支持行分隔 JSON-RPC 与 `Content-Length` 帧，`tools/list` 返回名与资源 `tools` 一致。

执行 `dimo-plugin init my-mcp --template mcp` 可直接生成带完整握手的最小模板。

### 4.4 编写 Provider 接缝

- **`provider.model.importSource`**：Worker handler 返回 `{ providers: [...] }`（或数组），每项提供 `name` 与 `apiUrl`（缺 `apiKey` 时展示但禁止勾选）；导入只写入预设，绑定 Agent 需经由带用户确认的 `provider.presets.bind`。
- **`provider.model.catalog`**：指向无密钥的静态 JSON 预置模板，追加在内置预置（[ADR-0088](../adr/0088-built-in-provider-presets.md)）之后供新建表单点选填表。
- **`provider.remote.provisioner`**：声明 `provisionKind` 与 `ensure` handler，在连接已保存远程 Host 前按需恢复可达性（参考 `plugins/remote-ssh` 与 [ADR-0070](../adr/0070-ssh-provisioned-remote-server.md)）。

## 5. 测试、实机验证与诊断

1. **离线单元测试**：运行 `dimo-plugin test`（使用 `@dimoai/plugin-sdk/testing` 的 `createPluginTestHarness` / `createWorkerHarness` / `createGenerationHarness`）。纯声明式插件直接读取真实 `.dimo-plugin/plugin.json` 做断言。
2. **真 Host 端到端旅程**：运行 `dimo plugin run test --host`，自动覆盖安装 → 启用 → 贡献出现在目录 → 禁用后原子撤下 → 重新启用 → Skill 变更触发摘要更新 → 卸载且保留开发目录。
3. **运行状况与日志诊断**：
   - 在 Dimo「设置 → 插件」选中目标插件，概览里的「运行状况」直接展示 Worker 状态（运行中 / 未运行 / 未声明）、缺失 Runtime、最近崩溃记录以及按需拉取的 stdout/stderr 日志尾部；
   - 在命令行执行 `dimo-plugin doctor` 查看同源诊断 JSON（含全部已发布 `contributions`、Runtime 锁探测结果与最近崩溃）。

## 6. 打包与分发

验证通过后打包确定性 `.vxp` 归档：

```bash
dimo-plugin pack --output dist/my-notes.vxp
```

支持三种分发方式：

1. **官方插件市场**：执行 `dimo plugin publish` 发布至插件市场，用户在 `/plugins` 的「插件市场」Tab 搜索并一键安装（来源锁定至市场，自动检查后续 semver 更新）。
2. **GitHub 仓库 / Release**：在 GitHub 发布带版本号的 tag（如 `v1.0.0`）与 `.vxp` Release 产物，用户通过 `dimo plugin add --web github:<owner>/<repo>#v1.0.0` 安装并自动追踪后续稳定 tag。
3. **离线 `.vxp` 传递**：用户执行 `dimo plugin add --profile my-notes.vxp` 或直接将 `.vxp` 拖入 `/plugins` 页面。

## 7. 生命周期配合注意事项

- 启用意图（enabled intent）与运行中的激活代（active generation）分离：若声明的本地 Runtime 尚未就绪，贡献不会进入运行目录。
- 禁用或卸载时，Host 按反序停止后台服务、dispose Worker 并回收贡献；请确保 `onDispose` 及时释放文件句柄、定时器与子进程，并在正常请求中提交持久数据。
- 配置 Schema 升级若不兼容旧版 `config.json` 键结构，请在发布说明与迁移逻辑中妥善处理；Host 遇到无法通过新 Schema 校验的用户配置时会拒绝升级并保留旧版本。
- 同一个源码目录可以同时包含 Dimo Package v4 与 Agent 原生插件格式，二者保持独立的启停与信任生命周期。
