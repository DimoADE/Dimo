---
status: accepted
date: 2026-09-04
decision-makers: Dimo maintainers
---

# 通过 SSH 供给与接管远程 Dimo Server

## Context

用户常面对仅具备 SSH 访问权限、无公网域名也未预装 Dimo 的远端开发机。Dimo 已通过 [ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md)、[ADR-0054](0054-host-family-distribution-and-client-surfaces.md)、[ADR-0059](0059-host-identity-and-pairing-invitation.md) 与 [ADR-0078](0078-host-command-registry-single-seam.md) 建立了共享 Application Core、Remote Protocol v1 与单一 Host 命令注册表。本决定补齐 SSH 供给、隧道承载与信任引导通道，使桌面客户端能够将完整编码工作区无缝托管在远端 `dimo-server` 上——Agent、Git worktree、终端与插件全部运行于远端，本地桌面仅作客户端。

## Decision

### 1. 拓扑与职责分离

SSH 仅承担三项职责：**供给通道**（投递、启动与升级 `dimo-server`）、**承载隧道**（`ssh -L` 本地端口转发）与**信任引导通道**（经 SSH exec 获取一次性配对邀请）。所有应用数据面保持 Remote Protocol v1 over HTTP/WS 不变，SSH 不成为第二套应用协议。

```text
桌面 / WebUI 客户端
  │  Remote Protocol v1（HTTP/WS，device credential）
  ▼
127.0.0.1:<forwarded>  ── ssh -L 隧道 ──▶  远端 127.0.0.1:<port>
                                              │
                                        dimo-server（SSH-only loopback）
                                              │
                        Agent / worktree / PTY / Plugin Kernel（全在远端）
```

远端 `dimo-server` 以 **SSH-only 模式**运行：仅绑定 loopback，不发布任何非 loopback Reachability，公网零暴露；仍遵守 [ADR-0054](0054-host-family-distribution-and-client-surfaces.md) 单数据目录单 Host 约束。

### 2. SSH Host Profile 与六步幂等供给管线

Server Profile 支持 `provisionKind = ssh`，仅保存 SSH 目标（host、port、user、可选 jump）与远端数据目录等**非秘密元数据**。SSH 认证严格复用用户系统 SSH 环境（`~/.ssh/config`、ssh-agent、密钥文件；同 [ADR-0060](0060-agent-installs-use-user-environment.md) 原则），Dimo 不存储、不生成、不代管 SSH 私钥，也不接管 `known_hosts` 信任决策（host key 变化时原样呈现系统 SSH 警告并阻断）。

连接 SSH Profile 执行六步幂等、可单步重试的管线：

1. **探测**：经 SSH 识别远端 OS/arch（首版面向 Linux/macOS 远端）、既有 `dimo-server` 版本以及目标数据目录占用状态（若已被其它 Host 占用则按 [ADR-0054](0054-host-family-distribution-and-client-surfaces.md) 拒绝启动第二份 Host）。
2. **投递**：缺失或版本不配套时，下载（远端直连或本地中转）同 semver 家族的 Dimo Server 发行包，经 SHA-256 校验后解压到 `~/.dimo/server/<version>/` 并原子切换 `current` 链接。
3. **启动**：以 loopback SSH-only 模式启动 `dimo-server` 并等待健康检查；进程守护默认使用 `nohup` + pidfile（附带可选 systemd user unit 模板），不强制远端安装 Docker 或 systemd。
4. **隧道**：建立 `ssh -L` 随机本地端口转发，断线自动重建；隧道生命周期绑定到发起连接的 Server-bound window（[ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md)）。
5. **信任引导**：自动完成一次性配对兑换（见第 3 节）。
6. **连接**：以 `127.0.0.1:<forwarded>` 走既有 `RemoteDesktopTransport` 连接，复用全部远程订阅与能力协商。

版本偏斜时通过 `PROTOCOL_VERSION` 与 `ServerCapabilities` 在兼容窗口内降级并提示升级，提供基于 `plan_host_upgrade` / `apply_host_upgrade` 的一键升级与失败自动回滚。

### 3. SSH 信任引导（扩展 ADR-0059）

- **SSH 权限即管理员证明**：能够 SSH 登录并读写目标数据目录的主体等价于本机控制台管理员。供给器经 SSH exec 向远端 `dimo-server` 申请 5 分钟一次性 pairing secret 并立即兑换为本机 scoped device credential，全程不落盘、不进 URL、无需手工抄码。
- **隧道地址不污染 Host 权威名单**：`127.0.0.1:<forwarded>` 仅作为客户端本地 Reachability（kind `ssh-tunnel`）保存在本机 Profile 中，永不写入 Host 对外发布的权威 Reachability 名单。
- **断连与运维动作分离**：沿用 `disconnect`（关隧道保配对）、`forget`（先远程撤销再清本地 Profile 与凭据）与 `revoke` 三动作；「停止远端 Server」「卸载远端 Server」作为需显式确认的独立 SSH 运维动作，不与 `forget` 隐式绑定。

### 4. 插件化供给器与统一能力面

- **插件运行在远端 Host**：远程窗口使用远端 Host 上的插件集、Worker 与数据，不在本地桌面复制执行；能力边界由远端 Host Command Registry 派生的 `ServerCapabilities` 诚实呈现（[ADR-0078](0078-host-command-registry-single-seam.md)），仅本机可用的能力（如本机桌面壳控制台）按 capability 降级。
- **SSH 供给器作为官方插件交付**：Host 通过公开 `provider.remote.provisioner` 贡献点与 `host.call remote.profile.* / remote.connect` 暴露供给接缝，官方能力等价插件 `dimo.remote-ssh`（[ADR-0069](0069-everything-is-a-plugin-platform.md)）实现 SSH 探测、投递、隧道与配对。Host 不按插件 ID 特判，第三方可用同一 SDK 实现 mosh、Teleport 或云厂商 API 供给器；卸载插件默认不删除已保存 Host Profile。

### 5. 安全基线

1. **零公网暴露**：远端 `dimo-server` 仅绑定 loopback。
2. **凭据边界严格**：私钥归系统 SSH，device credential 归系统凭据库，pairing secret 仅存于瞬时内存信道，不写远端磁盘、不进日志。
3. **供应链与审计**：发行包强制 SHA-256 校验；供给、启动、升级、停止、卸载与信任引导在客户端与远端双侧记录操作审计。

## Consequences

- 仅具备 SSH 权限的远端 Linux/macOS 服务器无需手工部署即可获得完整的远程 Dimo Host 编码闭环。
- 隧道断线自动重建与 durable attach 保证网络抖动不丢会话状态。
- 供给器走公开 `provider.remote.provisioner` 接缝，既保持远程工作区核心在 L0，又兑现 [ADR-0069](0069-everything-is-a-plugin-platform.md) 的无特权插件承诺。

## Considered Options

- **将 SSH exec / SFTP 作为应用数据面协议**：否决。形成第二套并行协议，绕过 Remote Protocol v1 的版本协商、事件订阅与 capabilities 机制。
- **分裂扩展执行面（UI 插件跑本地、workspace 插件跑远端）**：否决。破坏 [ADR-0054](0054-host-family-distribution-and-client-surfaces.md) 单 Host 插件内核与 [ADR-0069](0069-everything-is-a-plugin-platform.md) 单一接管面。
- **本地运行 Host + rsync 双向同步远端代码**：否决。双向文件同步与 Git worktree 隔离、事件溯源会话历史语义不可调和。
- **强依赖远端 Docker 或 systemd**：否决。自包含 Server 目录零前置依赖，Docker 与 systemd 仅作可选部署形态。
