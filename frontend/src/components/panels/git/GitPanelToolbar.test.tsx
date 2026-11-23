import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitPanelMode, LogViewMode } from '@/hooks/git';
import { GitPanel } from './GitPanel';

const { controllerState } = vi.hoisted(() => ({
  controllerState: {
    mode: 'diff' as GitPanelMode,
    diffListView: 'flat' as 'flat' | 'tree',
    logViewMode: 'graph' as LogViewMode,
    setMode: vi.fn(),
    toggleDiffListView: vi.fn(),
    toggleLogViewMode: vi.fn(),
    selectedDiffPath: null as string | null,
    setSelectedDiffPath: vi.fn(),
  },
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ projectId: 'proj-1' }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: () => ({ data: [], isLoading: false, isSuccess: true }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => ({ activeWorktreeId: null }),
}));

vi.mock('@/hooks/useAttempt', () => ({
  useAttempt: () => ({ data: null }),
}));

vi.mock('@/hooks/useAttemptRepo', () => ({
  useAttemptRepo: () => ({ selectedRepoId: null, isLoading: false }),
}));

vi.mock('@/hooks', () => ({
  useProjectRepos: () => ({
    data: [{ id: 'repo-1', name: 'demo', default_target_branch: 'main' }],
    isLoading: false,
    isSuccess: true,
  }),
}));

vi.mock('@/hooks/useProjectWorktrees', () => ({
  useProjectWorktrees: () => ({ worktrees: [], isLoading: false }),
}));

vi.mock('@/hooks/useBranchStatus', () => ({
  useBranchStatus: () => ({ data: undefined }),
}));

vi.mock('@/hooks/useAttemptConflicts', () => ({
  useAttemptConflicts: () => ({ abortConflicts: vi.fn() }),
}));

vi.mock('@/hooks/usePanelActions', () => ({
  usePanelActions: () => ({
    openDiffPreview: vi.fn(),
    openMergePanel: vi.fn(),
  }),
}));

vi.mock('@/components/context-menu', () => ({
  useAppContextMenu: () => ({ openSurfaceMenu: vi.fn() }),
}));

vi.mock('@/components/layout/ShellNavPanelDragHandle', () => ({
  ShellNavPanelDragHandle: () => <div data-testid="drag-handle" />,
}));

vi.mock('@astryxdesign/core/Selector', () => {
  type MockOption =
    | { value: string; label?: string }
    | {
        type: 'section';
        title: string;
        options: { value: string; label?: string }[];
      };
  return {
    Selector: ({
      value,
      options,
      onChange,
      label,
      'data-testid': dataTestId,
    }: {
      value: string;
      options: MockOption[];
      onChange: (v: string) => void;
      label?: string;
      'data-testid'?: string;
    }) => (
      <select
        className="raised-control"
        aria-label={label ?? 'Git view'}
        data-testid={dataTestId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) =>
          'type' in opt ? (
            <optgroup key={opt.title} label={opt.title}>
              {opt.options.map((child) => (
                <option key={child.value} value={child.value}>
                  {child.label ?? child.value}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={opt.value} value={opt.value}>
              {opt.label ?? opt.value}
            </option>
          )
        )}
      </select>
    ),
    SelectorOption: ({ label }: { label: React.ReactNode }) => <>{label}</>,
  };
});

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => (
    <div data-testid="virtuoso-mock">
      {data.map((item, idx) => (
        <div key={idx}>{itemContent(idx, item)}</div>
      ))}
    </div>
  ),
}));

