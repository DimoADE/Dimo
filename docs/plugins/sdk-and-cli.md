# Dimo Plugin SDK 与 CLI 参考

本文是 Dimo Plugin 公共 SDK（JS/TS、Python、Rust）、Worker / App 通信协议与 CLI 命令的规范参考（对应 Dimo `v0.5.2`）。

> 23 类贡献点、155 个 `host-api` 操作与 32 个 `host.call` 能力域的完整实时矩阵见 [`contract-bindings.md`](contract-bindings.md)；包布局与清单规范见 [`package-v4.md`](package-v4.md)。

## 1. JavaScript / TypeScript SDK（`@dimoai/plugin-sdk` v2.0.0）

`@dimoai/plugin-sdk` 要求 Node `>=20`，提供 **11 个导出子路径**（定义见 [`packages/plugin-sdk/package.json`](../../packages/plugin-sdk/package.json)）：

| 导出子路径 | 核心 API 与用途 |
| --- | --- |
| `@dimoai/plugin-sdk` (`.`) | 统一入口，导出 `defineDimoPlugin`（`protocol: "2.0"` 插件定义）并汇总导出全部子模块。 |
| `@dimoai/plugin-sdk/worker` | `definePluginWorker((registrar, env) => ...)`、`activatePluginWorker`、Worker 生命周期与 `HostCapabilityBroker` 调用客户端。 |
| `@dimoai/plugin-sdk/app` | `definePluginApp(({ root, bridge, signal }) => ...)`，用于 `protocol: "1.0"` 独立 HTML Surface App。 |
| `@dimoai/plugin-sdk/registry` | 与 React `useSyncExternalStore` 兼容的响应式贡献注册表（`Registry`、`slotRegistry`、`commandRegistry`、`panelRegistry`、`kanbanViewRegistry`、`settingsPageRegistry`、`themeRegistry` 等）。 |
| `@dimoai/plugin-sdk/services` | Cordis 风格 IoC 服务容器（`ServiceContainer`、`EffectScope`、`createServiceKey`、`WaterfallInterceptor`），支持属主卸载自动回收与洋葱拦截器。 |
| `@dimoai/plugin-sdk/context` | `PluginContext` 命名空间上下文构造与传输绑定（`ctx.ui.*`、`ctx.hooks.*`、`ctx.services.*`、`ctx.host.*`、`setDefaultHostCallTransport`、`setDefaultWorkerInvokeTransport`）。 |
| `@dimoai/plugin-sdk/hooks` | 面向宿主内 React 组件的注册表 Hooks（`useRegistry`、`bindExternalStoreHook` 等），复用宿主 React 单例。 |
| `@dimoai/plugin-sdk/volatile` | 细粒度响应式配置引用（`Volatile<T>`、`MutableVolatile<T>`、`get()` / `select()` / `subscribe()`），在 `config.json` 变更时原地更新而无需重启 Worker。 |
| `@dimoai/plugin-sdk/testing` | 离线测试 Harness：`createPluginTestHarness`、`createWorkerHarness`、`createGenerationHarness`、`createAppHarness`。 |
| `@dimoai/plugin-sdk/protocol` | Wire DTO、`DIMO_PLUGIN_PROTOCOL_VERSION`（`"1.1"`）、`JsonValue`、`frame.chunk` 分片重组与错误信封类型。 |
| `@dimoai/plugin-sdk/stdio` | `runStdioPluginWorker`，驱动 Node Worker 的 stdio JSON-RPC 2.0 主循环。 |

SDK 不导出宿主内部路由、Electron IPC、SQLite schema 或内部 Rust 枚举。Full Trust Worker 可以直接使用 Node 标准库，并通过 `environment.host.call` / `ctx.host.*` 调用结构化宿主能力。

### 1.1 Worker 入口（`@dimoai/plugin-sdk/worker` + `./stdio`）

```ts
import { definePluginWorker } from '@dimoai/plugin-sdk/worker';
import { runStdioPluginWorker } from '@dimoai/plugin-sdk/stdio';

const definition = definePluginWorker((registrar, env) => {
  registrar.handle('hello', async (input, callEnv) => {
    callEnv.log.info('hello invoked', { input });
    const count = (await callEnv.host.call<number>('storage.kv', 'get', { key: 'count' })) ?? 0;
    await callEnv.host.call('storage.kv', 'put', { key: 'count', value: count + 1 });
    return { ok: true, count: count + 1 };
  });

  registrar.onDispose(() => {
    // 释放句柄；持久化状态应在正常请求中事务提交
  });
});

export default definition;

// 独立进程入口
await runStdioPluginWorker(definition);
```

