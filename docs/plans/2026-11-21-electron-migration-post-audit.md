# Tauri → Electron + `dimo-server` 迁移后全量功能接线与异常隐患排查报告

- **审计日期**：2026-11-21
- **审计范围**：
  1. 命令 / IPC / 事件总线接线完整性（Frontend ↔ Electron Preload/Main ↔ `dimo-server` HTTP/WS）
  2. 启动 / 关闭生命周期、后台任务与打包资源路径一致性（对比原 `HEAD:src-tauri`）
  3. 运行时 Panic、管道死锁、Windows 子进程与 Tokio 异步阻塞隐患
  4. Electron 桌面壳（Electron 45）与前端桌面能力集成
- **审计原则**：所有条目均经源码逐行核实，附精确文件路径、行号、触发链路与修复方案。

---

## 总览矩阵

| 严重级别 | 数量 | 核心风险 |
| --- | :---: | --- |
| **P0（必现死锁 / 崩溃 / 数据丢失 / 核心不可用）** | 8 大类（含 15 个具体点位） | Windows `stdout` 管道 4KB 写满死锁、插件 CLI 管道死锁、`current_host_events()` 未绑定必现 Panic、打包版 Claude Native 引擎不可用、清空用户 `~/.claude/settings.json`、6 个命令必报 `400`、桌面通知无法输入且吞点击、拖拽重复上传 |
| **P1（高危功能异常 / 接线错配 / 迁移遗漏）** | 8 大类 | Git 仓库返回类型错误、5 个 Workspace 命令与 `invokeAsResult` 信封不匹配、插件更新/市场 Schema 错配、`dimo-asset://` 缺 CORS、WS `Lagged` 静默丢 `PatchStream`、打包 `resources/bin/` 破坏旧数据迁移、Windows 子进程树清理与守护缺失、若干 Tauri 后台模块/权限/菜单遗漏 |
| **P2（中低优先级 / 边缘隐患）** | 5 大类 | Tokio 线程同步阻塞 I/O 与无 WAL checkpoint 备份、内嵌浏览器 `POST` 表单降级为 `GET`、冷启动深链丢失、无托盘时隐藏设置窗阻止退出、旧版 `vibex` 环境变量/版本透传/Fixture 命令缺失 |

---

## P0 — 必现死锁 / 崩溃 / 数据丢失 / 核心功能完全不可用

### P0-1. Windows `sidecar.ts` 停读 `dimo-server` 的 `stdout` 导致 4KB 管道死锁
- **涉及文件**：
  - `electron/src/main/sidecar.ts:189-266`
  - `crates/server/src/agent_install.rs:452, 505, 513, 546, 552, 903, 1310, 1327, 1330, 1364, 1384, 1406, 1409, 1422, 1427, 1433, 1556, 1560, 1577, 1592, 1639`
  - `crates/server/src/agent_install/installers.rs:10, 22, 55, 72, 84, 118, 143, 201, 352, 422, 653, 802, 825, 923-930`
  - `crates/server/src/host/plugin_conversation.rs:724-727`
  - `crates/server/src/host/catalog/config.rs:229-243`
  - `crates/server/src/host/management/diagnostics_and_env.rs:399-402`
  - `crates/server/src/host/catalog/version_control.rs:394-398`
  - `crates/server/src/desktop/launcher.rs:456-472, 534-537`
  - `crates/server/src/host/catalog/system.rs:681-686`
- **根因**：
  1. `sidecar.ts:191` 以 `stdio: ['pipe', 'pipe', 'pipe']` 启动 `dimo-server.exe`。
  2. `sidecar.ts:222-264` 仅在等待 `dimo-server-ready` 握手行期间读取 `child.stdout`，握手成功后立即执行 `stdoutReader?.close()`，此后 `child.stdout` 处于暂停状态再也不排空（对比 `child.stderr` 始终有 `stderrReader` 消费）。
  3. 与此同时，运行时 `agent_install.rs`（21 处 `println!`）、`installers.rs`（13 处 `println!`）以及多个未显式重定向 `stdout` 的子进程（`git init`、`tar`、`play_notification_sound`、终端启动器等）都会持续向 `dimo-server` 的 `stdout` 管道写入内容。
  4. Windows 匿名管道缓冲区仅约 **4 KiB**。累计输出超过 4 KiB 后，下一次 `println!` 会持有 Rust 全局 `std::io::stdout()` 互斥锁并永久阻塞在 `WriteFile`，进而拖死 Tokio worker 线程导致整个 `dimo-server` 假死。
