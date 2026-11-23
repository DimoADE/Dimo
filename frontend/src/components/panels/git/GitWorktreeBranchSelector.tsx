import { memo, useCallback, useMemo } from 'react';
import {
  Eye,
  Folder,
  FolderGit2,
  GitBranch as GitBranchIcon,
} from 'lucide-react';
import {
  Selector,
  SelectorOption,
  type SelectorOptionData,
  type SelectorOptionType,
} from '@astryxdesign/core/Selector';
import type { GitBranch, GitWorktreeInfo, Workspace } from 'shared/types';
import i18n from '@/i18n';

export type GitDiffTarget =
  | {
      kind: 'worktree';
      id: string;
      worktreePath: string | null;
      workspaceId: string | null;
      branch: string | null;
      directoryLabel: string;
      isMain: boolean;
      isExternal: boolean;
    }
  | {
      kind: 'branch';
      id: string;
      branch: string;
      baseBranch: string | null;
      directoryLabel: string;
    };

export interface DirectoryBranchGroup {
  id: string;
  directoryLabel: string;
  path: string | null;
  isMain: boolean;
  isExternal: boolean;
  /** When true (only 1 branch in this directory), omit Level 2 and render a single flat row */
  collapsed: boolean;
  options: GitDiffTarget[];
}

function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function getPathBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

function matchWorkspaceForWorktree(
  wt: GitWorktreeInfo,
  workspaces: Workspace[]
): Workspace | undefined {
  const wtNorm = normalizeFsPath(wt.path);
  const byPath = workspaces.find((ws) => {
    if (!ws.container_ref) return false;
    const containerNorm = normalizeFsPath(ws.container_ref);
    return wtNorm === containerNorm || wtNorm.startsWith(`${containerNorm}/`);
  });
  if (byPath) return byPath;
  if (!wt.is_main && wt.branch) {
    return workspaces.find((ws) => ws.use_worktree && ws.branch === wt.branch);
  }
  return undefined;
}

export function buildDirectoryBranchGroups({
  worktrees,
  branches,
  workspaces,
  fallbackCurrentBranch,
  baseBranch,
  defaultDirLabel,
}: {
  worktrees: GitWorktreeInfo[];
  branches: GitBranch[];
  workspaces: Workspace[];
  fallbackCurrentBranch: string | null;
  baseBranch: string | null;
  defaultDirLabel: string;
}): DirectoryBranchGroup[] {
  const localBranches = branches.filter((b) => !b.is_remote);
  const effectiveWorktrees: GitWorktreeInfo[] =
    worktrees.length > 0
      ? worktrees
      : [
          {
            path: '',
            branch:
              fallbackCurrentBranch ??
              localBranches.find((b) => b.is_current)?.name ??
              null,
            head_sha: null,
            is_main: true,
            is_detached: false,
            is_bare: false,
          },
        ];

  const mainWt =
    effectiveWorktrees.find((wt) => wt.is_main) ?? effectiveWorktrees[0];
  const linkedWts = effectiveWorktrees.filter((wt) => wt !== mainWt);

  const linkedBranchSet = new Set<string>();
  for (const wt of linkedWts) {
    if (wt.branch) {
      linkedBranchSet.add(wt.branch);
    }
  }

  const groups: DirectoryBranchGroup[] = [];

  // 1. Default Directory group (live working tree + non-checked-out local branches as read-only)
  const mainWorkspace = mainWt.path
    ? matchWorkspaceForWorktree(mainWt, workspaces)
    : undefined;
  const mainBranch = mainWt.branch ?? fallbackCurrentBranch ?? null;
  const effectiveBase = baseBranch || mainBranch;

  const mainOptions: GitDiffTarget[] = [
    {
      kind: 'worktree',
      id: `wt:main`,
      worktreePath: mainWt.path || null,
      workspaceId: mainWorkspace?.id ?? null,
      branch: mainBranch,
      directoryLabel: defaultDirLabel,
      isMain: true,
      isExternal: false,
    },
  ];

  for (const branch of localBranches) {
    if (branch.name === mainBranch || linkedBranchSet.has(branch.name)) {
      continue;
    }
    mainOptions.push({
      kind: 'branch',
      id: `branch:${branch.name}`,
      branch: branch.name,
      baseBranch: effectiveBase,
      directoryLabel: defaultDirLabel,
    });
  }

  groups.push({
    id: 'dir:main',
    directoryLabel: defaultDirLabel,
    path: mainWt.path || null,
    isMain: true,
    isExternal: false,
    collapsed: mainOptions.length <= 1,
    options: mainOptions,
  });

  // 2. Linked worktrees (Dimo-managed + external git worktree add)
  for (const wt of linkedWts) {
    if (wt.is_bare) continue;
    const matchedWs = matchWorkspaceForWorktree(wt, workspaces);
    const dirLabel = matchedWs?.name?.trim() || getPathBasename(wt.path);
    const isExternal = !matchedWs;
    const option: GitDiffTarget = {
      kind: 'worktree',
      id: `wt:${wt.path}`,
      worktreePath: wt.path,
      workspaceId: matchedWs?.id ?? null,
      branch: wt.branch,
      directoryLabel: dirLabel,
      isMain: false,
      isExternal,
    };

    groups.push({
      id: `dir:${wt.path}`,
      directoryLabel: dirLabel,
      path: wt.path,
      isMain: false,
      isExternal,
      collapsed: true,
      options: [option],
    });
  }

  return groups;
}

