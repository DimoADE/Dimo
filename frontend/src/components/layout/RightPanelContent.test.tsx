import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createPortal } from 'react-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWorkspaceStageCreationHost } from '@/components/layout/workspaceStageCreationHost';
import {
  retainRightPanelHost,
  RightPanelSlotContext,
} from '@/contexts/RightPanelSlotContext';
import { requestWorkspaceCreateSessionOverlay } from '@/lib/requestCreateSession';
import {
  clearLastSessionAgent,
  getLastSessionAgent,
  recordLastSessionAgent,
} from '@/lib/lastSessionAgent';
import { RightPanelContent } from './RightPanelContent';

import { sessionsApi } from '@/lib/api';

const {
  kanbanSessionState,
  projectState,
  worktreeState,
  projectWorktreesState,
  selectableAgentsState,
  useTaskAttemptMock,
  branchHeaderRenderSpy,
  conversationRenderSpy,
  sessionCreationFormSpy,
  openSessionTabMock,
} = vi.hoisted(() => ({
  kanbanSessionState: {
    activeViewId: 'board',
    visibleRightSession: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    } as { sessionId: string; workspaceId: string } | null,
    activateExecutionSession: vi.fn(),
    placeCreatedSession: vi.fn(),
    isRightSessionPending: false,
    lastActiveWorkspaceId: 'workspace-1' as string | null,
  },
  projectState: {
    projectId: 'project-1',
    project: { id: 'project-1', is_git: true },
  },
  worktreeState: {
    activeWorktreeId: 'workspace-1' as string | null,
    setActiveWorktree: vi.fn(),
  },
  projectWorktreesState: {
    worktrees: [] as Array<{ workspace: Record<string, unknown> }>,
    isLoading: false,
    isSuccess: true,
  },
  selectableAgentsState: {
    agents: [] as Array<{
      agentId: string;
      displayName: string;
      iconLight: null;
      iconDark: null;
      iconSvg: null;
      enabled: boolean;
      lifecycle: string;
      runnable: boolean;
      settingsFeatures: [];
    }>,
  },
  useTaskAttemptMock: vi.fn((_workspaceId?: string) => ({
    data: undefined as Record<string, unknown> | undefined,
  })),
  branchHeaderRenderSpy: vi.fn(),
  conversationRenderSpy: vi.fn(),
  sessionCreationFormSpy: vi.fn(),
  openSessionTabMock: vi.fn(),
}));

vi.mock('@/features/agents/useSelectableAgents', () => ({
  useSelectableAgents: () => selectableAgentsState.agents,
}));

vi.mock('@/components/layout/BranchInfoHeader', () => ({
  BranchInfoHeader: () => {
    branchHeaderRenderSpy();
    return <div data-testid="right-panel-branch-header" />;
  },
}));

vi.mock('@/components/kanban/KanbanSessionConversationView', () => ({
  KanbanSessionConversationView: (props: {
    workspaceId: string;
    sessionId?: string;
    markViewed?: boolean;
  }) => {
    conversationRenderSpy(props);
    return (
      <div
        data-testid="right-panel-conversation-view"
        data-session-id={props.sessionId ?? ''}
        data-workspace-id={props.workspaceId}
      />
    );
  },
}));

vi.mock('@/components/sessions/SessionCreationForm', () => ({
  SessionCreationForm: (props: {
    title: string;
    selectedExecutorProfile?: {
      executor?: string;
      variant?: string | null;
    } | null;
    onSelectedExecutorProfileChange?: (profile: {
      executor: string;
      variant: string | null;
    }) => void;
    workspaceBranchOptions?: Array<{
      value: string;
      existingWorkspaceId?: string | null;
      branch?: string;
    }>;
    onSubmit?: () => void;
    onCancel?: () => void;
  }) => {
    sessionCreationFormSpy(props);
    return (
      <div
        data-testid="session-creation-form"
        data-selected-agent={props.selectedExecutorProfile?.executor ?? ''}
      >
        {props.title}
        <button
          type="button"
          onClick={() =>
            props.onSelectedExecutorProfileChange?.({
              executor: 'codex',
              variant: null,
            })
          }
        >
          select-codex
        </button>
        <button type="button" onClick={props.onSubmit}>
          submit-create
        </button>
        <button type="button" onClick={props.onCancel}>
          cancel-create
        </button>
      </div>
    );
  },
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    profiles: {
      CLAUDE_CODE: {
        DEFAULT: { CLAUDE_CODE: {} },
      },
      codex: {
        DEFAULT: { codex: {} },
      },
    },
    config: {
      executor_profile: { executor: 'CLAUDE_CODE', variant: null },
      multi_agent_enabled: false,
    },
  }),
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useKanbanSessionContext: () => kanbanSessionState,
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => worktreeState,
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => projectState,
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openSessionTab: openSessionTabMock,
  }),
}));

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
}));

