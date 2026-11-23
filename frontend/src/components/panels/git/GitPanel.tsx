import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GitBranch,
  History,
  ArrowLeftRight,
  Download,
  RefreshCw,
  Loader2,
  GitBranchPlus,
  GitPullRequest,
  CircleDot,
  LayoutList,
  FolderTree,
  GitGraph,
  Eye,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useAttempt } from '@/hooks/useAttempt';
import { useProjectRepos } from '@/hooks';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import {
  useGitStatus,
  useGitDiffs,
  shouldAutoPreloadDiffs,
  useGitLog,
  useGitActions,
  useGitCommit,
  useGitBranches,
  useGitHubData,
  useGitPanelController,
  useRepoWorktrees,
  useBranchDiffs,
  type GitPanelMode,
} from '@/hooks/git';
import {
  Selector,
  SelectorOption,
  type SelectorOptionData,
} from '@astryxdesign/core/Selector';
import { GitConflictSection } from './GitConflictSection';
import { GitStagingArea } from './GitStagingArea';
import { GitCommitBox } from './GitCommitBox';
import { GitChangeStats } from './GitChangeStats';
import { GitLogView } from './GitLogView';
import { GitBranchList } from './GitBranchList';
import { GitIssuesView } from './GitIssuesView';
import { GitPRsView } from './GitPRsView';
import {
  GitWorktreeBranchSelector,
  buildDirectoryBranchGroups,
  type GitDiffTarget,
} from './GitWorktreeBranchSelector';
import { resolveDefaultLogBranches } from './GitLogBranchFilter';
import { useBranchStatus } from '@/hooks/useBranchStatus';
import { useAttemptConflicts } from '@/hooks/useAttemptConflicts';
import { usePanelActions } from '@/hooks/usePanelActions';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';
import { useCommitDiffStore } from '@/stores/useCommitDiffStore';
import { useAppContextMenu } from '@/components/context-menu';
import { attemptsApi, projectsApi } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ShellNavPanelDragHandle } from '@/components/layout/ShellNavPanelDragHandle';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import i18n from '@/i18n';

const DEFAULT_LOG_PAGE_SIZE = 100;

const GIT_PANEL_MODE_OPTIONS: SelectorOptionData[] = [
  {
    value: 'diff',
    label: 'Diff',
    icon: <ArrowLeftRight className="h-3 w-3" />,
  },
  {
    value: 'log',
    label: 'Log',
    icon: <History className="h-3 w-3" />,
  },
  {
    value: 'branches',
    label: 'Branch',
    icon: <GitBranchPlus className="h-3 w-3" />,
  },
  {
    value: 'issues',
    label: 'Issue',
    icon: <CircleDot className="h-3 w-3" />,
  },
  {
    value: 'prs',
    label: 'PR',
    icon: <GitPullRequest className="h-3 w-3" />,
  },
];

function EmptyState() {
  return (
    <div className="relative h-full w-full flex items-center justify-center text-muted-foreground text-sm">
      <div className="absolute right-2 top-1.5">
        <ShellNavPanelDragHandle panelId={PANEL_IDS.GIT} />
      </div>
      <div className="text-center space-y-2">
        <GitBranch className="h-8 w-8 opacity-40 mx-auto" />
        <p className="font-medium">Git</p>
        <p className="text-xs">{i18n.t('panels:ui.git.thisFolderIsNotA')}</p>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="h-full w-full flex items-center justify-center text-muted-foreground text-xs">
      {i18n.t('panels:ui.git.loadingGitStatus')}
    </div>
  );
}