interface OptionMetadata {
  target: GitDiffTarget;
  group: DirectoryBranchGroup;
  collapsed: boolean;
}

function getTriggerLabel(target: GitDiffTarget, detachedLabel: string): string {
  const branchText = target.branch ?? detachedLabel;
  if (target.kind === 'branch') {
    return `${branchText} (${i18n.t('panels:ui.git.readOnlyBranchDiff')})`;
  }
  if (!target.isMain) {
    return `${branchText} · ${target.directoryLabel}`;
  }
  return branchText;
}

interface GitWorktreeBranchSelectorProps {
  groups: DirectoryBranchGroup[];
  selectedTarget: GitDiffTarget | null;
  onSelectTarget: (target: GitDiffTarget) => void;
  isLoading?: boolean;
}

export const GitWorktreeBranchSelector = memo(
  function GitWorktreeBranchSelector({
    groups,
    selectedTarget,
    onSelectTarget,
    isLoading = false,
  }: GitWorktreeBranchSelectorProps) {
    const detachedLabel = i18n.t('panels:ui.git.detachedHead');

    const { selectorOptions, metaById, totalOptions } = useMemo(() => {
      const options: SelectorOptionType[] = [];
      const map = new Map<string, OptionMetadata>();
      let count = 0;

      for (const group of groups) {
        if (group.collapsed && group.options.length === 1) {
          const target = group.options[0];
          map.set(target.id, { target, group, collapsed: true });
          options.push({
            value: target.id,
            label: getTriggerLabel(target, detachedLabel),
          });
          count += 1;
          continue;
        }

        const sectionOptions: SelectorOptionData[] = group.options.map(
          (target) => {
            map.set(target.id, { target, group, collapsed: false });
            count += 1;
            return {
              value: target.id,
              label: getTriggerLabel(target, detachedLabel),
            };
          }
        );

        const sectionTitle = group.isExternal
          ? `${group.directoryLabel} (${i18n.t('panels:ui.git.externalWorktree')})`
          : group.directoryLabel;

        options.push({
          type: 'section',
          title: sectionTitle,
          options: sectionOptions,
        });
      }

      return {
        selectorOptions: options,
        metaById: map,
        totalOptions: count,
      };
    }, [groups, detachedLabel]);

    const handleChange = useCallback(
      (nextId: string) => {
        const meta = metaById.get(nextId);
        if (meta) {
          onSelectTarget(meta.target);
        }
      },
      [metaById, onSelectTarget]
    );

    const renderOption = useCallback(
      (option: SelectorOptionData) => {
        const meta = metaById.get(option.value);
        if (!meta) {
          return (
            <SelectorOption
              label={
                <span className="text-[11px] font-normal">
                  {option.label ?? option.value}
                </span>
              }
            />
          );
        }

        const { target, group, collapsed } = meta;
        const branchText = target.branch ?? detachedLabel;

        if (collapsed) {
          return (
            <SelectorOption
              icon={
                group.isMain ? (
                  <Folder className="h-3 w-3" />
                ) : (
                  <FolderGit2 className="h-3 w-3" />
                )
              }
              label={
                <span className="font-mono text-[11px] font-normal">
                  {branchText}
                </span>
              }
              description={
                group.isMain ? undefined : (
                  <span className="text-[10px] text-muted-foreground">
                    {group.directoryLabel}
                    {group.isExternal
                      ? ` · ${i18n.t('panels:ui.git.externalWorktree')}`
                      : ''}
                  </span>
                )
              }
            />
          );
        }

        const isReadOnly = target.kind === 'branch';
        return (
          <SelectorOption
            icon={
              isReadOnly ? (
                <Eye className="h-3 w-3" />
              ) : (
                <GitBranchIcon className="h-3 w-3" />
              )
            }
            label={
              <span className="font-mono text-[11px] font-normal">
                {branchText}
              </span>
            }
            endContent={
              isReadOnly ? (
                <span className="text-[10px] text-muted-foreground">
                  {i18n.t('panels:ui.git.readOnlyBranchDiff')}
                </span>
              ) : undefined
            }
          />
        );
      },
      [metaById, detachedLabel]
    );

    const startIcon =
      selectedTarget?.kind === 'branch' ? (
        <Eye className="h-3 w-3" />
      ) : (
        <GitBranchIcon className="h-3 w-3" />
      );

    return (
      <div className="min-w-0 flex-1">
        <Selector
          label={i18n.t('panels:ui.git.selectDirectoryOrBranch')}
          isLabelHidden
          size="sm"
          width="100%"
          placement="below"
          className="git-branch-selector"
          data-testid="git-worktree-branch-selector"
          options={selectorOptions}
          value={selectedTarget?.id}
          onChange={handleChange}
          isLoading={isLoading}
          placeholder={detachedLabel}
          startIcon={startIcon}
          hasSearch={totalOptions > 6}
          searchPlaceholder={i18n.t('panels:ui.git.filterBranches')}
          renderOption={renderOption}
        />
      </div>
    );
  }
);
