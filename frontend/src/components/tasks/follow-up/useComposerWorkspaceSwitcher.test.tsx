import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from 'shared/types';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { useComposerWorkspaceSwitcher } from './useComposerWorkspaceSwitcher';

const mockUpdateWorkspace = vi.fn();
const mockEnsureProjectWorkspace = vi.fn();
const mockGetGitStatus = vi.fn();
const mockStash = vi.fn();
const mockCheckoutBranch = vi.fn();
const mockConfirmDialogShow = vi.fn();
const mockSetActiveWorktree = vi.fn();
const mockReplaceRightSession = vi.fn();
const mockOpenSessionTab = vi.fn();
const mockToastError = vi.fn();
const mockWorktrees = vi.fn();

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: {
    show: (...args: unknown[]) => mockConfirmDialogShow(...args),
  },
}));

vi.mock('@/hooks/useProjectWorktrees', () => ({
  useProjectWorktrees: (projectId?: string) => ({
    worktrees: mockWorktrees(projectId),
  }),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useOptionalWorktree: () => ({
    activeWorktreeId: 'ws-root',
    setActiveWorktree: mockSetActiveWorktree,
  }),
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useOptionalKanbanSessionContext: () => ({
    replaceRightSession: mockReplaceRightSession,
  }),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => ({
    openSessionTab: mockOpenSessionTab,
  }),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('@/lib/api', () => ({
  sessionsApi: {
    updateWorkspace: (sessionId: string, workspaceId: string) =>
      mockUpdateWorkspace(sessionId, workspaceId),
    ensureProjectWorkspace: (data: {
      project_id: string;
      branch?: string | null;
    }) => mockEnsureProjectWorkspace(data),
  },
  attemptsApi: {
    getGitStatus: (workspaceId: string, repoId: string) =>
      mockGetGitStatus(workspaceId, repoId),
    stash: (
      workspaceId: string,
      repoId: string,
      message: string | null,
      includeUntracked: boolean
    ) => mockStash(workspaceId, repoId, message, includeUntracked),
    checkoutBranch: (workspaceId: string, repoId: string, branchName: string) =>
      mockCheckoutBranch(workspaceId, repoId, branchName),
  },
}));

const ROOT_WORKSPACE: Workspace = {
  id: 'ws-root',
  project_id: 'proj-1',
  task_id: 'task-root',
  parent_workspace_id: null,
  container_ref: '/repo/dimo',
  branch: 'master',
  use_worktree: false,
  agent_working_dir: null,
  setup_completed_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  archived: false,
  pinned: false,
  name: null,
};

const WT_WORKSPACE: Workspace = {
  ...ROOT_WORKSPACE,
  id: 'ws-wt',
  task_id: 'task-wt',
  container_ref: '/repo/.worktrees/feat-ui',
  branch: 'feat/ui',
  use_worktree: true,
};

const SESSION: Session = {
  id: 'sess-1',
  workspace_id: 'ws-root',
  task_id: 'task-root',
  name: 'Refine footer',
  initial_prompt: null,
  status: 'inprogress',
  executor: 'CLAUDE_CODE',
  external_session_id: null,
  agent_id: 'claude-code',
  provider_instance_id: null,
  parent_session_id: null,
  parent_tool_use_id: null,
  delegation_call_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

describe('useComposerWorkspaceSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileTreeStore.setState({
      rootPath: null,
      selectedFilePath: '/repo/dimo/README.md',
      diffFilePath: '/repo/dimo/README.md',
    });
    mockWorktrees.mockReturnValue([
      { workspace: ROOT_WORKSPACE },
      { workspace: WT_WORKSPACE },
    ]);
  });

  it('switches the current session to the selected workspace and syncs active panel and file tree', async () => {
    const updatedSession: Session = {
      ...SESSION,
      workspace_id: WT_WORKSPACE.id,
      task_id: WT_WORKSPACE.task_id,
    };
    mockUpdateWorkspace.mockResolvedValue(updatedSession);
    const { queryClient, wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        useComposerWorkspaceSwitcher({
          projectId: 'proj-1',
          projectName: 'Dimo',
          session: SESSION,
          sessionId: SESSION.id,
          workspace: ROOT_WORKSPACE,
          workspaceId: ROOT_WORKSPACE.id,
          primaryRepo: {
            id: 'repo-1',
            name: 'dimo',
            path: '/repo/dimo',
            default_target_branch: 'master',
          },
          primaryRepoBranches: [],
          workspaceRepoNames: [{ name: 'dimo', path: '/repo/dimo' }],
          mainDirectoryBranch: 'master',
          currentBranchName: 'master',
        }),
      { wrapper }
    );

    expect(result.current?.workspaces).toHaveLength(2);
    expect(result.current?.workspaces[0].label).toBe('Dimo');

    await act(async () => {
      await result.current?.onSelectWorkspace(WT_WORKSPACE);
    });

    expect(mockUpdateWorkspace).toHaveBeenCalledWith('sess-1', 'ws-wt');
    expect(mockOpenSessionTab).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      workspaceId: 'ws-wt',
      title: 'Refine footer',
      agentId: 'claude-code',
    });
    expect(mockReplaceRightSession).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      workspaceId: 'ws-wt',
    });
    expect(mockSetActiveWorktree).toHaveBeenCalledWith('ws-wt', 'task-wt');
    expect(useFileTreeStore.getState().rootPath).toBe(
      '/repo/.worktrees/feat-ui'
    );
    expect(useFileTreeStore.getState().selectedFilePath).toBeNull();
    expect(queryClient.getQueryData(['session', 'sess-1'])).toEqual(
      updatedSession
    );
  });

  it('ensures project root workspace when switching back to default directory from a worktree-only list', async () => {
    mockWorktrees.mockReturnValue([{ workspace: WT_WORKSPACE }]);
    mockEnsureProjectWorkspace.mockResolvedValue(ROOT_WORKSPACE);
    mockUpdateWorkspace.mockResolvedValue({
      ...SESSION,
      workspace_id: ROOT_WORKSPACE.id,
      task_id: ROOT_WORKSPACE.task_id,
    });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        useComposerWorkspaceSwitcher({
          projectId: 'proj-1',
          projectName: 'Dimo',
          session: { ...SESSION, workspace_id: WT_WORKSPACE.id },
          sessionId: SESSION.id,
          workspace: WT_WORKSPACE,
          workspaceId: WT_WORKSPACE.id,
          primaryRepoBranches: [],
          workspaceRepoNames: [{ name: 'dimo', path: '/repo/dimo' }],
          mainDirectoryBranch: 'master',
          currentBranchName: 'feat/ui',
        }),
      { wrapper }
    );

    expect(result.current?.canEnsureDefaultDirectory).toBe(true);

    await act(async () => {
      await result.current?.onSelectDefaultDirectory?.();
    });

    expect(mockEnsureProjectWorkspace).toHaveBeenCalledWith({
      project_id: 'proj-1',
      branch: 'master',
    });
    expect(mockUpdateWorkspace).toHaveBeenCalledWith('sess-1', 'ws-root');
    expect(mockOpenSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        workspaceId: 'ws-root',
      })
    );
  });

  it('surfaces backend error via toast without mutating active workspace on failure', async () => {
    mockUpdateWorkspace.mockRejectedValue(
      new Error('Cannot switch workspace while a turn is running')
    );
    const { wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        useComposerWorkspaceSwitcher({
          projectId: 'proj-1',
          projectName: 'Dimo',
          session: SESSION,
          sessionId: SESSION.id,
          workspace: ROOT_WORKSPACE,
          workspaceId: ROOT_WORKSPACE.id,
          primaryRepoBranches: [],
          workspaceRepoNames: [{ name: 'dimo', path: '/repo/dimo' }],
          mainDirectoryBranch: 'master',
          currentBranchName: 'master',
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current?.onSelectWorkspace(WT_WORKSPACE);
    });

    expect(mockToastError).toHaveBeenCalledWith(
      'Cannot switch workspace while a turn is running'
    );
    expect(mockOpenSessionTab).not.toHaveBeenCalled();
    expect(mockSetActiveWorktree).not.toHaveBeenCalled();
  });

  it('returns null for non-git directories so the workspace selector cannot open', () => {
    const { wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        useComposerWorkspaceSwitcher({
          isGitDirectory: false,
          projectId: 'proj-plain',
          projectName: 'MyNotes',
          session: SESSION,
          sessionId: SESSION.id,
          workspace: ROOT_WORKSPACE,
          workspaceId: ROOT_WORKSPACE.id,
          primaryRepoBranches: [],
          workspaceRepoNames: [],
          mainDirectoryBranch: null,
          currentBranchName: null,
        }),
      { wrapper }
    );

    expect(result.current).toBeNull();
    expect(mockWorktrees).toHaveBeenCalledWith(undefined);
  });

  it('checks out an available branch directly without dialog when the working tree is clean', async () => {
    mockGetGitStatus.mockResolvedValue({
      branch_name: 'master',
      staged_files: [],
      unstaged_files: [],
      total_additions: 0,
      total_deletions: 0,
    });
    mockCheckoutBranch.mockResolvedValue(undefined);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        useComposerWorkspaceSwitcher({
          projectId: 'proj-1',
          projectName: 'Dimo',
          session: SESSION,
          sessionId: SESSION.id,
          workspace: ROOT_WORKSPACE,
          workspaceId: ROOT_WORKSPACE.id,
          primaryRepo: {
            id: 'repo-1',
            name: 'dimo',
            path: '/repo/dimo',
            default_target_branch: 'master',
          },
          primaryRepoBranches: [],
          workspaceRepoNames: [{ name: 'dimo', path: '/repo/dimo' }],
          mainDirectoryBranch: 'master',
          currentBranchName: 'master',
        }),
      { wrapper }
    );

    expect(result.current?.activeDirectoryLabel).toBe('Dimo');

    await act(async () => {
      await result.current?.onSelectBranch?.({
        name: 'develop',
        role: 'available',
        occupiedBy: null,
      });
    });

    expect(mockGetGitStatus).toHaveBeenCalledWith('ws-root', 'repo-1');
    expect(mockConfirmDialogShow).not.toHaveBeenCalled();
    expect(mockStash).not.toHaveBeenCalled();
    expect(mockCheckoutBranch).toHaveBeenCalledWith(
      'ws-root',
      'repo-1',
      'develop'
    );
  });

  it('prompts to stash all changes when working tree is dirty and respects cancel vs confirm', async () => {
    mockGetGitStatus.mockResolvedValue({
      branch_name: 'feat/ui',
      staged_files: [],
      unstaged_files: [{ path: 'src/a.ts', status: 'M' }],
      total_additions: 1,
      total_deletions: 0,
    });
    mockStash.mockResolvedValue(true);
    mockCheckoutBranch.mockResolvedValue(undefined);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        useComposerWorkspaceSwitcher({
          projectId: 'proj-1',
          projectName: 'Dimo',
          session: { ...SESSION, workspace_id: WT_WORKSPACE.id },
          sessionId: SESSION.id,
          workspace: WT_WORKSPACE,
          workspaceId: WT_WORKSPACE.id,
          primaryRepo: {
            id: 'repo-1',
            name: 'dimo',
            path: '/repo/dimo',
            default_target_branch: 'master',
          },
          primaryRepoBranches: [],
          workspaceRepoNames: [{ name: 'dimo', path: '/repo/dimo' }],
          mainDirectoryBranch: 'master',
          currentBranchName: 'feat/ui',
        }),
      { wrapper }
    );

    expect(result.current?.activeDirectoryLabel).toBe('feat/ui');

    // Occupied branch is ignored completely
    await act(async () => {
      await result.current?.onSelectBranch?.({
        name: 'master',
        role: 'occupied',
        occupiedBy: 'Main directory',
      });
    });
    expect(mockGetGitStatus).not.toHaveBeenCalled();

    // User cancels dirty checkout
    mockConfirmDialogShow.mockResolvedValueOnce('canceled');
    await act(async () => {
      await result.current?.onSelectBranch?.({
        name: 'develop',
        role: 'available',
        occupiedBy: null,
      });
    });
    expect(mockConfirmDialogShow).toHaveBeenCalledTimes(1);
    expect(mockStash).not.toHaveBeenCalled();
    expect(mockCheckoutBranch).not.toHaveBeenCalled();

    // User confirms stash-all & checkout
    mockConfirmDialogShow.mockResolvedValueOnce('confirmed');
    await act(async () => {
      await result.current?.onSelectBranch?.({
        name: 'develop',
        role: 'available',
        occupiedBy: null,
      });
    });
    expect(mockStash).toHaveBeenCalledWith('ws-wt', 'repo-1', null, true);
    expect(mockCheckoutBranch).toHaveBeenCalledWith(
      'ws-wt',
      'repo-1',
      'develop'
    );
  });
});
