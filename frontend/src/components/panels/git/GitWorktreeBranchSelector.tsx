import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Folder,
  FolderGit2,
  GitBranch as GitBranchIcon,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import type { GitBranch, GitWorktreeInfo, Workspace } from 'shared/types';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
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

type VisibleEntry =
  | {
      kind: 'directory';
      group: DirectoryBranchGroup;
    }
  | {
      kind: 'option';
      target: GitDiffTarget;
      group: DirectoryBranchGroup;
      showDirectoryHint: boolean;
    };

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

function matchesSearchQuery(
  target: GitDiffTarget,
  group: DirectoryBranchGroup,
  detachedLabel: string,
  query: string
): boolean {
  const haystack = [
    target.branch ?? detachedLabel,
    target.directoryLabel,
    group.directoryLabel,
    group.path ?? '',
    getTriggerLabel(target, detachedLabel),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
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
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const activeGroup = useMemo(
      () =>
        activeGroupId
          ? (groups.find((group) => group.id === activeGroupId) ?? null)
          : null,
      [activeGroupId, groups]
    );

    const totalOptions = useMemo(
      () => groups.reduce((sum, group) => sum + group.options.length, 0),
      [groups]
    );
    const showSearch = totalOptions > 6;
    const normalizedQuery = search.trim().toLowerCase();

    const visibleEntries = useMemo<VisibleEntry[]>(() => {
      // Level 2: branches inside the clicked directory
      if (activeGroup) {
        return activeGroup.options
          .filter(
            (target) =>
              !normalizedQuery ||
              matchesSearchQuery(
                target,
                activeGroup,
                detachedLabel,
                normalizedQuery
              )
          )
          .map((target) => ({
            kind: 'option',
            target,
            group: activeGroup,
            showDirectoryHint: false,
          }));
      }

      // Global search from Level 1: filter directly across all targets
      if (normalizedQuery) {
        const matches: VisibleEntry[] = [];
        for (const group of groups) {
          for (const target of group.options) {
            if (
              matchesSearchQuery(target, group, detachedLabel, normalizedQuery)
            ) {
              matches.push({
                kind: 'option',
                target,
                group,
                showDirectoryHint: groups.length > 1 || !group.isMain,
              });
            }
          }
        }
        return matches;
      }

      // Level 1: directory list (multi-branch directories open Level 2 on click; single-branch worktrees select directly)
      return groups
        .filter((group) => group.options.length > 0)
        .map((group) =>
          group.collapsed && group.options.length === 1
            ? {
                kind: 'option',
                target: group.options[0],
                group,
                showDirectoryHint: !group.isMain,
              }
            : {
                kind: 'directory',
                group,
              }
        );
    }, [activeGroup, detachedLabel, groups, normalizedQuery]);

    useEffect(() => {
      if (!open) return;
      if (showSearch) {
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
        });
      }
    }, [open, showSearch, activeGroupId]);

    const handleOpenChange = useCallback((nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        setSearch('');
        setActiveGroupId(null);
        setHighlightedIndex(-1);
      }
    }, []);

    const handleSelect = useCallback(
      (target: GitDiffTarget) => {
        onSelectTarget(target);
        handleOpenChange(false);
      },
      [onSelectTarget, handleOpenChange]
    );

    const handleEnterDirectory = useCallback((groupId: string) => {
      setActiveGroupId(groupId);
      setSearch('');
      setHighlightedIndex(0);
    }, []);

    const handleBackToDirectories = useCallback(() => {
      setActiveGroupId(null);
      setSearch('');
      setHighlightedIndex(-1);
    }, []);

    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          handleOpenChange(false);
          return;
        }
        if (event.key === 'ArrowLeft' && activeGroup && search.length === 0) {
          event.preventDefault();
          handleBackToDirectories();
          return;
        }
        if (visibleEntries.length === 0) return;

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setHighlightedIndex((prev) =>
            prev < 0 ? 0 : (prev + 1) % visibleEntries.length
          );
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setHighlightedIndex((prev) =>
            prev <= 0 ? visibleEntries.length - 1 : prev - 1
          );
        } else if (event.key === 'ArrowRight' && highlightedIndex >= 0) {
          const entry = visibleEntries[highlightedIndex];
          if (entry?.kind === 'directory') {
            event.preventDefault();
            handleEnterDirectory(entry.group.id);
          }
        } else if (event.key === 'Enter' && highlightedIndex >= 0) {
          const entry = visibleEntries[highlightedIndex];
          if (!entry) return;
          event.preventDefault();
          if (entry.kind === 'directory') {
            handleEnterDirectory(entry.group.id);
          } else {
            handleSelect(entry.target);
          }
        }
      },
      [
        activeGroup,
        handleBackToDirectories,
        handleEnterDirectory,
        handleOpenChange,
        handleSelect,
        highlightedIndex,
        search.length,
        visibleEntries,
      ]
    );

    const triggerLabel = selectedTarget
      ? getTriggerLabel(selectedTarget, detachedLabel)
      : detachedLabel;

    const startIcon = isLoading ? (
      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
    ) : selectedTarget?.kind === 'branch' ? (
      <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />
    ) : (
      <GitBranchIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
    );

    const readOnlyLabel = i18n.t('panels:ui.git.readOnlyBranchDiff');
    const worktreeLabel = i18n.t('panels:ui.git.externalWorktree');

    const renderDirectoryRow = (
      group: DirectoryBranchGroup,
      entryIndex: number
    ) => {
      const selectedInGroup = group.options.find(
        (option) => option.id === selectedTarget?.id
      );
      const summaryBranch =
        selectedInGroup?.branch ?? group.options[0]?.branch ?? detachedLabel;
      const isHighlighted = entryIndex === highlightedIndex;
      const stateClass = isHighlighted
        ? 'bg-accent text-foreground'
        : selectedInGroup
          ? 'bg-accent/60 text-foreground'
          : 'text-foreground hover:bg-accent/60';

      return (
        <button
          key={group.id}
          type="button"
          role="option"
          aria-selected={Boolean(selectedInGroup)}
          aria-haspopup="listbox"
          data-testid={`git-dir-group-${group.id}`}
          onMouseEnter={() => setHighlightedIndex(entryIndex)}
          onClick={() => handleEnterDirectory(group.id)}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${stateClass}`}
        >
          {group.isMain ? (
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1">
            <span
              className="block truncate text-[11px] font-medium leading-snug"
              title={group.directoryLabel}
            >
              {group.directoryLabel}
            </span>
            <span
              className="block truncate font-mono text-[10px] leading-tight text-muted-foreground"
              title={summaryBranch}
            >
              {summaryBranch}
            </span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {!group.isMain && (
              <span className="rounded bg-muted/70 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                {worktreeLabel}
              </span>
            )}
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {group.options.length}
            </span>
            <ChevronRight
              aria-hidden="true"
              className="h-3 w-3 shrink-0 text-muted-foreground"
            />
          </span>
        </button>
      );
    };

    const renderOptionRow = (
      entry: Extract<VisibleEntry, { kind: 'option' }>,
      entryIndex: number
    ) => {
      const { target, group, showDirectoryHint } = entry;
      const branchText = target.branch ?? detachedLabel;
      const isSelected = selectedTarget?.id === target.id;
      const isHighlighted = entryIndex === highlightedIndex;
      const isReadOnly = target.kind === 'branch';
      const isCollapsedWorktree = !activeGroup && !normalizedQuery;

      const stateClass = isHighlighted
        ? 'bg-accent text-foreground'
        : isSelected
          ? 'bg-accent/70 text-foreground'
          : 'text-foreground hover:bg-accent/60';

      return (
        <button
          key={target.id}
          type="button"
          role="option"
          aria-selected={isSelected}
          onMouseEnter={() => setHighlightedIndex(entryIndex)}
          onClick={() => handleSelect(target)}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors ${stateClass}`}
        >
          {isCollapsedWorktree ? (
            group.isMain ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )
          ) : isReadOnly ? (
            <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <GitBranchIcon className="h-3 w-3 shrink-0 text-primary" />
          )}
          <span className="min-w-0 flex-1">
            <span
              className="block truncate font-mono text-[11px] leading-snug"
              title={branchText}
            >
              {branchText}
            </span>
            {showDirectoryHint && (
              <span
                className="block truncate text-[10px] leading-tight text-muted-foreground"
                title={group.directoryLabel}
              >
                {group.directoryLabel}
              </span>
            )}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {isReadOnly && (
              <span className="rounded bg-muted/70 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                {readOnlyLabel}
              </span>
            )}
            {!isReadOnly && !group.isMain && (
              <span className="rounded bg-muted/70 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                {worktreeLabel}
              </span>
            )}
            <span
              aria-hidden="true"
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
            >
              {isSelected && <Check className="h-3 w-3 text-primary" />}
            </span>
          </span>
        </button>
      );
    };

    return (
      <div className="min-w-0 flex-1">
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="git-worktree-branch-selector"
              aria-label={i18n.t('panels:ui.git.selectDirectoryOrBranch')}
              aria-expanded={open}
              aria-haspopup="listbox"
              title={triggerLabel}
              className={`astryx-selector git-branch-selector inline-flex h-6 w-full min-w-0 items-center gap-1.5 rounded-full border px-2 text-[11px] transition-colors ${
                open
                  ? 'border-primary/50 bg-accent/60 text-foreground'
                  : 'border-border/60 bg-background/70 text-foreground hover:border-border hover:bg-accent/50'
              }`}
            >
              {startIcon}
              <span className="min-w-0 flex-1 truncate text-left font-mono leading-none">
                {triggerLabel}
              </span>
              <ChevronDown
                aria-hidden="true"
                className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
                  open ? 'rotate-180' : ''
                }`}
              />
            </button>
          </PopoverTrigger>

          <PopoverContent
            align="start"
            sideOffset={4}
            onKeyDown={handleKeyDown}
            className="w-[310px] max-w-[min(360px,calc(100vw-24px))] overflow-hidden p-0"
          >
            {activeGroup && (
              <div className="flex items-center gap-1.5 border-b border-border/40 px-2 py-1.5">
                <button
                  type="button"
                  data-testid="git-branch-selector-back"
                  aria-label={i18n.t('panels:ui.git.backToDirectories')}
                  onClick={handleBackToDirectories}
                  className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-[11px] font-medium text-foreground transition-colors hover:bg-accent/60"
                >
                  <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {activeGroup.isMain ? (
                    <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderGit2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{activeGroup.directoryLabel}</span>
                </button>
                {!activeGroup.isMain && (
                  <span className="shrink-0 rounded bg-muted/70 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                    {worktreeLabel}
                  </span>
                )}
                <span className="shrink-0 pr-1 text-[10px] tabular-nums text-muted-foreground">
                  {visibleEntries.length}
                </span>
              </div>
            )}

            {showSearch && (
              <div className="border-b border-border/40 px-2 py-1.5">
                <div
                  data-control-frame="true"
                  className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2 transition-colors focus-within:border-primary/60"
                >
                  <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setHighlightedIndex(0);
                    }}
                    aria-label={i18n.t('panels:ui.git.filterBranches')}
                    placeholder={i18n.t('panels:ui.git.filterBranches')}
                    className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 pl-0.5 text-[11px] leading-normal text-foreground shadow-none placeholder:text-[11px] placeholder:text-muted-foreground focus:outline-none"
                  />
                  {search.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch('');
                        setHighlightedIndex(-1);
                        searchInputRef.current?.focus();
                      }}
                      aria-label={i18n.t('panels:ui.git.clearSearch')}
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div
              role="listbox"
              aria-label={i18n.t('panels:ui.git.selectDirectoryOrBranch')}
              className="max-h-[280px] overflow-y-auto p-1"
            >
              {visibleEntries.length === 0 ? (
                <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                  {i18n.t('panels:ui.git.noMatchingBranches')}
                </div>
              ) : activeGroup ? (
                <div
                  role="group"
                  aria-label={activeGroup.directoryLabel}
                  className="space-y-0.5"
                >
                  {visibleEntries.map((entry, idx) =>
                    entry.kind === 'option' ? renderOptionRow(entry, idx) : null
                  )}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {visibleEntries.map((entry, idx) =>
                    entry.kind === 'directory'
                      ? renderDirectoryRow(entry.group, idx)
                      : renderOptionRow(entry, idx)
                  )}
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    );
  }
);