vi.mock('@/hooks/git', () => ({
  useGitPanelController: () => controllerState,
  useRepoWorktrees: () => ({
    worktrees: [
      {
        path: '/repo',
        branch: 'main',
        head_sha: 'aaa1111',
        is_main: true,
        is_detached: false,
        is_bare: false,
      },
    ],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useBranchDiffs: () => ({
    diffs: [
      {
        change: 'modified',
        oldPath: 'src/feat.ts',
        newPath: 'src/feat.ts',
        oldContent: 'a',
        newContent: 'b',
        contentOmitted: false,
        additions: 5,
        deletions: 1,
        repoId: 'repo-1',
      },
    ],
    files: [{ path: 'src/feat.ts', status: 'M', additions: 5, deletions: 1 }],
    totalAdditions: 5,
    totalDeletions: 1,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useGitStatus: () => ({
    branchName: 'main',
    stagedFiles: [],
    unstagedFiles: [],
    totalAdditions: 0,
    totalDeletions: 0,
    isLoading: false,
    refresh: vi.fn(),
  }),
  useGitDiffs: () => ({ diffs: [] }),
  shouldAutoPreloadDiffs: () => false,
  useGitActions: () => ({
    stageFile: vi.fn(),
    unstageFile: vi.fn(),
    revertFile: vi.fn(),
    stageAll: vi.fn(),
    revertAll: vi.fn(),
    error: null,
  }),
  useGitCommit: () => ({
    commitMessage: '',
    setCommitMessage: vi.fn(),
    commitLoading: false,
    pushLoading: false,
    pullLoading: false,
    fetchLoading: false,
    commitError: null,
    operationError: null,
    onCommit: vi.fn(),
    onCommitAndPush: vi.fn(),
    onPush: vi.fn(),
    onPull: vi.fn(),
    onFetch: vi.fn(),
  }),
  useGitLog: () => ({
    entries: [],
    total: 0,
    ahead: 0,
    behind: 0,
    upstream: null,
    branchName: 'main',
    isLoading: false,
    refresh: vi.fn(),
  }),
  useGitBranches: () => ({
    branches: [
      {
        name: 'main',
        is_current: true,
        is_remote: false,
        is_worktree: false,
        worktree_path: null,
        last_commit_date: new Date('2026-01-01T00:00:00Z'),
      },
      {
        name: 'feat/readonly-branch',
        is_current: false,
        is_remote: false,
        is_worktree: false,
        worktree_path: null,
        last_commit_date: new Date('2026-01-01T00:00:00Z'),
      },
      {
        name: 'origin/main',
        is_current: false,
        is_remote: true,
        is_worktree: false,
        worktree_path: null,
        last_commit_date: new Date('2026-01-01T00:00:00Z'),
      },
    ],
    remotes: [],
    isLoading: false,
    error: null,
    checkoutBranch: vi.fn(),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    refresh: vi.fn(),
  }),
  useGitHubData: () => ({
    issues: [],
    issuesLoading: false,
    issuesError: null,
    issueFilter: 'open',
    setIssueFilter: vi.fn(),
    refreshIssues: vi.fn(),
    prs: [],
    prsLoading: false,
    prsError: null,
    refreshPrs: vi.fn(),
  }),
}));

describe('GitPanel Row 1 view toggle and read-only branch diff', () => {
  beforeEach(() => {
    controllerState.mode = 'diff';
    controllerState.diffListView = 'flat';
    controllerState.logViewMode = 'graph';
    controllerState.toggleDiffListView.mockReset();
    controllerState.toggleLogViewMode.mockReset();
  });

  it('shows Flat/Tree toggle in Diff mode, Graph/List toggle in Log mode, and hides it in Branch/Issue/PR modes', () => {
    const { rerender } = render(<GitPanel />);

    // Diff mode -> flat/tree toggle
    const diffToggle = screen.getByTestId('git-panel-view-toggle');
    fireEvent.click(diffToggle);
    expect(controllerState.toggleDiffListView).toHaveBeenCalledTimes(1);

    // Log mode -> graph/list toggle
    controllerState.mode = 'log';
    rerender(<GitPanel />);
    const logToggle = screen.getByTestId('git-panel-view-toggle');
    fireEvent.click(logToggle);
    expect(controllerState.toggleLogViewMode).toHaveBeenCalledTimes(1);

    // Branch, Issue, PR modes -> toggle hidden
    for (const hiddenMode of ['branches', 'issues', 'prs'] as const) {
      controllerState.mode = hiddenMode;
      rerender(<GitPanel />);
      expect(screen.queryByTestId('git-panel-view-toggle')).toBeNull();
    }
  });

  it('hides commit box and shows read-only branch diff banner when selecting a non-checked-out local branch', () => {
    render(<GitPanel />);

    // Commit box visible on live default directory
    expect(screen.getByPlaceholderText('提交信息...')).toBeTruthy();

    // Select non-checked-out local branch from the standard two-level Selector
    fireEvent.change(screen.getByTestId('git-worktree-branch-selector'), {
      target: { value: 'branch:feat/readonly-branch' },
    });

    expect(screen.queryByPlaceholderText('提交信息...')).toBeNull();
    expect(screen.getByTestId('git-readonly-branch-banner')).toBeTruthy();
    expect(screen.getByText('feat.ts')).toBeTruthy();
  });
});
