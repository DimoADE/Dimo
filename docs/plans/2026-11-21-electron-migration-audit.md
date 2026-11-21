# Tauri → Electron + `dimo-server` 迁移后全量功能接线与异常隐患排查报告（核验合并版）

- **日期**：2026-11-21
- **合并来源**：合并并逐条源码核验了首轮排查报告与 [`2026-11-21-electron-migration-post-audit.md`](./2026-11-21-electron-migration-post-audit.md)，剔除误报、修正细节偏差，并补全双边独有发现。
- **对比基线**：原 `HEAD:src-tauri` 桌面壳 → Electron + `dimo-server --desktop` Sidecar 架构（参考 [`2026-11-20-tauri-to-electron-migration-plan.md`](./2026-11-20-tauri-to-electron-migration-plan.md)）
- **核验标准**：所有保留条目均经当前工作区源码（及 `HEAD:src-tauri` 历史对照）直接核实，附精确文件路径、行号、触发链路与修复建议。

---

## 0. 对照核验结论与总览

### 0.1 已在本轮完成修复的问题

| 编号 | 问题 | 根因 | 修改文件 | 状态 |
| --- | --- | --- | --- | --- |
| FIXED-1 | Windows 创建会话发送消息后永久停在「连接中」、无报错、无 AI 网络请求 | Electron 以同步管道打开 `stdin`，`dimo-stdin-watchdog` 阻塞 `ReadFile` 占住内核 `FILE_OBJECT` 锁，导致发消息前的 `git rev-parse --git-dir`（`tokio::process::Command::output()` 默认继承 `stdin`）启动死锁 | `crates/server/src/bin/dimo-server.rs`、`crates/utils/src/process.rs`、`crates/agents/src/checkpoint_ref.rs` | 已改源码，待重编 `dimo-server` |

### 0.2 `post-audit.md` 核验纠偏记录（已剔除误报 / 已修正细节）

| 原文档条目 | 核验结论 | 核实依据与处理方式 |
| --- | :---: | --- |
| `updater.ts:266-268` `latest-arm64` 与 `electron-builder.yml` 仅构 `x64` 矛盾 | **误报（已剔除）** | `.github/workflows/desktop-release.yml:160-179, 364` 显式构建 `windows-arm64`（`--win --arm64`），并由 `scripts/generate-tauri-bridge-manifest.js:29-33` 发布为 `latest-arm64.yml`，接线正确 |
| `PluginDevConnection::current()` 空壳与 `plugin_dev_server::start` 迁移遗漏 | **误报（已剔除）** | 核对 `HEAD:src-tauri/src/plugin_dev_server.rs:42-65`，原 Tauri 实现本身即仅启动 `start_artifact_http` 并返回 `token: ""`，现 `composition.rs:480` 已 1:1 迁移（保留独立安全项 P2-5：LAN Web Service 下 `/api/v1/plugin-artifacts/*` 无鉴权） |
| Voice Input 麦克风权限缺失（原 P1-8 #4） | **部分误报（降级至 P2-6）** | 前端 `frontend/src/` 无 Voice Input 功能（仅第三方库导出未使用符号）；但 Electron 侧确实缺少 `NSMicrophoneUsageDescription`、`com.apple.security.device.audio-input` 与 `setPermissionRequestHandler` |
| `theme-changed` 归入 `SHELL_ONLY_EVENTS`（原 P1-8 #3） | **需纠偏（降级至 P2-7）** | 本地设置窗同步依赖 IPC `backendEmit('theme-changed')`，**不可直接移出 `SHELL_ONLY_EVENTS`**（否则本地切主题反会失效）；仅服务端 WS 推送被忽略，且有 `settings_watcher` 兜底刷新 |
| `import_cli_inbox` / `warm_agent_management` 遗漏（原 P1-8 #1） | **精准化（合并入 P1-9）** | `import_queued_developer_links()`（`composition.rs:392`）与 `warm_local_runtime_discovery`（`composition.rs:583`）已迁入；真正缺失的是 `~/.dimo/imports` 压缩包导入（`import_cli_package`）、`reconcile_managed_cli_exposures` 与 `warm_agent_management` |
| `previewMediaActions.ts:9` 跨源 `fetch(dimo-asset://...)`（原 P1-4） | **精准化（合并入 P1-6）** | `dimo-asset://` 缺 CORS 确实影响 `HostHtmlPreview.tsx` 沙箱 HTML 预览；但 `previewMediaActions.ts` 当前实际消费的是 `blob:` / `http(s):` URL |
| `ClaudeSettings` 清空整个 `~/.claude/settings.json`（原总览） | **精准化（P0-5）** | 仅清空 `enabledPlugins` 字段，`env` 与其他顶层键会被保留 |
| macOS `Cmd+,` 行号与影响（原 P1-8 #6） | **精准化（P2-6）** | 实际位置为 `chrome.ts:415-416, 443`（410 行是 `Cmd+N`），仅聚焦远程主机窗口 `host-<id>` 时错开本地设置窗 |
| 原“已核实正常”称外链仅限 `http/https/mailto` | **精准化（见第 4 节）** | 仅 `windows.ts` 弹窗拦截限 `http/https/mailto`；`osBridge.ts` 允许 9 种协议及任意本地绝对路径 |

### 0.3 合并后待修复问题总表