- **修复建议**：
  1. `electron/src/main/sidecar.ts`：握手完成后**不要关闭** `stdoutReader`（或切到持续 drain 的 `child.stdout.on('data', ...)` 转发到日志/丢弃），同时在 Windows 传入 `--parent-pid` 时使用 `stdio: ['ignore', 'pipe', 'pipe']`（不再保留无用的打开 `stdin` 管道）。
  2. `crates/server/src/agent_install.rs` / `installers.rs`：桌面/服务模式下的进度输出改为 `tracing::info!`（落到 stderr / 日志文件）而非 `println!`（仅 CLI 子命令 `dimo-server agents ...` 打印 stdout）。
  3. 所有 raw `std::process::Command::new(...)` 与不采集输出的 `new_hidden_std_command(...).status()` 显式设置 `.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())`，避免子进程继承/泄漏父进程管道句柄。

---

### P0-2. `plugin_control_import_cli` 管道必现死锁 + 无超时
- **涉及文件**：`crates/server/src/domains/plugins_catalog.rs:770-780`
- **根因**：
  ```rust
  let status = utils::process::new_hidden_tokio_command(&program, &parsed.args)
      .kill_on_drop(true)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::piped())
      .stderr(std::process::Stdio::piped())
      .status()
      .await
  ```
  `.status()` 不会读取 `stdout`/`stderr` 管道。只要外部 CLI（`claude` / `codex`）输出超过 4 KiB，子进程会永久阻塞在 `WriteFile`，`.status().await` 永不返回；且缺少超时保护。
- **修复建议**：改用 `.output()`（自动并发排空 `stdout`/`stderr`）或 `.stdout(Stdio::null()).stderr(Stdio::null())`，并包裹 `tokio::time::timeout(...)`。

---

### P0-3. `current_host_events()` 未绑定 task-local 导致 2 处必现 Panic
`current_host_events()`（`crates/server/src/host/events.rs:21-36`）依赖 Tokio `task_local!`（`CURRENT_BUS`），若所在任务未包裹 `bind_host_events(...)` 会直接 `.expect("Host Event Bus is not bound to this task")` panic。

- **3a. 本地历史批量导入（Panic + 永久 `409 Conflict` 锁死）**
  - **涉及文件**：`crates/server/src/host/surface.rs:1381-1476, 2579-2586`
  - **触发链路**：`agent_import_local_history_batch` 将全局 `local_history_job().running = true` 后执行 `tokio::spawn(async move { ... })`，但未用 `bind_host_events(self.events.clone(), ...)` 包裹，任务内立即调用 `apply_history_progress` → `current_host_events()` 直接 panic；由于未执行到 `job.running = false`，后续所有导入请求均永久报 `409 "A local conversation import is already running"`。
- **3b. 插件调用 `provider.presets.save` / `provider.presets.bind` 必现 Panic**
  - **涉及文件**：
    - `crates/plugins/src/host_call.rs:77-94, 238-293`
    - `crates/server/src/host/provider_bind.rs:116-149, 151-222`
    - `crates/server/src/host/native_commands.rs:62-64, 334, 451`
  - **触发链路**：`PluginHostCall::bind_loopback` 启动在独立 `tokio::spawn` 上的 Axum 服务未绑定 `CURRENT_BUS`；`HostProviderPresetHost::save` / `bind` 虽持有 `self.events`，但在调用 `dispatch_model_provider_save` / `dispatch_model_provider_bind` 时未包裹 `bind_host_events(self.events.clone(), ...)`，后者在落盘后调用 `invalidate()` → `current_host_events()` 直接 panic。
- **修复建议**：
  1. `surface.rs:1394`：将 `tokio::spawn` 内部包裹在 `bind_host_events(events.clone(), ...)` 中，或将 `events: Arc<HostEventBus>` 直接传给 `apply_history_progress`，并用 `Drop` guard 确保任何异常退出都会重置 `job.running = false`。
  2. `provider_bind.rs:123, 212`：将 `dispatch_model_provider_save` / `dispatch_model_provider_bind` 包裹在 `crate::host::events::bind_host_events(self.events.clone(), ...)` 中。

