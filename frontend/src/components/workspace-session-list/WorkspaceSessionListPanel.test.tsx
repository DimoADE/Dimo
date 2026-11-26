import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { IDockviewPanelProps } from 'dockview-react';
import type { Workspace } from 'shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { sessionsApi } from '@/lib/api';
import WorkspaceSessionListPanel from './WorkspaceSessionListPanel';

const openSessionTabMock = vi.fn();
const activateExecutionSessionMock = vi.fn();
const setActiveWorktreeMock = vi.fn();
const navigateMock = vi.fn();

let mockedSessions: KanbanProjectSessionRecord[] = [];
let mockedActiveSessionId: string | undefined;

vi.mock('@/contexts/ProjectContext', () => {
  const value = () => ({ projectId: 'project-1', project: null });
  return {
    useProject: value,
    useOptionalProject: value,
  };
});

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => ({
    activeWorktreeId: 'workspace-1',
    setActiveWorktree: setActiveWorktreeMock,
  }),
}));

vi.mock('@/contexts/KanbanSessionContext', () => {
  const value = () => ({
    visibleRightSession: mockedActiveSessionId
      ? { sessionId: mockedActiveSessionId, workspaceId: 'workspace-1' }
      : null,
    activateExecutionSession: activateExecutionSessionMock,
    pruneSessions: vi.fn(),
  });
  return {
    useKanbanSessionContext: value,
    useOptionalKanbanSessionContext: () => null,
  };
});

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openSessionTab: openSessionTabMock,
  }),
  useOptionalPanelActionsContext: () => ({
    openSessionTab: openSessionTabMock,
  }),
}));

vi.mock('@/hooks/useNavigateWithSearch', () => ({
  useNavigateWithSearch: () => navigateMock,
}));

vi.mock('@/hooks/useKanbanProjectSessions', () => ({
  useKanbanProjectSessions: () => ({
    sessions: mockedSessions,
    isLoading: false,
  }),
}));

vi.mock('@/components/context-menu', () => ({
  useAppContextMenu: () => ({
    openSurfaceMenu: vi.fn(),
  }),
}));

vi.mock('@/components/kanban/session-hub/useKanbanSessionMutations', () => ({
  useKanbanSessionMutations: () => ({
    renameSessionMutation: { mutateAsync: vi.fn() },
  }),
}));

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference: vi.fn(),
}));

function buildSession(
  overrides: Partial<KanbanProjectSessionRecord> = {}
): KanbanProjectSessionRecord {
  const workspace: Workspace = {
    id: 'workspace-1',
    project_id: 'project-1',
    task_id: 'task-1',
    parent_workspace_id: null,
    container_ref: null,
    branch: 'main',
    use_worktree: false,
    agent_working_dir: null,
    setup_completed_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    archived: false,
    pinned: false,
    name: 'Dimo',
  };
  const id = overrides.id ?? 'session-1';
  return {
    id,
    placement: { sessionId: id, workspaceId: workspace.id },
    workspace,
    task: null,
    taskId: workspace.task_id,
    name: 'Review Target',
    status: 'inreview',
    branch: workspace.branch,
    workspaceName: workspace.name ?? workspace.branch,
    workspaceDisplayLabel: 'Dimo · main',
    executor: 'codex',
    agentId: 'codex',
    updatedAt: '2026-08-17T12:00:00Z',
    createdAt: '2026-08-17T10:00:00Z',
    firstPrompt: 'Review this session',
    model: null,
    fullName: 'Review Target',
    shortName: 'Review',
    taskTitle: null,
    isCompleted: false,
    isRunning: false,
    isErrored: false,
    pinnedAt: null,
    collaboration: null,
    ...overrides,
  };
}

describe('WorkspaceSessionListPanel', () => {
  beforeEach(() => {
    openSessionTabMock.mockReset();
    activateExecutionSessionMock.mockReset();
    setActiveWorktreeMock.mockReset();
    navigateMock.mockReset();
    mockedSessions = [];
    mockedActiveSessionId = undefined;
  });

  it('marks an already-active in-review session viewed when clicked in the list, without marking running sessions', async () => {
    mockedActiveSessionId = 'session-review';
    mockedSessions = [
      buildSession({
        id: 'session-review',
        name: 'Review Target',
        fullName: 'Review Target',
        status: 'inreview',
        isRunning: false,
      }),
      buildSession({
        id: 'session-running',
        name: 'Running Target',
        fullName: 'Running Target',
        status: 'inreview',
        isRunning: true,
      }),
    ];

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      ['workspaceSessions', 'workspace-1', 'summaries'],
      [
        {
          id: 'session-review',
          workspace_id: 'workspace-1',
          status: 'inreview',
          is_running: false,
        },
        {
          id: 'session-running',
          workspace_id: 'workspace-1',
          status: 'inreview',
          is_running: true,
        },
      ]
    );
    const markViewedSpy = vi
      .spyOn(sessionsApi, 'markViewed')
      .mockResolvedValue({
        id: 'session-review',
        workspace_id: 'workspace-1',
        status: 'done',
      } as never);

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <WorkspaceSessionListPanel
            {...({
              api: {},
              containerApi: {},
              params: {},
            } as unknown as IDockviewPanelProps)}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /Running Target/ }));
    expect(markViewedSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Review Target/ }));
    expect(openSessionTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-review' })
    );
    await waitFor(() => {
      expect(markViewedSpy).toHaveBeenCalledWith('session-review');
    });
    expect(
      queryClient.getQueryData<Array<{ id: string; status: string }>>([
        'workspaceSessions',
        'workspace-1',
        'summaries',
      ])?.[0]?.status
    ).toBe('done');
    markViewedSpy.mockRestore();
  });
});