| 编号 | 级别 | 所属层 | 问题摘要 | 主要涉及文件 |
| --- | :---: | --- | --- | --- |
| P0-1 | **P0** | Electron + Rust | Sidecar `stdout` 停读导致 Windows 4KB 管道死锁（含 `agent_install` 34 处运行时 `println!` 与子进程继承 `stdout`） | `electron/src/main/sidecar.ts`、`crates/server/src/agent_install*.rs`、`crates/utils/src/process.rs` 等 |
| P0-2 | **P0** | Rust | `plugin_control_import_cli` 对 `Stdio::piped()` 调用 `.status().await` 必现管道死锁且无超时 | `crates/server/src/domains/plugins_catalog.rs` |
| P0-3 | **P0** | Rust | `current_host_events()` 未绑定 task-local 导致 2 处必现 Panic（本地历史批量导入永久 409、插件 `provider.presets.save/bind`） | `crates/server/src/host/{surface,provider_bind,native_commands}.rs`、`crates/plugins/src/host_call.rs` |
| P0-4 | **P0** | Electron + Rust | 打包版全平台找不到 `claude-native-driver.mjs`，Claude Native 引擎完全不可用 | `electron/electron-builder.yml`、`crates/agents/src/engine/claude_events.rs`、`crates/server/src/bin/dimo-server.rs` |
| P0-5 | **P0** | 前端 + Rust | `get_claude_settings` / `update_claude_settings` 字段大小写错配，每次保存清空 `enabledPlugins` | `crates/server/src/host/catalog/config.rs`、`frontend/src/lib/api/config.ts` |
| P0-6 | **P0** | 前端 + Rust | 6 个命令反序列化参数错配，调用必报 `400 Bad Request` | `crates/server/src/host/{workspace_parity,surface}.rs`、`frontend/src/lib/api/{tasks,attempts,config,plugins}.ts` |
| P0-7 | **P0** | 前端 + Rust | 5 个 Workspace 命令把错误包进 HTTP 200，`push_workspace_branch` 丢弃 `PushError`，且 `WebTransportError` 丢弃 `ErrorEnvelope.details` | `crates/server/src/host/{workspace_parity,product}.rs`、`frontend/src/lib/transport/webTransport.ts`、`frontend/src/lib/api/attempts.ts` |
| P0-8 | **P0** | Electron | 自动更新 `quitAndInstall()` 在 Windows 存在退出竞态、macOS 存在 Squirrel.Mac 断链与未捕获崩溃 | `electron/src/main/{updater,index,chrome}.ts`、`frontend/src/lib/appUpdate/check.ts` |
| P0-9 | **P0** | Electron 安全 | Preload 暴露无路径限制的 `fs:readFile` / `fs:write*` IPC，且缺失 CSP | `electron/src/preload/index.ts`、`electron/src/main/{ipc,osBridge,protocol}.ts`、`frontend/index.html` |
| P0-10 | **P0** | Electron + 前端 | 桌面通知 Toast 窗口 `focusable: false` 导致 Quick Reply 无法打字，且 456×520 透明区域吞掉背后应用点击 | `electron/src/main/desktopToast.ts`、`frontend/src/components/desktop-toast/DesktopToastWindow.tsx` |
| P0-11 | **P0** | 前端 + Preload | 会话输入框拖拽文件触发 2~3 次重复上传 + 非媒体文件走错分支 + HiDPI 坐标误命中 | `electron/src/preload/index.ts`、`frontend/src/components/tasks/follow-up/{composerHostFileDrop.ts,session-composer-input/*}` |
| P1-1 | **P1** | Rust + 前端 | Git 仓库命令返回类型错误（`get_repo_commit_diffs` 返回 `CommitDetail`、`pull_repo` 返回 `null`） | `crates/server/src/host/product.rs`、`frontend/src/lib/api/repos.ts` |
| P1-2 | **P1** | Rust + 前端 | 插件更新 `plugin_update` 与市场列表 `plugin_marketplace_index` Schema 错配 | `crates/server/src/host/{surface,plugin_updates}.rs`、`frontend/src/lib/api/plugins.ts` |
| P1-3 | **P1** | Electron | Sidecar 异常崩溃后无监控、不重启、不清空死连接、不通知前端 | `electron/src/main/{sidecar,ipc,crashReporter}.ts` |
| P1-4 | **P1** | Rust | Windows 在线 SQLite 备份/恢复缺陷（占用中直接 `fs::rename` 报共享冲突、备份无 WAL checkpoint） | `crates/server/src/desktop/backup.rs` |
| P1-5 | **P1** | Rust + Electron | Electron `resources/bin/` 布局破坏历史数据迁移、VibeX 探测与 macOS 更新前防删库检查 | `crates/utils/src/assets.rs`、`crates/server/src/data_dir_adoption.rs`、`electron/src/main/{index,updater}.ts` |
| P1-6 | **P1** | Electron + 前端 | `dimo-asset://` 缺 `Access-Control-Allow-Origin` 与 `OPTIONS`，沙箱 HTML 预览拦截 ES Module / `fetch()` | `electron/src/main/protocol.ts`、`frontend/src/components/previews/HostHtmlPreview.tsx` |
| P1-7 | **P1** | Rust | WebSocket `RecvError::Lagged` 静默丢弃 `PatchStream` 增量补丁，导致前端状态永久错位 | `crates/server/src/ws.rs`、`crates/server/src/host/{events,streams}.rs` |
| P1-8 | **P1** | Rust | Windows 子进程树清理与守护缺失（`git_impl_timed` 孙进程卡死、Plugin Worker 缺 Guardian Job 与 30s/180s 锁超时错配、`installers` 缺 `kill_on_drop`） | `crates/git/src/cli.rs`、`crates/utils/src/process.rs`、`crates/plugins/src/worker_host.rs`、`crates/server/src/agent_install/installers.rs` |
| P1-9 | **P1** | Rust | Tauri 启动/关闭钩子遗漏（`import_cli_package`、`reconcile_managed_cli_exposures`、`warm_agent_management`、关机漏调 `stop_relay()`） | `crates/server/src/composition.rs`、`crates/server/src/desktop/web_service.rs` |
| P1-10 | **P1** | Electron + 前端 | Linux 无边框窗口缺失最小化/最大化/关闭按钮及标题栏双击最大化 | `electron/src/main/windows.ts`、`frontend/src/components/settings/{DesktopWindowControls,AppTitleBar}.tsx` |
| P1-11 | **P1** | Electron 打包 | Windows `AppUserModelID` 打包与运行时不一致；EVSign 流内层 exe 未签名、跳过更新验签、破坏 `.blockmap` | `electron/electron-builder.yml`、`electron/src/main/{index,windows}.ts`、`.github/workflows/desktop-release.yml`、`scripts/sign-windows-evsign.ps1` |
| P2-1 | **P2** | Electron + Rust | 远程 SSH 编辑器白名单漏 `vscode-insiders:` / `antigravity:`；带 `.` 的 SPA 路由 404；流读取缺 `error` 监听 | `electron/src/main/{osBridge,protocol}.ts`、`crates/services/src/services/config/editor/mod.rs` |
| P2-2 | **P2** | Electron | Host Browser `will-navigate` 把 `POST` 表单降级为 `GET`、缺 `will-redirect` 拦截、`will-download` 覆盖同名文件 | `electron/src/main/browser/controller.ts` |
| P2-3 | **P2** | Electron | 冷启动会话深链与早期 `second-instance` 参数丢失；隐藏 `settings` 窗导致无托盘时进程无法退出 | `electron/src/main/{index,deeplink,windows,desktopToast}.ts` |
| P2-4 | **P2** | Rust | Tokio 异步线程内同步阻塞 I/O；关机任务滞后于 WAL checkpoint；退出误杀多实例 MCP；Host 自更新未屏蔽 `--desktop`/Windows | `crates/server/src/desktop/{backup,mod}.rs`、`crates/server/src/host/{surface,remote_profiles,catalog/system}.rs`、`crates/utils/src/process.rs`、`crates/server/src/composition.rs` |
| P2-5 | **P2** | Rust 安全 | `/api/v1/plugin-artifacts/*` 未鉴权且 `ACAO: *`，开启 LAN Web Service 后局域网可直接读取插件文件 | `crates/server/src/{runtime,plugin_artifact}.rs` |
| P2-6 | **P2** | Electron | Windows/Linux 未禁用默认菜单（快捷键冲突）、原生菜单硬编码中文、macOS `Cmd+,` 远程窗错位、缺 `setPermissionRequestHandler` 与麦克风权限配置 | `electron/src/main/{chrome,ipc}.ts`、`electron/electron-builder.yml`、`electron/build/entitlements.mac.plist` |
| P2-7 | **P2** | 前端 + Rust | 零散接线与残留：`configuredBackendTransport.origin`、`fixture_*`/`record_shell_crash`、`theme-changed` 双总线、`/desktop-toast` 多余挂载 `UserSystemProvider`、版本/能力漂移等 | 见 P2-7 详述 |