- **Handler ID 正则**：`^[a-z][A-Za-z0-9]*(?:[.-][a-z][A-Za-z0-9]*)*$`，且必须与 `plugin.json` 中的声明一致。
- **冻结规则**：`setup` 阶段只做注册，完成后注册表冻结；重复注册、未声明 handler 或缺失必填 handler 会使候选激活代失败。
- **`environment` 字段**：`context`（`pluginId`、`pluginVersion`、`generation`、`packageClass`、`grantedCapabilities`）、`host.call(capability, operation, input?)`、`signal`（`AbortSignal`）、`log.debug/info/warn/error(message, fields?)`。
- **`onDispose`**：卸载或切代时按反序执行并带 deadline；持久状态必须在正常请求期间提交，不得依赖 `onDispose` 写盘。

### 1.2 App 入口（`protocol: "2.0"` 与 `protocol: "1.0"`）

**`protocol: "2.0"`（Module Federation / 宿主内 App，`app/main.js`）**：

```ts
import { defineDimoPlugin } from '@dimoai/plugin-sdk';

export default defineDimoPlugin((ctx) => {
  ctx.ui.registerCommand({
    id: 'refresh-dashboard',
    title: 'Refresh Dashboard',
    async handler() {
      await ctx.host.storage.kv.set('lastRefreshAt', Date.now());
      await ctx.host.ui.notify({ title: 'Dashboard', message: 'Refreshed', variant: 'info' });
    },
  });
});
```

**`protocol: "1.0"`（独立 HTML Surface App，`dist/app/index.html`）**：

```ts
import { definePluginApp } from '@dimoai/plugin-sdk/app';

export default definePluginApp(({ bridge, root, signal }) => {
  const button = document.createElement('button');
  button.textContent = 'Refresh';
  button.addEventListener('click', () => void bridge.invoke('dashboard.refresh', {}));
  root.replaceChildren(button);
  bridge.ready();

  const dispose = () => root.replaceChildren();
  signal.addEventListener('abort', dispose, { once: true });
  return dispose;
});
```

`bridge` 提供 `pluginId`、`generation`、`invoke(handler, input?)`、`hostCall?(capability, operation, input?)`、`subscribe(channel, listener)`、`ready()` 以及（在 `artifact.editor` 槽位下）`artifact.name`、`artifact.readText()`、`artifact.writeText(content, expectedRevision)`。

### 1.3 结构化宿主能力（`host.call`）

Worker 通过 `env.host.call<T>(capability, operation, input?)`、`protocol: "2.0"` App 通过 `ctx.host.*` 访问 `HostCapabilityBroker`。主要能力域包括：

- **数据与配置**：`storage.kv`（按插件 ID 隔离的 SQLite KV）、`storage.settings`（按 `config.schema` 校验读写根 `config.json`）、`secrets`（OS Keychain / 加密存储）、`blob`（大文件流式读写，单文件上限 4 GiB，单块 512 KiB）。
- **文件、网络与进程**：`files`（受控目录读写与列举，越界返回 `files_root_denied`）、`network.fetch`、`exec`（`run` / `spawn` / `kill` / `status`）、`runtime.lock` / `runtime.execute`。
- **产品领域能力**：`conversation.*`（创建、入队、纠偏、取消、审批/提问应答与事件流，作用域外返回 `conversation_scope_denied`）、`collaboration.*`、`browser.*`、`artifact.preview` / `artifact.readText` / `artifact.writeText`、`remote.profile.*` / `remote.connect` / `remote.disconnect`、`provider.presets.*`。
- **事件与诊断**：`events`（`subscribe` / `ack` / `publish`）、`app.notify.toast`、`log.*`、`plugin.self.doctor`。

逐操作清单与实现状态以 [`contract-bindings.md`](contract-bindings.md) 为准。

## 2. Python Worker SDK（`sdk/python/`，`dimo-plugin@2.0.0`）

要求 Python `>=3.11`（宿主托管解释器为 CPython 3.12）：