---

### P0-4. 打包版 Claude Native 引擎必定找不到 `claude-native-driver.mjs`（全平台失效）
- **涉及文件**：
  - `electron/electron-builder.yml:20-21, 32-35`
  - `electron/src/main/sidecar.ts:173-175`
  - `crates/server/src/bin/dimo-server.rs:120`
  - `crates/server/src/composition.rs:667`
  - `crates/agents/src/engine/claude_events.rs:484-522`
- **根因**：
  - 打包后 `dimo-server` 位于 `<resources>/bin/dimo-server[.exe]`，而驱动脚本位于 `<resources>/scripts/claude-native-driver.mjs`（相对 `exe_dir` 为 `../scripts/claude-native-driver.mjs`）。
  - `resolve_claude_driver_script()` 检查的 5 个候选路径全都不匹配 `<resources>/bin/../scripts/...`；而 Electron 传入的 `--resources-dir` 仅被传给 `DesktopWebServiceContext`（找 `frontend-dist`），从未传给 `agents` 或写入 `DIMO_CLAUDE_DRIVER_SCRIPT`。
  - 开发态因为走 `#[cfg(debug_assertions)]` 下的 `CARGO_MANIFEST_DIR/../../scripts/...` 所以能工作，**打包发布版在 Windows / macOS / Linux 三端必定报 `BinaryNotFound`**。
- **修复建议**：
  1. `crates/agents/src/engine/claude_events.rs:505-513`：增加 `exe_dir.join("../scripts/claude-native-driver.mjs")` 候选路径。
  2. `crates/server/src/bin/dimo-server.rs` 或 `electron/src/main/sidecar.ts`：同时根据 `--resources-dir` 显式透传 `DIMO_CLAUDE_DRIVER_SCRIPT`（若文件存在且用户未覆盖）。

---

### P0-5. `get_claude_settings` / `update_claude_settings` 字段大小写错配导致静默清空用户配置
- **涉及文件**：
  - `frontend/src/lib/api/config.ts:950-962`
  - `crates/server/src/host/catalog/config.rs:78-84, 628-696`
- **根因**：
  - 前端接口为 `ClaudeSettings { env, enabled_plugins }`（`snake_case`）。
  - 后端 `struct ClaudeSettings` 标注了 `#[serde(default, rename = "enabledPlugins")]` 且**没有** `#[serde(alias = "enabled_plugins")]`。
  - 结果：读取时返回 `enabledPlugins`，前端 `settings.enabled_plugins` 为 `undefined`；保存时前端发 `enabled_plugins`，后端反序列化将其忽略并回退为空 `{}`，**每次保存都会清空用户 `~/.claude/settings.json` 中的 `enabledPlugins`**。
- **修复建议**：前后端统一契约——对外 API 字段与前端 `ClaudeSettings` 保持 `enabled_plugins`（序列化为 `enabled_plugins` 或前端统一读 `enabledPlugins`），并在读写 `~/.claude/settings.json` 文件层显式映射 `enabledPlugins` 键（文件 JSON 键名必须维持 Claude Code 规定的 `enabledPlugins`）。

---

### P0-6. 6 个前后端命令反序列化错配，调用必报 `400 Bad Request`
1. **`create_task_and_start`**
   - 前端：`frontend/src/lib/api/tasks.ts:11-31`、`shared/types.ts:486-490, 528`（发送 `snake_case`：`executor_profile_id`、`repo_id`、`target_branch`、`use_worktree`）。
   - 后端：`crates/server/src/host/workspace_parity.rs:78-97`（`#[serde(rename_all = "camelCase")]`，缺少 `snake_case` `alias`，导致 `missing field 'executorProfileId'` 及 `use_worktree: false` 被静默覆盖为 `true`）。
2. **`create_workspace_from_pr`**
   - 前端：`frontend/src/lib/api/attempts.ts:684-691`、`shared/types.ts:647-656`（发送 `snake_case`）。
   - 后端：`crates/server/src/host/workspace_parity.rs:64-76`（`#[serde(rename_all = "camelCase")]`，缺少 `snake_case` `alias`，必报 `missing field 'repoId'`）。