---

## 1. P0 — 必现死锁 / 崩溃 / 数据损坏 / 核心不可用 / 高危安全

### P0-1. Windows `sidecar.ts` 停读 `dimo-server` 的 `stdout` 导致 4KB 管道死锁
- **涉及文件**：
  - `electron/src/main/sidecar.ts:189-266`
  - `crates/server/src/agent_install.rs:452, 505, 513, 546, 552, 903, 1310, 1327, 1330, 1364, 1384, 1406, 1409, 1422, 1427, 1433, 1556, 1560, 1577, 1592, 1639`（21 处运行时可达 `println!`，另有 10 处仅 CLI 子命令可达）
  - `crates/server/src/agent_install/installers.rs:10, 22, 55, 72, 84, 118, 143, 201, 352, 422, 653, 802, 825`（13 处运行时可达 `println!`）
  - 未重定向 `stdout`/`stderr` 的 `.spawn()` 调用点：`crates/services/src/services/config/editor/mod.rs:239, 262, 392-394`、`crates/server/src/host/plugin_conversation.rs:724-727`、`crates/server/src/host/catalog/config.rs:229-243`、`crates/server/src/host/management/diagnostics_and_env.rs:396-403`（原始 `Command::new("cmd")` 且闪黑框）、`crates/server/src/host/catalog/version_control.rs:394-398`、`crates/server/src/desktop/launcher.rs:456-472, 534-538`、`crates/utils/src/browser.rs:71-74`
- **根因**：`sidecar.ts:191` 以 `stdio: ['pipe', 'pipe', 'pipe']` 启动 `dimo-server`，读完 `dimo-server-ready` 后在 `260-261` 行关闭 `stdoutReader`，此后 `child.stdout` 处于暂停状态再也不排空。桌面端触发 Agent 安装（34 处 `println!`）或任意继承 `stdout` 的子进程累计输出超过 Windows 4 KiB 管道缓冲后，下一次写操作永久阻塞（`println!` 还会持住全局 `stdout` 锁拖死 Tokio 线程）。
- **修复建议**：
  1. `sidecar.ts`：握手完成后保持持续排空 `child.stdout`（如 `child.stdout.on('data', ...)` 转发日志或丢弃）；Windows 传 `--parent-pid` 时使用 `stdio: ['ignore', 'pipe', 'pipe']`。
  2. `agent_install.rs` / `installers.rs`：服务运行时进度日志改走 `tracing::info!`（落到 stderr/日志文件），不要写 `stdout`。
  3. 所有不采集输出的 `.spawn()` / `.status()` 显式设 `.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())`，并修复 `diagnostics_and_env.rs:396` 的黑框问题。

---

### P0-2. `plugin_control_import_cli` 管道必现死锁 + 无超时
- **涉及文件**：`crates/server/src/domains/plugins_catalog.rs:770-780`
- **根因**：代码为 `.stdout(Stdio::piped()).stderr(Stdio::piped()).status().await`。`.status()` 不会消费管道，只要 `claude`/`codex` CLI 输出超过 4 KiB 就会永久阻塞，且没有超时控制。
- **修复建议**：改用 `utils::process::run_command_output_with_timeout(...)`（自动并发排空管道并带进程树超时终止），或不需要输出时改为 `Stdio::null()` + 超时。

---

### P0-3. `current_host_events()` 未绑定 task-local 导致 2 处必现 Panic
`crates/server/src/host/events.rs:21-36` 的 `current_host_events()` 在 `CURRENT_BUS` 未绑定时直接 `.expect(...)` panic：
1. **本地历史批量导入 Panic + 永久 `409 Conflict`**：`crates/server/src/host/surface.rs:1381-1476, 2579-2586`。置 `job.running = true` 后 `tokio::spawn` 未包裹 `bind_host_events`，首次调用 `apply_history_progress` 释放锁后调用 `current_host_events()` 直接 panic，导致 `job.running = false` 永不执行，后续导入永久 409。
2. **插件 `provider.presets.save` / `provider.presets.bind` Panic**：`crates/plugins/src/host_call.rs:77-94, 238-293`、`crates/server/src/host/provider_bind.rs:116-222`、`crates/server/src/host/native_commands.rs:62-64, 334, 451`。Loopback host-call 服务在裸 `tokio::spawn` 中运行，`save`/`bind` 虽持有 `self.events`，调用 `dispatch_model_provider_save`/`bind` 前却未包裹 `bind_host_events`，触发 `invalidate()` → `current_host_events()` 直接 panic（`bind` 在未绑定且用户同意后触发）。
- **修复建议**：两处均显式包裹 `bind_host_events(events.clone(), ...)`；批量导入增加 `Drop` guard 确保任何异常退出都能重置 `job.running = false`。

---

### P0-4. 打包版 Claude Native 引擎必定找不到 `claude-native-driver.mjs`（全平台失效）
- **涉及文件**：`electron/electron-builder.yml:20-21, 32-35`、`electron/src/main/sidecar.ts:173-184`、`crates/server/src/bin/dimo-server.rs:120`、`crates/server/src/composition.rs:667`、`crates/agents/src/engine/claude_events.rs:484-522`
- **根因**：打包后 `dimo-server` 在 `<resources>/bin/`，而 `claude-native-driver.mjs` 在 `<resources>/scripts/`（相对 `exe_dir` 为 `../scripts/claude-native-driver.mjs`）。`resolve_claude_driver_script()` 的 5 个 release 候选路径都不含 `../scripts/...`，且 `--resources-dir` 未透传给 `agents` 或 `DIMO_CLAUDE_DRIVER_SCRIPT`。开发态因 `debug_assertions` 读仓库源码路径掩盖了该问题，打包发布版 Windows / macOS / Linux 均必报 `BinaryNotFound`。
- **修复建议**：在 `claude_events.rs:505-513` 补充 `exe_dir.join("../scripts/claude-native-driver.mjs")`，并在 `sidecar.ts` 或 `dimo-server.rs` 基于 `--resources-dir` 透传 `DIMO_CLAUDE_DRIVER_SCRIPT`。

