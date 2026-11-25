import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Context,
  type ReactNode,
} from 'react';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { getProjectScopeKey } from '@/lib/projectScope';
import {
  activateSessionInExecutionArea,
  createEmptyKanbanSessionLayoutState,
  placeCreatedSession,
  placeForkedChild,
  placeSessionFromList,
  promoteMonitorSessionToRight,
  pruneUnavailableSessions,
  removeMonitorSession,
  replaceRightSession,
  sessionLayoutForWorkspaceChange,
  type KanbanSessionLayoutState,
  type KanbanSessionPlacement,
} from '@/lib/kanbanSessionLayout';
import { type KanbanPanelView } from '@/lib/kanbanPanelView';
import {
  DEFAULT_KANBAN_VIEW_ID,
  legacyKanbanPanelView,
  migrateKanbanViewId,
  viewIdForBoardStyleChange,
} from '@/lib/kanbanViews';
import {
  getKanbanBoardStyle,
  useKanbanBoardStyle,
} from '@/lib/kanbanBoardStyle';
import { shouldRevealKanbanMonitorOnPlacement } from '@/lib/kanbanZoneVisibility';
import { useProjectViewStateStore } from '@/stores/useProjectViewStateStore';

interface KanbanSessionContextValue {
  panelView: KanbanPanelView;
  activeViewId: string;
  setActiveViewId: (viewId: string) => void;
  setPanelView: (view: KanbanPanelView) => void;
  goToBoard: () => void;
  goToSessionHub: () => void;
  goToUsageDashboard: () => void;
  isSessionHubVisible: boolean;
  setSessionHubVisible: (visible: boolean) => void;
  toggleSessionHub: () => void;
  rightSession: KanbanSessionPlacement | null;
  visibleRightSession: KanbanSessionPlacement | null;
  isRightSessionPending: boolean;
  monitorSessions: KanbanSessionPlacement[];
  lastActiveWorkspaceId: string | null;
  canUseRightPanelForSessions: boolean;
  isLayoutHydrated: boolean;
  openSessionFromList: (session: KanbanSessionPlacement) => void;
  placeCreatedSession: (session: KanbanSessionPlacement) => void;
  placeForkedChild: (
    session: KanbanSessionPlacement,
    parentSessionId: string | null
  ) => void;
  replaceRightSession: (session: KanbanSessionPlacement) => void;
  activateExecutionSession: (session: KanbanSessionPlacement) => void;
  promoteMonitorSession: (sessionId: string) => void;
  cancelMonitorSession: (sessionId: string) => void;
  pruneSessions: (
    availableSessionIds: Set<string>,
    knownWorkspaceIds?: Set<string>
  ) => void;
}

const GLOBAL_KANBAN_SESSION_CONTEXT_KEY =
  '__DIMO_KANBAN_SESSION_CONTEXT__' as const;
const globalKanbanSessionScope = globalThis as typeof globalThis & {
  [GLOBAL_KANBAN_SESSION_CONTEXT_KEY]?: Context<KanbanSessionContextValue | null>;
};

const KanbanSessionContext: Context<KanbanSessionContextValue | null> =
  globalKanbanSessionScope[GLOBAL_KANBAN_SESSION_CONTEXT_KEY] ??
  (globalKanbanSessionScope[GLOBAL_KANBAN_SESSION_CONTEXT_KEY] =
    createContext<KanbanSessionContextValue | null>(null));

interface ProjectKanbanState {
  projectKey: string;
  panelView: KanbanPanelView;
  activeViewId: string;
  layoutState: KanbanSessionLayoutState;
  lastActiveWorkspaceId: string | null;
}

function readProjectKanbanState(
  projectKey: string,
  hasProject: boolean
): ProjectKanbanState {
  const style = getKanbanBoardStyle();
  if (!hasProject) {
    const viewId = viewIdForBoardStyleChange(style, DEFAULT_KANBAN_VIEW_ID);
    return {
      projectKey,
      panelView: legacyKanbanPanelView(viewId),
      activeViewId: viewId,
      layoutState: createEmptyKanbanSessionLayoutState(),
      lastActiveWorkspaceId: null,
    };
  }
  const stored = useProjectViewStateStore
    .getState()
    .getKanbanState(projectKey);
  const migrated =
    stored.activeViewId ?? migrateKanbanViewId(stored.panelView, style);
  const viewId = viewIdForBoardStyleChange(style, migrated);
  return {
    projectKey,
    panelView: legacyKanbanPanelView(viewId),
    activeViewId: viewId,
    layoutState: stored.layoutState,
    lastActiveWorkspaceId: stored.lastActiveWorkspaceId,
  };
}