3. **`weixin_check_qrcode`**
   - 前端：`frontend/src/lib/api/config.ts:933-940`（发送 `{ request: { channel_id, qrcode } }`）。
   - 后端：`crates/server/src/host/surface.rs:236-241`（`WeixinCheckArgs` 为 `camelCase` 且无 `#[serde(alias = "channel_id")]`）。
4. **`plugin_control_contributions` / `plugin_control_rollback` / `plugin_install`**
   - 前端：`frontend/src/lib/api/plugins.ts:625-631, 696-700, 761-777`（均不传 `path`）。
   - 后端：`crates/server/src/host/surface.rs:223-234, 2367-2386, 2422-2464`（统一解析为 `PluginPathArgs`，其中 `path: String` 为必填字段，导致 3 个命令全报 `missing field 'path'`；且 `plugin_install` 尚未实现 `source.marketplace` 分支）。
- **修复建议**：
  - 为 `CreateAndStartTaskRequest`、`WorkspaceRepoSpec`、`CreateWorkspaceFromPrRequest`、`WeixinCheckArgs` 补齐全部 `snake_case` `#[serde(alias = "...")]`。
  - 将 `plugin_control_contributions`、`plugin_control_rollback`、`plugin_install` 从 `PluginPathArgs` 拆分出各自独立、精确的参数结构体（保持 `PluginPathArgs` 仅用于真正需要本地路径的命令，避免破坏现有单元测试 `plugin_path_args_still_require_a_filesystem_path`），并补齐 `plugin_install` 的 `source.marketplace` 处理逻辑。

---

### P0-7. 桌面通知弹窗 Quick Reply 无法输入 + 透明窗口吞点击
- **涉及文件**：
  - `electron/src/main/desktopToast.ts:12-13, 122, 163-187`
  - `frontend/src/components/desktop-toast/DesktopToastWindow.tsx:330-332, 411-465`
- **根因**：
  1. `desktopToast.ts:177` 设置了 `focusable: false`。虽然 `showInactive()` 已经能防止弹出时抢焦点，但 `focusable: false` 会导致用户在 Windows/macOS 上**点击通知里的 Quick Reply `<input>` 也无法获得键盘焦点、无法打字**。
  2. 整个 `456×520` 透明置顶窗口未调用 `win.setIgnoreMouseEvents(true, { forward: true })`，CSS `pointer-events-none` 无法让 OS 鼠标事件穿透 Electron `BrowserWindow`，导致通知显示时屏幕右下角整块区域无法点击下方其他应用。
- **修复建议**：
  - 将 `focusable` 改为 `true`（弹出继续使用 `win.showInactive()` 避免抢焦点）。
  - 为 toast 窗口增加鼠标穿透切换（默认 `setIgnoreMouseEvents(true, { forward: true })`，鼠标移入实际卡片 DOM 时通过轻量 IPC 切为 `false`，移出时切回 `true`；或按实际可见卡片高度动态调整窗口尺寸）。

---

### P0-8. 会话输入框拖拽文件重复上传（2~3 次）+ HiDPI 误命中
- **涉及文件**：
  - `electron/src/preload/index.ts:106-162`
  - `frontend/src/components/tasks/follow-up/session-composer-input/SessionComposerSurface.tsx:194-202, 337-347`
  - `frontend/src/components/tasks/follow-up/session-composer-input/useSessionComposerInsert.ts:360-430`
  - `frontend/src/components/tasks/follow-up/composerHostFileDrop.ts:55-73`
- **根因**：
  1. `SessionComposerSurface.tsx` 的外层 `div`（201 行）和内层 `ChatComposerInput`（344 行）都绑定了 `onDrop={handleDrop}`，而 `useSessionComposerInsert.ts:423-427` 只调了 `event.preventDefault()`、未调 `event.stopPropagation()`。
  2. React `handleDrop` 上传一次后，原生 `drop` 事件继续冒泡到 `window`，触发 `electron/src/preload/index.ts:146-162` 的 `onDragDropEvent`，再读磁盘上传同一文件第 2 次（且内外层双 `onDrop` 可能触发第 3 次）。
  3. `composerHostFileDrop.ts:55-73` 保留了 Tauri 物理像素折算（同时检查 `(x, y)` 和 `(x / dpr, y / dpr)`），但 Electron `clientX/clientY` 已是 CSS 逻辑像素；在 150%/200% 缩放屏上，拖到页面其他区域也可能误落入折算后的输入框矩形内。
