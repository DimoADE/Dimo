import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DetailedGitStatus,
  GitBranch,
  Repo,
  Workspace,
} from 'shared/types';
import { useComposerWorkspaceContext } from './useComposerWorkspaceContext';

const mockUseOptionalProject = vi.fn();
const mockUseAttemptRepo = vi.fn();
const mockUseAttemptBranch = vi.fn();
const mockUseTaskAttempt = vi.fn();
const mockGetRepositories = vi.fn();
const mockGitChildren = vi.fn();
const mockGetBranches = vi.fn();
const mockRepoGetGitStatus = vi.fn();
const mockAttemptGetGitStatus = vi.fn();

vi.mock('@/contexts/ProjectContext', () => ({
  useOptionalProject: () => mockUseOptionalProject(),
}));

vi.mock('@/hooks/useAttemptRepo', () => ({
  useAttemptRepo: (workspaceId?: string) => mockUseAttemptRepo(workspaceId),
}));

vi.mock('@/hooks/useAttemptBranch', () => ({
  useAttemptBranch: (workspaceId?: string) => mockUseAttemptBranch(workspaceId),
}));

vi.mock('@/hooks/useTaskAttempt', () => ({
  useTaskAttempt: (workspaceId?: string) => mockUseTaskAttempt(workspaceId),
}));

vi.mock('@/lib/api', () => ({
  projectsApi: {
    getRepositories: (projectId: string) => mockGetRepositories(projectId),
    gitChildren: (projectId: string) => mockGitChildren(projectId),
  },
  repoApi: {
    getBranches: (repoId: string) => mockGetBranches(repoId),
    getGitStatus: (repoId: string) => mockRepoGetGitStatus(repoId),
  },
  attemptsApi: {
    getGitStatus: (workspaceId: string, repoId: string) =>
      mockAttemptGetGitStatus(workspaceId, repoId),
  },
}));

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const DEFAULT_WORKSPACE: Workspace = {
  id: 'ws-root',
  project_id: 'proj-1',
  task_id: 'task-1',
  parent_workspace_id: null,
  container_ref: '/repo/dimo',
  branch: '',
  use_worktree: false,
  agent_working_dir: null,
  setup_completed_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  archived: false,
  pinned: false,
  name: null,
};

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo/dimo',
  name: 'dimo',
  display_name: 'Dimo Repo',
  setup_script: null,
  cleanup_script: null,
  archive_script: null,
  copy_files: null,
  parallel_setup_script: false,
  dev_server_script: null,
  default_target_branch: null,
  default_working_dir: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

describe('useComposerWorkspaceContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOptionalProject.mockReturnValue({
      projectId: 'proj-1',
      project: {
        id: 'proj-1',
        name: 'Dimo',
        root_path: '/repo/dimo',
        is_git: true,
      },
    });
    mockUseAttemptRepo.mockReturnValue({
      repos: [],
      selectedRepoId: null,
    });
    mockUseAttemptBranch.mockReturnValue({
      branch: null,
      refetch: vi.fn(),
    });
    mockUseTaskAttempt.mockReturnValue({ data: undefined });
    mockGetRepositories.mockResolvedValue([]);
    mockGitChildren.mockResolvedValue([]);
    mockGetBranches.mockResolvedValue([]);
    mockRepoGetGitStatus.mockResolvedValue({
      branch_name: '',
      staged_files: [],
      unstaged_files: [],
      total_additions: 0,
      total_deletions: 0,
    } satisfies DetailedGitStatus);
  });

  it('resolves project name and branch via project repositories when workspace_repos is empty', async () => {
    mockGetRepositories.mockResolvedValue([REPO]);
    const branches: GitBranch[] = [
      {
        name: 'master',
        is_current: true,
        is_remote: false,
        is_worktree: false,
        worktree_path: null,
        last_commit_date: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    mockGetBranches.mockResolvedValue(branches);

    const { result } = renderHook(
      () =>
        useComposerWorkspaceContext({
          workspace: DEFAULT_WORKSPACE,
          workspaceId: DEFAULT_WORKSPACE.id,
        }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => {
      expect(result.current.composerBranchName).toBe('master');
    });
    expect(result.current.isGitDirectory).toBe(true);
    expect(result.current.composerProjectName).toBe('Dimo');
    expect(result.current.primaryRepo?.id).toBe('repo-1');
  });

  it('falls back to gitChildren when an explicit git parent project has no direct repo', async () => {
    mockGetRepositories.mockImplementation((projectId: string) => {
      if (projectId === 'proj-1') return Promise.resolve([]);
      if (projectId === 'proj-child') return Promise.resolve([REPO]);
      return Promise.resolve([]);
    });
    mockGitChildren.mockResolvedValue([{ id: 'proj-child', name: 'Child' }]);
    mockGetBranches.mockResolvedValue([
      {
        name: 'main',
        is_current: true,
        is_remote: false,
        is_worktree: false,
        worktree_path: null,
        last_commit_date: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const { result } = renderHook(
      () =>
        useComposerWorkspaceContext({
          workspace: DEFAULT_WORKSPACE,
          workspaceId: DEFAULT_WORKSPACE.id,
        }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => {
      expect(result.current.composerBranchName).toBe('main');
    });
    expect(result.current.composerProjectName).toBe('Dimo');
  });

  it('falls back to repoApi.getGitStatus when branches list has no current branch', async () => {
    mockGetRepositories.mockResolvedValue([REPO]);
    mockGetBranches.mockResolvedValue([]);
    mockRepoGetGitStatus.mockResolvedValue({
      branch_name: 'HEAD (detached)',
      staged_files: [],
      unstaged_files: [],
      total_additions: 0,
      total_deletions: 0,
    } satisfies DetailedGitStatus);

    const { result } = renderHook(
      () =>
        useComposerWorkspaceContext({
          workspace: DEFAULT_WORKSPACE,
          workspaceId: DEFAULT_WORKSPACE.id,
        }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => {
      expect(result.current.composerBranchName).toBe('HEAD (detached)');
    });
    expect(mockRepoGetGitStatus).toHaveBeenCalledWith('repo-1');
  });

  it('treats non-git directories as non-git, displays folder name, and hides branch', () => {
    mockUseOptionalProject.mockReturnValue({
      projectId: 'proj-plain',
      project: {
        id: 'proj-plain',
        name: 'Global',
        root_path: 'C:\\Users\\alice\\Documents\\MyNotes',
        is_git: false,
      },
    });
    mockGitChildren.mockResolvedValue([{ id: 'proj-child', name: 'Child' }]);

    const plainWorkspace: Workspace = {
      ...DEFAULT_WORKSPACE,
      id: 'ws-plain',
      project_id: 'proj-plain',
      container_ref: 'C:\\Users\\alice\\Documents\\MyNotes',
      branch: 'stale-branch',
    };

    const { result } = renderHook(
      () =>
        useComposerWorkspaceContext({
          workspace: plainWorkspace,
          workspaceId: plainWorkspace.id,
        }),
      { wrapper: makeWrapper() }
    );

    expect(result.current.isGitDirectory).toBe(false);
    expect(result.current.isWorktreeWorkspace).toBe(false);
    expect(result.current.composerProjectName).toBe('MyNotes');
    expect(result.current.composerBranchName).toBeNull();
    expect(mockGetRepositories).not.toHaveBeenCalled();
    expect(mockGitChildren).not.toHaveBeenCalled();
    expect(mockGetBranches).not.toHaveBeenCalled();
    expect(mockRepoGetGitStatus).not.toHaveBeenCalled();
  });
});
