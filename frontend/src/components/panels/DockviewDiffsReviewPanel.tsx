import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  GitCompare,
  ChevronsUp,
  ChevronsDown,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  User,
  Calendar,
  Hash,
  X,
  Eye,
  FolderGit2,
  GitBranch,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useAttempt } from '@/hooks/useAttempt';
import { useDiffStream } from '@/hooks/useDiffStream';
import { repoApi } from '@/lib/api';
import DiffCard from '@/components/DiffCard';
import DiffViewSwitch, {
  DIFF_VIEW_BUTTON_COUNT,
  computeDiffViewVisibleLabelCount,
} from '@/components/DiffViewSwitch';
import { DiffFileTree } from '@/components/diff/DiffFileTree';
import { Button as AstryxButton } from '@astryxdesign/core/Button';
import { ButtonGroup as AstryxButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { useCommitDiffStore } from '@/stores/useCommitDiffStore';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';
import type { Diff, DiffChangeKind } from 'shared/types';
import { useAppContextMenu } from '@/components/context-menu';
import { toast } from '@/components/ui/toast';
import { writeTextToClipboard } from '@/utils/clipboard';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import i18n from '@/i18n';

type DiffCollapseDefaults = Record<DiffChangeKind, boolean>;

const DEFAULT_COLLAPSE: DiffCollapseDefaults = {
  added: true,
  deleted: true,
  modified: true,
  renamed: true,
  copied: true,
  permissionChange: true,
};
const COLLAPSE_MAX_LINES = 200;
const LARGE_CHANGESET_MAX_LINES = 10_000;

const exceedsMax = (d: Diff, max: number) =>
  d.additions != null || d.deletions != null
    ? (d.additions ?? 0) + (d.deletions ?? 0) > max
    : true;

const getDiffId = (diff: Diff, index: number) =>
  diff.newPath || diff.oldPath || String(index);

function normalizeDiffPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function pathsReferToSameDiffFile(candidatePath: string, targetPath: string) {
  const candidate = normalizeDiffPath(candidatePath);
  const target = normalizeDiffPath(targetPath);

  return (
    candidate === target ||
    candidate.endsWith(`/${target}`) ||
    target.endsWith(`/${candidate}`)
  );
}

const changeBadge: Record<DiffChangeKind, { label: string; color: string }> = {
  added: {
    label: 'A',
    color: 'bg-[var(--diff-added-bg)] text-[var(--diff-added-fg)]',
  },
  deleted: {
    label: 'D',
    color: 'bg-[var(--diff-removed-bg)] text-[var(--diff-removed-fg)]',
  },
  modified: {
    label: 'M',
    color: 'bg-[hsl(var(--primary)/0.1)] text-primary',
  },
  renamed: {
    label: 'R',
    color: 'bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]',
  },
  copied: {
    label: 'C',
    color:
      'bg-[hsl(var(--status-running)/0.1)] text-[hsl(var(--status-running))]',
  },
  permissionChange: {
    label: 'P',
    color: 'text-muted-foreground bg-muted',
  },
};

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

export function formatCommitBody(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph.split('\n');
      const isStructured = lines.some((line) =>
        /^\s*([-*+]|\d+[.)]|#|>|\s{2,})\s/.test(line)
      );
      if (isStructured) {
        return lines.join('\n');
      }
      return lines
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ');
    })
    .join('\n\n');
}