- **修复建议**：
  - 桌面端文件拖拽统一走单一来源（`onDragDropEvent` 或 DOM `onDrop` 二选一；若保留 DOM `onDrop`，处理后立即 `event.stopPropagation()` 并对 preload `drop` 监听检测 `event.defaultPrevented` 避免二次派发）。
  - 移除 `composerHostFileDrop.ts` 中对 Electron 逻辑坐标的 `x / devicePixelRatio` 折算。

---

## P1 — 高危功能异常 / 接线错配 / 迁移遗漏

### P1-1. Git 仓库命令返回类型错误（`get_repo_commit_diffs` / `pull_repo`）
- **涉及文件**：
  - `crates/server/src/host/product.rs:695-698, 752-754, 1492-1516`
  - `frontend/src/lib/api/repos.ts:202-204, 221-223`
- **根因**：
  - `DomainCommand::RepoCommitDiffs` 与 `RepoCommitDetail` 合并路由到了 `self.commit_read(args)`，返回单个 `CommitDetail` 而非 `Vec<Diff>`（应参考 `WorkspaceCommitDiffs` 调用 `git.get_diffs(git::DiffTarget::Commit { ... }, None)`）。
  - `DomainCommand::RepoPull` 写了 `git.pull(path).map(|_| ())`，把 `PullResult` 丢弃成了 `null`（应参考 `WorkspacePull` 直接序列化返回 `PullResult`）。

---

### P1-2. 5 个 Workspace 命令响应/错误信封与 `invokeAsResult` 契约不匹配
- **涉及文件**：
  - `frontend/src/lib/api/base.ts:47-87`
  - `frontend/src/lib/api/attempts.ts:198-218, 320-372, 684-691`
  - `crates/server/src/host/workspace_parity.rs:132-190, 282-325, 376-496, 634-751`
  - `crates/server/src/host/product.rs:397-411, 1334-1336`
- **根因**：
  - 前端 `invokeAsResult<T, E>` 约定成功返回 HTTP 200 裸数据 `T`，业务错误通过异常 `details` 返回结构化 `E`。
  - `run_setup_script`、`run_cleanup_script`、`run_archive_script`、`create_workspace_pr`、`create_workspace_from_pr` 均在 HTTP 200 中返回了 `{ process/url/response, error }` 包装结构，导致业务错误被前端判定为 `{ success: true }` 且 `data` 结构错位。
  - `push_workspace_branch` 使用 `.map_err(internal_error)`，丢失了前端依赖的结构化 `PushError`（如 `force_push_required` 弹窗提示）。

---

### P1-3. 插件更新与市场列表 Schema 错配
- **涉及文件**：
  - `frontend/src/lib/api/plugins.ts:723-733, 795-804`
  - `crates/server/src/host/surface.rs:677-682, 2349-2365`
  - `crates/server/src/host/plugin_updates.rs:48-56, 235-413`
- **根因**：
  - `plugin_update` / `plugin_control_update` 忽略前端传入的 `version`/`digest`，且无 `confirmationId` 时仅返回 `PluginUpdatePreview` 而非 `PluginControlItem`。
  - `plugin_marketplace_index` 实际调用 `plugin_marketplace_catalog`，返回的是 `CatalogListing`（`owner`/`pluginName`/`downloadUrl`），缺少前端期望的 `MarketplaceListing` 字段（`publisher`/`pluginId`/`archive`）。

---

### P1-4. `dimo-asset://` 协议缺少 CORS 响应头与 `OPTIONS` 处理
- **涉及文件**：
  - `electron/src/main/protocol.ts:280-357, 377-385, 410-419`
  - `frontend/src/components/previews/HostHtmlPreview.tsx:14, 73-79`
  - `frontend/src/lib/previewMediaActions.ts:9`
