---
status: accepted
date: 2026-09-14
decision-makers: Dimo maintainers
---

# Windows Desktop 内存归因与性能预算

## Context

Windows 任务管理器将 Electron 桌面壳、渲染/GPU/网络进程、嵌入 `<webview>`、本机 `dimo-server --desktop` sidecar 以及 Coding Agent 拉起的 Node/CLI/MCP/PTY 子树合并在同一应用分组下展示。要治理 Windows 桌面端的内存与流畅度，不能把分组总和等同于单一进程泄漏，而必须建立按进程类别归因的观测口径、稳态预算与子进程树治理规则。本决定扩展 [ADR-0061](0061-host-local-safety-and-performance-baseline.md)，与 Electron + `dimo-server --desktop`（ADR-0090）及 SQLite 单一权威（ADR-0091）保持一致。

## Decision

### 1. 分层归因口径与稳态预算

Windows 11 x64 发布构建的性能评估按进程类别分别记录 Working Set、Private Bytes、Commit、CPU、句柄数、线程数、父 PID、Job Object ID 与退出时间：

- Electron 主进程 / 渲染进程 / GPU / utility / `<webview>`（`dimo.browser` 启用与关闭分开基线）；
- Rust `dimo-server --desktop` sidecar（SQLite 连接池、事件通道深度、单 Turn 字节与背压计数）；
- Agent / Node / MCP / PTY 外部子进程树。

回归预算门槛：

- **无内存线性泄漏**：双会话稳态及 30 分钟连续流式输出期间内存趋于平台，不允许持续线性增长；单输出缓冲、文件读取与 diff 预览均有硬字节上限。
- **关闭零孤儿进程**：关闭会话后 10 秒内其 Agent / Node / MCP / PTY 子进程树完全清零；进程异常退出后 60 秒内由回收器收敛并留下可定位日志。
- **交互与流式延迟**：可见时间线交互 p95 帧时间 ≤ 16.7 ms；流式文本事件到绘制 p95 延迟 ≤ 100 ms；停止流式后 5 秒内事件积压清零。

### 2. Electron 多窗口与嵌入浏览器生命周期

- 遵守 [ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md) 与 [ADR-0054](0054-host-family-distribution-and-client-surfaces.md) 的 Server-bound window 隔离语义；同一 Host 的设置与辅助页面复用已有窗口上下文，禁止预创建隐藏窗口。
- 重型编辑器、Git diff、无限画布、插件诊断与嵌入浏览器 `<webview>`（`crates/browser-host` + `dimo.browser`）按路由与面板懒加载，卸载时释放订阅与可重建资源，不复制完整会话状态。
- GPU 加速与缓存策略的任何变更必须以帧时间与 Private Bytes 的发布版 A/B 数据为依据，不以牺牲滚动和输入延迟换取账面 RSS 下降。

### 3. Windows Job Object 与子进程树治理

- 每次 Agent 连接、MCP 进程与 PTY 会话均创建绑定 `KILL_ON_JOB_CLOSE` 的 Windows Job Object，将 adapter、`.cmd` 包装壳、Node worker、MCP 与 shell 纳入同一作业树。
- 关闭会话、取消超时退役、窗口退出与 Host shutdown 统一执行幂等的 `terminate-and-wait`，绝不仅依赖 leader 进程的 `kill_on_drop`；定期巡检 Dimo 持有的 Job，回收无主残留进程。
- 优先直接启动 `.exe` 可执行文件，仅在 Windows shim 必需时经转义后的 `cmd.exe /d /c` 包装；npx 类档案复用已安装运行时，安装探测维持有界并发（ADR-0026）。
- Agent 与 PTY 输出通道采用生产者侧 coalesce、按 Turn 字节硬上限与有界等待，并将背压纳入可观测指标。

### 4. SQLite 单一权威与低复制数据流（ADR-0091）

- `dimo-server` 使用分离的 `WritePool(1)` / `ReadPool(4)`、WAL 与受控 page-cache，消除多连接缓存乘数与写者争用；流式事件按 ~80 ms 批量合并落库。
- 会话打开基于 `conversation_timeline_rows` 仅加载尾窗（初始 16 行，更早记录按页增量追加），不再随详情下发完整历史或重复 `turns`；长 Turn 按事件数或时间间隔刷新投影快照。
- 事件订阅通过共享 `HostEventBus` 按会话精准投递，保留 rAF 合并与断线 `eventsSince` 补偿。

### 5. 前端调度与非阻塞 I/O

- 时间线 reducer 使用 keyed structural sharing 与增量排序，仅在顺序变化时重排；流式 Markdown 按 16–50 ms 或字节阈值批量 prepare，保留 TanStack virtualizer 与 memo 边界。
- 后台与不可见窗口受 `document.visibilityState`、窗口焦点与路由门控，暂停高频轮询并优先依赖事件唤醒；恢复可见时执行一次带游标的增量同步。
- 所有 Git 状态/diff、目录递归与大文件读取统一进入 `spawn_blocking` 或受限线程池，优先复用 FS watcher 并对大仓库跳过 `node_modules` / `target` 且设置条目与时间预算。

### 6. 发布构建验证纪律

所有性能与内存回归测试均在 Windows Release 安装包与用户环境 Agent 上执行，不混入 Vite dev server 或调试符号；CI 覆盖关闭后零孤儿、长流稳态与大仓库 I/O 场景，且双端共用 `dimo-server` 核心同测。

## Consequences

- 任务管理器分组占用被拆解为 Electron、Rust sidecar 与 Agent 子树三层可行动预算，定位回归有据可依。
- Windows Job Object 治理彻底消除 `.cmd` / Node / MCP 孙进程残留导致的隐性内存增长。
- 拒绝以移除虚拟化、关闭流式输出、牺牲窗口隔离或禁用 GPU 为代价的伪优化方案。