```python
from dimo_plugin import define_plugin_worker, run_stdio_plugin_worker

def setup(registrar, env):
    def hello(input, call_env):
        call_env.log.info("hello", {"input": input})
        return {"ok": True}

    registrar.handle("hello", hello)

if __name__ == "__main__":
    run_stdio_plugin_worker(define_plugin_worker(setup))
```

- 异步主循环使用 `run_stdio_plugin_worker_async`；`env.host.call(capability, operation, input=None)` 为 `async` 方法。
- `env.context` 提供 `plugin_id`、`plugin_version`、`generation`、`package_class`。
- 测试工具导出 `create_worker_harness`、`create_generation_harness` 与 `MemoryHostClient`。

## 3. Rust Worker SDK（`crates/plugin-sdk/`，`dimo-plugin-sdk@2.0.0`）

Rust Edition 2024，MSRV `1.85`，基于 Tokio current-thread 驱动 stdio JSON-RPC：

```rust
use dimo_plugin_sdk::{
    define_plugin_worker, run_stdio_plugin_worker_blocking, PluginSdkError,
};
use serde_json::json;

fn main() {
    let definition = define_plugin_worker(|registrar, _env| {
        registrar.handle_sync("hello", |input, _env| Ok(json!({ "received": input })));
        registrar.on_dispose(|| async { Ok(()) });
    });
    if let Err(error) = run_stdio_plugin_worker_blocking(definition) {
        eprintln!("{error}");
    }
}
```

- `PluginRegistrar`：`handle(id, async_fn)`、`handle_sync(id, fn)`、`on_dispose(async_fn)`（反序执行）。
- `WorkerEnv`：`context()`、`replace_context()`、`host`（`HostClient`）、`call(capability, operation, input)`、`log.debug/info/warn/error`、`is_cancelled()` / `cancel()`。
- 主循环：`run_stdio_plugin_worker`（async）与 `run_stdio_plugin_worker_blocking`（同步 `main`）。
- 测试工具：`create_worker_harness`、`create_generation_harness`、`MemoryHost`。

## 4. Worker 协议 `1.1` 与 App 桥接

- **传输**：每个 Worker 持有一条 stdio JSON-RPC 2.0 连接，默认单帧上限 `32 MiB`（可在 `entrypoints.worker.maxFrameMiB` 配置 `1..128`），逻辑消息上限 `64 MiB`，超单帧自动经 `frame.chunk` 分片重组；大体积二进制走 `blob.*`。Worker stderr 进入插件诊断日志，不参与协议解析。
- **握手**：`Host → initialize`（携带 `protocolRange`、`hostVersion`、`pluginIdentity`、`packageDigest`、`generationId`、`declaredContributions`、`trust: "full"`、`features`、`limits`）→ `Worker → initialized` → `Host → activate` → `Worker → ready`。
- **错误信封**：`{ code, message, retryable, operationId?, contributionId?, diagnosticId?, details? }`，宿主按稳定 `code` 生成本地化文案与恢复指引。
- **App Bridge**：`protocol: "1.0"` surface 挂载时接收一次性 bootstrap（surface token、plugin/generation identity、theme/locale、允许的方法列表），通过 `postMessage` / `MessagePort` 与宿主通信；卸载、禁用或切代时立即撤销 token。

## 5. CLI 参考（`dimo-plugin` 与 `dimo plugin`）

Dimo 提供两套互补的 CLI 入口，均通过 `~/.dimo/pluginrc` 与标准 Remote Protocol v1（`POST /api/v1/call/*`）对接本机或远程 Dimo Host：

### 5.1 `@dimoai/plugin-cli`（`dimo-plugin` v2.0.0）— 作者构建与调试工具链