- **根因**：注册协议时启用了 `corsEnabled: true`，但 `createStreamingFileResponse` 未返回 `Access-Control-Allow-Origin` 且未响应 `OPTIONS`，导致前端跨源 `fetch(dimo-asset://...)`（预览媒体保存/复制）及 sandboxed HTML 预览内的 `<script type="module">` / `fetch()` / 字体加载被拦截。

---

### P1-5. WebSocket `RecvError::Lagged` 静默丢弃 `PatchStream` 增量补丁
- **涉及文件**：
  - `crates/server/src/ws.rs:160, 252-268`
  - `crates/server/src/host/events.rs:19, 306`
  - `crates/server/src/host/streams.rs:108-213`
- **根因**：所有 `HostEvent` 与 `PatchStream` 共用单个 4096 容量的 `broadcast` 通道。当终端高吞吐输出导致接收端滞后时，`ws.rs:252-268` 仅重同步 durable 订阅，对 `HostEvent` / `PatchStream` 直接 `continue`，丢弃的 RFC 6902 patch 会导致前端列表/diff/会话视图永久状态错位。
- **修复建议**：对 `Lagged` 时受影响的 `PatchStream` 主动向客户端发送重建/重同步通知或断开触发重连重放初始 snapshot；并将高频 `terminal-output` 与低频控制/补丁通道解耦或增大缓冲。

---

### P1-6. 打包版 `resources/bin/` 嵌套破坏历史数据目录迁移与更新前疏散检查
- **涉及文件**：
  - `crates/utils/src/assets.rs:170-177, 356-381, 436-440`
  - `crates/server/src/data_dir_adoption.rs:285-320`
  - `electron/electron-builder.yml:20-21`
- **根因**：原 Tauri 可执行文件在 `<InstallDir>/dimo.exe` 或 `Dimo.app/Contents/MacOS/dimo`；Electron 打包后 `dimo-server` 位于 `<InstallDir>/resources/bin/` 或 `Dimo.app/Contents/Resources/bin/`，导致基于 `current_exe().parent()` 向上推算旧版 `VibeX/data`、0.5.0 自定义目录 `data` 以及 macOS 更新前防删库检查（`database_update_would_delete`）全部路径错位。

---

### P1-7. Windows 子进程树终止、Plugin Worker 进程守护与安装任务取消残留
- **`GitCli::git_impl_timed` Windows 超时卡死**：`crates/git/src/cli.rs:1647-1688` + `crates/utils/src/process.rs:827-857`。超时后仅 `child.kill()` 杀 `git.exe`，未杀子进程树（`git-remote-https.exe`/`ssh.exe`），孙进程仍持有管道写端，导致 `stdout_reader.join()` 永久阻塞。
- **Plugin Worker 缺少 Windows Guardian Job 绑定与超时错配**：
  - `crates/plugins/src/worker_host.rs:2685-2710, 3057-3066` 未调用 `assign_pid_to_guardian_job(pid)`，且 `composition.rs:805-819` 优雅退出时未在 WAL checkpoint 前显式关闭 `PluginControlPlane`。
  - `SharedNodeWorkerHost` 持有 `host.inner.lock()` 执行嵌套 `host.call`，而 `provider.presets.bind` 用户确认超时为 180s，但 Worker 请求超时仅 30s（`worker_host.rs:769`），会阻塞同进程其他插件并在 30s 后提前失败。
- **Agent 安装子进程无 `.kill_on_drop(true)` 与超时**：`crates/server/src/agent_install/installers.rs:1201-1241` 的 `run_command_with_progress` 未设 `kill_on_drop(true)` 且无超时，取消操作时会残留 `npm`/`uv` 子进程。

---

### P1-8. Tauri 迁移遗漏的功能模块、系统权限与跨平台桌面壳细节
1. **Plugin Dev Server 与启动钩子遗漏**：
   - `crates/server/src/desktop/mod.rs:36-44` 的 `PluginDevConnection::current()` 仍是空壳（`token: ""`，且指向只读静态文件服务）。
   - 原 `HEAD:src-tauri/src/lib.rs` 中的 `plugin_dev_server::start`、`import_cli_inbox`、`reconcile_managed_cli_exposures`、`warm_agent_management` 未迁入 `crates/server/src/composition.rs`。
