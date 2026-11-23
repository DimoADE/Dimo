import { memo, useMemo, useCallback, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import {
  GitCommit,
  Upload,
  Download,
  Copy,
  ClipboardCopy,
  GitBranch,
  RotateCcw,
  Undo2,
  CherryIcon,
  Loader2,
  Search,
} from 'lucide-react';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { GitBranch as GitBranchType, GitLogEntry } from 'shared/types';
import type { LogViewMode } from '@/hooks/git';
import { toast } from '@/components/ui/toast';
import { attemptsApi, repoApi } from '@/lib/api';
import { writeTextToClipboard } from '@/utils/clipboard';
import { GitContextMenu, type ContextMenuAction } from './GitContextMenu';
import { GitLogBranchFilter } from './GitLogBranchFilter';
import {
  computeGitLogGraphLayout,
  type GitLogGraphRow,
} from './gitLogGraphLayout';
import { useCommitDiffStore } from '@/stores/useCommitDiffStore';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import i18n from '@/i18n';

const GRAPH_LANE_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--status-running))',
  'hsl(var(--success))',
  'hsl(var(--warning))',
  'hsl(var(--destructive))',
  'hsl(var(--muted-foreground))',
] as const;

const GRAPH_LANE_WIDTH = 12;
const GRAPH_MAX_VISIBLE_LANES = 8;
const GRAPH_NODE_Y = 11;
const GRAPH_CURVE_HEIGHT = 14;

function getLaneColor(colorIndex: number): string {
  return GRAPH_LANE_COLORS[colorIndex % GRAPH_LANE_COLORS.length];
}

function getLaneX(col: number): number {
  return (
    Math.min(col, GRAPH_MAX_VISIBLE_LANES - 1) * GRAPH_LANE_WIDTH +
    GRAPH_LANE_WIDTH / 2 +
    2
  );
}