---

### P0-5. `get_claude_settings` / `update_claude_settings` 字段错配，每次保存清空 `enabledPlugins`
- **涉及文件**：`frontend/src/lib/api/config.ts:950-962`、`crates/server/src/host/catalog/config.rs:78-84, 628-696`
- **根因**：前端读写 `enabled_plugins`（`snake_case`），后端 `ClaudeSettings` 标注 `#[serde(default, rename = "enabledPlugins")]` 且缺少 `#[serde(alias = "enabled_plugins")]`。读取时前端拿不到 `enabled_plugins`（为 `undefined`）；保存时后端忽略前端发来的 `enabled_plugins` 并回退为空 `{}`，直接覆盖 `~/.claude/settings.json` 中的 `enabledPlugins`（`env` 及其他顶层键不受影响）。
- **修复建议**：API 层统一字段名并补齐 `alias`，文件读写层单独映射为 Claude Code 要求的 JSON 键 `enabledPlugins`。

---

### P0-6. 6 个前后端命令参数反序列化错配，调用必报 `400 Bad Request`
`crates/application/src/args.rs:51-89` 仅解包 `{ payload }` / `{ request }`，不做 `snake_case` ↔ `camelCase` 转换：
1. **`create_task_and_start`**：前端 `tasks.ts:11-31` / `shared/types.ts:486-490, 528` 发 `snake_case`；后端 `workspace_parity.rs:78-97` 强 `camelCase` 无 alias（必报缺 `executorProfileId`，且 `use_worktree: false` 会被默认覆盖为 `true`）。
2. **`create_workspace_from_pr`**：前端 `attempts.ts:684-691` / `shared/types.ts:647-656` 发 `snake_case`；后端 `workspace_parity.rs:64-76` 强 `camelCase` 无 alias（必报缺 `repoId`）。
3. **`weixin_check_qrcode`**：前端 `config.ts:933-940` 发 `{ request: { channel_id, qrcode } }`；后端 `surface.rs:236-241` `WeixinCheckArgs` 为 `camelCase` 无 `alias = "channel_id"`（必报缺 `channelId`）。
4. **`plugin_control_contributions` / `plugin_control_rollback` / `plugin_install`**：前端 `plugins.ts:625-631, 696-700, 761-777` 均不传 `path`；后端 `surface.rs:223-234, 2367-2386, 2422-2464` 统一反序列化为必填 `path: String` 的 `PluginPathArgs`（全报缺 `path`），且 `plugin_install` 尚未实现 `source.marketplace` 分支。
- **修复建议**：前 3 项补齐 `snake_case` alias（或去掉错误的 `rename_all = "camelCase"`）；后 3 项拆出各自独立参数结构体（保留 `PluginPathArgs` 给本地路径命令）并补全 `source.marketplace` 处理。

---

### P0-7. Workspace 业务错误信封错配 + `WebTransportError` 丢弃 `ErrorEnvelope.details`
- **涉及文件**：
  - `crates/server/src/host/workspace_parity.rs:132-190, 282-325, 376-496, 634-751`
  - `crates/server/src/host/product.rs:397-411, 1334-1336`
  - `frontend/src/lib/transport/webTransport.ts:25-43, 331-343`
  - `frontend/src/lib/api/base.ts:47-87`（`invokeAsResult`）、`frontend/src/lib/api/attempts.ts:198-218, 320-372, 684-691`
  - `frontend/src/components/dialogs/tasks/CreatePRDialog.tsx:146-168`
- **根因**：
  1. `webTransport.ts` 的 `ErrorEnvelope` 与 `WebTransportError` 遗漏了 `details` 字段，所有走 `WebTransport`（含 Electron 本地端）的结构化业务错误（`PushError`、`GitOperationError`、`PrError` 等）在 `invokeAsResult` 读取 `'details' in error` 时均变成 `undefined`。
  2. `run_setup_script`、`run_cleanup_script`、`run_archive_script`、`create_workspace_pr`、`create_workspace_from_pr` 将业务错误包装进 HTTP 200 `{ process/url/response, error }`，前端 `invokeAsResult` 一律当作 `{ success: true }`，导致 `CreatePRDialog` 在 `CliNotInstalled`/`CliNotLoggedIn` 时误关弹窗且成功时 `data` 类型错位。
  3. `push_workspace_branch` 使用 `.map_err(internal_error)`，丢失结构化 `PushError`（如 `force_push_required` 弹窗提示）。
- **修复建议**：先在 `WebTransportError` 透传 `details`；再将上述 6 个后端命令统一为成功返回裸 DTO、业务错误通过带 `details` 的 `ApplicationError` 返回。

---

### P0-8. 自动更新 `quitAndInstall()` 在 Windows 退出竞态 & macOS Squirrel.Mac 断链崩溃
- **涉及文件**：`electron/src/main/updater.ts:264, 373-399, 416-427`、`electron/src/main/index.ts:216-261, 341-344`、`electron/src/main/chrome.ts:272-278`、`frontend/src/lib/appUpdate/check.ts:433-444`
- **根因**：
  1. **Windows/Linux 竞态**：`updater.install()` 先调 `prepareForExit()`，销毁托盘与全部窗口触发 `window-all-closed` → `gracefulExit()` → `.finally(() => app.quit())`，在下一微任务直接退出应用，打断 `NsisUpdater` 异步拉起安装器及 `EACCES` → `elevate.exe` UAC 提权回退。
  2. **macOS 断链与崩溃**：`updater.ts:264` 设 `autoInstallOnAppQuit = false` 导致 `MacUpdater` 下载阶段跳过 Squirrel.Mac 预备；直到窗口和后端都撕毁后才启动 `nativeUpdater.checkForUpdates()`，且未注册 `autoUpdater.on('error', ...)`，Squirrel 任何异常直接抛出未捕获崩溃。
  3. **IPC 断链**：`check.ts:435-443` 在 `await pendingUpdate.install()` 后继续调 `close()`/`relaunch()`，但窗口在 IPC 返回前已被销毁。
- **修复建议**：更新安装期间禁止 `window-all-closed` 额外触发 `app.quit()`，将退出控制权交给 `quitAndInstall()`；补全 `autoUpdater.on('error', ...)` 与 macOS Squirrel 预备流程；主进程在销毁窗口前先响应 IPC 或接管重启。