vi.mock('@/features/collaboration/space/SpaceStoreContext', () => ({
  useOptionalCollaborationSpaceStore: () => null,
}));

vi.mock('@/hooks', () => ({
  useProjectRepos: () => ({ data: [], isPending: false }),
  useProjectWorktrees: () => projectWorktreesState,
  useRepoBranches: () => ({ data: [], isPending: false }),
  useRepoBranchSelection: () => ({
    configs: [],
    isLoading: false,
    isGitInitIncomplete: false,
    setRepoBranch: vi.fn(),
    getWorkspaceRepoInputs: () => [],
    reset: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTaskAttempt', () => ({
  useTaskAttempt: (workspaceId?: string) => useTaskAttemptMock(workspaceId),
}));

vi.mock('@/hooks/useNavigateWithSearch', () => ({
  useNavigateWithSearch: () => vi.fn(),
}));

function TestHarness({
  children,
  initialEntry = '/projects/project-1/workspaces/workspace-1/sessions/session-1',
}: {
  children: React.ReactNode;
  initialEntry?: string;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/projects/:projectId/workspaces/:workspaceId/sessions/:sessionId"
            element={children}
          />
          <Route path="/projects/:projectId" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('RightPanelContent detached host deduplication', () => {
  beforeEach(() => {
    branchHeaderRenderSpy.mockReset();
    conversationRenderSpy.mockReset();
    sessionCreationFormSpy.mockReset();
    openSessionTabMock.mockReset();
    kanbanSessionState.visibleRightSession = {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    };
    kanbanSessionState.lastActiveWorkspaceId = 'workspace-1';
    projectState.projectId = 'project-1';
    projectState.project = { id: 'project-1', is_git: true };
    worktreeState.activeWorktreeId = 'workspace-1';
    projectWorktreesState.worktrees = [];
    selectableAgentsState.agents = [];
    clearLastSessionAgent();
    useTaskAttemptMock.mockReset();
    useTaskAttemptMock.mockReturnValue({ data: undefined });
  });

  it('preserves standalone rendering when mounted directly without a detached slot host (host === null)', () => {
    render(
      <TestHarness>
        <RightPanelContent />
      </TestHarness>
    );

    expect(screen.getByTestId('right-panel-branch-header')).toBeInTheDocument();
    expect(
      screen.getByTestId('right-panel-conversation-view')
    ).toBeInTheDocument();
  });

  it('does not mount BranchInfoHeader or KanbanSessionConversationView while RightPanelSlotContext host is detached, yet still portals CreateSessionOverlay into stageCreationHost', () => {
    const detachedHost = document.createElement('div');
    const stageCreationHost = document.createElement('div');
    document.body.appendChild(stageCreationHost);
    const unregisterStageHost =
      registerWorkspaceStageCreationHost(stageCreationHost);

    try {
      const view = render(
        <TestHarness>
          <RightPanelSlotContext.Provider
            value={{ host: detachedHost, placement: 'workspace' }}
          >
            {createPortal(<RightPanelContent />, detachedHost)}
          </RightPanelSlotContext.Provider>
        </TestHarness>
      );

      // Zero duplicate mounts while detached in Free Tabs mode!
      expect(branchHeaderRenderSpy).not.toHaveBeenCalled();
      expect(conversationRenderSpy).not.toHaveBeenCalled();
      expect(
        detachedHost.querySelector(
          '[data-testid="right-panel-conversation-view"]'
        )
      ).toBeNull();

      // Requesting session creation still portals CreateSessionOverlay into stageCreationHost!
      act(() => {
        requestWorkspaceCreateSessionOverlay('right-group');
      });
      expect(
        stageCreationHost.querySelector('[data-testid="session-creation-form"]')
      ).not.toBeNull();

      // Attaching the host (e.g. KanbanSessionSlot or unbound ai-chat panel) mounts header + conversation.
      let releaseHost!: () => void;
      act(() => {
        document.body.appendChild(detachedHost);
        releaseHost = retainRightPanelHost(detachedHost);
      });

      expect(
        detachedHost.querySelector('[data-testid="right-panel-branch-header"]')
      ).not.toBeNull();
      expect(
        detachedHost.querySelector(
          '[data-testid="right-panel-conversation-view"]'
        )
      ).not.toBeNull();

      // Releasing the host unmounts header + conversation again.
      act(() => {
        releaseHost();
        detachedHost.remove();
      });

      expect(
        detachedHost.querySelector('[data-testid="right-panel-branch-header"]')
      ).toBeNull();
      expect(
        detachedHost.querySelector(
          '[data-testid="right-panel-conversation-view"]'
        )
      ).toBeNull();

      view.unmount();
    } finally {
      unregisterStageHost();
      stageCreationHost.remove();
    }
  });

  it('also suppresses detached rendering when portaled as a sibling outside RightPanelSlotContext.Provider (IDELayout portal topology)', () => {
    const detachedHost = document.createElement('div');

    render(
      <TestHarness>
        <>
          <RightPanelSlotContext.Provider
            value={{ host: detachedHost, placement: 'workspace' }}
          >
            <div data-testid="stage-sibling" />
          </RightPanelSlotContext.Provider>
          {createPortal(<RightPanelContent />, detachedHost)}
        </>
      </TestHarness>
    );

    expect(
      detachedHost.querySelector('[data-testid="right-panel-branch-header"]')
    ).toBeNull();
    expect(
      detachedHost.querySelector(
        '[data-testid="right-panel-conversation-view"]'
      )
    ).toBeNull();

    let releaseHost!: () => void;
    act(() => {
      document.body.appendChild(detachedHost);
      releaseHost = retainRightPanelHost(detachedHost);
    });

    expect(
      detachedHost.querySelector(
        '[data-testid="right-panel-conversation-view"]'
      )
    ).not.toBeNull();

    act(() => {
      releaseHost();
      detachedHost.remove();
    });

    expect(
      detachedHost.querySelector(
        '[data-testid="right-panel-conversation-view"]'
      )
    ).toBeNull();
  });

  it('excludes workspaces belonging to another project from creation options and createProject requests', async () => {
    projectState.projectId = 'project-b';
    projectState.project = { id: 'project-b', is_git: true };
    worktreeState.activeWorktreeId = 'workspace-a';
    kanbanSessionState.visibleRightSession = null;
    kanbanSessionState.lastActiveWorkspaceId = 'workspace-a';
    projectWorktreesState.worktrees = [
      {
        workspace: {
          id: 'workspace-b',
          project_id: 'project-b',
          branch: 'main',
          is_root: true,
        },
      },
    ];
    useTaskAttemptMock.mockImplementation((workspaceId?: string) =>
      workspaceId === 'workspace-a'
        ? {
            data: {
              id: 'workspace-a',
              project_id: 'project-a',
              branch: 'feature/from-project-a',
              is_root: false,
            },
          }
        : { data: undefined }
    );

    const createProjectSpy = vi
      .spyOn(sessionsApi, 'createProject')
      .mockResolvedValue({
        id: 'session-new',
        workspace_id: 'workspace-b',
        executor: 'CLAUDE_CODE',
      } as never);

    try {
      render(
        <TestHarness initialEntry="/projects/project-b">
          <RightPanelContent />
        </TestHarness>
      );

      act(() => {
        requestWorkspaceCreateSessionOverlay();
      });

      expect(screen.getByTestId('session-creation-form')).toBeInTheDocument();
      const lastCall =
        sessionCreationFormSpy.mock.calls[
          sessionCreationFormSpy.mock.calls.length - 1
        ]?.[0];
      expect(lastCall?.workspaceBranchOptions).toHaveLength(1);
      expect(lastCall?.workspaceBranchOptions?.[0]).toEqual(
        expect.objectContaining({
          existingWorkspaceId: 'workspace-b',
          branch: 'main',
        })
      );

      fireEvent.click(screen.getByRole('button', { name: 'submit-create' }));

      await waitFor(() => {
        expect(createProjectSpy).toHaveBeenCalledTimes(1);
      });
      expect(createProjectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 'project-b',
          workspace_id: 'workspace-b',
        })
      );
    } finally {
      createProjectSpy.mockRestore();
    }
  });

  it('ignores cross-project createSessionMutation completion after switching projects while still invalidating origin project queries', async () => {
    projectState.projectId = 'project-a';
    projectState.project = { id: 'project-a', is_git: false };
    worktreeState.activeWorktreeId = 'workspace-a';
    kanbanSessionState.visibleRightSession = null;
    kanbanSessionState.lastActiveWorkspaceId = 'workspace-a';
    kanbanSessionState.activateExecutionSession.mockReset();
    kanbanSessionState.placeCreatedSession.mockReset();
    openSessionTabMock.mockReset();

    let resolveCreate!: (value: unknown) => void;
    const createProjectSpy = vi
      .spyOn(sessionsApi, 'createProject')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }) as never
      );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const renderWithClient = (entry: string) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route
              path="/projects/:projectId"
              element={<RightPanelContent />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    try {
      const view = render(renderWithClient('/projects/project-a'));

      act(() => {
        requestWorkspaceCreateSessionOverlay();
      });
      expect(screen.getByTestId('session-creation-form')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'submit-create' }));
      await waitFor(() => {
        expect(createProjectSpy).toHaveBeenCalledTimes(1);
      });

      // Switch to project-b before project-a creation settles
      projectState.projectId = 'project-b';
      projectState.project = { id: 'project-b', is_git: false };
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/projects/project-a']}>
            <Routes>
              <Route
                path="/projects/:projectId"
                element={<RightPanelContent />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );

      await act(async () => {
        resolveCreate({
          id: 'session-from-a',
          workspace_id: 'workspace-a',
          executor: 'CLAUDE_CODE',
        });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({
          queryKey: ['projectWorktrees', 'project-a'],
        });
      });
      expect(invalidateSpy).not.toHaveBeenCalledWith({
        queryKey: ['projectWorktrees', 'project-b'],
      });
      expect(
        kanbanSessionState.activateExecutionSession
      ).not.toHaveBeenCalled();
      expect(kanbanSessionState.placeCreatedSession).not.toHaveBeenCalled();
      expect(openSessionTabMock).not.toHaveBeenCalled();
    } finally {
      createProjectSpy.mockRestore();
      invalidateSpy.mockRestore();
    }
  });

  it('does not reopen create overlay on the new project when a previous project session creation fails', async () => {
    projectState.projectId = 'project-a';
    projectState.project = { id: 'project-a', is_git: false };
    kanbanSessionState.visibleRightSession = null;

    let rejectCreate!: (error: Error) => void;
    const createProjectSpy = vi
      .spyOn(sessionsApi, 'createProject')
      .mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectCreate = reject;
          }) as never
      );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    try {
      const view = render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/projects/project-a']}>
            <Routes>
              <Route
                path="/projects/:projectId"
                element={<RightPanelContent />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );

      act(() => {
        requestWorkspaceCreateSessionOverlay();
      });
      fireEvent.click(screen.getByRole('button', { name: 'submit-create' }));
      await waitFor(() => {
        expect(createProjectSpy).toHaveBeenCalledTimes(1);
      });

      // Switch to project-b (which has an active session and closes the project-a overlay)
      projectState.projectId = 'project-b';
      projectState.project = { id: 'project-b', is_git: false };
      kanbanSessionState.visibleRightSession = {
        sessionId: 'session-b',
        workspaceId: 'workspace-b',
      };
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/projects/project-a']}>
            <Routes>
              <Route
                path="/projects/:projectId"
                element={<RightPanelContent />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );

      await waitFor(() => {
        expect(screen.queryByTestId('session-creation-form')).toBeNull();
      });

      await act(async () => {
        rejectCreate(new Error('project-a creation failed'));
        await Promise.resolve();
      });

      expect(screen.queryByTestId('session-creation-form')).toBeNull();
    } finally {
      createProjectSpy.mockRestore();
    }
  });

  it('defaults new sessions to the last created session agent and ignores canceled selections', async () => {
    projectState.projectId = 'project-1';
    projectState.project = { id: 'project-1', is_git: false };
    selectableAgentsState.agents = [
      {
        agentId: 'CLAUDE_CODE',
        displayName: 'Claude Code',
        iconLight: null,
        iconDark: null,
        iconSvg: null,
        enabled: true,
        lifecycle: 'ready',
        runnable: true,
        settingsFeatures: [],
      },
      {
        agentId: 'codex',
        displayName: 'Codex',
        iconLight: null,
        iconDark: null,
        iconSvg: null,
        enabled: true,
        lifecycle: 'ready',
        runnable: true,
        settingsFeatures: [],
      },
    ];

    const createProjectSpy = vi
      .spyOn(sessionsApi, 'createProject')
      .mockResolvedValue({
        id: 'session-created',
        workspace_id: 'workspace-1',
        executor: 'codex',
      } as never);

    try {
      render(
        <TestHarness initialEntry="/projects/project-1">
          <RightPanelContent />
        </TestHarness>
      );

      // Initially falls back to user's configured default agent.
      act(() => {
        requestWorkspaceCreateSessionOverlay();
      });
      expect(screen.getByTestId('session-creation-form')).toHaveAttribute(
        'data-selected-agent',
        'CLAUDE_CODE'
      );

      // Selecting codex and canceling does NOT update the remembered agent.
      fireEvent.click(screen.getByRole('button', { name: 'select-codex' }));
      expect(screen.getByTestId('session-creation-form')).toHaveAttribute(
        'data-selected-agent',
        'codex'
      );
      fireEvent.click(screen.getByRole('button', { name: 'cancel-create' }));
      expect(getLastSessionAgent()).toBeNull();

      // Reopening still uses user's default agent.
      act(() => {
        requestWorkspaceCreateSessionOverlay();
      });
      expect(screen.getByTestId('session-creation-form')).toHaveAttribute(
        'data-selected-agent',
        'CLAUDE_CODE'
      );

      // Selecting codex and creating a session remembers codex.
      fireEvent.click(screen.getByRole('button', { name: 'select-codex' }));
      fireEvent.click(screen.getByRole('button', { name: 'submit-create' }));
      await waitFor(() => {
        expect(createProjectSpy).toHaveBeenCalledWith(
          expect.objectContaining({ executor: 'codex' })
        );
      });
      await waitFor(() => {
        expect(getLastSessionAgent()).toBe('codex');
      });

      // Next time the create overlay opens, codex is selected by default.
      act(() => {
        requestWorkspaceCreateSessionOverlay();
      });
      expect(screen.getByTestId('session-creation-form')).toHaveAttribute(
        'data-selected-agent',
        'codex'
      );
    } finally {
      createProjectSpy.mockRestore();
    }
  });

  it('falls back to the user default agent when the remembered agent is unavailable', () => {
    projectState.projectId = 'project-1';
    projectState.project = { id: 'project-1', is_git: false };
    recordLastSessionAgent('codex');
    selectableAgentsState.agents = [
      {
        agentId: 'CLAUDE_CODE',
        displayName: 'Claude Code',
        iconLight: null,
        iconDark: null,
        iconSvg: null,
        enabled: true,
        lifecycle: 'ready',
        runnable: true,
        settingsFeatures: [],
      },
      {
        agentId: 'codex',
        displayName: 'Codex',
        iconLight: null,
        iconDark: null,
        iconSvg: null,
        enabled: false,
        lifecycle: 'ready',
        runnable: false,
        settingsFeatures: [],
      },
    ];

    render(
      <TestHarness initialEntry="/projects/project-1">
        <RightPanelContent />
      </TestHarness>
    );

    act(() => {
      requestWorkspaceCreateSessionOverlay();
    });
    expect(screen.getByTestId('session-creation-form')).toHaveAttribute(
      'data-selected-agent',
      'CLAUDE_CODE'
    );
  });
});
