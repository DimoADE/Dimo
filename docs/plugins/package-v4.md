# Dimo Plugin Package v4 规范

本文定义 Dimo Plugin Package v4 的标准目录布局、`.dimo-plugin/plugin.json` 清单格式、内容与配置模型，以及 `.vxp` 打包契约（遵循 [ADR-0047](../adr/0047-product-centric-plugin-package-and-content-model.md)、[ADR-0048](../adr/0048-full-trust-plugin-execution-model.md) 与 [ADR-0069](../adr/0069-everything-is-a-plugin-platform.md)）。

> 所有 **23 类贡献点**的完整注册状态、宿主消费者与 155 个 `host-api` 操作的权威清单见自动生成的 [`contract-bindings.md`](contract-bindings.md)。

## 1. 标准目录布局

```text
my-plugin/
├─ .dimo-plugin/
│  ├─ plugin.json              # 身份、兼容性、入口与贡献声明（必填）
│  ├─ content.index.json       # 作者维护、build 严查、Host 复验的内容索引
│  ├─ package.lock.json        # build 生成的不可变执行内容摘要
│  ├─ signature.json           # 可选：签名证据
│  └─ sbom.spdx.json           # 可选：SBOM
├─ README.md                    # 根目录说明；frontmatter 提供一句话 summary（必填）
├─ config.json                  # 用户配置的唯一事实文件（可选，存在 schema 时由 Host 原子维护）
├─ assets/
│  └─ icon.svg                 # 插件图标
├─ contents/                    # 用户与 Agent 可见的内容资产
│  ├─ skills/<name>/SKILL.md
│  ├─ mcps/<name>.json
│  ├─ workflows/<name>/workflow.json
│  └─ resources/               # 模板、示例与其他只读资源
├─ depends/
│  └─ runtimes/<id>.json       # 声明式本地 Runtime 依赖描述
├─ app/                         # protocol: "2.0" 联邦模块 / 宿主内 App 入口（如 app/main.js）
├─ runtime/                     # Worker / protocol: "1.0" App 源码（不进入 .vxp 发布物）
└─ dist/                        # build 产出的确定性执行物（如 dist/worker.mjs、dist/app/index.html）
```

### 路径安全规则

所有清单路径必须相对于包根目录并使用 `/` 分隔符。校验器和 Host 拒绝绝对路径、`..` 路径穿越、符号链接/硬链接逃逸、大小写碰撞、重复规范路径以及超出限额的归档条目。

## 2. `README.md` 与 `summary`

根目录 `README.md` 必须通过 YAML frontmatter 提供独立的 `summary` 字段：

```markdown
---
summary: Preview, create, and transform Word, Excel, and PowerPoint documents.
---

# Dimo Office

完整插件说明正文……
```

规范要求：

- `summary` 必须为单句纯文本（不支持 Markdown），非空且不超过 200 个 Unicode 字符；
- 宿主不从 Markdown 标题或正文段落推断简介；
- 插件目录列表与详情标题区展示 `summary`；「内容」Tab 展示去除 frontmatter 后的完整 `README.md`。

## 3. 根 `config.json` 与 `config.schema`

根 `config.json` 是插件配置的唯一事实来源，Host 不维护第二份数据库副本：

```json
{
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "idleTimeoutMinutes": {
          "type": "integer",
          "title": "空闲后停止预览",
          "minimum": 1,
          "maximum": 60,
          "default": 10
        }
      },
      "additionalProperties": false
    }
  }
}
```

- 配置路径固定为包根目录 `config.json`，`plugin.json` 中只声明 `config.schema`；
- 插件详情「配置」Tab 根据 `config.schema` 渲染表单，Host 写入前先按 Schema 校验，再通过同目录临时文件 + `fsync` + 原子替换落盘；
- `config.json` 属于可变用户数据，不计入可执行包摘要（`packageDigest`）与激活代签名；更新插件时默认保留用户配置，若新 Schema 拒绝旧值则阻止升级；卸载时按用户选择保留或删除。