function DockviewDiffsReviewPanel() {
  const { t } = useTranslation(['panels', 'common']);
  const { openSurfaceMenu } = useAppContextMenu();
  const { activeWorktreeId } = useWorktree();
  const { workspaceId: routeWorkspaceId } = useParams<{
    workspaceId?: string;
  }>();
  const effectiveAttemptId = activeWorktreeId ?? routeWorkspaceId ?? undefined;
  const { data: workspace } = useAttempt(effectiveAttemptId);
  const attemptId = workspace?.id ?? effectiveAttemptId ?? null;

  // Commit diff mode from store
  const {
    commitSha,
    commitInfo,
    commitDiffs,
    isLoading: commitLoading,
    clearCommitDiff,
  } = useCommitDiffStore(
    useShallow((state) => ({
      commitSha: state.commitSha,
      commitInfo: state.commitInfo,
      commitDiffs: state.commitDiffs,
      isLoading: state.isLoading,
      clearCommitDiff: state.clearCommitDiff,
    }))
  );
  const isCommitMode = !!commitSha;
  const targetPath = useGitDiffNavigationStore((state) => state.targetPath);
  const targetToken = useGitDiffNavigationStore((state) => state.requestToken);
  const clearTargetPath = useGitDiffNavigationStore(
    (state) => state.clearTargetPath
  );
  const reviewSource = useGitDiffNavigationStore(
    (state) => state.reviewSource ?? null
  );
  const clearReviewSource = useGitDiffNavigationStore(
    (state) => state.clearReviewSource
  );

  const isBranchReviewMode = !isCommitMode && reviewSource?.kind === 'branch';
  const isRepoWorktreeReviewMode =
    !isCommitMode &&
    reviewSource?.kind === 'worktree' &&
    !reviewSource.workspaceId;
  const streamWorkspaceId =
    !isCommitMode &&
    reviewSource?.kind === 'worktree' &&
    reviewSource.workspaceId
      ? reviewSource.workspaceId
      : attemptId;

  const [repoWorktreeState, setRepoWorktreeState] = useState<{
    diffs: Diff[];
    isLoading: boolean;
    error: string | null;
  }>({
    diffs: [],
    isLoading: false,
    error: null,
  });

  const repoWorktreeRepoId =
    isRepoWorktreeReviewMode && reviewSource.kind === 'worktree'
      ? reviewSource.repoId
      : null;
  const repoWorktreePath =
    isRepoWorktreeReviewMode && reviewSource.kind === 'worktree'
      ? reviewSource.worktreePath
      : null;

  useEffect(() => {
    if (!isRepoWorktreeReviewMode || !repoWorktreeRepoId) {
      return;
    }
    let isCurrent = true;
    setRepoWorktreeState((prev) => ({
      ...prev,
      isLoading: true,
      error: null,
    }));
    void repoApi
      .getWorktreeDiffs(repoWorktreeRepoId, repoWorktreePath)
      .then((nextDiffs) => {
        if (!isCurrent) return;
        setRepoWorktreeState({
          diffs: nextDiffs,
          isLoading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (!isCurrent) return;
        setRepoWorktreeState({
          diffs: [],
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      isCurrent = false;
    };
  }, [
    isRepoWorktreeReviewMode,
    repoWorktreeRepoId,
    repoWorktreePath,
    targetToken,
  ]);

  // Worktree diff mode (existing streaming functionality)
  const {
    diffs: worktreeDiffs,
    error: streamError,
    isInitialized,
  } = useDiffStream(
    streamWorkspaceId,
    !isCommitMode && !isBranchReviewMode && !isRepoWorktreeReviewMode
  );

  // Select data source based on mode
  const diffs = isCommitMode
    ? commitDiffs
    : isBranchReviewMode
      ? reviewSource.diffs
      : isRepoWorktreeReviewMode
        ? repoWorktreeState.diffs
        : worktreeDiffs;

  const error = isCommitMode
    ? null
    : isBranchReviewMode
      ? null
      : isRepoWorktreeReviewMode
        ? repoWorktreeState.error
        : streamError;

  const reviewSourceKey = useMemo(() => {
    if (!reviewSource) return null;
    if (reviewSource.kind === 'branch') {
      return `branch:${reviewSource.repoId}:${reviewSource.branch}:${reviewSource.baseBranch ?? ''}`;
    }
    return `wt:${reviewSource.repoId}:${reviewSource.workspaceId ?? ''}:${reviewSource.worktreePath ?? ''}`;
  }, [reviewSource]);

  // Compute stats from active diffs without opening a second diff stream
  const { fileCount, added, deleted } = useMemo(() => {
    let totalAdded = 0;
    let totalDeleted = 0;
    for (const d of diffs) {
      totalAdded += d.additions ?? 0;
      totalDeleted += d.deletions ?? 0;
    }
    return {
      fileCount: diffs.length,
      added: totalAdded,
      deleted: totalDeleted,
    };
  }, [diffs]);

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [processedIds, setProcessedIds] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const resizeAbortRef = useRef<AbortController | null>(null);
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  const [stickyFileId, setStickyFileId] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const ids = useMemo(() => diffs.map((d, i) => getDiffId(d, i)), [diffs]);
  const isLargeChangeSet = useMemo(
    () =>
      diffs.reduce(
        (total, diff) => total + (diff.additions ?? 0) + (diff.deletions ?? 0),
        0
      ) > LARGE_CHANGESET_MAX_LINES,
    [diffs]
  );
  const activeLargeDiffId = isLargeChangeSet
    ? selectedFileId && ids.includes(selectedFileId)
      ? selectedFileId
      : (ids[0] ?? null)
    : null;

  useEffect(() => {
    return () => {
      resizeAbortRef.current?.abort();
      resizeAbortRef.current = null;
    };
  }, []);

  // Reset collapse state when switching modes, commit, workspace attempt, or review source
  useEffect(() => {
    setCollapsedIds(new Set());
    setProcessedIds(new Set());
    setStickyFileId(null);
    setSelectedFileId(null);
  }, [commitSha, streamWorkspaceId, reviewSourceKey]);

  // Safety timeout: if not initialized within 5s, stop showing spinner
  useEffect(() => {
    if (
      isCommitMode ||
      isBranchReviewMode ||
      isRepoWorktreeReviewMode ||
      isInitialized ||
      diffs.length > 0
    ) {
      setLoadingTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setLoadingTimedOut(true), 5000);
    return () => clearTimeout(timer);
  }, [
    isCommitMode,
    isBranchReviewMode,
    isRepoWorktreeReviewMode,
    isInitialized,
    diffs.length,
  ]);

  const showLoading = isCommitMode
    ? commitLoading
    : isBranchReviewMode
      ? Boolean(reviewSource.isLoading) && diffs.length === 0
      : isRepoWorktreeReviewMode
        ? repoWorktreeState.isLoading && diffs.length === 0
        : !isInitialized && !loadingTimedOut && diffs.length === 0;

  const diffRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [visibleLabelCount, setVisibleLabelCount] = useState<number>(
    DIFF_VIEW_BUTTON_COUNT
  );
  const [expandIconOnly, setExpandIconOnly] = useState(false);

  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateLayout = (rawWidth: number) => {
      if (rawWidth <= 0) {
        setVisibleLabelCount(DIFF_VIEW_BUTTON_COUNT);
        setExpandIconOnly(false);
        return;
      }
      // Subtract horizontal padding (px-3 => 24px)
      const innerWidth = Math.max(0, rawWidth - 24);
      // Reserve space for the right-side Expand/Collapse All button when present
      const reservedForExpand = isLargeChangeSet ? 0 : 84;
      const availableForGroup = Math.max(0, innerWidth - reservedForExpand);
      const nextCount = computeDiffViewVisibleLabelCount(availableForGroup);
      setVisibleLabelCount(nextCount);
      setExpandIconOnly(!isLargeChangeSet && innerWidth < 196);
    };
    updateLayout(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        updateLayout(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [diffs.length, isLargeChangeSet]);

  // Auto-collapse large/deleted diffs
  useEffect(() => {
    if (diffs.length === 0) return;
    const newDiffs = diffs
      .map((d, i) => ({ diff: d, index: i, id: getDiffId(d, i) }))
      .filter(({ id }) => !processedIds.has(id));

    if (newDiffs.length === 0) return;

    const newIds = newDiffs.map(({ id }) => id);
    const toCollapse = newDiffs
      .filter(
        ({ diff, id }) =>
          id !== activeLargeDiffId &&
          (DEFAULT_COLLAPSE[diff.change] ||
            exceedsMax(diff, COLLAPSE_MAX_LINES))
      )
      .map(({ id }) => id);

    setProcessedIds((prev) => new Set([...prev, ...newIds]));
    if (toCollapse.length > 0) {
      setCollapsedIds((prev) => new Set([...prev, ...toCollapse]));
    }
  }, [activeLargeDiffId, diffs, processedIds]);

  const toggle = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const allCollapsed = collapsedIds.size === diffs.length && diffs.length > 0;

  const handleCollapseAll = useCallback(() => {
    setCollapsedIds(allCollapsed ? new Set() : new Set(ids));
  }, [allCollapsed, ids]);

  const scrollToFile = useCallback(
    (id: string, behavior: ScrollBehavior = 'smooth') => {
      setSelectedFileId(id);
      setCollapsedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      const el = diffRefs.current.get(id);
      if (el) {
        el.scrollIntoView({ behavior, block: 'start' });
      }
    },
    []
  );

  useEffect(() => {
    if (!targetPath || diffs.length === 0) return;

    const targetEntryIndex = diffs.findIndex((diff) => {
      const candidate = diff.newPath || diff.oldPath || '';
      return pathsReferToSameDiffFile(candidate, targetPath);
    });

    if (targetEntryIndex < 0) return;

    const targetId = getDiffId(diffs[targetEntryIndex], targetEntryIndex);
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
    scrollToFile(targetId, 'auto');
    clearTargetPath();
  }, [
    clearTargetPath,
    diffs,
    scrollToFile,
    sidebarCollapsed,
    targetPath,
    targetToken,
  ]);

  // Sticky file header tracking via IntersectionObserver
  // Tracks the last diff element that scrolled past the top of the viewport
  const lastVisibleIdRef = useRef<string | null>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || diffs.length === 0) return;

    // Track which elements are above the viewport threshold (top 40px of container)
    const aboveThreshold = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const ioEntry of entries) {
          const id = (ioEntry.target as HTMLElement).dataset.diffId;
          if (!id) continue;

          // When the element's top edge is above the rootMargin boundary,
          // it means the element has scrolled past the top => it's the "sticky" one
          if (!ioEntry.isIntersecting) {
            // Element is fully above the threshold line
            const rect = ioEntry.boundingClientRect;
            if (rect.top < 0) {
              aboveThreshold.add(id);
            } else {
              aboveThreshold.delete(id);
            }
          } else {
            aboveThreshold.delete(id);
          }
        }

        // Find the last element (by document order) that is above threshold
        let foundId: string | null = null;
        for (const [id] of diffRefs.current) {
          if (aboveThreshold.has(id)) {
            foundId = id;
          }
        }

        if (foundId !== lastVisibleIdRef.current) {
          lastVisibleIdRef.current = foundId;
          setStickyFileId(foundId);
        }
      },
      {
        root: container,
        // A thin margin at the very top of the scroll container
        rootMargin: '-40px 0px 0px 0px',
        threshold: [0, 1],
      }
    );

    // Observe all current diff elements
    for (const [, el] of diffRefs.current) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [diffs]);

  const stickyDiff = useMemo(() => {
    if (!stickyFileId) return null;
    const idx = ids.indexOf(stickyFileId);
    if (idx === -1) return null;
    return diffs[idx];
  }, [stickyFileId, ids, diffs]);

  const showReviewSourceBanner =
    !isCommitMode &&
    reviewSource !== null &&
    (reviewSource.kind === 'branch' ||
      !reviewSource.isMain ||
      (reviewSource.workspaceId ?? null) !== attemptId);

  if (
    !isCommitMode &&
    !isBranchReviewMode &&
    !isRepoWorktreeReviewMode &&
    !streamWorkspaceId
  ) {
    return (
      <div
        className="h-full w-full flex items-center justify-center text-muted-foreground text-sm"
        data-panel="diffs"
      >
        <div className="text-center space-y-2">
          <GitCompare className="h-8 w-8 opacity-40 mx-auto" />
          <p className="font-medium">Diff Review</p>
          <p className="text-xs">
            {t('diffsReviewPanel.selectWorkspaceToViewChanges')}
          </p>
        </div>
      </div>
    );
  }

  if (!isCommitMode && error) {
    return (
      <div className="m-4 rounded-lg border border-[hsl(var(--destructive)/0.28)] bg-[hsl(var(--destructive)/0.08)] p-4">
        <div className="text-sm text-destructive">
          {t('diffsReviewPanel.loadDiffFailed', { error: String(error) })}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 w-full gap-2 overflow-hidden p-2"
      data-panel="diffs"
      onContextMenu={(event) => {
        const path =
          stickyDiff?.newPath ||
          stickyDiff?.oldPath ||
          diffs[0]?.newPath ||
          diffs[0]?.oldPath ||
          '';
        openSurfaceMenu(event, [
          {
            id: 'copy-path',
            label: t('common:contextMenu.copyFilePath'),
            disabled: !path,
            onSelect: () => {
              void writeClipboardViaBridge(path);
            },
          },
          {
            id: 'toggle-diffs',
            label: allCollapsed
              ? t('common:contextMenu.expandAllDiffs')
              : t('common:contextMenu.collapseAllDiffs'),
            disabled: diffs.length === 0,
            onSelect: handleCollapseAll,
          },
        ]);
      }}
    >
      {/* Left: Diff content */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {/* Commit info header (only in commit mode) */}
        {isCommitMode && commitInfo && (
          <div
            data-testid="commit-diff-info-card"
            className="mx-3 mb-2.5 shrink-0 rounded-xl border border-border/60 bg-muted/20"
          >
            <div className="px-3.5 py-2.5 space-y-1.5">
              {/* Title row with close button */}
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-foreground leading-snug">
                    {commitInfo.summary}
                  </h3>
                </div>
                <button
                  onClick={clearCommitDiff}
                  className="shrink-0 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  title={t('diffsReviewPanel.backToWorktreeDiff')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Body (if any) */}
              {commitInfo.body && (
                <div
                  data-testid="commit-diff-body"
                  className="w-full max-w-none text-xs text-muted-foreground whitespace-pre-line leading-relaxed max-h-24 overflow-y-auto"
                >
                  {formatCommitBody(commitInfo.body)}
                </div>
              )}

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <User className="h-3 w-3" />
                  <span className="text-foreground/80">
                    {commitInfo.author}
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <Hash className="h-3 w-3" />
                  <button
                    className="font-mono text-foreground/80 hover:text-foreground transition-colors"
                    onClick={() => {
                      void writeTextToClipboard(commitInfo.sha).then(
                        (copied) => {
                          if (copied) {
                            toast.success(t('common:contextMenu.copied'));
                          } else {
                            toast.error(
                              t('common:contextMenu.copyFailed', {
                                error: 'Clipboard unavailable',
                              })
                            );
                          }
                        }
                      );
                    }}
                    title={i18n.t('panels:ui.diffsReview.copyFullSha')}
                  >
                    {commitInfo.sha.slice(0, 12)}
                  </button>
                </span>
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  <span>{formatTimestamp(commitInfo.timestamp)}</span>
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Review source banner (read-only branch diff or switched worktree) */}
        {showReviewSourceBanner && reviewSource && (
          <div
            data-testid="diff-review-source-banner"
            className="mx-3 mb-2 shrink-0 flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-1.5 text-xs"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              {reviewSource.kind === 'branch' ? (
                <>
                  <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-foreground">
                    {i18n.t('panels:ui.git.comparingBranch', {
                      branch: reviewSource.branch,
                      base: reviewSource.baseBranch || 'HEAD',
                    })}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {i18n.t('panels:ui.git.readOnlyBranchDiff')}
                  </span>
                </>
              ) : (
                <>
                  <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-foreground">
                    {reviewSource.label}
                  </span>
                  {reviewSource.branch && (
                    <span className="inline-flex items-center gap-1 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      <GitBranch className="h-2.5 w-2.5" />
                      {reviewSource.branch}
                    </span>
                  )}
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => clearReviewSource?.()}
              className="shrink-0 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title={t('diffsReviewPanel.backToWorktreeDiff')}
              aria-label={t('diffsReviewPanel.backToWorktreeDiff')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {diffs.length > 0 && (
          <div
            ref={toolbarRef}
            className="diff-review-toolbar flex shrink-0 items-start justify-between gap-2 px-3 pb-1.5 pt-0"
          >
            <DiffViewSwitch visibleLabelCount={visibleLabelCount} />
            {!isLargeChangeSet && (
              <AstryxButtonGroup
                label={
                  allCollapsed
                    ? t('diffsReviewPanel.expandAll')
                    : t('diffsReviewPanel.collapseAll')
                }
                size="sm"
                className="diff-expand-button-group ml-auto shrink-0"
              >
                <AstryxButton
                  label={
                    allCollapsed
                      ? t('diffsReviewPanel.expandAll')
                      : t('diffsReviewPanel.collapseAll')
                  }
                  type="button"
                  size="sm"
                  variant="primary"
                  onClick={handleCollapseAll}
                  tooltip={
                    allCollapsed
                      ? t('diffsReviewPanel.expandAll')
                      : t('diffsReviewPanel.collapseAll')
                  }
                  className="diff-toolbar-btn"
                >
                  <span className="inline-flex items-center gap-1">
                    {allCollapsed ? (
                      <ChevronsDown className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronsUp className="h-3 w-3 shrink-0" />
                    )}
                    {!expandIconOnly && (
                      <span className="diff-toolbar-btn-label whitespace-nowrap text-[11px]">
                        {allCollapsed
                          ? t('diffsReviewPanel.expandAll')
                          : t('diffsReviewPanel.collapseAll')}
                      </span>
                    )}
                  </span>
                </AstryxButton>
              </AstryxButtonGroup>
            )}
          </div>
        )}

        {/* Sticky file header */}
        {stickyDiff && diffs.length > 1 && (
          <div className="shrink-0 flex items-center gap-1.5 px-3 py-1 bg-accent/30 border-b border-border/30 text-xs">
            <span
              className={`font-bold text-[10px] ${(changeBadge[stickyDiff.change] || changeBadge.modified).color} px-1 rounded`}
            >
              {(changeBadge[stickyDiff.change] || changeBadge.modified).label}
            </span>
            <span className="font-mono text-foreground truncate">
              {stickyDiff.newPath || stickyDiff.oldPath}
            </span>
            {stickyDiff.additions != null && stickyDiff.additions > 0 && (
              <span className="font-mono text-[10px] text-[hsl(var(--success))]">
                +{stickyDiff.additions}
              </span>
            )}
            {stickyDiff.deletions != null && stickyDiff.deletions > 0 && (
              <span className="font-mono text-[10px] text-destructive">
                -{stickyDiff.deletions}
              </span>
            )}
          </div>
        )}

        {/* Diff cards */}
        <div
          ref={scrollContainerRef}
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        >
          {diffs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {showLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>
                    {isCommitMode
                      ? t('diffsReviewPanel.loadingCommitDiff')
                      : t('diffsReviewPanel.loadingChanges')}
                  </span>
                </div>
              ) : isCommitMode ? (
                t('diffsReviewPanel.commitNoFileChanges')
              ) : (
                t('diffsReviewPanel.noChangesYet')
              )}
            </div>
          ) : (
            diffs
              .map((diff, idx) => ({ diff, idx }))
              .filter(({ diff, idx }) => {
                if (!isLargeChangeSet) return true;
                return getDiffId(diff, idx) === activeLargeDiffId;
              })
              .map(({ diff, idx }) => {
                const id = getDiffId(diff, idx);
                return (
                  <div
                    key={id}
                    data-diff-id={id}
                    className="first:[&>div]:mt-0"
                    ref={(el) => {
                      if (el) diffRefs.current.set(id, el);
                      else diffRefs.current.delete(id);
                    }}
                  >
                    <DiffCard
                      diff={diff}
                      expanded={!collapsedIds.has(id)}
                      onToggle={() => toggle(id)}
                      selectedAttempt={
                        isCommitMode ||
                        isBranchReviewMode ||
                        isRepoWorktreeReviewMode
                          ? null
                          : (workspace ?? null)
                      }
                    />
                  </div>
                );
              })
          )}
        </div>
      </div>

      {/* Right: Changes directory sidebar */}
      {diffs.length > 0 && (
        <div
          className="relative h-full shrink-0"
          style={sidebarCollapsed ? undefined : { width: sidebarWidth }}
        >
          {sidebarCollapsed ? null : (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('diffsReviewPanel.resizeFileTree')}
              className="workspace-resize-handle diffs-file-tree-resizer"
              onPointerDown={(event) => {
                event.preventDefault();
                resizeAbortRef.current?.abort();
                const controller = new AbortController();
                resizeAbortRef.current = controller;
                const startX = event.clientX;
                const startWidth = sidebarWidth;
                const onMove = (move: PointerEvent) => {
                  const next = startWidth + startX - move.clientX;
                  setSidebarWidth(Math.min(480, Math.max(160, next)));
                };
                const onEnd = () => {
                  controller.abort();
                  if (resizeAbortRef.current === controller) {
                    resizeAbortRef.current = null;
                  }
                };
                window.addEventListener('pointermove', onMove, {
                  signal: controller.signal,
                });
                window.addEventListener('pointerup', onEnd, {
                  signal: controller.signal,
                });
                window.addEventListener('pointercancel', onEnd, {
                  signal: controller.signal,
                });
              }}
            />
          )}
          <div
            className={`flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-muted/20 ${
              sidebarCollapsed ? 'w-8' : ''
            }`}
          >
            {sidebarCollapsed ? (
              <button
                onClick={() => setSidebarCollapsed(false)}
                className="h-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50"
                title={t('diffsReviewPanel.expandFileTree')}
              >
                <PanelRightOpen className="h-3.5 w-3.5" />
              </button>
            ) : (
              <>
                <div className="flex items-center gap-1.5 h-7 px-2.5">
                  <span className="inline-flex items-center text-xs font-bold text-foreground leading-none">
                    {isCommitMode ? 'Changed Files' : 'Changes'}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="group/files relative inline-flex items-center">
                      <span className="inline-flex items-center text-xs text-muted-foreground leading-none">
                        {fileCount} Files
                      </span>
                      <span
                        data-testid="changes-line-stats"
                        className="pointer-events-none absolute right-0 top-full z-20 mt-1 hidden whitespace-nowrap rounded-xl border border-border bg-popover px-2 py-1 font-mono text-[10px] text-popover-foreground group-hover/files:block"
                      >
                        <span className="text-[hsl(var(--success))]">
                          +{added}
                        </span>{' '}
                        <span className="text-destructive">-{deleted}</span>
                      </span>
                    </span>
                    <button
                      onClick={() => setSidebarCollapsed(true)}
                      className="inline-flex items-center justify-center p-0.5 rounded hover:bg-accent text-muted-foreground"
                      title={t('diffsReviewPanel.collapse')}
                    >
                      <PanelRightClose className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto py-1">
                  <DiffFileTree
                    key={`diff-tree-${targetToken}`}
                    files={diffs.map((diff, idx) => {
                      const id = getDiffId(diff, idx);
                      const badge =
                        changeBadge[diff.change] || changeBadge.modified;
                      return {
                        id,
                        path: diff.newPath || diff.oldPath || id,
                        badge,
                        additions: diff.additions,
                        deletions: diff.deletions,
                      };
                    })}
                    activeFileId={
                      isLargeChangeSet ? activeLargeDiffId : selectedFileId
                    }
                    onFileClick={(id) => scrollToFile(id)}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DockviewDiffsReviewPanel;