const CommitGraphCell = memo(function CommitGraphCell({
  row,
  maxLanes,
  isHead,
}: {
  row: GitLogGraphRow;
  maxLanes: number;
  isHead: boolean;
}) {
  const visibleLanes = Math.min(Math.max(maxLanes, 1), GRAPH_MAX_VISIBLE_LANES);
  const svgWidth = visibleLanes * GRAPH_LANE_WIDTH + 4;
  const nodeX = getLaneX(row.nodeCol);
  const nodeColor = getLaneColor(row.colorIndex);
  const curveEndY = GRAPH_NODE_Y + GRAPH_CURVE_HEIGHT;

  return (
    <div
      data-testid="git-log-graph-cell"
      className="relative shrink-0 self-stretch select-none"
      style={{ width: svgWidth }}
      aria-hidden="true"
    >
      <svg
        width={svgWidth}
        className="pointer-events-none absolute inset-0 block h-full w-full overflow-visible"
      >
        {/* Active lanes passing straight through from top to bottom */}
        {row.passThroughs.map((lane) => {
          const x = getLaneX(lane.col);
          return (
            <line
              key={`pt-${lane.col}`}
              x1={x}
              y1="0"
              x2={x}
              y2="100%"
              stroke={getLaneColor(lane.colorIndex)}
              strokeWidth={1.75}
              strokeLinecap="round"
            />
          );
        })}

        {/* Incoming straight segment from top into this commit */}
        {row.hasIncomingTop && (
          <line
            x1={nodeX}
            y1="0"
            x2={nodeX}
            y2={GRAPH_NODE_Y}
            stroke={nodeColor}
            strokeWidth={1.75}
          />
        )}

        {/* Incoming merge curves from upper lanes converging into this commit */}
        {row.incomingMerges.map((edge, idx) => {
          const fromX = getLaneX(edge.fromCol);
          const color = getLaneColor(edge.colorIndex);
          if (fromX === nodeX) {
            return (
              <line
                key={`in-${idx}`}
                x1={fromX}
                y1="0"
                x2={nodeX}
                y2={GRAPH_NODE_Y}
                stroke={color}
                strokeWidth={1.75}
              />
            );
          }
          const c1Y = Math.round(GRAPH_NODE_Y * 0.65);
          const c2Y = Math.round(GRAPH_NODE_Y * 0.35);
          return (
            <path
              key={`in-${idx}`}
              d={`M ${fromX} 0 C ${fromX} ${c1Y}, ${nodeX} ${c2Y}, ${nodeX} ${GRAPH_NODE_Y}`}
              fill="none"
              stroke={color}
              strokeWidth={1.75}
              strokeLinecap="round"
            />
          );
        })}

        {/* Outgoing edges from this commit downward to parent lanes */}
        {row.outgoingEdges.map((edge, idx) => {
          const toX = getLaneX(edge.toCol);
          const color = getLaneColor(edge.colorIndex);
          if (toX === nodeX) {
            return (
              <line
                key={`out-${idx}`}
                x1={nodeX}
                y1={GRAPH_NODE_Y}
                x2={nodeX}
                y2="100%"
                stroke={color}
                strokeWidth={1.75}
              />
            );
          }
          const c1Y = GRAPH_NODE_Y + Math.round(GRAPH_CURVE_HEIGHT * 0.55);
          const c2Y = GRAPH_NODE_Y + Math.round(GRAPH_CURVE_HEIGHT * 0.45);
          return (
            <g key={`out-${idx}`}>
              <path
                d={`M ${nodeX} ${GRAPH_NODE_Y} C ${nodeX} ${c1Y}, ${toX} ${c2Y}, ${toX} ${curveEndY}`}
                fill="none"
                stroke={color}
                strokeWidth={1.75}
                strokeLinecap="round"
              />
              <line
                x1={toX}
                y1={curveEndY}
                x2={toX}
                y2="100%"
                stroke={color}
                strokeWidth={1.75}
              />
            </g>
          );
        })}

        {/* Commit node circle (double ring for merge commits) */}
        {row.isMerge ? (
          <>
            <circle
              cx={nodeX}
              cy={GRAPH_NODE_Y}
              r={4.25}
              fill="hsl(var(--background))"
              stroke={nodeColor}
              strokeWidth={1.75}
            />
            <circle cx={nodeX} cy={GRAPH_NODE_Y} r={1.75} fill={nodeColor} />
          </>
        ) : (
          <circle
            cx={nodeX}
            cy={GRAPH_NODE_Y}
            r={isHead ? 4 : 3.25}
            fill={nodeColor}
            stroke="hsl(var(--background))"
            strokeWidth={1.5}
          />
        )}
      </svg>
    </div>
  );
});

interface GitLogViewProps {
  entries: GitLogEntry[];
  total: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  branchName: string;
  loading?: boolean;
  workspaceId: string | null;
  repoId: string | null;
  worktreePath?: string | null;
  viewMode?: LogViewMode;
  branches?: GitBranchType[];
  selectedBranches?: string[];
  defaultBranches?: string[];
  onSelectedBranchesChange?: (branches: string[]) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onRefresh?: () => Promise<void>;
}

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

/** Color for ref badge based on ref type */
function getRefBadgeStyle(ref: string): string {
  if (ref.startsWith('origin/') || ref.startsWith('upstream/')) {
    return 'border-[hsl(var(--status-running)/0.3)] bg-[hsl(var(--status-running)/0.12)] text-[hsl(var(--status-running))]';
  }
  if (ref.startsWith('tag:') || ref.startsWith('v')) {
    return 'border-[hsl(var(--warning)/0.32)] bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]';
  }
  return 'border-[hsl(var(--primary)/0.3)] bg-[hsl(var(--primary)/0.1)] text-primary';
}

interface ContextMenuState {
  x: number;
  y: number;
  entry: GitLogEntry;
}