| 命令 | 说明 |
| --- | --- |
| `dimo-plugin init [dir] [--publisher id] [--template <name>]` | 初始化 Package v4 脚手架并执行首次构建（默认模板 `full`）。 |
| `dimo-plugin validate [dir] [--json]` | 离线全量校验清单、README `summary`、内容索引、图标白名单、路径安全与依赖（单次遍历报告全部违规）。 |
| `dimo-plugin build [dir]` | 编译 Worker / App 产物至 `dist/` 并生成 `.dimo-plugin/package.lock.json`。 |
| `dimo-plugin test [dir] [--host]` | 运行离线测试；加 `--host` 时针对运行中的 Host 验证安装、启用、贡献出现、禁用撤下、Skill 重载与卸载全链路。 |
| `dimo-plugin pack [dir] [--output file.vxp]` | 校验并打包确定性 `.vxp` 归档，打印 `sha256:` 摘要。 |
| `dimo-plugin run server [--http://127.0.0.1:17891] [--token <token>]` | 绑定目标 Host 并写入 `~/.dimo/pluginrc`。 |
| `dimo-plugin run dev [dir]` / `dimo-plugin dev [dir]` | 构建、链接并持续监听源码变动；Worker 变更时切候选激活代，Module Federation remote 走 Vite HMR。 |
| `dimo-plugin run build [dir]` / `dimo-plugin run test [dir] [--host]` | 在绑定 Host 上下文中执行构建或测试。 |
| `dimo-plugin install --link [dir]` | 构建并将目录登记为 linked development 插件。 |
| `dimo-plugin reload [id\|dir]` | 重新检视链接目录并触发候选激活代切换。 |
| `dimo-plugin uninstall [dir] [--delete-data]` | 从 Host 卸载该插件（默认保留用户数据，不删除开发源码目录）。 |
| `dimo-plugin doctor [dir]` | 查询 Host 上的安装状态、激活代、Runtime 探测、已发布贡献、Agent 绑定与最近崩溃。 |
| `dimo-plugin toolchain` | 输出本机 Host 版本、CLI、contract、JS / Python / Rust SDK 路径与全部可用模板名。 |

`init --template` 支持全部 16 个模板：`skill`、`mcp`、`file-tab`、`editor-tab`、`full`、`ts-worker`、`node-worker`、`python-worker`、`rust-worker`、`host-service`、`hooks`、`host-chrome`、`provider-import`、`provider-catalog`、`panel`、`kanban-view`。

### 5.2 `dimo plugin`（`npx-cli`）— 统一用户与开发者入口

```bash
# 开发者工作流
dimo plugin run server --http://127.0.0.1:17891 --token <token>
dimo plugin add --dev .                  # 仅链接目录并立即返回（不启动 HMR）
dimo plugin run dev                      # 构建、监听源码变更并驱动热更新 / Vite HMR
dimo plugin run build
dimo plugin run test --host
dimo plugin publish                      # 发布至插件市场

# 用户安装与生命周期管理
dimo plugin add --web <git-or-url>#<tag> [-y]
dimo plugin add --profile <file.vxp>
dimo plugin list
dimo plugin enable <plugin-id>
dimo plugin disable <plugin-id>
dimo plugin update <plugin-id> [--ref <tag>] [--yes]
dimo plugin remove <plugin-id> [--delete-data]
dimo plugin gc-runtimes
```

## 6. 离线测试 Harness（`@dimoai/plugin-sdk/testing`）

```ts
import {
  createPluginTestHarness,
  createWorkerHarness,
  createGenerationHarness,
} from '@dimoai/plugin-sdk/testing';

const harness = createPluginTestHarness({ pluginId: 'acme.my-plugin' });
await harness.activate(myPlugin);
await harness.dispose();

const worker = await createWorkerHarness(workerDef, {
  context: { pluginId: 'acme.my-plugin', pluginVersion: '1.0.0', generation: 1 },
});
await worker.invoke('hello', {});
await worker.dispose();

const gen = await createGenerationHarness(workerDef, { requiredHandlers: ['hello'] });
await gen.activateCandidate(workerDef);
await gen.dispose();
```

Harness 支持验证 UI 注册与 `dispose()` 零残留、declared/undeclared handler 匹配、Host API 桩调用与断言、候选代切换/回滚以及 `createAppHarness` 消息桥语义。跨平台进程生命周期、Electron WebView 与真实 Agent 投影仍需配合 `dimo plugin run test --host` 进行实机验证。

## 7. SDK 版本与兼容原则

- 稳定接口遵循 SemVer；实验性接口以 `experimental_` / `experimental.*` 明确标注。
- 插件应优先通过握手阶段的能力协商（`features`）判断宿主支持度，而非硬编码版本猜测。
- 官方插件全部仅依赖公开 SDK 与清单契约，由 CI 的 `pnpm run plugin:no-privilege` 持续强制门禁。