2. **Host Tunnel Relay 未在关闭时停止**：`crates/server/src/desktop/web_service.rs:590-603` 调用了 `stop_quick_tunnel()`，遗漏了 `stop_relay()`。
3. **服务端触发的 `theme-changed` 在 Electron 被丢弃**：`frontend/src/lib/transport/electronTransport.ts:25-39, 132-144` 将 `theme-changed` 归入 `SHELL_ONLY_EVENTS`，导致只听 Electron IPC、不听 `dimo-server` WS（双总线互斥）。
4. **Voice Input 麦克风权限缺失**：`electron/electron-builder.yml:72-86` 缺 `NSMicrophoneUsageDescription`，`electron/build/entitlements.mac.plist` 缺 `com.apple.security.device.audio-input`，主进程未配置 `session.setPermissionRequestHandler`。
5. **Linux 无边框窗口无窗口控制按钮**：`electron/src/main/windows.ts:273-292` 对 Linux 设 `frame: false`，但 `DesktopWindowControls.tsx:5-9`、`AppTitleBar.tsx:47-53` 与 CSS 仅对 `isWindows()` 生效。
6. **Windows/Linux 未移除 Electron 默认应用菜单**：`electron/src/main/chrome.ts:177-185` 未调用 `Menu.setApplicationMenu(null)`，默认 `Ctrl+R`、`Ctrl+W`、`Ctrl+=/-`、`F11` 等快捷键仍生效；macOS `Cmd+,`（`chrome.ts:410, 415`）硬编码传 `'main'` 而非当前聚焦窗口。
7. **Windows `AppUserModelId` 打包与运行时不一致**：`electron/electron-builder.yml:1` 为 `com.dimo.app`，运行时 `electron/src/main/index.ts:115-123` 与 `windows.ts:213-214` 为 `com.dimo.desktop`，会导致任务栏固定图标重复分组。

---

## P2 — 中低优先级与边缘隐患

1. **Tokio 异步线程同步阻塞 I/O 与备份一致性**：
   - `crates/server/src/desktop/backup.rs:365-602`：在 `async fn` 中同步遍历/读写整个数据目录，且备份 `db.sqlite` 前未做 SQLite WAL checkpoint，并发写入时快照可能不一致。
   - `crates/server/src/host/workspace_parity.rs:361-1161`（网络 `git`/`gh`）、`crates/server/src/host/surface.rs:1280`（`agent_list_local_history`）、`crates/server/src/host/product.rs`、`crates/server/src/host_ops/mod.rs`、`crates/utils/src/process.rs:891-898`（`async fn kill_process_group` 内同步调用 `taskkill`）、`crates/server/src/host/remote_profiles.rs:54-99`（持 `std::sync::Mutex` 跨 `std::fs::write` 且 `.unwrap()`）。
2. **Host Browser 表单 `POST` 降级为 `GET` 与下载覆写**：
   - `electron/src/main/browser/controller.ts:458-506, 636-638`：`will-navigate` 无条件 `event.preventDefault()` 后以 `wc.loadURL(url)` 重放，导致内嵌浏览器中的 OAuth/SSO `POST` 表单丢失 body；未监听 `will-redirect`；`will-download` 未对同名文件去重。
3. **冷启动深链事件丢失**：
   - `electron/src/main/index.ts:378`、`electron/src/main/deeplink.ts:177-185, 224-237`：`dimo://session/...` 在渲染进程挂载监听器前直接广播且无 pending 队列；`second-instance` 早期的 `--open-settings` / `--new-window` 参数也会被丢弃。
4. **隐藏的 `settings` 窗口导致无托盘时进程无法退出**：
   - `electron/src/main/windows.ts:421, 529-542` + `electron/src/main/index.ts:257-261`：关闭设置窗口仅隐藏而不销毁，导致无托盘环境下关闭主窗口后 `window-all-closed` 永不触发。