---

### P0-9. Preload 无路径限制本地文件读写 IPC + 缺失 CSP（安全高危）
- **涉及文件**：`electron/src/preload/index.ts:217-229`、`electron/src/main/ipc.ts:200-215`、`electron/src/main/osBridge.ts:111-130`、`electron/src/main/protocol.ts:280-357`、`frontend/index.html:1-24`
- **根因**：`dimo:fs:readFile`/`writeFile`/`writeTextFile` 对 `filePath` 无任何白名单或对话框授权校验（还会递归创建任意父目录）；同时 `dimo-app://localhost` 响应与 `index.html` 均未配置 `Content-Security-Policy`。
- **修复建议**：主进程维护经 `dialog.open`/`dialog.save`/拖拽授权的路径集合及工作区白名单；为 `dimo-app://localhost` 响应补充严格 CSP 头。

---

### P0-10. 桌面通知弹窗 Quick Reply 无法输入 + 透明窗口吞点击
- **涉及文件**：`electron/src/main/desktopToast.ts:12-13, 122, 163-187`、`frontend/src/components/desktop-toast/DesktopToastWindow.tsx:330-344, 411-465`
- **根因**：
  1. `desktopToast.ts:177` 设 `focusable: false`，用户点击通知里的 Quick Reply `<input>` 永远无法获取键盘焦点。
  2. 固定 `456×520` 透明置顶窗口未调用 `win.setIgnoreMouseEvents(true, { forward: true })`，CSS `pointer-events-none` 无法在 Electron 中穿透鼠标点击，屏幕右下角整块区域会拦截背后其他应用的点击。
- **修复建议**：将 `focusable` 改为 `true`（保持 `showInactive()` 弹出不抢焦点），并实现基于鼠标移入/移出卡片 DOM 的 `setIgnoreMouseEvents` 动态穿透切换（或按卡片尺寸动态缩窗）。

---

### P0-11. 会话输入框拖拽文件重复上传（2~3 次）+ 源码文件分流错误 + HiDPI 误命中
- **涉及文件**：
  - `electron/src/preload/index.ts:106-162`
  - `frontend/src/components/tasks/follow-up/session-composer-input/SessionComposerSurface.tsx:194-202, 337-347`
  - `frontend/src/components/tasks/follow-up/session-composer-input/useSessionComposerInsert.ts:245-276, 360-430`
  - `frontend/src/components/tasks/follow-up/composerHostFileDrop.ts:55-73`
- **根因**：
  1. `SessionComposerSurface` 外层 `div`（201 行）与内层 `ChatComposerInput`（344 行，会将 `...rest` 透传给根节点）双绑 `onDrop={handleDrop}`；`useSessionComposerInsert.ts:423-427` 仅调 `preventDefault()` 未调 `stopPropagation()`，原生 `drop` 又继续冒泡到 `preload/index.ts:146-162` 的 `window` 监听（未判 `defaultPrevented`），导致单次拖拽并发触发 **2~3 次**上传（虽有后端 SHA-256 与前端路径去重，但并发请求可绕过 `find_by_hash` 产生重复文件并浪费磁盘/网络 I/O）。
  2. `handleHostDroppedPaths` 通过 `shell.fs.readFile` 是否抛错区分“可上传媒体 vs `@file` 引用”，普通源码文件（`.ts`/`.rs`）读取不抛错被误传给 `onAttachImages`。
  3. `composerHostFileDrop.ts:55-73` 对已是 CSS 逻辑像素的 Electron `clientX/clientY` 额外检查了 `(x / dpr, y / dpr)`，150%/200% 缩放屏下拖到其他区域也可能误命中输入框。
- **修复建议**：去重 `SessionComposerSurface` 双重 `onDrop`、统一单一拖拽来源（已处理时 `stopPropagation()` 且 preload 检查 `defaultPrevented`）、按文件类型显式区分媒体附件与 `@file` 引用、移除 Electron 下的 `dpr` 坐标折算。

---

## 2. P1 — 高危功能异常 / 接线错配 / 跨平台缺陷

### P1-1. Git 仓库命令返回类型错误（`get_repo_commit_diffs` / `pull_repo`）
- **涉及文件**：`crates/server/src/host/product.rs:695-698, 752-754, 1492-1516`、`frontend/src/lib/api/repos.ts:202-204, 221-223`
- **根因**：`RepoCommitDiffs` 误合并到 `commit_read` 返回单个 `CommitDetail` 而非 `Vec<Diff>`；`RepoPull` 写了 `git.pull(path).map(|_| ())` 把 `PullResult` 丢成 `null`。

### P1-2. 插件更新与市场列表 Schema 错配
- **涉及文件**：`frontend/src/lib/api/plugins.ts:723-733, 795-804`、`crates/server/src/host/surface.rs:677-682, 2349-2365`、`crates/server/src/host/plugin_updates.rs:48-56, 235-413`
- **根因**：`plugin_marketplace_index` 返回 `CatalogListing`（`owner`/`pluginName`/`downloadUrl`），缺少前端期望的 `MarketplaceListing`（`publisher`/`pluginId`/`archive`）；`plugins.ts:795-804` 的一步式 `update()`（针对标准 Dimo 插件，不含已走两步流程的 `prepareUpdate`/`confirmUpdate`）传入 `version`/`digest` 会被后端忽略且返回预览对象而非 `PluginControlItem`。

### P1-3. Sidecar 崩溃后无监控、不重启、连接信息未失效
- **涉及文件**：`electron/src/main/sidecar.ts:126-131, 275-284`、`electron/src/main/ipc.ts:122-131`、`electron/src/main/crashReporter.ts:113-188`
- **根因**：`dimo-server` 意外退出时仅打印日志并置空 `this.child`，未清除 `this.connection`、未写崩溃日志、未尝试有限次重启、也未通知渲染层；新开窗口继续拿到失效端口与 Token，整套 UI 陷入永久静默断连。

### P1-4. Windows 下 SQLite 备份与恢复异常（`backup_create` / `backup_restore`）
- **涉及文件**：`crates/server/src/desktop/backup.rs:227, 568-576`
- **根因**：`backup_restore` 提交阶段在 `SqlitePool` 仍打开 `db.sqlite` 时直接 `fs::rename` 覆盖，Windows 下必报共享冲突（`os error 32`）且先提交的配置文件无法回滚；`backup_create` 直接读裸文件而未做 `PRAGMA wal_checkpoint(TRUNCATE)`，易丢失未落盘 WAL 帧。