export function KanbanSessionProvider({ children }: { children: ReactNode }) {
  const { projectId } = useProject();
  const hasProject = Boolean(projectId);
  const projectKey = getProjectScopeKey(projectId);
  const { activeWorktreeId } = useWorktree();
  const {
    data: activeWorkspaceWithSession,
    isLoading: isActiveWorkspaceLoading,
    isError: isActiveWorkspaceError,
  } = useTaskAttemptWithSession(activeWorktreeId ?? undefined);
  const isKanbanSessionVisible = useLayoutStore(
    (state) => state.isKanbanSessionVisible
  );
  const boardStyle = useKanbanBoardStyle();

  const [projectState, setProjectState] = useState<ProjectKanbanState>(() =>
    readProjectKanbanState(projectKey, hasProject)
  );

  // Swap project-scoped state synchronously during render so children (e.g.
  // Toolbar, RightPanelContent) never observe or navigate using the previous
  // project's session/workspace before passive effects run.
  let currentProjectState = projectState;
  if (projectState.projectKey !== projectKey) {
    currentProjectState = readProjectKanbanState(projectKey, hasProject);
    setProjectState(currentProjectState);
  }

  const { panelView, activeViewId, layoutState, lastActiveWorkspaceId } =
    currentProjectState;

  const updateCurrentProjectState = useCallback(
    (updater: (current: ProjectKanbanState) => ProjectKanbanState) => {
      setProjectState((current) => {
        const base =
          current.projectKey === projectKey
            ? current
            : readProjectKanbanState(projectKey, hasProject);
        return updater(base);
      });
    },
    [hasProject, projectKey]
  );

  // Derived state for backward compatibility
  const isSessionHubVisible = panelView === 'sessionHub';

  useEffect(() => {
    if (!projectId) {
      useProjectViewStateStore.getState().resetKanbanState(projectKey);
      return;
    }
    useProjectViewStateStore.getState().setKanbanState(projectKey, {
      panelView,
      activeViewId,
      layoutState,
      lastActiveWorkspaceId,
    });
  }, [
    projectId,
    projectKey,
    panelView,
    activeViewId,
    layoutState,
    lastActiveWorkspaceId,
  ]);

  const activeWorkspaceBelongsToAnotherProject = Boolean(
    projectId &&
      activeWorkspaceWithSession?.project_id &&
      activeWorkspaceWithSession.project_id !== projectId
  );

  useEffect(() => {
    if (!activeWorktreeId || activeWorkspaceBelongsToAnotherProject) return;
    updateCurrentProjectState((current) =>
      current.lastActiveWorkspaceId === activeWorktreeId
        ? current
        : { ...current, lastActiveWorkspaceId: activeWorktreeId }
    );
  }, [
    activeWorkspaceBelongsToAnotherProject,
    activeWorktreeId,
    updateCurrentProjectState,
  ]);

  useEffect(() => {
    updateCurrentProjectState((current) => {
      const next = viewIdForBoardStyleChange(boardStyle, current.activeViewId);
      if (next === current.activeViewId) {
        return current;
      }
      return {
        ...current,
        activeViewId: next,
        panelView: legacyKanbanPanelView(next),
      };
    });
  }, [boardStyle, updateCurrentProjectState]);

  const setActiveViewId = useCallback(
    (viewId: string) => {
      updateCurrentProjectState((current) => ({
        ...current,
        activeViewId: viewId,
        panelView: legacyKanbanPanelView(viewId),
      }));
    },
    [updateCurrentProjectState]
  );

  const setPanelView = useCallback(
    (view: KanbanPanelView) => {
      updateCurrentProjectState((current) => ({
        ...current,
        panelView: view,
        activeViewId: migrateKanbanViewId(view, getKanbanBoardStyle()),
      }));
    },
    [updateCurrentProjectState]
  );

  // A session already open in this workspace stays. A session that belongs
  // to another workspace leaves as soon as the workspace identity changes.
  useEffect(() => {
    if (
      !projectId ||
      !activeWorktreeId ||
      activeWorkspaceBelongsToAnotherProject
    ) {
      return;
    }

    const sessionId = activeWorkspaceWithSession?.session?.id;
    const nextSession = sessionId
      ? {
          sessionId,
          workspaceId: activeWorktreeId,
        }
      : null;

    updateCurrentProjectState((current) => {
      const nextLayout = sessionLayoutForWorkspaceChange(
        current.layoutState,
        activeWorktreeId,
        nextSession,
        {
          sessionKnown:
            !isActiveWorkspaceLoading && activeWorkspaceWithSession != null,
        }
      );
      return nextLayout === current.layoutState
        ? current
        : { ...current, layoutState: nextLayout };
    });
  }, [
    activeWorkspaceBelongsToAnotherProject,
    activeWorkspaceWithSession,
    activeWorktreeId,
    isActiveWorkspaceLoading,
    projectId,
    updateCurrentProjectState,
  ]);

  const canUseRightPanelForSessions = isKanbanSessionVisible;
  const isLayoutHydrated = currentProjectState.projectKey === projectKey;

  const goToBoard = useCallback(() => {
    setActiveViewId(DEFAULT_KANBAN_VIEW_ID);
  }, [setActiveViewId]);

  const goToSessionHub = useCallback(() => {
    setActiveViewId('builtin:canvas');
  }, [setActiveViewId]);

  const goToUsageDashboard = useCallback(() => {
    setActiveViewId('builtin:usage');
  }, [setActiveViewId]);

  const toggleSessionHub = useCallback(() => {
    updateCurrentProjectState((current) => {
      const next =
        current.activeViewId === 'builtin:canvas'
          ? DEFAULT_KANBAN_VIEW_ID
          : 'builtin:canvas';
      return {
        ...current,
        activeViewId: next,
        panelView: legacyKanbanPanelView(next),
      };
    });
  }, [updateCurrentProjectState]);

  const setSessionHubVisible = useCallback(
    (visible: boolean) => {
      setActiveViewId(visible ? 'builtin:canvas' : DEFAULT_KANBAN_VIEW_ID);
    },
    [setActiveViewId]
  );

  const commitLayoutState = useCallback(
    (
      updater: (current: KanbanSessionLayoutState) => KanbanSessionLayoutState
    ) => {
      updateCurrentProjectState((current) => {
        const next = updater(current.layoutState);
        if (
          shouldRevealKanbanMonitorOnPlacement(
            current.layoutState.monitorSessions.length,
            next.monitorSessions.length
          )
        ) {
          useLayoutStore.getState().setKanbanMonitorVisible(true);
        }
        return next === current.layoutState
          ? current
          : { ...current, layoutState: next };
      });
    },
    [updateCurrentProjectState]
  );

  const openSessionFromList = useCallback(
    (session: KanbanSessionPlacement) => {
      commitLayoutState((current) =>
        placeSessionFromList(current, session, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions, commitLayoutState]
  );

  const placeCreatedSessionInLayout = useCallback(
    (session: KanbanSessionPlacement) => {
      commitLayoutState((current) =>
        placeCreatedSession(current, session, {
          // Creating from the composer or overlay means the execution area is
          // already on screen. Gate on the kanban-zone flag would park the new
          // session in the monitor while the execution area keeps the old one.
          canUseRightPanel: true,
        })
      );
    },
    [commitLayoutState]
  );

  const placeForkedChildInLayout = useCallback(
    (session: KanbanSessionPlacement, parentSessionId: string | null) => {
      commitLayoutState((current) =>
        placeForkedChild(current, session, parentSessionId, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions, commitLayoutState]
  );

  const replaceRightSessionInLayout = useCallback(
    (session: KanbanSessionPlacement) => {
      commitLayoutState((current) =>
        replaceRightSession(current, session, {
          canUseRightPanel: true,
        })
      );
    },
    [commitLayoutState]
  );

  const activateExecutionSession = useCallback(
    (session: KanbanSessionPlacement) => {
      commitLayoutState((current) =>
        activateSessionInExecutionArea(current, session, {
          canUseRightPanel: true,
        })
      );
    },
    [commitLayoutState]
  );

  const promoteMonitorSession = useCallback(
    (sessionId: string) => {
      commitLayoutState((current) =>
        promoteMonitorSessionToRight(current, sessionId, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions, commitLayoutState]
  );

  const cancelMonitorSession = useCallback(
    (sessionId: string) => {
      commitLayoutState((current) => removeMonitorSession(current, sessionId));
    },
    [commitLayoutState]
  );

  const pruneSessions = useCallback(
    (availableSessionIds: Set<string>, knownWorkspaceIds?: Set<string>) => {
      commitLayoutState((current) =>
        pruneUnavailableSessions(current, availableSessionIds, {
          knownWorkspaceIds,
        })
      );
    },
    [commitLayoutState]
  );

  const visibleRightSession = useMemo<KanbanSessionPlacement | null>(() => {
    if (
      activeWorktreeId &&
      layoutState.rightSession &&
      layoutState.rightSession.workspaceId !== activeWorktreeId
    ) {
      return !activeWorkspaceBelongsToAnotherProject &&
        activeWorkspaceWithSession?.id === activeWorktreeId &&
        activeWorkspaceWithSession.session?.id
        ? {
            sessionId: activeWorkspaceWithSession.session.id,
            workspaceId: activeWorktreeId,
          }
        : null;
    }
    return layoutState.rightSession;
  }, [
    activeWorkspaceBelongsToAnotherProject,
    activeWorkspaceWithSession?.id,
    activeWorkspaceWithSession?.session?.id,
    activeWorktreeId,
    layoutState.rightSession,
  ]);
  const isRightSessionPending =
    !visibleRightSession &&
    !!activeWorktreeId &&
    !activeWorkspaceBelongsToAnotherProject &&
    !isActiveWorkspaceError &&
    (isActiveWorkspaceLoading ||
      typeof activeWorkspaceWithSession === 'undefined');

  const value = useMemo<KanbanSessionContextValue>(
    () => ({
      panelView,
      activeViewId,
      setActiveViewId,
      setPanelView,
      goToBoard,
      goToSessionHub,
      goToUsageDashboard,
      isSessionHubVisible,
      setSessionHubVisible,
      toggleSessionHub,
      rightSession: layoutState.rightSession,
      visibleRightSession,
      isRightSessionPending,
      monitorSessions: layoutState.monitorSessions,
      lastActiveWorkspaceId,
      canUseRightPanelForSessions,
      isLayoutHydrated,
      openSessionFromList,
      placeCreatedSession: placeCreatedSessionInLayout,
      placeForkedChild: placeForkedChildInLayout,
      replaceRightSession: replaceRightSessionInLayout,
      activateExecutionSession,
      promoteMonitorSession,
      cancelMonitorSession,
      pruneSessions,
    }),
    [
      panelView,
      activeViewId,
      setActiveViewId,
      setPanelView,
      goToBoard,
      goToSessionHub,
      goToUsageDashboard,
      isSessionHubVisible,
      canUseRightPanelForSessions,
      isLayoutHydrated,
      lastActiveWorkspaceId,
      setSessionHubVisible,
      layoutState.monitorSessions,
      layoutState.rightSession,
      openSessionFromList,
      placeCreatedSessionInLayout,
      placeForkedChildInLayout,
      replaceRightSessionInLayout,
      activateExecutionSession,
      promoteMonitorSession,
      cancelMonitorSession,
      pruneSessions,
      toggleSessionHub,
      visibleRightSession,
      isRightSessionPending,
    ]
  );

  return (
    <KanbanSessionContext.Provider value={value}>
      {children}
    </KanbanSessionContext.Provider>
  );
}

export function useKanbanSessionContext() {
  const context = useContext(KanbanSessionContext);
  if (!context) {
    throw new Error(
      'useKanbanSessionContext must be used within KanbanSessionProvider'
    );
  }
  return context;
}

export function useOptionalKanbanSessionContext() {
  return useContext(KanbanSessionContext);
}
