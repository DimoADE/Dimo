---
status: accepted
date: 2026-08-20
decision-makers: Dimo maintainers
---

# Host 本地安全与性能基线

## Context

Dimo 是本地优先的 Host 平台（桌面端由 Electron 壳托管 `dimo-server --desktop` sidecar，无头端运行独立 `dimo-server`，共享同一 Rust Application Core；见 [ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md) 与 ADR-0090）。本 ADR 固定本地运行场景下的信任边界，以及内存、锁、数据处理、命令执行、Git 操作与性能六个维度的不可回退工程约束。所有约束对桌面端与无头 `dimo-server` 同样生效。

## Decision

### 1. 信任模型与防线划分

- **全信任本机代码**：用户启用的 Coding Agent 及其拉起的终端子进程、已安装的 Full-Trust 插件包（[ADR-0048](0048-full-trust-plugin-execution-model.md)）、用户仓库的 setup/cleanup/dev-server 脚本、以及 Workspace 交互式 PTY 均与 Host 同权运行。Host 与 UI 不得宣称 OS 级沙箱隔离，也不保留伪沙箱 `isolated` 插件执行路径。
- **非全信任输入边界**：恶意或 Agent 写入的 Git 仓库、Agent 输出与终端流、第三方归档、导入的 Conversation bundle、Windows `.cmd` 参数以及前端传入的文件路径均为非全信任输入，严禁未经校验进入 shell 字符串、Git ref、无界内存缓冲或任意本机路径。
- **Workspace-less 低权限边界**：无工作区会话（[ADR-0006](0006-workspace-less-conversation.md)）的专用临时目录约束必须在终端与文件工具路径强制执行，不得停留在文案层面。

### 2. 内存与有界资源

- **硬字节上限**：Agent 终端 `output_byte_limit` 强制施加硬上限（4–16 MiB），忽略 Agent 声明的超大值；PTY 历史、Agent stderr ring、协议帧与工具预览均保持有界上限。
- **有界流通道与生产者侧合并**：Agent → Conversation 持久化通道与 PTY 订阅通道必须有界，在生产者侧执行流式 coalesce 并对单 Turn 字节设顶，避免快生产者配合慢写者导致 OOM。
- **先查界再读文件**：所有文件树预览、文本读取与内联 Git diff 必须先检查 `metadata().len()` 或采用有界流式读取，严禁先整文件读入内存再截断。
- **进程环境与锁表卫生**：多线程运行期禁止调用 `std::env::set_var`（改由子进程 env map 显式传入）；按会话/工作区分配的锁表定期回收，避免长周期慢泄漏。

### 3. 锁与并发安全

- **等待与终止解耦**：Agent 终端 `wait()` 不得持有阻碍 `kill()` / `release()` 的同一把子进程锁，保证停止操作即时生效且进程退出不挂死。
- **Turn 锁身份稳定**：持有活跃 Turn guard 期间严禁从 `conversation_turn_locks` 移除该会话锁；锁条目仅在无活跃引用（`Weak` / `strong_count == 0`）时清理，彻底防止双在途 Turn。
- **窄临界区与防毒化**：Turn 锁仅覆盖 `idle-check → claim → 写入活跃 Turn`，不得跨越 Agent 握手、worktree 创建或慢 I/O，确保取消不被阻塞；共享内存锁避免临界区 `.lock().unwrap()` 毒化整个 Host。

### 4. 数据处理与路径约束

- **本地资源路径收敛**：Markdown 本地图片与文件读写路径必须 canonicalize 并严格校验落在当前 Workspace 或允许的附件目录内，拒绝 `..` 与任意绝对路径逃逸。
- **归档解压统一规则**：所有 Agent 归档（zip / tar / gzip）与插件包解压统一执行 `enclosed_name` 校验，拒绝 `..`、绝对路径与越界 symlink，并施加条目数、目录深度与未压缩字节上限。
- **导入完整性**：Conversation bundle 导入强制验证 checksum、行长、事件数与 JSON 深度上限。
- **渲染消毒**：KaTeX 显式设置 `trust: false` 与 `maxExpand`；Mermaid 固定 `securityLevel: 'strict'`；Registry SVG 经严格清洗。

### 5. 命令执行安全

- **参数安全与 Windows shim**：Git、Agent 与工具调用坚持 argv 数组，不拼接 shell 字符串。Windows 下包装 `.cmd`/`.bat` 时必须正确转义 `cmd.exe` 元字符，优先直接 `CreateProcess` 启动 `.exe`。
- **后端白名单一致**：交互式 PTY 的允许 `shell` 清单由后端强制校验，与前端白名单一致；远程 `TerminalCreate` 不得执行任意可执行文件。
- **固定工具路径**：Host 调用系统 `git`、`tar` 等基础命令时解析并缓存绝对路径，避免被用户环境 `PATH`（[ADR-0060](0060-agent-installs-use-user-environment.md)）中的同名程序意外劫持。

### 6. Git 操作安全

- **环境隔离与禁用仓库 hooks**：所有工作树变更走 Git CLI argv。每次调用先剥离父进程全部 `GIT_*` 环境变量再写入显式白名单，并附加 `-c core.hooksPath=<空目录>`、`-c submodule.recurse=false`、`-c protocol.file.allow=never`；Host 自动发起的 commit 统一携带 `--no-verify`。
- **Ref 严格校验**：所有分支名与 ref 必须通过 `name_is_valid`，拒绝前导 `-`、`:`、`*`、`..`，命令中在 ref 前使用 `--` 分隔；禁止使用通配 `+` refspec 覆盖本地分支。
- **保护主工作树与锁键规范化**：merge / rebase-back 不得 checkout 用户主工作树；对非 Host 托管工作树的破坏性操作需要独立显式确认；worktree 锁 key 必须先 canonicalize 路径。

### 7. 性能基线与不可回退控制

- **SQLite 单一权威与分层连接池（ADR-0091）**：SQLite 采用 WAL、`busy_timeout` 与分离的 `WritePool(1)` / `ReadPool(4)`，消除写者争用与过量 page-cache 乘数。流式事件以 50–100 ms 批量合并落库，Turn 中途定期刷新投影快照。
- **分页打开与零双投影**：会话打开基于 `conversation_timeline_rows` 仅加载尾窗与 `last_sequence`，不再随详情下发完整历史或重复 `turns`；前端维持虚拟列表、rAF 批处理与单向投影消费。
- **异步运行时防阻塞**：所有 Git 面板命令、目录遍历（带条目与时间预算，跳过 `node_modules`/`target`）与大文件 diff 统一放入 `spawn_blocking`；状态刷新优先依赖文件系统 watcher 而非高频轮询。

## Consequences

- 任何偏离上述有界资源、锁身份、路径校验、Git 隔离或非阻塞 I/O 约束的实现均按缺陷处理，不以「本地应用」为由豁免。
- 桌面端与无头 `dimo-server` 共享同一 `crates/server` / `crates/application` 代码路径，安全与性能加固天然双端同步生效。
- 默认禁用仓库 hooks 保护 Host 免受恶意仓库脚本影响；如未来需要支持在 Dimo 内执行用户 pre-commit hooks，须作为显式可选能力单独设计。