5. **其他配置与版本对齐细节**：
   - `electron/src/main/index.ts:25-89`：`resolveBootstrapConfigPath` / `resolveDefaultDataDir` 未兼容旧版 `vibex/bootstrap.json`、`VIBEX_DATA_DIR` 与 macOS `.app` 路径拒绝，且 GPU 加速设置读取早于 Rust `adopt_legacy_data_dir()`。
   - `--app-version` 仅写入 `ServerConfig.server_version`，`/api/v1/desktop/health`、`check_app_release`、`backup.rs`、`crash_reports.rs`、`local-deployment` 仍读编译期 `CARGO_PKG_VERSION`。
   - `electron/src/main/updater.ts:266-268` 为 `win32`/`arm64` 选了 `latest-arm64`，但 `electron-builder.yml` 仅构建 Windows `x64`。
   - `shared/hostCommands.ts:604-605` 声明了 `fixture_delegate` / `fixture_reset`，但 Electron IPC 与服务端桌面路由未实现。
   - `electron/build/installer.nsh:7` 残留 `taskkill /F /IM dimo-computer-helper.exe /T`。
   - `crates/server/src/composition.rs:793-836` 关机时多个后台任务仅在 `Drop`（WAL checkpoint 之后）才 abort，`settings_watcher` / `spawn_developer_link_refresh` 等未接入统一关机令牌。

---

## 已核实正常的模块（无需重复排查）

- **前端 Tauri 运行时残留**：`frontend/package.json` 无 `@tauri-apps/*` 依赖；`frontend/src/lib/desktopShell/*`、`transport/*`、`platform.ts` 无 `__TAURI__`、`tauri://`、`asset.localhost` 残留；`useTauriClient` / `isTauriClient` 已通过 `isDesktopShell()` 适配 Electron。
- **Electron 32+ `webUtils.getPathForFile`**：`electron/src/preload/index.ts:74-86` 已正确使用 `webUtils.getPathForFile(file)`，未依赖已移除的 `File.path`。
- **`HOST_EVENT_CHANNELS` 目录对齐**：`crates/server/src/host/events.rs` 与 `shared/hostCommands.ts` 的 45 个事件前缀 1:1 完整一致（含 `dimo://collaboration-*`、`dimo://local-app-data-cleared` 等）。
- **Desktop Origin / Bearer Auth**：`dimo-app://localhost`、`dimo-asset://localhost` 在 desktop 模式下已放行，且拒绝 `x-forwarded-for`/`x-real-ip` 伪造。
- **`dimo-asset://` 路径穿越防护与外链校验**：已做 `realpathSync` + scope 白名单校验，外链已限制仅 `http:`/`https:`/`mailto:`。
- **`opencode/models-dev.json` 与窗口/托盘图标打包**：`models-dev.json` 已 `include_str!` 编译进二进制；`electron-builder.yml` 与 `windows.ts`/`chrome.ts` 的图标路径对齐。
- **`new_hidden_tokio_command` 默认 `stdin` 隔离**：`crates/utils/src/process.rs:218-278` 已默认 `.stdin(Stdio::null())`，规避了此前 `git checkpoint` 继承 `stdin` 锁死的问题。

---

## 建议修复批次

1. **Batch 1（P0 稳定性 & 数据安全，最高优先级）**：
   - 修复 `sidecar.ts` `stdout` 排空 + `agent_install` `println!` + `plugins_catalog.rs` 管道死锁（P0-1, P0-2）
   - 修复 2 处 `current_host_events()` 未绑定 panic（P0-3）
   - 修复打包版 `claude-native-driver.mjs` 路径解析（P0-4）
   - 修复 `ClaudeSettings` 大小写清空配置 + 6 个 `400` 命令参数/Schema 错配（P0-5, P0-6）
   - 修复桌面通知弹窗焦点/穿透 + 拖拽重复上传/HiDPI 坐标（P0-7, P0-8）
2. **Batch 2（P1 功能接线与跨平台完善）**：
   - 修复 `get_repo_commit_diffs`、`pull_repo`、5 个 `invokeAsResult` 信封、插件更新/市场 Schema（P1-1 ~ P1-3）
   - 修复 `dimo-asset://` CORS、WS `Lagged` 重同步、`resources/bin/` 迁移路径（P1-4 ~ P1-6）
   - 补齐 Windows 进程树/Guardian Job、Host Tunnel `stop_relay`、菜单/AUMID/Linux 控制按钮/麦克风权限（P1-7, P1-8）
3. **Batch 3（P2 性能、备份一致性与边缘体验）**：
   - `backup.rs` WAL checkpoint + `spawn_blocking` 改造、Host Browser `POST` 表单与 `will-redirect`、冷启动深链队列、隐藏设置窗退出逻辑。