export function GitPanel() {
  const { openSurfaceMenu } = useAppContextMenu();
  const { openDiffPreview, openMergePanel } = usePanelActions();
  const queryClient = useQueryClient();
  const [conflictBusy, setConflictBusy] = useState<'continue' | 'abort' | null>(
    null
  );
  const focusDiffPath = useGitDiffNavigationStore((state) => state.focusPath);
  const setReviewSource = useGitDiffNavigationStore(
    (state) => state.setReviewSource
  );
  const clearCommitDiff = useCommitDiffStore((state) => state.clearCommitDiff);
  const { activeWorktreeId } = useWorktree();
  const { workspaceId: routeWorkspaceId, projectId } = useParams<{
    workspaceId?: string;
    projectId?: string;
  }>();
  const effectiveWorkspaceId = activeWorktreeId ?? routeWorkspaceId ?? null;
  const { data: workspace } = useAttempt(effectiveWorkspaceId ?? undefined);
  const { selectedRepoId, isLoading: attemptRepoLoading } = useAttemptRepo(
    effectiveWorkspaceId ?? undefined
  );

  // When no workspace is active, fall back to the project's first repo
  const projectReposQuery = useProjectRepos(projectId, {
    enabled: !!projectId,
  });
  const projectRepos = useMemo(
    () => projectReposQuery.data ?? [],
    [projectReposQuery.data]
  );
  const parentHasNoGitRepo =
    projectReposQuery.isSuccess && projectRepos.length === 0;
  const { data: gitChildren = [], isLoading: gitChildrenLoading } = useQuery({
    queryKey: ['project-git-children', projectId],
    queryFn: () => projectsApi.gitChildren(projectId!),
    enabled: Boolean(projectId) && parentHasNoGitRepo,
    staleTime: 30_000,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === projectId ? previousData : undefined,
  });
  const [gitChildId, setGitChildId] = useState<string | null>(null);
  useEffect(() => {
    setGitChildId(null);
  }, [projectId]);
  const selectedGitChildId = gitChildId ?? gitChildren[0]?.id ?? null;
  const { data: childRepos = [], isLoading: childReposLoading } =
    useProjectRepos(selectedGitChildId, {
      enabled: parentHasNoGitRepo && !!selectedGitChildId,
    });
  const fallbackRepoId = parentHasNoGitRepo
    ? (childRepos[0]?.id ?? null)
    : (selectedRepoId ?? projectRepos[0]?.id ?? null);

  const workspaceId = parentHasNoGitRepo ? null : effectiveWorkspaceId;
  const repoId = fallbackRepoId;
  const activeRepo = useMemo(
    () =>
      (parentHasNoGitRepo ? childRepos : projectRepos).find(
        (repo) => repo.id === repoId
      ) ?? null,
    [parentHasNoGitRepo, childRepos, projectRepos, repoId]
  );

  const isResolvingRepo =
    !repoId &&
    (Boolean(projectId && projectReposQuery.isLoading) ||
      Boolean(effectiveWorkspaceId && attemptRepoLoading) ||
      Boolean(parentHasNoGitRepo && (gitChildrenLoading || childReposLoading)));

  const {
    mode,
    setMode,
    diffListView,
    toggleDiffListView,
    logViewMode,
    toggleLogViewMode,
    selectedDiffPath,
    setSelectedDiffPath,
  } = useGitPanelController();

  // Local Diff target selection & Log multi-branch filter state (scoped to GitPanel)
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [selectedLogBranches, setSelectedLogBranches] = useState<
    string[] | null
  >(null);
  const [logMaxCount, setLogMaxCount] = useState(DEFAULT_LOG_PAGE_SIZE);

  useEffect(() => {
    setSelectedTargetId(null);
    setSelectedLogBranches(null);
    setLogMaxCount(DEFAULT_LOG_PAGE_SIZE);
  }, [projectId, repoId]);

  const { worktrees: projectWorktreeEntries } = useProjectWorktrees(projectId);
  const projectWorkspaces = useMemo(
    () => projectWorktreeEntries.map((item) => item.workspace),
    [projectWorktreeEntries]
  );

  const {
    worktrees: repoWorktrees,
    isLoading: worktreesLoading,
    refresh: refreshWorktrees,
  } = useRepoWorktrees({
    repoId,
    enabled: Boolean(repoId),
  });

  // Load branches across Diff, Log, and Branches modes so selectors always have full data
  const repoBranchesQuery = useGitBranches({
    workspaceId: null,
    repoId,
    enabled:
      Boolean(repoId) &&
      (mode === 'diff' || mode === 'log' || mode === 'branches'),
  });

  const defaultDirLabel = i18n.t('panels:ui.git.defaultDirectory');
  const directoryGroups = useMemo(
    () =>
      buildDirectoryBranchGroups({
        worktrees: repoWorktrees,
        branches: repoBranchesQuery.branches,
        workspaces: projectWorkspaces,
        fallbackCurrentBranch: workspace?.branch ?? null,
        baseBranch: activeRepo?.default_target_branch ?? null,
        defaultDirLabel,
      }),
    [
      repoWorktrees,
      repoBranchesQuery.branches,
      projectWorkspaces,
      workspace?.branch,
      activeRepo?.default_target_branch,
      defaultDirLabel,
    ]
  );

  const allTargets = useMemo(
    () => directoryGroups.flatMap((group) => group.options),
    [directoryGroups]
  );

  const activeTarget = useMemo<GitDiffTarget | null>(() => {
    if (selectedTargetId) {
      const matched = allTargets.find(
        (target) => target.id === selectedTargetId
      );
      if (matched) return matched;
    }
    if (workspaceId) {
      const wsMatch = allTargets.find(
        (target) =>
          target.kind === 'worktree' && target.workspaceId === workspaceId
      );
      if (wsMatch) return wsMatch;
    }
    return (
      allTargets.find(
        (target) => target.kind === 'worktree' && target.isMain
      ) ??
      allTargets[0] ??
      null
    );
  }, [allTargets, selectedTargetId, workspaceId]);

  const isReadOnlyBranchTarget = activeTarget?.kind === 'branch';

  const activeTargetWorkspaceId = useMemo(() => {
    if (!activeTarget || activeTarget.kind !== 'worktree') {
      return null;
    }
    if (activeTarget.workspaceId) {
      return activeTarget.workspaceId;
    }
    if (activeTarget.isMain && !activeTarget.worktreePath) {
      return workspaceId;
    }
    return null;
  }, [activeTarget, workspaceId]);

  const activeTargetWorktreePath = useMemo(() => {
    if (!activeTarget || activeTarget.kind !== 'worktree') {
      return null;
    }
    if (activeTargetWorkspaceId) {
      return null;
    }
    return activeTarget.worktreePath;
  }, [activeTarget, activeTargetWorkspaceId]);

  const { data: branchStatus } = useBranchStatus(
    activeTargetWorkspaceId ?? undefined
  );
  const conflictStatus = branchStatus?.find((repo) => repo.repo_id === repoId);
  const conflictOp = conflictStatus?.conflict_op ?? null;
  const conflictedFiles = conflictStatus?.conflicted_files ?? [];
  const { abortConflicts } = useAttemptConflicts(
    activeTargetWorkspaceId ?? undefined,
    repoId ?? undefined
  );

  const {
    branchName,
    stagedFiles,
    unstagedFiles,
    totalAdditions,
    totalDeletions,
    isLoading: statusLoading,
    refresh: refreshStatus,
  } = useGitStatus({
    workspaceId: activeTargetWorkspaceId,
    repoId,
    worktreePath: activeTargetWorktreePath,
    enabled: !isReadOnlyBranchTarget,
  });

  const displayedBranchName =
    activeTarget?.branch || workspace?.branch || branchName;

  const displayedTarget = useMemo<GitDiffTarget | null>(() => {
    if (!activeTarget) return null;
    if (
      activeTarget.kind === 'worktree' &&
      !activeTarget.branch &&
      displayedBranchName
    ) {
      return { ...activeTarget, branch: displayedBranchName };
    }
    return activeTarget;
  }, [activeTarget, displayedBranchName]);

  const branchDiffs = useBranchDiffs({
    repoId,
    branch: isReadOnlyBranchTarget ? activeTarget.branch : null,
    baseBranch: isReadOnlyBranchTarget ? activeTarget.baseBranch : null,
    enabled: mode === 'diff' && isReadOnlyBranchTarget,
  });

  const handleRefreshAll = useCallback(async () => {
    await Promise.all([
      isReadOnlyBranchTarget ? branchDiffs.refresh() : refreshStatus(),
      refreshWorktrees(),
    ]);
  }, [isReadOnlyBranchTarget, branchDiffs, refreshStatus, refreshWorktrees]);

  const {
    stageFile,
    unstageFile,
    revertFile,
    stageAll,
    revertAll,
    error: actionError,
  } = useGitActions({
    workspaceId: activeTargetWorkspaceId,
    repoId,
    worktreePath: activeTargetWorktreePath,
    onSuccess: refreshStatus,
  });

  const shouldPreloadDiffs =
    mode === 'diff' &&
    !isReadOnlyBranchTarget &&
    stagedFiles.length > 0 &&
    shouldAutoPreloadDiffs(stagedFiles, unstagedFiles);
  const { diffs } = useGitDiffs({
    workspaceId: activeTargetWorkspaceId,
    repoId,
    worktreePath: activeTargetWorktreePath,
    enabled: shouldPreloadDiffs,
  });

  const {
    commitMessage,
    setCommitMessage,
    commitLoading,
    pushLoading,
    pullLoading,
    fetchLoading,
    commitError,
    operationError,
    onCommit,
    onCommitAndPush,
    onPush,
    onPull,
    onFetch,
  } = useGitCommit({
    workspaceId: activeTargetWorkspaceId,
    repoId,
    worktreePath: activeTargetWorktreePath,
    onSuccess: handleRefreshAll,
  });

  // Default Log branch filter: default directory's current branch + origin target branch
  const mainWorktreeBranch = useMemo(() => {
    const mainWt = repoWorktrees.find((wt) => wt.is_main);
    return mainWt?.branch || branchName || workspace?.branch || null;
  }, [repoWorktrees, branchName, workspace?.branch]);

  const defaultLogBranches = useMemo(
    () =>
      resolveDefaultLogBranches({
        defaultCurrentBranch: mainWorktreeBranch,
        branches: repoBranchesQuery.branches,
        defaultTargetBranch: activeRepo?.default_target_branch,
      }),
    [
      mainWorktreeBranch,
      repoBranchesQuery.branches,
      activeRepo?.default_target_branch,
    ]
  );

  const effectiveLogBranches = useMemo(() => {
    if (selectedLogBranches && selectedLogBranches.length > 0) {
      return selectedLogBranches;
    }
    return defaultLogBranches;
  }, [selectedLogBranches, defaultLogBranches]);

  const gitLog = useGitLog({
    workspaceId: mode === 'log' ? null : activeTargetWorkspaceId,
    repoId,
    worktreePath: mode === 'log' ? null : activeTargetWorktreePath,
    branches:
      mode === 'log' && effectiveLogBranches.length > 0
        ? effectiveLogBranches
        : undefined,
    maxCount: mode === 'log' ? logMaxCount : undefined,
    enabled: mode === 'log' || (mode === 'diff' && !isReadOnlyBranchTarget),
  });

  const gitBranches = useGitBranches({
    workspaceId: activeTargetWorkspaceId,
    repoId,
    worktreePath: activeTargetWorktreePath,
    enabled: mode === 'branches',
  });

  const handleCheckoutBranch = useCallback(
    async (name: string) => {
      await gitBranches.checkoutBranch(name);
      await Promise.all([
        refreshStatus(),
        refreshWorktrees(),
        repoBranchesQuery.refresh(),
      ]);
      if (activeTargetWorkspaceId) {
        void queryClient.invalidateQueries({
          queryKey: ['branchStatus', activeTargetWorkspaceId],
        });
      }
    },
    [
      gitBranches,
      queryClient,
      refreshStatus,
      refreshWorktrees,
      repoBranchesQuery,
      activeTargetWorkspaceId,
    ]
  );

  const gitHub = useGitHubData({
    repoId,
    enableIssues: mode === 'issues',
    enablePrs: mode === 'prs',
  });

  const buildReviewSourceForTarget = useCallback(
    (target: GitDiffTarget | null) => {
      if (!target || !repoId) return null;
      if (target.kind === 'branch') {
        return {
          kind: 'branch' as const,
          repoId,
          branch: target.branch,
          baseBranch: target.baseBranch,
          diffs: branchDiffs.diffs,
          isLoading: branchDiffs.isLoading,
        };
      }
      return {
        kind: 'worktree' as const,
        repoId,
        worktreePath: target.worktreePath,
        workspaceId: target.workspaceId,
        label: target.directoryLabel,
        branch: target.branch || branchName || null,
        isMain: target.isMain,
      };
    },
    [repoId, branchDiffs.diffs, branchDiffs.isLoading, branchName]
  );

  // Keep review panel synchronized if it is currently inspecting this read-only branch
  useEffect(() => {
    if (!isReadOnlyBranchTarget || !repoId || !activeTarget) return;
    const currentSource = useGitDiffNavigationStore.getState().reviewSource;
    if (
      currentSource?.kind === 'branch' &&
      currentSource.repoId === repoId &&
      currentSource.branch === activeTarget.branch
    ) {
      setReviewSource({
        kind: 'branch',
        repoId,
        branch: activeTarget.branch,
        baseBranch: activeTarget.baseBranch,
        diffs: branchDiffs.diffs,
        isLoading: branchDiffs.isLoading,
      });
    }
  }, [
    isReadOnlyBranchTarget,
    repoId,
    activeTarget,
    branchDiffs.diffs,
    branchDiffs.isLoading,
    setReviewSource,
  ]);

  const handleSelectDiffTarget = useCallback(
    (target: GitDiffTarget) => {
      setSelectedTargetId(target.id);
      setSelectedDiffPath(null);
      const currentSource = useGitDiffNavigationStore.getState().reviewSource;
      if (currentSource && repoId) {
        clearCommitDiff();
        if (target.kind === 'branch') {
          setReviewSource({
            kind: 'branch',
            repoId,
            branch: target.branch,
            baseBranch: target.baseBranch,
            diffs: [],
            isLoading: true,
          });
        } else {
          setReviewSource({
            kind: 'worktree',
            repoId,
            worktreePath: target.worktreePath,
            workspaceId: target.workspaceId,
            label: target.directoryLabel,
            branch: target.branch,
            isMain: target.isMain,
          });
        }
      }
    },
    [repoId, setSelectedDiffPath, clearCommitDiff, setReviewSource]
  );

  const openFileInDiffReview = useCallback(
    (path: string) => {
      setSelectedDiffPath(path);
      clearCommitDiff();
      const source = buildReviewSourceForTarget(displayedTarget);
      if (source) {
        setReviewSource(source);
      }
      openDiffPreview();
      focusDiffPath(path);
    },
    [
      setSelectedDiffPath,
      clearCommitDiff,
      buildReviewSourceForTarget,
      displayedTarget,
      setReviewSource,
      openDiffPreview,
      focusDiffPath,
    ]
  );

  const handleSelectFile = useCallback(
    (path: string) => {
      openFileInDiffReview(path);
    },
    [openFileInDiffReview]
  );

  const handleDoubleClickFile = useCallback(
    (path: string) => {
      openFileInDiffReview(path);
    },
    [openFileInDiffReview]
  );

  const handleRevertAll = useCallback(() => {
    revertAll();
  }, [revertAll]);

  const handleLoadMoreLogs = useCallback(() => {
    setLogMaxCount((prev) => prev + DEFAULT_LOG_PAGE_SIZE);
  }, []);

  if (!repoId && !isResolvingRepo && gitChildren.length === 0) {
    return <EmptyState />;
  }

  const effectiveAdditions = isReadOnlyBranchTarget
    ? branchDiffs.totalAdditions
    : totalAdditions;
  const effectiveDeletions = isReadOnlyBranchTarget
    ? branchDiffs.totalDeletions
    : totalDeletions;

  const isInitialDiffLoading = isReadOnlyBranchTarget
    ? branchDiffs.isLoading && branchDiffs.files.length === 0
    : (isResolvingRepo || statusLoading) &&
      stagedFiles.length === 0 &&
      unstagedFiles.length === 0;

  return (
    <div
      className="h-full w-full flex flex-col bg-background overflow-hidden"
      data-panel="git"
      onContextMenu={(event) => {
        openSurfaceMenu(event, [
          {
            id: 'fetch',
            label: 'Fetch',
            disabled: fetchLoading,
            onSelect: () => onFetch(),
          },
          {
            id: 'pull',
            label: 'Pull',
            disabled: pullLoading || isReadOnlyBranchTarget,
            onSelect: () => onPull(),
          },
          {
            id: 'push',
            label: 'Push',
            disabled: pushLoading || isReadOnlyBranchTarget,
            onSelect: () => onPush(),
          },
          {
            id: 'refresh',
            label: 'Refresh',
            onSelect: () => {
              void handleRefreshAll();
            },
          },
        ]);
      }}
    >
      {/* Row 1: Mode Selector + Fetch, Pull, and mode-aware view toggle */}
      <div
        data-testid="git-panel-mode-tabs"
        className="flex items-center gap-1.5 px-2 py-1 border-b border-border/30 shrink-0"
      >
        <div className="min-w-0 flex-1">
          <Selector
            label="Git view"
            isLabelHidden
            size="sm"
            width="100%"
            placement="below"
            className="git-mode-selector"
            options={GIT_PANEL_MODE_OPTIONS}
            value={mode}
            onChange={(nextMode) => setMode(nextMode as GitPanelMode)}
            startIcon={
              GIT_PANEL_MODE_OPTIONS.find((opt) => opt.value === mode)?.icon
            }
            renderOption={(option) => (
              <SelectorOption
                icon={option.icon}
                label={
                  <span className="text-[11px] font-normal">
                    {option.label ?? option.value}
                  </span>
                }
              />
            )}
          />
        </div>

        {/* Fetch / Pull / Mode-specific view toggle */}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className="p-1 rounded bg-transparent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            onClick={onFetch}
            disabled={fetchLoading}
            title={i18n.t('panels:ui.git.fetchAllRemotes')}
          >
            {fetchLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </button>
          <button
            type="button"
            className={`p-1 rounded bg-transparent transition-colors relative disabled:opacity-40 ${
              !isReadOnlyBranchTarget && gitLog.behind > 0
                ? 'text-[hsl(var(--warning))] hover:text-[hsl(var(--warning))]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={onPull}
            disabled={pullLoading || isReadOnlyBranchTarget}
            title={
              !isReadOnlyBranchTarget && gitLog.behind > 0
                ? `Pull ${gitLog.behind} commit${gitLog.behind > 1 ? 's' : ''}`
                : 'Pull from remote'
            }
          >
            {pullLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {!isReadOnlyBranchTarget && gitLog.behind > 0 && (
              <span className="absolute -right-1 -top-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[hsl(var(--warning))] px-0.5 text-[8px] font-bold leading-none text-background tabular-nums">
                {gitLog.behind}
              </span>
            )}
          </button>

          {/* View toggle: Diff -> Flat/Tree, Log -> Graph/List, other modes -> hidden */}
          {mode === 'diff' && (
            <button
              type="button"
              data-testid="git-panel-view-toggle"
              className="p-1 rounded bg-transparent text-muted-foreground hover:text-foreground transition-colors"
              onClick={toggleDiffListView}
              title={
                diffListView === 'flat'
                  ? i18n.t('panels:ui.git.switchToTreeView')
                  : i18n.t('panels:ui.git.switchToFlatView')
              }
              aria-label={
                diffListView === 'flat'
                  ? i18n.t('panels:ui.git.switchToTreeView')
                  : i18n.t('panels:ui.git.switchToFlatView')
              }
            >
              {diffListView === 'flat' ? (
                <FolderTree className="h-3 w-3" />
              ) : (
                <LayoutList className="h-3 w-3" />
              )}
            </button>
          )}
          {mode === 'log' && (
            <button
              type="button"
              data-testid="git-panel-view-toggle"
              className="p-1 rounded bg-transparent text-muted-foreground hover:text-foreground transition-colors"
              onClick={toggleLogViewMode}
              title={
                logViewMode === 'graph'
                  ? i18n.t('panels:ui.git.switchToListView')
                  : i18n.t('panels:ui.git.switchToGraphView')
              }
              aria-label={
                logViewMode === 'graph'
                  ? i18n.t('panels:ui.git.switchToListView')
                  : i18n.t('panels:ui.git.switchToGraphView')
              }
            >
              {logViewMode === 'graph' ? (
                <LayoutList className="h-3 w-3" />
              ) : (
                <GitGraph className="h-3 w-3" />
              )}
            </button>
          )}

          <ShellNavPanelDragHandle panelId={PANEL_IDS.GIT} />
        </div>
      </div>

      {/* Row 2: Worktree/Branch two-level selector + change stats (only in Diff mode) */}
      {mode === 'diff' && (
        <div
          data-testid="git-panel-branch-toolbar"
          className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border/30 shrink-0"
        >
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {parentHasNoGitRepo && gitChildren.length > 0 && (
              <Select
                value={selectedGitChildId ?? ''}
                onValueChange={setGitChildId}
              >
                <SelectTrigger className="h-7 w-[112px] shrink-0 text-xs">
                  <SelectValue
                    placeholder={i18n.t('panels:ui.git.gitRepository')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {gitChildren.map((child) => (
                    <SelectItem key={child.id} value={child.id}>
                      {child.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <GitWorktreeBranchSelector
              groups={directoryGroups}
              selectedTarget={displayedTarget}
              onSelectTarget={handleSelectDiffTarget}
              isLoading={worktreesLoading && !displayedTarget?.branch}
            />
          </div>

          {(effectiveAdditions > 0 || effectiveDeletions > 0) && (
            <GitChangeStats
              additions={effectiveAdditions}
              deletions={effectiveDeletions}
              className="ml-auto shrink-0"
            />
          )}
        </div>
      )}

      {/* Diff mode */}
      {mode === 'diff' && (
        <div className="flex flex-col flex-1 min-h-0">
          {!isReadOnlyBranchTarget &&
          activeTargetWorkspaceId &&
          repoId &&
          conflictOp ? (
            <GitConflictSection
              op={conflictOp}
              files={conflictedFiles}
              onOpenFile={(filePath) =>
                openMergePanel({
                  workspaceId: activeTargetWorkspaceId,
                  repoId,
                  filePath,
                })
              }
              onContinue={async () => {
                setConflictBusy('continue');
                try {
                  await attemptsApi.continueConflicts(
                    activeTargetWorkspaceId,
                    repoId
                  );
                  await queryClient.invalidateQueries({
                    queryKey: ['branchStatus', activeTargetWorkspaceId],
                  });
                  refreshStatus();
                } catch (error) {
                  console.error('Failed to continue conflicts:', error);
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : 'Failed to continue conflict resolution'
                  );
                } finally {
                  setConflictBusy(null);
                }
              }}
              onAbort={async () => {
                setConflictBusy('abort');
                try {
                  await abortConflicts();
                  refreshStatus();
                } catch (error) {
                  console.error('Failed to abort conflicts:', error);
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : 'Failed to abort conflict resolution'
                  );
                } finally {
                  setConflictBusy(null);
                }
              }}
              continueLoading={conflictBusy === 'continue'}
              abortLoading={conflictBusy === 'abort'}
            />
          ) : null}

          {isReadOnlyBranchTarget && activeTarget ? (
            <div
              data-testid="git-readonly-branch-banner"
              className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border/30 bg-muted/40 text-[11px] text-muted-foreground shrink-0"
            >
              <Eye className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {i18n.t('panels:ui.git.comparingBranch', {
                  branch: activeTarget.branch,
                  base: activeTarget.baseBranch || 'HEAD',
                })}
              </span>
            </div>
          ) : (
            <GitCommitBox
              commitMessage={commitMessage}
              onCommitMessageChange={setCommitMessage}
              hasStagedFiles={stagedFiles.length > 0}
              hasUnstagedFiles={unstagedFiles.length > 0}
              stagedFiles={stagedFiles}
              diffs={diffs}
              commitLoading={commitLoading}
              pushLoading={pushLoading}
              commitError={commitError}
              operationError={operationError ?? actionError}
              commitsAhead={
                gitLog.ahead || conflictStatus?.remote_commits_ahead || 0
              }
              onCommit={onCommit}
              onCommitAndPush={onCommitAndPush}
              onPush={onPush}
            />
          )}

          <div className="flex flex-1 min-h-0">
            <div className="w-full flex flex-col min-h-0 overflow-y-auto">
              {isInitialDiffLoading ? (
                <LoadingState />
              ) : isReadOnlyBranchTarget ? (
                <GitStagingArea
                  stagedFiles={[]}
                  unstagedFiles={branchDiffs.files}
                  selectedPath={selectedDiffPath}
                  viewMode={diffListView}
                  workspaceId={null}
                  readOnly
                  onSelectFile={handleSelectFile}
                  onDoubleClickFile={handleDoubleClickFile}
                />
              ) : (
                <GitStagingArea
                  stagedFiles={stagedFiles}
                  unstagedFiles={unstagedFiles}
                  selectedPath={selectedDiffPath}
                  viewMode={diffListView}
                  workspaceId={activeTargetWorkspaceId}
                  onSelectFile={handleSelectFile}
                  onDoubleClickFile={handleDoubleClickFile}
                  onStageFile={stageFile}
                  onUnstageFile={unstageFile}
                  onRevertFile={revertFile}
                  onStageAll={stageAll}
                  onRevertAll={handleRevertAll}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Log mode */}
      {mode === 'log' && (
        <GitLogView
          entries={gitLog.entries}
          total={gitLog.total}
          ahead={gitLog.ahead}
          behind={gitLog.behind}
          upstream={gitLog.upstream}
          branchName={gitLog.branchName || displayedBranchName}
          loading={gitLog.isLoading}
          workspaceId={activeTargetWorkspaceId}
          repoId={repoId}
          worktreePath={activeTargetWorktreePath}
          viewMode={logViewMode}
          branches={repoBranchesQuery.branches}
          selectedBranches={effectiveLogBranches}
          defaultBranches={defaultLogBranches}
          onSelectedBranchesChange={(next) => {
            setSelectedLogBranches(next);
            setLogMaxCount(DEFAULT_LOG_PAGE_SIZE);
          }}
          hasMore={gitLog.entries.length >= logMaxCount}
          onLoadMore={handleLoadMoreLogs}
          onRefresh={gitLog.refresh}
        />
      )}

      {/* Branches mode */}
      {mode === 'branches' && (
        <GitBranchList
          branches={gitBranches.branches}
          remotes={gitBranches.remotes}
          isLoading={gitBranches.isLoading}
          error={gitBranches.error}
          onCheckout={handleCheckoutBranch}
          onCreate={gitBranches.createBranch}
          onDelete={gitBranches.deleteBranch}
          onRefresh={gitBranches.refresh}
        />
      )}

      {/* Issues mode */}
      {mode === 'issues' && (
        <GitIssuesView
          issues={gitHub.issues}
          isLoading={gitHub.issuesLoading}
          error={gitHub.issuesError}
          issueState={gitHub.issueFilter}
          onSetIssueState={gitHub.setIssueFilter}
          onRefresh={gitHub.refreshIssues}
        />
      )}

      {/* PRs mode */}
      {mode === 'prs' && (
        <GitPRsView
          prs={gitHub.prs}
          isLoading={gitHub.prsLoading}
          error={gitHub.prsError}
          onRefresh={gitHub.refreshPrs}
        />
      )}
    </div>
  );
}
