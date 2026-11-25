import { useEffect } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useNavigate,
} from 'react-router-dom';
import { ProjectProvider, useProject } from '@/contexts/ProjectContext';
import { WorktreeProvider } from '@/contexts/WorktreeContext';
import {
  KanbanSessionProvider,
  useKanbanSessionContext,
} from '@/contexts/KanbanSessionContext';
import { useProjectViewStateStore } from '@/stores/useProjectViewStateStore';
import { useLayoutStore } from '@/stores/useLayoutStore';

const { taskAttemptWithSessionMock } = vi.hoisted(() => ({
  taskAttemptWithSessionMock: vi.fn(),
}));

vi.mock('@/hooks/useProjects', () => {
  const projects = [
    {
      id: 'project-1',
      name: 'Project One',
      created_at: '2026-03-24T00:00:00.000Z',
    },
    {
      id: 'project-2',
      name: 'Project Two',
      created_at: '2026-03-25T00:00:00.000Z',
    },
  ];

  return {
    useProjects: () => ({
      projects,
      projectsById: Object.fromEntries(
        projects.map((project) => [project.id, project])
      ),
      isLoading: false,
      isConnected: true,
      error: null,
    }),
  };
});

vi.mock('@/hooks/useTaskAttempt', () => ({
  useTaskAttemptWithSession: (workspaceId?: string) =>
    taskAttemptWithSessionMock(workspaceId),
}));

interface EffectObservation {
  projectId: string | undefined;
  rightSessionWorkspaceId: string | null;
  rightSessionId: string | null;
  lastActiveWorkspaceId: string | null;
  isLayoutHydrated: boolean;
}

function KanbanProbe({
  onEffect,
}: {
  onEffect?: (observation: EffectObservation) => void;
}) {
  const { projectId } = useProject();
  const {
    rightSession,
    visibleRightSession,
    monitorSessions,
    lastActiveWorkspaceId,
    isLayoutHydrated,
  } = useKanbanSessionContext();

  useEffect(() => {
    onEffect?.({
      projectId,
      rightSessionWorkspaceId: rightSession?.workspaceId ?? null,
      rightSessionId: rightSession?.sessionId ?? null,
      lastActiveWorkspaceId,
      isLayoutHydrated,
    });
  }, [
    isLayoutHydrated,
    lastActiveWorkspaceId,
    onEffect,
    projectId,
    rightSession?.sessionId,
    rightSession?.workspaceId,
  ]);

  return (
    <>
      <div data-testid="right-session">
        {rightSession
          ? `${rightSession.workspaceId}:${rightSession.sessionId}`
          : 'none'}
      </div>
      <div data-testid="visible-right-session">
        {visibleRightSession
          ? `${visibleRightSession.workspaceId}:${visibleRightSession.sessionId}`
          : 'none'}
      </div>
      <div data-testid="monitor-count">{monitorSessions.length}</div>
      <div data-testid="last-workspace">{lastActiveWorkspaceId ?? 'none'}</div>
    </>
  );
}

describe('KanbanSessionProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useProjectViewStateStore.setState({
      worktreeByProject: {},
      kanbanByProject: {},
    });
    useLayoutStore.getState().resetLayout();
    taskAttemptWithSessionMock.mockReset();
    taskAttemptWithSessionMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });
  });

  it('swaps project state synchronously on project switch before child effects run', () => {
    useProjectViewStateStore.getState().setKanbanState('project-1', {
      panelView: 'board',
      activeViewId: 'builtin:board',
      layoutState: {
        rightSession: {
          workspaceId: 'workspace-a',
          sessionId: 'session-a',
        },
        monitorSessions: [
          {
            workspaceId: 'workspace-a',
            sessionId: 'session-a-monitor',
          },
        ],
      },
      lastActiveWorkspaceId: 'workspace-a',
    });

    const observations: EffectObservation[] = [];

    function SwitchButtons() {
      const navigate = useNavigate();
      return (
        <>
          <button
            type="button"
            onClick={() => navigate('/local-projects/project-2/sessions')}
          >
            to-project-2
          </button>
          <button
            type="button"
            onClick={() => navigate('/local-projects/project-1/sessions')}
          >
            to-project-1
          </button>
        </>
      );
    }

    render(
      <MemoryRouter
        initialEntries={[
          '/local-projects/project-1/workspaces/workspace-a/sessions/session-a',
        ]}
      >
        <Routes>
          <Route
            element={
              <ProjectProvider>
                <WorktreeProvider>
                  <KanbanSessionProvider>
                    <KanbanProbe
                      onEffect={(obs) => {
                        observations.push(obs);
                      }}
                    />
                    <SwitchButtons />
                    <Outlet />
                  </KanbanSessionProvider>
                </WorktreeProvider>
              </ProjectProvider>
            }
          >
            <Route path="/local-projects/:projectId/sessions" element={null} />
            <Route
              path="/local-projects/:projectId/workspaces/:workspaceId/sessions/:sessionId"
              element={null}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('right-session').textContent).toBe(
      'workspace-a:session-a'
    );
    expect(screen.getByTestId('monitor-count').textContent).toBe('1');
    expect(screen.getByTestId('last-workspace').textContent).toBe(
      'workspace-a'
    );

    fireEvent.click(screen.getByRole('button', { name: 'to-project-2' }));

    expect(screen.getByTestId('right-session').textContent).toBe('none');
    expect(screen.getByTestId('visible-right-session').textContent).toBe(
      'none'
    );
    expect(screen.getByTestId('monitor-count').textContent).toBe('0');
    expect(screen.getByTestId('last-workspace').textContent).toBe('none');

    // Child effects for project-2 must never have observed project-1's session/workspace.
    const project2Observations = observations.filter(
      (obs) => obs.projectId === 'project-2'
    );
    expect(project2Observations.length).toBeGreaterThan(0);
    for (const obs of project2Observations) {
      expect(obs.rightSessionWorkspaceId).toBeNull();
      expect(obs.rightSessionId).toBeNull();
      expect(obs.lastActiveWorkspaceId).toBeNull();
      expect(obs.isLayoutHydrated).toBe(true);
    }

    // Switching back to project-1 restores its persisted session state.
    fireEvent.click(screen.getByRole('button', { name: 'to-project-1' }));

    expect(screen.getByTestId('right-session').textContent).toBe(
      'workspace-a:session-a'
    );
    expect(screen.getByTestId('last-workspace').textContent).toBe(
      'workspace-a'
    );
  });

  it('ignores an active workspace that belongs to a different project', () => {
    taskAttemptWithSessionMock.mockImplementation((workspaceId?: string) => {
      if (workspaceId === 'workspace-a') {
        return {
          data: {
            id: 'workspace-a',
            project_id: 'project-1',
            session: { id: 'session-a' },
          },
          isLoading: false,
          isError: false,
        };
      }
      return {
        data: undefined,
        isLoading: false,
        isError: false,
      };
    });

    render(
      <MemoryRouter
        initialEntries={['/local-projects/project-2/workspaces/workspace-a']}
      >
        <Routes>
          <Route
            path="/local-projects/:projectId/workspaces/:workspaceId"
            element={
              <ProjectProvider>
                <WorktreeProvider>
                  <KanbanSessionProvider>
                    <KanbanProbe />
                  </KanbanSessionProvider>
                </WorktreeProvider>
              </ProjectProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('right-session').textContent).toBe('none');
    expect(screen.getByTestId('visible-right-session').textContent).toBe(
      'none'
    );
    expect(screen.getByTestId('last-workspace').textContent).toBe('none');
  });
});
