---
status: accepted
date: 2026-08-17
decision-makers: Dimo maintainers
---

# Host 家族分发与客户端表面

## Context

Dimo 只发行一个执行面：**Dimo Host**（`dimo-server`）。桌面应用、浏览器 WebUI、远程桌面工作站、原生移动端 Companion 以及 IM 聊天通道全部连接到同一个 Host 执行核心。本决定补充 [ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md) 的多端共享架构，定义 Host 家族的拓扑、发行物形态与四类客户端表面的权限边界。Apple Developer ID 与 Windows Authenticode 不作为发行门槛，但 updater 签名与 SHA-256 校验必须保持强制。

## Decision

### 1. 拓扑：单数据目录单 Host

同一数据目录在同一时刻只允许一个 Dimo Host 拥有写权。Agent 进程、Git worktree、Automation 调度器、Plugin Kernel 与 Worker、官方产品 MCP 和 Chat channel 适配器全部运行在 Host 上。

```text
移动 Companion（iOS / Android）──┐
IM Chat Channel ────────────────┤
远程桌面 Workstation ────────────┼── Remote Protocol v1 / Chat Channel ──▶ Dimo Host
本机 Electron 桌面壳 ────────────┘         （dimo-server --desktop 或独立 dimo-server）
```

桌面应用采用 Electron 壳（`electron/`）托管本机 `dimo-server --desktop` sidecar（ADR-0090）；当目标数据目录已被独立运行的 `dimo-server` 占用时，桌面应用作为客户端连接该 Host，不再启动第二份 Host 进程。

### 2. 同版本家族发行物

每次产品版本同步产出同一 semver 家族的发行物：

| 产物 | 形态 | 内容 |
| --- | --- | --- |
| Dimo Desktop | `.dmg` / NSIS / `.msi` / `.AppImage` / `.deb` | Electron 桌面壳 + `dimo-server` sidecar + 前端 + `dimo-mcp` + `dimo-workflow-mcp` + 官方插件快照 |
| Dimo Server | 跨平台压缩包 / 可选 Docker | `dimo-server`、`dimo-mcp`、`dimo-workflow-mcp`、`web/`、`plugins/bundled/` |
| Dimo Companion | 原生 Android（[ADR-0041](0041-native-kotlin-compose-android-companion.md)）与原生 iOS（[ADR-0084](0084-native-swiftui-ios-companion.md)） | 薄客户端，复用 Remote Protocol v1，不运行 Agent 或插件 |

不单独发行独立 MCP 安装器、独立插件守护进程、第二套 Web 管理台或自研 IM 客户端。Server 发行包目录结构统一为：

```text
dimo-server
dimo-mcp
dimo-workflow-mcp
web/
plugins/bundled/
```

安装器仅下载明确指定的版本并强制校验 SHA-256（含包内 `SHA256SUMS`）；存在 minisign 私钥时同步发布 `.sig`。官方 Releases 必须如实标明安装包的代码签名状态。

### 3. 四类客户端表面与权限预设

设备配对时可选择 **Device permission preset**；预设仅用于组织 scopes，鉴权始终按细粒度 scope 执行，新增 scope 不得自动加入旧预设。

- **本机控制台（Host Console）**：运行 Host 的本机环境。无需配对，可管理监听地址、TLS/Reachability、管理员 token、已配对设备、备份恢复以及任意插件与 Agent 安装。
- **Workstation Device**：另一台电脑上的桌面客户端。几乎完整接管 Host 上的编码工作（Project / Workspace / Conversation / Turn / 文件读写 / Git 写 / 终端 / Workflow / Automation / 启用与使用插件），但不接管 Host 运维（公网监听暴露、管理员 token、撤销他人设备、备份恢复、升级 Host 二进制）。其 scope 集合为 `DEVICE_SCOPES` 加上 `application.call` 与 `plugin.write`，排除所有 Host 管理 scope。嵌入浏览器（Electron `<webview>` + `crates/browser-host`）与本机 Office 自动化留在 Host 机器，远程通过 capabilities 与 preview proxy 消费，不在客户端复制一套 runtime。
- **Companion Device**：原生 iOS 与 Android 薄客户端（`mobile/ios`、`mobile/android`）。支持会话读写、审批、取消、纠偏、只读 Artifact、离线缓存与终态通知摘要；不包含插件写入、Workflow/Automation 写入、终端或 Git 写 scope。
- **Chat Channel**：非 Paired device。Telegram、Discord、飞书、企业微信、微信 iLink、QQ 等适配器运行在 Host 上，仅接收授权发送者的入站命令并投递不含秘密的摘要。

### 4. 插件与远程协议绑定

Plugin Kernel、Worker、App surface、Runtime lock 与 Activation Generation 归属当前数据目录所在的 Host。远程 Workstation 通过统一的 Application Core 接缝操作 Host 上的插件事实；官方插件快照随 Host 物化，第三方 `.vxp` 也仅安装在该 Host 上。

所有非 IM 客户端共用 Remote Protocol v1：一次性配对 secret 有效期 5 分钟，兑换后的长期 device credential 存入系统凭据存储（Keychain / Credential Manager / Android Keystore）。监听默认绑定 loopback；开放 LAN 或公网需显式二次确认，TLS 终止由外部反代承担。桌面与 Server 要求同版本家族；Companion 允许落后一个次版本并通过 capabilities 协商，缺 scope 或 capability 时 fail-closed。

## Consequences

- `CreatePairingRequest` 支持可选 `preset` 参数并展开为对应 scope 集合；显式指定 scopes 的配对请求保持兼容，但必须受限于设备等级允许的子集。
- Workstation 成为远程桌面的标准权限预设。
- Chat channel 适配器与 Plugin Kernel 随 `dimo-server` 统一托管，客户端零双写。
- 缺失商业代码签名证书不阻塞 Server 发行或未公证桌面安装包发布，但必须以校验和与显式状态声明保障供应链透明度。

## Considered Options

- **将 IM 通道建模为第四种 Paired device**：否决。IM 平台缺乏客户端设备凭据存储，授权发送者白名单足以表达入站信任。
- **远程桌面在客户端本地复制一份 Host**：否决。双数据目录会破坏 Automation 单所有者 lease、SQLite 单写者约束与插件 activation generation 一致性。
