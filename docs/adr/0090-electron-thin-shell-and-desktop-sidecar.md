---
status: accepted
date: 2026-11-20
decision-makers: Dimo maintainers
---

# Electron 桌面薄壳与 `dimo-server --desktop` Sidecar 架构

## Context

Dimo 的全部业务规则、Agent 进程、Git worktree、SQLite 数据库、插件 Worker 与远程协议都收敛在单接缝 Rust `HostRuntime`（[ADR-0078](0078-host-command-registry-single-seam.md)）中。桌面端需要一个跨 macOS / Windows / Linux 行为一致、内置浏览器与主窗口共享 Chromium 合成管线、并能通过标准 CDP/Playwright 调试与验证的薄壳，同时与无头 `dimo-server` 保持完全一致的协议与传输语义。

## Decision

1. **Electron 薄壳 + Rust Sidecar**：桌面壳实现位于 `electron/`（`@dimo/electron`），不承载任何业务规则；启动时拉起 `dimo-server --desktop` 作为受管本地 sidecar 进程，由 `HostRuntime` 承载全部产品命令与事件总线。
2. **Sidecar 握手、鉴权与防孤儿生命周期**：
   - `dimo-server --desktop` 绑定 `127.0.0.1:0`（随机回环端口），通过环境变量或 stdin 接收单次启动生成的 Bearer Token（绝不写入 CLI 参数），初始化完成后向 stdout 输出单行 `dimo-server-ready` JSON 就绪信号。
   - Electron 主进程持续消费 sidecar 的 stdout/stderr 以防止 Windows 管道缓冲死锁，并确保 `dimo-server --desktop` 注册 `bind_host_events` 以向桌面 WebSocket 推送实时事件。
   - 仅在回环接口暴露 `/api/v1/desktop/*` 桌面控制路由（含 `/api/v1/desktop/shutdown`）。通过父进程 PID watchdog、Windows Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）与 stdin EOF 停机机制保证桌面退出或崩溃时不留孤儿进程。
3. **固定自定义协议与安全边界**：
   - 生产环境通过 `dimo-app://localhost` 提供前端资源，保持 `localStorage` 与 IndexedDB 的 origin 稳定，不受随机回环端口变化影响。
   - 本地文件流式预览通过 `dimo-asset://` 协议提供，并强制执行路径白名单校验、严格 CSP 与 CORS 策略。
4. **内置浏览器采用 Electron `<webview>` + `crates/browser-host`**：
   - 嵌入式网页预览与 Agent 浏览器控制基于 Electron `<webview>`（与主界面共享 Chromium Viz 合成），经 `ElectronNativeTabs` WebSocket JSON-RPC 桥接到 `crates/browser-host` 与 `dimo.browser` 插件。
5. **前端传输与桌面桥**：
   - 前端通过 `ElectronTransport`（HTTP + WebSocket 连接本地 `dimo-server --desktop`，遇 `Lagged` 广播缺口自动触发快照重同步）调用共享产品命令。
   - 原生桌面壳能力（系统文件对话框、窗口控制、剪贴板、白名单文件读写、深度链接、桌面通知、应用自动更新）经 `contextBridge` 暴露为 `DesktopShellBridge`，与产品命令注册表解耦。
6. **打包布局与自动化**：
   - 桌面安装包将 sidecar 可执行文件及伴随脚本（含 `claude-native-driver.mjs`）统一放入 `resources/bin/`。
   - 桌面自动化与 UI 验证直接使用标准 Electron CDP / Playwright。

## Consequences

- 桌面端、浏览器 WebUI 与远程 Workstation 共享同一套 `dimo-server` HTTP/WebSocket 实现与事件流语义，消除原生壳差异。
- 内置浏览器与主工作台共享同一 Chromium 运行时，减少额外浏览器二进制体积并消除跨进程窗口叠加问题。
- 所有桌面原生扩展权限必须收口在 `electron/src/preload/` 与主进程 allowlist 校验中。
