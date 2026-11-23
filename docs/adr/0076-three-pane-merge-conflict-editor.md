---
status: accepted
date: 2026-09-04
decision-makers: Dimo maintainers
---

# 三窗格冲突编辑器：冲突是工作区事实，解决只写工作区

## Context

Git 冲突是工作区的一等状态，用户需要不依赖 Agent 也能在工作区 Git 面板内看见所有冲突文件、逐块比对 base / ours / theirs 并安全写回结果；同时仍可按文件或冲突块粒度请 Agent 协助。本决定遵守 [ADR-0068](0068-workspace-default-surfaces-and-activity.md) 的工作区面板模型以及「自动化与宿主绝不自动提交/推送」的安全约束。

## Decision

### 1. 宿主提供索引三 stage 与冲突块切分，前端不解析标记

`crates/git` 提供读取冲突文件 stage 1（base）、stage 2（ours）、stage 3（theirs）内容与各自存在性（新增/删除冲突时缺失保持缺失，不以空串伪造）的能力，并由宿主基于 Git 三方合并结果给出冲突块切分。前端严禁自行正则解析 `<<<<<<<` / `=======` / `>>>>>>>` 冲突标记，避免文件内容本身包含类似文本时误解析。

### 2. 写回窄边界与全类型 `continue`

写回操作仅完成两件事：将解决后的完整内容写入工作区文件，以及将该路径标记为已解决（`git add`）。写回**绝不**自动 commit、自动 `--continue` 或自动 push。

`crates/git` 对全部四种 `ConflictOp`（`Rebase | Merge | CherryPick | Revert`）完整提供显式 `continue` 与 `abort` 操作，由用户在确认全部冲突已解决后手动触发。

### 3. 基于现有 Monaco 组装三窗格编辑器

不引入第三套编辑器或合并库，直接复用现有 Monaco 组件组装三窗格布局：

- 左上：`base ↔ ours` 只读 `DiffEditor`；
- 右上：`base ↔ theirs` 只读 `DiffEditor`；
- 下/中：可编辑结果区 `CodeEditor`（初始值为 Git 三方合并输出）。

逐块操作（取 ours、取 theirs、两者都取）与手工编辑共享同一结果缓冲区，无模式互斥。二进制文件与超大文件冲突不进入三窗格编辑器，直接提供整文件「取 ours / 取 theirs」动作；子模块冲突不在本编辑器范围内。

### 4. 独立 Dockview 面板 `PANEL_IDS.MERGE`

合并编辑器作为独立工作区面板登记在 `PANEL_IDS.MERGE`（面板 ID 形如 `merge:${filePath}`），与只读单文件/diff 预览面板 `PANEL_IDS.PREVIEW` 分离，避免同一组件混杂只读预览与可写未保存状态两套生命周期。

### 5. 工作区 Git 面板冲突分区与会话提示对齐

- `GitPanel` 的 diff 模式在暂存区之上条件展示冲突分区（仅当 `detect_conflict_op` 非空时出现），列出冲突文件路径、解决状态、点击直达合并面板以及底部显式 `continue` / `abort` 按钮。
- 会话侧的 `ConflictBanner` 保留就地提示职责，其「Resolve」动作直接打开对应三窗格合并面板，移除打开带冲突标记原始文本的旧入口。

### 6. Agent 协助收窄到文件/块粒度并走同一写回路径

`GitConflictResolutionDialog` 支持从合并面板针对当前文件或当前冲突块发起，提示词附带真实的 base / ours / theirs 内容片段。Agent 产出的建议结果落入结果缓冲区，由用户确认后经同一写回路径落盘，不开辟 Agent 绕过缓冲区直接覆盖工作区的旁路。

### 7. 未保存保护

关闭存在未写回变更的合并面板时必须弹窗确认，严禁静默丢弃用户的中间合并结果。

## Consequences

- 冲突状态与解决闭环完整归位工作区 Git 面板，覆盖 rebase、merge、cherry-pick 与 revert 四种冲突操作。
- 复用现有 Monaco 实例避免增加额外前端包体积与第三套 diff 渲染风格。
- 人类手工编辑与 Agent 辅助建议收敛于同一结果缓冲区与窄写回边界，兼顾可控性与安全性。

## Considered Options

- **引入独立第三方合并编辑器库**：否决。与现有 Monaco / diff 视图割裂且增加维护成本。
- **前端自行解析冲突标记**：否决。无法可靠区分真实文件内容与冲突分隔符，且各入口重复解析。
- **解决完最后一个文件后自动执行 `continue`**：否决。剥夺用户提交前最终检查的机会，将可回退中间态变成不可回退提交。
- **仅保留 AI 冲突解决对话框**：否决。Agent 不可用或判断有误时用户必须拥有独立、确定的手工处理路径。