## 4. 内容索引（`.dimo-plugin/content.index.json`）

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "path": "contents/skills/word/SKILL.md",
      "kind": "skill",
      "title": "Word documents"
    },
    {
      "path": "contents/workflows/create-document/workflow.json",
      "kind": "workflow",
      "title": "Create document"
    }
  ]
}
```

UI 只读取经 Host 验证返回的结构化索引与文档，不在客户端任意扫描目录。索引中所有 `path` 必须存在于 `contents/` 内并通过 `dimo-plugin build` / `validate` 检查。

## 5. `.dimo-plugin/plugin.json` 清单规范

```json
{
  "$schema": "https://schemas.dimo-ai.com/plugin/v4/plugin.schema.json",
  "manifestVersion": 4,
  "apiVersion": "2.0",
  "id": "you.notes",
  "publisher": "you",
  "version": "1.0.0",
  "name": "Notes",
  "readme": "README.md",
  "engines": {
    "dimo": ">=0.5.0 <1.0.0",
    "pluginSdk": "^2.0.0"
  },
  "content": {
    "root": "contents",
    "index": ".dimo-plugin/content.index.json"
  },
  "config": {
    "schema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "entrypoints": {
    "worker": {
      "path": "dist/worker.mjs",
      "runtime": "node",
      "protocol": "1.1",
      "maxFrameMiB": 32
    },
    "app": {
      "entry": "app/main.js",
      "protocol": "2.0"
    }
  },
  "dependencies": [],
  "integrations": [],
  "interface": {
    "icon": "assets/icon.svg"
  }
}
```

### 顶层字段要点

- **产品身份**：由 `(publisher, id)` 共同唯一确定；派生他人源码打包时必须更换新的 `(publisher, id)`，并可在清单中附加 `derivedFrom` 溯源字段。
- **固定路径约定**：`readme` 固定为 `"README.md"`，`content.root` 固定为 `"contents"`，配置固定为根 `config.json`。
- **至少一项贡献**：插件必须至少声明一项受宿主识别的 `integrations`（或声明式 `themes`）；App-only、Theme-only、Provider-only 与 Agent-only 包均一等合法。
- **Full Trust 执行模型**：安装或启用即授予与 Dimo Host 一致的本机用户权限，清单无需声明 capability permissions。

### `entrypoints.worker`

| 字段 | 说明 |
| --- | --- |
| `path` | Worker 可执行入口相对路径（如 `dist/worker.mjs`、Python 脚本或原生二进制）。 |
| `runtime` | 固定为 `"node"`、`"python"` 或 `"native"`。 |
| `protocol` | 固定为 `"1.1"`（stdio JSON-RPC 2.0，握手顺序 `initialize` → `activate`）。 |
| `maxFrameMiB` | 可选，单帧上限整数，范围 `1..128`（默认 `32` MiB）；逻辑消息上限 `64` MiB，超单帧自动分片（`frame.chunk`）。 |

### `entrypoints.app`（渲染三轨中的两种代码轨）

| 协议 | 清单形状 | 适用场景与 SDK 入口 |
| --- | --- | --- |
| `protocol: "2.0"`（Module Federation / 宿主内 App） | `{ "entry": "app/main.js", "protocol": "2.0" }` | 高频交互面板、看板视图、设置页、命令、Turn Hook 与 IoC 服务；入口导出 `defineDimoPlugin((ctx) => ...)`（`@dimoai/plugin-sdk`）。 |
| `protocol: "1.0"`（独立 HTML Surface App） | `{ "root": "dist/app", "document": "index.html", "protocol": "1.0" }` | 文档型 / 富媒体独立页面（如 `plugin.detail.panel` 与 `artifact.editor`）；入口导出 `definePluginApp(({ root, bridge, signal }) => ...)`（`@dimoai/plugin-sdk/app`）。 |

纯声明式宿主渲染槽位（如 `app.command`、`app.status`、`app.composer.slash` 等 `L1` descriptor）由宿主组件库直接渲染，无需提供 `entrypoints.app`。

## 6. `integrations`（23 类贡献点）

每条 integration 必须声明稳定的 `id` 与宿主识别的 `kind`。运行时 Worker / App 只能绑定清单中已声明的 integration，不得动态注册未声明的 contribution（属于契约校验）。

23 类贡献点按层级划分为四组（各项的 `ready` / `preview` / `unimplemented` 状态与前端/Rust 消费入口以 [`contract-bindings.md`](contract-bindings.md) 为唯一权威）：

- **L0 内容与 Agent 集成**：`content.skill`、`content.mcp`、`content.hook`（清单可校验，宿主无静态 Hook 运行时；动态 Turn Hook 请使用 `protocol: "2.0"` 的 `ctx.hooks`）、`workflow.binding`。
- **L1 宿主渲染 UI（Descriptor 轨）**：`app.command`、`app.toolbar`、`app.status`（支持 `status.main` 与 `status.after-mcp` 槽位）、`app.composer.slash`、`app.composer.action`、`app.timeline.card`、`app.settings.section`、`app.rail.section`、`file.opener`、`artifact.preview`。
- **L2 后台服务与 Provider 接缝**：`host.service`、`provider.model.importSource`、`provider.model.catalog`、`provider.remote.provisioner`。
- **L3 结构面与自定义视图**：`app.panel`（Dockview 面板，支持 `multiInstance`）、`app.tab`、`app.kanban.view`、`app.settings.page`（设置侧栏整页）、`app.surface`。

### 关键贡献点契约

- **`app.surface.slot`**：允许值为 `plugin.detail.panel`（插件详情页「配置」Tab 扩展面）与 `artifact.editor`（可编辑文件 Tab）。`app.timeline.card` 与 `app.settings.section` 的承载面由宿主自动合成。
- **可编辑文件 Tab 契约**：`file.opener` 通过 `editorSurface` 指向一个 `slot: "artifact.editor"` 的 `app.surface`。宿主保留真实文件路径，向 App 提供文件名、revision 与 `bridge.artifact.readText()` / `writeText(content, expectedRevision)`，写入按期望 revision 原子替换并检测外部冲突。
- **`icon` 约束**：宿主界面槽位的 `icon` 字段必须来自 `@dimo/plugin-contract/catalog/icons` 公开图标白名单，校验器与宿主共同验证。
- **`content.mcp` 资源格式**：指向 `contents/mcps/*.json`，支持四种启动形状：
  1. `managedRuntime.kind = "hostFamilyBinary"`（随 Host 分发的家族二进制 MCP，工具目录由宿主填充）；
  2. `managedRuntime.kind = "workerHttp"`（Worker 暴露 loopback HTTP MCP，激活时返回 `{ url, headers }`）；
  3. `managedRuntime.entrypoint`（包内 STDIO 脚本，宿主解析 Node、入口与 `host.call` 环境）；
  4. 静态 `command` + `args`（STDIO 命令，宿主补全路径与 `cwd`）。
  除 `hostFamilyBinary` 外，资源应声明 `tools` 列表以便状态栏在 Agent 连接前展示工具目录。

## 7. `dependencies`（单层扩展规则）

`dependencies` 仅用于声明本地 **Runtime 依赖**（`kind: "runtime"`，引用 `depends/runtimes/*.json`）：

```json
{
  "dependencies": [
    {
      "kind": "runtime",
      "descriptor": "depends/runtimes/officecli.json"
    }
  ]
}
```

- Runtime 精确锁身份为 `id + version + target + digest`，支持多版本并存；由 Host 统一负责下载、SHA-256 校验、健康探测（probe）、引用计数与 GC。
- 遵循单层扩展原则（[ADR-0069](../adr/0069-everything-is-a-plugin-platform.md)）：**不存在插件依赖插件**，校验器与 Host 均拒绝 `kind: "plugin"`。

## 8. 构建、打包与 UI 契约

- **`dimo-plugin build`**：完整遍历并报告清单、`README.md` `summary`、`config.schema`、`content.index.json`、`integrations` 与 `dependencies` 的全部校验问题；将源码编译至 `dist/`；生成 `.dimo-plugin/package.lock.json`。
- **`dimo-plugin pack`**：产出确定性 `.vxp` 归档并输出 `sha256:` 摘要。归档包含 `README.md`、初始 `config.json`、`contents/`、`depends/`、`assets/`、`app/`、`dist/` 与 `.dimo-plugin/` 元数据；排除 `runtime/` 源码、source map、`.git`、`node_modules`、开发链接元数据与本机绝对路径。
- **UI 契约**：`/plugins` 展示「已安装」与「插件市场」两个 Tab；`/plugins/:pluginId` 仅展示「内容」与「配置」；操作失败以本地化 Toast 呈现；generation、handler、runtime lock 与崩溃证据收敛在诊断视图与 `dimo-plugin doctor`。
- **参考实现**：官方 `plugins/office`（`dimo.office`）完全基于本规范与公开 SDK 构建，宿主不按插件 ID、文件扩展名或 `officecli` 名称做任何特判。