### P1-5. Electron `resources/bin/` 布局破坏历史数据迁移与更新前防删库检查
- **涉及文件**：`crates/utils/src/assets.rs:170-177, 356-380`、`crates/server/src/data_dir_adoption.rs:64-68, 308-321`、`electron/src/main/{index,updater}.ts`
- **根因**：`packaged_install_dir()`、`database_update_would_delete()` 与 `pre_rename_install_data_dir_candidates_for()` 仍按 Tauri 目录假设 `current_exe().parent()` 是安装根（`Contents/MacOS`），而 Electron 将 `dimo-server` 置于 `resources/bin/`，导致扫描不到旧版 `Contents/MacOS/data` 的数据库，`evacuate_user_data_before_update` 返回空且 VibeX 同级目录探测偏移；主进程启动前解析 `acceleration_mode`（`index.ts:25-89`）也遗漏了 `VIBEX_DATA_DIR` 与 `app.vibex.vibex` 旧版回退。

### P1-6. `dimo-asset://` 协议缺少 CORS 响应头与 `OPTIONS` 处理
- **涉及文件**：`electron/src/main/protocol.ts:280-357, 365-386, 410-419`、`frontend/src/components/previews/HostHtmlPreview.tsx:14, 58-80`
- **根因**：协议注册启用了 `corsEnabled: true`，但 `createStreamingFileResponse` 未返回 `Access-Control-Allow-Origin` 也不处理 `OPTIONS`；`HostHtmlPreview` 沙箱 `<iframe>`（无 `allow-same-origin`，`Origin: null`）内的 `<script type="module">`、`fetch()`、字体/Canvas 加载以及未来任意跨源 `fetch(dimo-asset://...)` 会被拦截。

### P1-7. WebSocket `RecvError::Lagged` 静默丢弃 `PatchStream` 增量补丁
- **涉及文件**：`crates/server/src/ws.rs:160, 252-268`、`crates/server/src/host/events.rs:19, 306`、`crates/server/src/host/streams.rs:108-213`
- **根因**：所有 `HostEvent` 与 `PatchStream` 共用单个容量 4096 的 `broadcast` 通道；终端高吞吐输出触发 `Lagged` 时仅重同步 durable 订阅，对 `PatchStream` 直接 `continue`，丢弃的 RFC 6902 patch 会使前端视图状态永久错位。

### P1-8. Windows 子进程树终止、Plugin Worker 守护与安装取消残留
1. **`GitCli::git_impl_timed` 超时卡死**：`crates/git/src/cli.rs:1647-1688` + `crates/utils/src/process.rs:821-857`。Windows 下 `terminate_std_child_group` 仅杀 `git.exe`，孙进程（`git-remote-https.exe`/`ssh.exe`）继续持有管道写端导致 `stdout_reader.join()` 永久阻塞。
2. **Plugin Worker 缺 Guardian Job 与锁超时错配**：`crates/plugins/src/worker_host.rs:658-695, 769, 2685-2710, 3057-3109` 未调用 `assign_pid_to_guardian_job(pid)`，且 `composition.rs:805-819` 未在 WAL checkpoint 前显式关闭 `PluginControlPlane`；`SharedNodeWorkerHost::invoke_slot` 持有 `inner.lock()` 执行嵌套 `host.call` 且默认超时仅 30s，而 `provider.presets.bind` 用户确认超时为 180s，会阻塞同进程其他插件并在 30s 后提前失败。
3. **Agent 安装子进程无 `kill_on_drop(true)` 与超时**：`crates/server/src/agent_install/installers.rs:1201-1241` 的 `run_command_with_progress` 取消时会残留 `npm`/`uv` 子进程。

### P1-9. Tauri 启动与关闭钩子遗漏
1. **启动钩子部分遗漏**（对比 `HEAD:src-tauri/src/lib.rs` 与 `crates/server/src/composition.rs`）：
   - `~/.dimo/imports` 下的 CLI 插件压缩包导入（`import_cli_package`，目前 `composition.rs:392` 仅迁入了 `import_queued_developer_links()`）。
   - `reconcile_managed_cli_exposures`（清理已失效 Runtime 残留的 PATH CLI shim，`agents::remove_orphaned_cli_shims`）。
   - `warm_agent_management`（目前 `composition.rs:583` 仅迁入了 `warm_local_runtime_discovery`）。
2. **Host Tunnel Relay 关闭未停止**：`crates/server/src/desktop/web_service.rs:590-603` 仅调了 `stop_quick_tunnel()`，遗漏了 `stop_relay()`。

### P1-10. Linux 无边框窗口缺失窗口控制按钮与双击最大化
- **涉及文件**：`electron/src/main/windows.ts:273-292`、`frontend/src/components/settings/{DesktopWindowControls,AppTitleBar}.tsx`
- **根因**：`windows.ts` 对 Windows 与 Linux 均设 `frame: false`，但前端控制按钮与标题栏双击最大化均用 `isWindows()` 过滤，导致 Linux 无边框窗口无任何窗口操作按钮。

### P1-11. Windows `AppUserModelID` 不一致 & EVSign 发布流签名缺陷
- **涉及文件**：`electron/electron-builder.yml:1`、`electron/src/main/{index,windows}.ts`、`.github/workflows/desktop-release.yml:352-374`、`scripts/sign-windows-evsign.ps1:33-42`、`scripts/generate-tauri-bridge-manifest.js:114-167`
- **根因**：
  1. 打包 `appId` 为 `com.dimo.app`，运行时 `APP_USER_MODEL_ID` 为 `com.dimo.desktop`，导致 Windows 任务栏固定后出现双图标、JumpList 与通知归属异常。
  2. CI `evsign` 路径关闭了 `electron-builder` 签名并在构建后仅签外层 `*-setup.exe`，导致包内 `Dimo.exe`/sidecar 未签名、`app-update.yml` 缺 `publisherName`（自动更新跳过验签）、修改 PE 后未重算 `.blockmap`（差分更新失效）。

---

## 3. P2 — 中低优先级与边缘隐患

### P2-1. 远程 SSH 编辑器协议白名单缺失 & `dimo-app://` 带点路由 404
- `crates/services/src/services/config/editor/mod.rs:370-377` 生成 `vscode-insiders://`、`antigravity://`，但 `electron/src/main/osBridge.ts:32-42` 白名单遗漏这两项。
- `electron/src/main/protocol.ts:263-275, 333-349` 用 `!path.extname(relative)` 判 SPA 回退，导致 `/plugins/com.dimo.foo` 等带 `.` 的路由直达/刷新返回 404；且 `fs.createReadStream` 未绑定 `'error'` 监听。