const LogEntry = memo(function LogEntry({
  entry,
  isSelected,
  isHead,
  workspaceId,
  graphRow,
  graphMaxLanes,
  onSelect,
  onContextMenu,
}: {
  entry: GitLogEntry;
  isSelected: boolean;
  isHead: boolean;
  isPushable: boolean;
  workspaceId?: string | null;
  graphRow?: GitLogGraphRow | null;
  graphMaxLanes?: number;
  onSelect: (sha: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: GitLogEntry) => void;
}) {
  const handleCopyClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void writeTextToClipboard(entry.sha).then((copied) => {
        if (copied) {
          toast.success('Copied commit SHA');
        } else {
          toast.error('Failed to copy commit SHA');
        }
      });
    },
    [entry.sha]
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const payload = {
        id: `git-commit:${workspaceId ?? ''}:${entry.sha}`,
        component: PANEL_IDS.PREVIEW,
        title: `${entry.sha.slice(0, 7)} — ${entry.summary}`,
        params: { commitSha: entry.sha, mode: 'commit-diff' },
        expanded: true,
      };
      e.dataTransfer.setData(
        'application/x-dimo-panel',
        JSON.stringify(payload)
      );
      e.dataTransfer.effectAllowed = 'copy';
    },
    [entry.sha, entry.summary, workspaceId]
  );

  const initial = entry.author.charAt(0).toUpperCase();
  const isGraphMode = Boolean(graphRow);

  return (
    <div
      data-testid="git-log-entry"
      className={`group flex cursor-pointer items-stretch text-xs transition-colors hover:bg-accent/50 ${
        isGraphMode
          ? 'mx-1.5 min-h-[34px] gap-1.5 rounded-md px-1.5 py-0'
          : 'mx-1.5 my-0.5 items-start gap-2.5 rounded-md px-2.5 py-2'
      } ${
        isSelected
          ? 'bg-accent/60 ring-1 ring-inset ring-ring/30'
          : isHead
            ? 'bg-accent/20'
            : ''
      }`}
      draggable
      onDragStart={handleDragStart}
      onClick={() => onSelect(entry.sha)}
      onContextMenu={(e) => onContextMenu(e, entry)}
    >
      {graphRow ? (
        <CommitGraphCell
          row={graphRow}
          maxLanes={graphMaxLanes ?? 1}
          isHead={isHead}
        />
      ) : (
        /* Author avatar timeline rail (list mode) */
        <div className="shrink-0 self-stretch py-[1.5px] flex flex-col items-center justify-center gap-0.5">
          <span className="w-px flex-1 min-h-0 rounded-full bg-primary/60" />
          <div
            className="w-[14.4px] h-[14.4px] rounded-full flex items-center justify-center bg-primary text-[8px] font-bold text-primary-foreground"
            title={entry.author}
          >
            {initial}
          </div>
          <span className="w-px flex-1 min-h-0 rounded-full bg-primary/60" />
        </div>
      )}

      {/* Content */}
      <div
        className={`flex-1 min-w-0 flex flex-col gap-0.5 ${
          isGraphMode ? 'py-1' : ''
        }`}
      >
        {/* Summary */}
        <span
          className={
            isGraphMode
              ? 'truncate text-foreground leading-tight'
              : 'text-foreground leading-tight break-all line-clamp-2'
          }
          title={entry.summary}
        >
          {entry.summary}
        </span>

        {/* Refs badges */}
        {(entry.refs?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1">
            {(entry.refs ?? []).map((ref) => (
              <span
                key={ref}
                className={`inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[10px] font-medium border ${getRefBadgeStyle(ref)}`}
              >
                {ref.startsWith('origin/') || ref.startsWith('upstream/') ? (
                  <span className="opacity-60">{'~'}</span>
                ) : (
                  <GitBranch className="h-2.5 w-2.5 opacity-60" />
                )}
                {ref}
              </span>
            ))}
          </div>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-1.5 text-[10px] leading-tight">
          <button
            className="font-mono text-primary transition-colors hover:text-primary/80 flex items-center gap-0.5"
            onClick={handleCopyClick}
            title={i18n.t('panels:ui.gitLog.copyFullSha')}
          >
            {entry.sha.slice(0, 7)}
            <Copy className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60" />
          </button>
          <span className="truncate text-primary">{entry.author}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {formatRelativeTime(entry.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
});

/** Discriminated union for flat virtual list items */
type VirtualListItem =
  | {
      type: 'section-header';
      title: string;
      icon: 'upload' | 'download' | 'commit';
      count: number;
      accentColor: string;
      extra?: string;
    }
  | { type: 'entry'; entry: GitLogEntry; isPushable: boolean };

const EMPTY_VIRTUOSO_COMPONENTS = {};

export const GitLogView = memo(function GitLogView(props: GitLogViewProps) {
  const {
    entries,
    ahead,
    behind,
    loading,
    workspaceId,
    repoId,
    worktreePath = null,
    viewMode = 'list',
    branches,
    selectedBranches,
    defaultBranches,
    onSelectedBranchesChange,
    hasMore = false,
    onLoadMore,
    onRefresh,
  } = props;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [createBranchInput, setCreateBranchInput] = useState<{
    sha: string;
    show: boolean;
  }>({
    sha: '',
    show: false,
  });
  const [newBranchName, setNewBranchName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const panelActions = useOptionalPanelActionsContext();
  const { setCommitDiff, setLoading: setCommitDiffLoading } =
    useCommitDiffStore();

  const isGraphActive = viewMode === 'graph' && !searchQuery.trim();
  const isMultiBranch = (selectedBranches?.length ?? 0) > 1;

  // Preserve backend `--topo-order` in graph mode; sort by timestamp in list mode
  const orderedEntries = useMemo(() => {
    if (viewMode === 'graph') {
      return entries;
    }
    return [...entries].sort((a, b) => b.timestamp - a.timestamp);
  }, [entries, viewMode]);

  const graphLayout = useMemo(() => {
    if (!isGraphActive) return null;
    return computeGitLogGraphLayout(orderedEntries);
  }, [isGraphActive, orderedEntries]);

  // Head SHA is the commit marked HEAD -> ..., or the first entry
  const headSha = useMemo(() => {
    const headEntry = orderedEntries.find((entry) =>
      (entry.refs ?? []).some(
        (ref) => ref.startsWith('HEAD ->') || ref === 'HEAD'
      )
    );
    return headEntry?.sha ?? orderedEntries[0]?.sha ?? null;
  }, [orderedEntries]);

  const { aheadEntries, recentEntries } = useMemo(() => {
    if (ahead <= 0 || isGraphActive || isMultiBranch) {
      return { aheadEntries: [], recentEntries: orderedEntries };
    }
    return {
      aheadEntries: orderedEntries.slice(0, ahead),
      recentEntries: orderedEntries.slice(ahead),
    };
  }, [orderedEntries, ahead, isGraphActive, isMultiBranch]);

  // Filter entries by search query
  const filteredAhead = useMemo(() => {
    if (!searchQuery) return aheadEntries;
    const q = searchQuery.toLowerCase();
    return aheadEntries.filter(
      (e) =>
        e.summary.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q) ||
        e.sha.startsWith(q)
    );
  }, [aheadEntries, searchQuery]);

  const filteredRecent = useMemo(() => {
    if (!searchQuery) return recentEntries;
    const q = searchQuery.toLowerCase();
    return recentEntries.filter(
      (e) =>
        e.summary.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q) ||
        e.sha.startsWith(q)
    );
  }, [recentEntries, searchQuery]);

  const handleSelect = useCallback(
    async (sha: string) => {
      // Toggle deselect
      if (selectedSha === sha) {
        setSelectedSha(null);
        return;
      }
      setSelectedSha(sha);
      if (!repoId) return;

      // Load commit detail + diffs and open in center panel
      setCommitDiffLoading(true);
      panelActions?.openCommitDiff();
      try {
        const [detail, diffs] = await Promise.all([
          workspaceId
            ? attemptsApi.getCommitDetail(workspaceId, repoId, sha)
            : repoApi.getCommitDetail(repoId, sha, worktreePath),
          workspaceId
            ? attemptsApi.getCommitDiffs(workspaceId, repoId, sha)
            : repoApi.getCommitDiffs(repoId, sha, worktreePath),
        ]);
        setCommitDiff(sha, detail, diffs);
      } catch (error) {
        setCommitDiffLoading(false);
        console.error('Failed to load commit details:', error);
        const detail = error instanceof Error ? error.message : String(error);
        toast.error(
          detail
            ? `Failed to load commit details: ${detail}`
            : 'Failed to load commit details'
        );
      }
    },
    [
      selectedSha,
      workspaceId,
      repoId,
      worktreePath,
      setCommitDiff,
      setCommitDiffLoading,
      panelActions,
    ]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: GitLogEntry) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, entry });
    },
    []
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
    setCreateBranchInput({ sha: '', show: false });
    setNewBranchName('');
  }, []);

  const executeAction = useCallback(
    async (
      action: () => Promise<void>,
      messages?: { success?: string; error?: string }
    ): Promise<boolean> => {
      setActionLoading(true);
      try {
        await action();
        await onRefresh?.();
        if (messages?.success) {
          toast.success(messages.success);
        }
        return true;
      } catch (error) {
        console.error('Git log action failed:', error);
        const detail = error instanceof Error ? error.message : String(error);
        const prefix = messages?.error ?? 'Git action failed';
        toast.error(detail ? `${prefix}: ${detail}` : prefix);
        return false;
      } finally {
        setActionLoading(false);
      }
    },
    [onRefresh]
  );

  const buildCommitContextActions = useCallback(
    (entry: GitLogEntry): ContextMenuAction[] => {
      const canOperate = !!workspaceId && !!repoId && !actionLoading;
      const actions: ContextMenuAction[] = [];

      actions.push({
        label: 'Copy SHA',
        icon: <ClipboardCopy className="h-3 w-3" />,
        group: 'quick',
        onClick: () => {
          void writeTextToClipboard(entry.sha).then((copied) => {
            if (copied) {
              toast.success('Copied commit SHA');
            } else {
              toast.error('Failed to copy commit SHA');
            }
          });
        },
      });
      actions.push({
        label: 'Copy Message',
        icon: <Copy className="h-3 w-3" />,
        group: 'quick',
        onClick: () => {
          void writeTextToClipboard(entry.summary).then((copied) => {
            if (copied) {
              toast.success('Copied commit message');
            } else {
              toast.error('Failed to copy commit message');
            }
          });
        },
      });

      actions.push({
        label: 'Create Branch Here',
        icon: <GitBranch className="h-3 w-3" />,
        group: 'branch',
        disabled: !canOperate,
        onClick: () => {
          setContextMenu(null);
          setCreateBranchInput({ sha: entry.sha, show: true });
        },
      });
      actions.push({
        label: 'Reset to This Commit',
        icon: <RotateCcw className="h-3 w-3" />,
        group: 'branch',
        disabled: !canOperate,
        submenu: [
          {
            label: 'Soft (keep changes staged)',
            icon: <RotateCcw className="h-3 w-3" />,
            onClick: () =>
              executeAction(
                () =>
                  attemptsApi.resetToCommit(
                    workspaceId!,
                    repoId!,
                    entry.sha,
                    'soft'
                  ),
                {
                  success: 'Soft reset completed',
                  error: 'Soft reset failed',
                }
              ),
          },
          {
            label: 'Mixed (keep changes unstaged)',
            icon: <RotateCcw className="h-3 w-3" />,
            onClick: () =>
              executeAction(
                () =>
                  attemptsApi.resetToCommit(
                    workspaceId!,
                    repoId!,
                    entry.sha,
                    'mixed'
                  ),
                {
                  success: 'Mixed reset completed',
                  error: 'Mixed reset failed',
                }
              ),
          },
          {
            label: 'Hard (discard all changes)',
            icon: <RotateCcw className="h-3 w-3" />,
            danger: true,
            onClick: () => {
              void (async () => {
                const result = await ConfirmDialog.show({
                  title: 'Discard all uncommitted changes?',
                  message:
                    'Hard reset will discard all uncommitted changes in the current workspace.',
                  confirmText: 'Discard',
                  cancelText: 'Cancel',
                  variant: 'destructive',
                });
                if (result !== 'confirmed') {
                  return;
                }

                executeAction(
                  () =>
                    attemptsApi.resetToCommit(
                      workspaceId!,
                      repoId!,
                      entry.sha,
                      'hard'
                    ),
                  {
                    success: 'Hard reset completed',
                    error: 'Hard reset failed',
                  }
                );
              })();
            },
          },
        ],
        onClick: () => {},
      });

      actions.push({
        label: 'Cherry-pick',
        icon: <CherryIcon className="h-3 w-3" />,
        group: 'write',
        disabled: !canOperate,
        onClick: () =>
          executeAction(
            () => attemptsApi.cherryPick(workspaceId!, repoId!, entry.sha),
            {
              success: 'Cherry-pick completed',
              error: 'Cherry-pick failed',
            }
          ),
      });
      actions.push({
        label: 'Revert',
        icon: <Undo2 className="h-3 w-3" />,
        group: 'write',
        disabled: !canOperate,
        onClick: () =>
          executeAction(
            () => attemptsApi.revertCommit(workspaceId!, repoId!, entry.sha),
            {
              success: 'Revert completed',
              error: 'Revert failed',
            }
          ),
      });

      return actions;
    },
    [workspaceId, repoId, actionLoading, executeAction]
  );

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name || !workspaceId || !repoId) return;
    const ok = await executeAction(
      () =>
        attemptsApi.createBranchAtCommit(
          workspaceId,
          repoId,
          name,
          createBranchInput.sha
        ),
      {
        success: `Created branch "${name}"`,
        error: `Failed to create branch "${name}"`,
      }
    );
    if (ok) {
      setCreateBranchInput({ sha: '', show: false });
      setNewBranchName('');
    }
  }, [
    newBranchName,
    workspaceId,
    repoId,
    createBranchInput.sha,
    executeAction,
  ]);

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set()
  );

  const toggleSection = useCallback((title: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(title)) {
        next.delete(title);
      } else {
        next.add(title);
      }
      return next;
    });
  }, []);

  // Build flat virtual list items (continuous stream in graph or multi-branch mode)
  const virtualItems = useMemo<VirtualListItem[]>(() => {
    const items: VirtualListItem[] = [];

    if (isGraphActive || isMultiBranch) {
      for (const entry of filteredRecent) {
        items.push({ type: 'entry', entry, isPushable: false });
      }
      return items;
    }

    // "To Push" section
    if (ahead > 0 && filteredAhead.length > 0) {
      items.push({
        type: 'section-header',
        title: 'To Push',
        icon: 'upload',
        count: ahead,
        accentColor: 'text-[hsl(var(--success))]',
      });
      if (!collapsedSections.has('To Push')) {
        for (const entry of filteredAhead) {
          items.push({ type: 'entry', entry, isPushable: true });
        }
      }
    }

    // "To Pull" indicator
    if (behind > 0) {
      items.push({
        type: 'section-header',
        title: 'To Pull',
        icon: 'download',
        count: behind,
        accentColor: 'text-[hsl(var(--warning))]',
        extra: collapsedSections.has('To Pull')
          ? undefined
          : 'Fetch or pull to see these commits',
      });
    }

    // "Recent Commits" section
    if (filteredRecent.length > 0) {
      if (ahead > 0 || behind > 0) {
        items.push({
          type: 'section-header',
          title: 'Recent Commits',
          icon: 'commit',
          count: 0,
          accentColor: 'text-muted-foreground',
        });
      }
      if (!collapsedSections.has('Recent Commits')) {
        for (const entry of filteredRecent) {
          items.push({ type: 'entry', entry, isPushable: false });
        }
      }
    }

    return items;
  }, [
    ahead,
    behind,
    filteredAhead,
    filteredRecent,
    collapsedSections,
    isGraphActive,
    isMultiBranch,
  ]);

  const sectionIcons = useMemo(
    () => ({
      upload: <Upload className="h-3 w-3" />,
      download: <Download className="h-3 w-3" />,
      commit: <GitCommit className="h-3 w-3" />,
    }),
    []
  );

  const renderVirtualItem = useCallback(
    (_index: number, item: VirtualListItem) => {
      if (item.type === 'section-header') {
        const testId = `git-log-section-header-${item.title
          .toLowerCase()
          .replace(/\s+/g, '-')}`;
        const isCollapsed = collapsedSections.has(item.title);
        return (
          <div
            role="button"
            tabIndex={0}
            aria-expanded={!isCollapsed}
            data-testid={testId}
            className="mx-1.5 my-0.5 flex cursor-pointer select-none items-center justify-between rounded-md bg-muted/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/80"
            onClick={() => toggleSection(item.title)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleSection(item.title);
              }
            }}
          >
            <div className="flex items-center gap-1.5">
              <span className={item.accentColor}>
                {sectionIcons[item.icon]}
              </span>
              <span>{item.title}</span>
              {item.count > 0 && (
                <span className="text-muted-foreground/60">({item.count})</span>
              )}
              {item.extra && (
                <span className="ml-1 text-[10px] font-normal normal-case text-muted-foreground">
                  {item.extra}
                </span>
              )}
            </div>
          </div>
        );
      }

      const graphRow = graphLayout?.bySha.get(item.entry.sha) ?? null;

      return (
        <LogEntry
          entry={item.entry}
          isSelected={selectedSha === item.entry.sha}
          isHead={headSha === item.entry.sha}
          isPushable={item.isPushable}
          workspaceId={workspaceId}
          graphRow={graphRow}
          graphMaxLanes={graphLayout?.maxLanes}
          onSelect={handleSelect}
          onContextMenu={handleContextMenu}
        />
      );
    },
    [
      sectionIcons,
      collapsedSections,
      toggleSection,
      graphLayout,
      selectedSha,
      headSha,
      handleSelect,
      handleContextMenu,
      workspaceId,
    ]
  );

  const virtuosoComponents = useMemo(() => {
    if (!hasMore || !onLoadMore) return EMPTY_VIRTUOSO_COMPONENTS;
    return {
      Footer: () => (
        <div className="flex justify-center py-2">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="rounded-md border border-border/50 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors disabled:opacity-40"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              i18n.t('panels:ui.gitLog.loadMoreCommits')
            )}
          </button>
        </div>
      ),
    };
  }, [hasMore, onLoadMore, loading]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Permanent search input + compact branch filter on the right */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border/30 shrink-0">
        <div className="min-w-0 flex-1">
          <TextInput
            ref={searchInputRef}
            label={i18n.t('panels:ui.gitLog.searchCommits2')}
            isLabelHidden
            size="sm"
            width="100%"
            className="git-log-search-input"
            placeholder={i18n.t('panels:ui.gitLog.searchCommits')}
            value={searchQuery}
            onChange={(val) => setSearchQuery(val)}
            hasClear
            startIcon={
              <button
                type="button"
                className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => searchInputRef.current?.focus()}
                title={i18n.t('panels:ui.gitLog.searchCommits2')}
                aria-label={i18n.t('panels:ui.gitLog.searchCommits2')}
              >
                <Search className="h-3 w-3" />
              </button>
            }
          />
        </div>
        {branches && branches.length > 0 && onSelectedBranchesChange && (
          <GitLogBranchFilter
            branches={branches}
            selectedBranches={selectedBranches ?? []}
            defaultBranches={defaultBranches ?? []}
            onChange={onSelectedBranchesChange}
          />
        )}
      </div>

      {/* Create branch input (shown after context menu action) */}
      {createBranchInput.show && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/30 bg-accent/10">
          <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            className="flex-1 bg-background/50 border border-border/50 rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
            placeholder={`Branch from ${createBranchInput.sha.slice(0, 7)}...`}
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateBranch();
              if (e.key === 'Escape') {
                setCreateBranchInput({ sha: '', show: false });
                setNewBranchName('');
              }
            }}
            autoFocus
          />
          <button
            className="px-2 py-1 rounded text-[11px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            disabled={!newBranchName.trim() || actionLoading}
            onClick={handleCreateBranch}
          >
            {actionLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              'Create'
            )}
          </button>
        </div>
      )}

      {/* Commit list (virtualized) */}
      <div className="flex-1 overflow-hidden">
        {loading && entries.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {i18n.t('panels:ui.gitLog.loadingCommits')}
          </div>
        )}
        {!loading && entries.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            {i18n.t('panels:ui.gitLog.noCommitsFound')}
          </div>
        )}

        {virtualItems.length > 0 && (
          <Virtuoso
            data={virtualItems}
            itemContent={renderVirtualItem}
            components={virtuosoComponents}
            style={{ height: '100%' }}
            overscan={200}
          />
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <GitContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={buildCommitContextActions(contextMenu.entry)}
          onClose={handleCloseContextMenu}
        />
      )}
    </div>
  );
});