### P2-2. Host Browser 表单 `POST` 降级为 `GET`、缺 `will-redirect` 与下载覆写
- `electron/src/main/browser/controller.ts:458-506, 561-570, 631-638`：`will-navigate` 无条件 `preventDefault()` 后以 `wc.loadURL(url)` 重放，导致内嵌浏览器中的 OAuth/SSO `POST` 表单丢弃 body；未监听 `will-redirect` 导致 3xx 重定向绕过 URL 校验；`will-download` 直接覆写同名文件。

### P2-3. 冷启动会话深链丢失 & 隐藏 `settings` 窗阻止无托盘退出
- `electron/src/main/{index,deeplink}.ts`：`dimo://?session=...` 启动时立即广播但前端尚未订阅（无 pending 队列）；`whenReady` 前的 `second-instance` CLI 参数也会丢失。
- `electron/src/main/windows.ts:421, 529-558` + `index.ts:257-261`：`settings` 窗设 `hideOnClose: 'always'` 且关闭 `main` 时不销毁 `settings`，在无托盘环境下关闭主窗后 `window-all-closed` 永不触发（`desktopToast.ts:138-144` 也会将退出延迟最多 60s）。

### P2-4. 后端异步阻塞 I/O、关机时序、多实例误杀与 Host 自更新防护
- **异步函数内同步阻塞 I/O**：`backup.rs:365-602`、`surface.rs:1280`（`agent_list_local_history`）、`process.rs:891-898`（`async fn kill_process_group` 内同步调 `taskkill`）、`remote_profiles.rs:50-99`（持 `std::sync::Mutex` 调 `std::fs::write` 且 `.unwrap()`）、`workspace_parity.rs` 部分同步网络命令。
- **关机后台任务滞后于 WAL checkpoint**：`composition.rs:793-836` 中 `workflow_dispatch_task`、`terminal_task`、`idle_recycle_task`、`local_discovery_task` 仅在 `Drop`（WAL checkpoint 之后）才 abort，`settings_watcher` 等 detached 任务未接关机令牌。
- **退出误杀其他实例 & Host 自更新未屏蔽 `--desktop`/Windows**：`desktop/mod.rs:64-85` 在 Windows 用全局 `taskkill /IM` 误杀其他实例 MCP；`host/catalog/system.rs:530-582, 681-686` 的 `schedule_host_restart` 写死 `systemctl`，`apply_host_upgrade` 未在 `--desktop` / Windows 下屏蔽。

### P2-5. `/api/v1/plugin-artifacts/*` 未鉴权（LAN Web Service 暴露面）
- `crates/server/src/runtime.rs:336-338`、`crates/server/src/plugin_artifact.rs:27-63`：该路由在 `require_token` 之外且带 `ACAO: *`，开启绑定 `0.0.0.0:17891` 的 Web Service 后局域网可直接读取插件目录文件。

### P2-6. 菜单快捷键冲突、原生菜单未国际化、权限处理器与 macOS 细节
- `electron/src/main/chrome.ts:177-185, 352-493, 500-517`：Windows/Linux 未调 `Menu.setApplicationMenu(null)`（`Ctrl+R`/`Ctrl+W`/`Ctrl+±` 与自定义逻辑冲突）；缩放未跨窗同步；托盘/macOS 菜单/JumpList 硬编码简体中文；macOS 菜单 `Cmd+,`（`415-416, 443`）硬编码 `'main'` 导致远程主机窗错开本地设置窗，`{ role: 'close' }` 重复出现。
- Electron 主进程未配置 `session.setPermissionRequestHandler`（内嵌 Host Browser 继承默认策略）；若未来接入语音或页面需麦克风，需同步补充 `NSMicrophoneUsageDescription` 与 `com.apple.security.device.audio-input`。

### P2-7. 零散接线缺口与历史残留
- `frontend/src/lib/transport/transportRegistry.ts:62-117` 未透传 `.origin`，`PluginFilePreview.tsx:55-60` 相对 URL 回退会落到 `dimo-app://localhost` 404。
- `shared/hostCommands.ts:604-605` 的 `fixture_delegate`/`fixture_reset` 未在 Electron `ipc.ts` 处理；`record_shell_crash` 未加入 `SERVER_DESKTOP_COMMANDS`。
- `electronTransport.ts:25-39` 将 `theme-changed` 归入 `SHELL_ONLY_EVENTS`，仅忽略服务端 WS 推送（有 `settings_watcher` 兜底；若改造需双总线监听，不可直接删掉否则会破坏本地设置窗 IPC 同步）。
- `/desktop-toast` 窗跳过了 `BackendTransportProvider`，但 `App.tsx:488-496` 仍挂载 `UserSystemProvider`，额外拉起 RPC 与 3 条 WS 订阅。
- `electronTransport.ts:94-109` 的 `stream()` 实为非流式批量回放；`WINDOW_START_DRAGGING` 为空实现但 `AppTitleBar.tsx:44-49` 每次按下仍发 IPC；`preload/index.ts:100-163` 的 `dragenter` `paths` 恒为 `[]` 且全局拖拽监听永不卸载；4 处直接调用 `navigator.clipboard.writeText` 未走 `writeClipboardViaBridge`（`AppUpdaterSection.tsx:216`、`AccountSettings.tsx:64`、`HostBrowserPanel.tsx:1706, 2153`）。
- 能力/版本与清理残留：`--desktop` 同时上报 `desktop.tauri` 与 `desktop.electron`；多处版本号（`desktop/routes.rs:172`、`backup.rs:272`、`diagnostics_and_env.rs:718`、`worker_host.rs:1006, 2604`、`crash_reports.rs`）仍读 `CARGO_PKG_VERSION` 而非 `--app-version`；`check_app_release` 用字符串 `!=` 而非 semver；`host_bin.rs:77, 139` 残留 `src-tauri/binaries` 标记且缺 `dimo-computer-helper`；`installer.nsh:7` 残留已移除的 `dimo-computer-helper.exe`；macOS `wait_for_parent_exit` 每 500ms 派生一次 `/bin/kill -0`；`updater.ts:301` `Promise.race` 超时后可能遗留未捕获 rejection；`windows.ts:508` 写死 `spellcheck: false`。

---

## 4. 已核实正常的模块（无需返工）

- **前端 Tauri 依赖清理**：`frontend/package.json` 无 `@tauri-apps/*` 依赖；`window.dimoDesktop` 检测及 `useTauriClient` / `isTauriClient` 过渡别名均已指向 Electron。
- **核心命令与事件通道**：76/78 项 `DESKTOP_SHELL_COMMANDS`、全部 50 项 `SERVER_DESKTOP_COMMANDS`、全部 45 个 `HOST_EVENT_CHANNELS` 前缀均已完成 1:1 接线。
- **基础桌面能力与隔离**：单实例锁、macOS `open-url`/`activate`、托盘隐藏/恢复、Electron 32+ `webUtils.getPathForFile(file)`、OAuth `dimo://modelrouter-import` 闭环、渲染进程 `contextIsolation/sandbox/webSecurity` 与 `<webview>` 加固均正常。
- **鉴权与路径安全基线**：HTTP Bearer + WS `Sec-WebSocket-Protocol` 鉴权、`dimo-app://localhost`/`dimo-asset://localhost` Origin 白名单、`dimo-asset://` `realpathSync` + `PreviewAssetScope` 路径穿越防护、`windows.ts` 弹窗外链限制（`http/https/mailto`；`osBridge.ts` 另允许编辑器协议与本地绝对路径）、Windows `arm64` 更新通道（`latest-arm64.yml`）及 macOS 签名公证脚本均已到位。

---

## 5. 建议分批修复顺序

1. **Batch 1（P0 死锁 / Panic / 必挂主链路）**：`P0-1`（`stdout` 排空 + `agent_install` `println!` + 子进程 stdio）、`P0-2`（`plugins_catalog.rs` 管道死锁）、`P0-3`（2 处 `current_host_events` Panic）、`P0-4`（打包版 `claude-native-driver.mjs`）、`P0-5`（`ClaudeSettings`）、`P0-6`（6 个 400 命令）、`P0-7`（Workspace 响应信封 + `WebTransportError.details`）。
2. **Batch 2（核心交互与桌面稳定性）**：`P0-10`（Toast 焦点与穿透）、`P0-11`（拖拽重复上传 + 源码分流 + HiDPI）、`P1-1`（Repo 命令返回类型）、`P1-2`（插件更新/市场 Schema）、`P1-3`（Sidecar 崩溃自愈）、`P1-6`（`dimo-asset://` CORS）、`P1-7`（WS `Lagged` 重同步）、`P1-10`（Linux 窗口按钮）。
3. **Batch 3（数据安全、自动更新与发布链路）**：`P0-8`（自动更新 Windows 竞态 & macOS 断链）、`P1-4`（Windows SQLite 备份/恢复）、`P1-5`（`resources/bin/` 历史数据迁移与撤离）、`P1-8`（Windows 进程树/Worker 守护）、`P1-9`（遗漏启动钩子与 `stop_relay`）、`P1-11`（AUMID 与 EVSign 签名流）。
4. **Batch 4（安全加固与 P2 收尾）**：`P0-9`（Preload 文件读写白名单 + CSP）、`P2-1` ~ `P2-7`。

---

## 6. 修复执行与验收记录（2026-11-21 已全部合入 `master`）

全部 29 项核验问题（`P0-1`~`P0-11`、`P1-1`~`P1-11`、`P2-1`~`P2-7`）已拆分为 7 条文件无冲突的隔离 worktree 轨道按拓扑波次并行实现、逐项代码审核并合入 `master`（基线提交：`44ee9267a`）：

| 轨道 | 波次 | 覆盖条目 | 实现 Commit | 合并 Commit (`master`) | 状态 |
| --- | :---: | --- | --- | --- | :---: |
| **W1-A**（Rust 进程/管道/Worker/驱动路径/WS 重同步） | Wave 1 | `P0-1(Rust)`、`P0-2`、`P0-4(Rust)`、`P1-7`、`P1-8`、`P2-4(process/system)`、`P2-7(host_bin/version)` | `62b412352` | `9141497ab` | 已验收合入 |
| **W1-B**（Rust Host API 契约/Panic/`ClaudeSettings`/插件） | Wave 1 | `P0-1(sound)`、`P0-3`、`P0-5`、`P0-6`、`P0-7(Rust)`、`P1-1`、`P1-2`、`P2-4(async I/O)`、`P2-7(domain)` | `6ba5b28d2` | `bac2adc4a` | 已验收合入 |
| **W1-C**（Electron 主进程/Sidecar/Updater/Toast/菜单） | Wave 1 | `P0-1(Electron)`、`P0-4(Electron)`、`P0-8`、`P0-10(Electron)`、`P1-3`、`P1-5(Electron)`、`P1-11(AUMID)`、`P2-2`、`P2-3`、`P2-6(Electron)`、`P2-7(IPC)` | `b9aaebda6` | `cfb15d608` | 已验收合入 |
| **W1-D**（前端 Transport/拖拽/Toast UI/Linux 控制/接线） | Wave 1 | `P0-7(FE)`、`P0-8(FE)`、`P0-10(FE)`、`P0-11(FE)`、`P1-10`、`P2-7(FE)` | `ee1eb9d44` | `e9578c7cc` | 已验收合入 |
| **W2-A**（Electron 协议 CORS/CSP/FS 白名单/SSH/Preload） | Wave 2 | `P0-9`、`P0-11(Preload)`、`P1-6`、`P2-1`（审核补充 CSP `'wasm-unsafe-eval'` 与 LAN `frame-src http:`：`c3e78d4c1`） | `496ed3548` | `994aae77b` | 已验收合入 |
| **W2-B**（Rust 备份恢复/目录迁移/启停钩子/制品鉴权/版本） | Wave 2 | `P1-4`、`P1-5(Rust)`、`P1-9`、`P2-4(shutdown/desktop)`、`P2-5`、`P2-7(version/parent_watch)` | `d08e7fa87` | `657a99b67` | 已验收合入 |
| **W2-C**（Electron 打包/Windows EVSign/macOS 权限/CI） | Wave 2 | `P1-11(EVSign)`、`P2-6(macOS)`、`P2-7(installer.nsh)` | `81d10ce7c` | `a2ee0e588` | 已验收合入 |

### 全栈集成验证结果（`master` 合入后）
- `SQLX_OFFLINE=true cargo check --workspace --lib --tests`：通过（0 errors）
- `SQLX_OFFLINE=true cargo test -p utils --lib -- --test-threads=1`：121 passed, 0 failed
- `SQLX_OFFLINE=true cargo test -p application --lib`：34 passed, 0 failed
- `SQLX_OFFLINE=true cargo test -p server --lib -- ws:: host:: desktop:: data_dir_adoption:: plugin_artifact:: runtime:: composition:: update:: agent_install::`：401 passed, 0 failed
- `pnpm run frontend:check`（`tsc --noEmit`）：通过
- `pnpm --filter @dimo/electron check / test / build`：通过（6/6 文件，62 passed, 0 failed；`dist/main/index.js` 与 `dist/preload/index.js` 构建成功）
- `pnpm run test:tauri-bridge-manifest`（3/3 passed）与 `node --test scripts/installer-packaging.test.js`（5/5 passed）：通过

