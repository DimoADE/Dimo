import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TFunction } from 'i18next';
import { SoundFile } from 'shared/types';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useProject } from '@/contexts/ProjectContext';
import { useProjects } from '@/hooks/useProjects';
import {
  useKanbanProjectSessions,
  type KanbanProjectSessionRecord,
} from '@/hooks/useKanbanProjectSessions';
import { useUserSystem } from '@/components/ConfigProvider';
import {
  attemptsApi,
  configApi,
  sessionsApi,
  type SessionSummary,
} from '@/lib/api';
import { showDesktopToast } from '@/lib/desktopToast';
import { backendListen } from '@/lib/backendTransport';
import { getDesktopShell, hasElectronDesktopRuntime } from '@/lib/desktopShell';
import { desktopApi } from '@/lib/api';
import {
  DESKTOP_OPEN_FILE_EVENT,
  enqueueDesktopOpenFiles,
  hasPendingDesktopOpenFiles,
  type DesktopOpenFilePayload,
} from '@/lib/desktopOpenFiles';
import { paths } from '@/lib/paths';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { useStopToastSuppression } from '@/stores/useTaskDetailsUiStore';
import { useOpenProjectSession } from '@/hooks/useOpenProjectSession';
import { deliverDesktopNotification } from './sessionCompletionNotification';

function getSessionStatusLabel(
  session: KanbanProjectSessionRecord,
  t: TFunction<['panels', 'common']>
) {
  if (session.isRunning) {
    return t('windowManager.statusRunning');
  }

  switch (session.status) {
    case 'done':
      return t('windowManager.statusDone');
    case 'inreview':
      return t('windowManager.statusInReview');
    case 'inprogress':
      return t('windowManager.statusInProgress');
    case 'todo':
      return t('windowManager.statusTodo');
    default:
      return t('windowManager.statusIdle');
  }
}

type ProjectSessionTarget = {
  projectId: string;
  workspaceId: string;
  sessionId: string;
};

type SessionAttentionKind =
  | 'permission'
  | 'question'
  | 'notice'
  | 'warning'
  | 'error'
  | 'completed';

type SessionAttentionPayload = ProjectSessionTarget & {
  turnId?: string | null;
  kind: SessionAttentionKind;
  title?: string | null;
  message?: string | null;
};

function buildTrackedProjectIds(
  currentProjectId: string | undefined,
  openProjectIds: string[],
  projectsById: Record<string, { id: string }>,
  includeAllProjects: boolean
) {
  return Array.from(
    new Set([
      ...(currentProjectId ? [currentProjectId] : []),
      ...openProjectIds,
      ...(includeAllProjects ? Object.keys(projectsById) : []),
    ])
  ).filter((trackedProjectId) => Boolean(projectsById[trackedProjectId]));
}

function attentionTitle(
  payload: SessionAttentionPayload,
  projectName: string,
  t: TFunction<['panels', 'common']>
) {
  const key =
    payload.kind === 'permission'
      ? 'windowManager.sessionPermissionTitle'
      : payload.kind === 'question'
        ? 'windowManager.sessionQuestionTitle'
        : payload.kind === 'warning' || payload.kind === 'notice'
          ? 'windowManager.sessionNoticeTitle'
          : payload.kind === 'error'
            ? 'windowManager.sessionFailedTitle'
            : 'windowManager.sessionCompletedTitle';
  return t(key, { project: projectName });
}

function resolveSummaryDisplayName(summary: SessionSummary, t: TFunction) {
  const manualName = summary.name?.trim();
  if (manualName) return manualName;

  const firstPrompt = summary.first_prompt?.replace(/\s+/g, ' ').trim() ?? '';
  if (firstPrompt.length > 0) {
    return Array.from(firstPrompt).slice(0, 8).join('');
  }

  return summary.display_name?.trim() || t('windowManager.sessionFallbackName');
}

function ProjectNotificationBridge() {
  const { t } = useTranslation(['panels', 'common']);
  const location = useLocation();
  const navigate = useNavigate();
  const { projectId: activeProjectId } = useProject();
  const { config } = useUserSystem();
  const { projectsById } = useProjects();
  const setProjectAlert = useWindowProjectsStore(
    (state) => state.setProjectAlert
  );
  const { consumeStopToastSuppression } = useStopToastSuppression();
  const latestNotificationStateRef = useRef({
    activeProjectId,
    config,
    projectsById,
    consumeStopToastSuppression,
    pathname: location.pathname,
    t,
  });
  latestNotificationStateRef.current = {
    activeProjectId,
    config,
    projectsById,
    consumeStopToastSuppression,
    pathname: location.pathname,
    t,
  };

  // Shared context-aware reveal: workspace execution area, kanban execution
  // area, or kanban canvas depending on where the main window currently is.
  const openProjectSession = useOpenProjectSession();

  const isApplicationCurrentlyFocused = useCallback(async () => {
    try {
      return await desktopApi.isMainWindowFocused();
    } catch {
      return (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        document.hasFocus()
      );
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let drainInFlight = false;
    const liveKeysBeforeDrain = new Set<string>();
    let recentDrainedActivation: { key: string; at: number } | null = null;

    const activationKey = (target: ProjectSessionTarget) =>
      `${target.projectId}:${target.workspaceId}:${target.sessionId}`;

    const handleLiveActivation = (target: ProjectSessionTarget) => {
      if (cancelled) return;
      const key = activationKey(target);
      if (drainInFlight) {
        liveKeysBeforeDrain.add(key);
      }
      if (
        recentDrainedActivation &&
        recentDrainedActivation.key === key &&
        Date.now() - recentDrainedActivation.at < 1_000
      ) {
        recentDrainedActivation = null;
        return;
      }
      openProjectSession(target);
    };

    void backendListen<ProjectSessionTarget>(
      'desktop-toast-activated',
      handleLiveActivation
    )
      .then((dispose) => {
        if (cancelled) {
          dispose();
          return;
        }
        unlisten = dispose;
        if (!hasElectronDesktopRuntime()) {
          return;
        }
        drainInFlight = true;
        void getDesktopShell()
          .invoke<ProjectSessionTarget | null>(
            'take_pending_desktop_toast_activation'
          )
          .catch(() => null)
          .then((pending) => {
            drainInFlight = false;
            if (
              cancelled ||
              !pending ||
              !pending.projectId ||
              !pending.workspaceId ||
              !pending.sessionId
            ) {
              return;
            }
            const key = activationKey(pending);
            if (liveKeysBeforeDrain.has(key)) {
              return;
            }
            recentDrainedActivation = { key, at: Date.now() };
            openProjectSession(pending);
          });
      })
      .catch(() => {
        // Ignore listener registration errors outside the desktop shell.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openProjectSession]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let drainInFlight = false;
    const livePathsBeforeDrain = new Set<string>();
    const recentDrainedPaths = new Map<string, number>();

    const normalizeIncomingPaths = (rawPaths: unknown): string[] => {
      if (!Array.isArray(rawPaths)) {
        return [];
      }
      return rawPaths
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    };

    const dispatchOpenFiles = (filePaths: string[]) => {
      if (filePaths.length === 0) {
        return;
      }
      enqueueDesktopOpenFiles(filePaths);
      if (!hasPendingDesktopOpenFiles()) {
        return;
      }
      const { pathname, activeProjectId: currentProjectId } =
        latestNotificationStateRef.current;
      const isOutsideWorkspace =
        pathname.startsWith('/workflows/') || pathname.endsWith('/full');
      if (isOutsideWorkspace) {
        navigate(
          currentProjectId ? paths.projectSessions(currentProjectId) : '/'
        );
      }
    };

    const handleLiveOpenFiles = (payload: DesktopOpenFilePayload) => {
      if (cancelled) return;
      const now = Date.now();
      const incoming = normalizeIncomingPaths(payload?.paths);
      const filtered: string[] = [];
      for (const filePath of incoming) {
        if (drainInFlight) {
          livePathsBeforeDrain.add(filePath);
        }
        const drainedAt = recentDrainedPaths.get(filePath);
        if (drainedAt !== undefined) {
          recentDrainedPaths.delete(filePath);
          if (now - drainedAt < 1_000) {
            continue;
          }
        }
        filtered.push(filePath);
      }
      dispatchOpenFiles(filtered);
    };

    void backendListen<DesktopOpenFilePayload>(
      DESKTOP_OPEN_FILE_EVENT,
      handleLiveOpenFiles
    )
      .then((dispose) => {
        if (cancelled) {
          dispose();
          return;
        }
        unlisten = dispose;
        if (!hasElectronDesktopRuntime()) {
          return;
        }
        drainInFlight = true;
        void getDesktopShell()
          .invoke<string[]>('take_pending_open_files')
          .catch(() => [] as string[])
          .then((pending) => {
            drainInFlight = false;
            if (cancelled) {
              return;
            }
            const now = Date.now();
            const remaining = normalizeIncomingPaths(pending).filter(
              (filePath) => !livePathsBeforeDrain.has(filePath)
            );
            for (const filePath of remaining) {
              recentDrainedPaths.set(filePath, now);
            }
            dispatchOpenFiles(remaining);
          });
      })
      .catch(() => {
        // Ignore listener registration errors outside the desktop shell.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [navigate]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    backendListen<SessionAttentionPayload>(
      'desktop-session-attention',
      (payload) => {
        void sessionsApi
          .getSummariesByWorkspace(payload.workspaceId)
          .then(async (summaries) => {
            if (cancelled) return;
            const sessionSummary = summaries.find(
              (summary) => summary.id === payload.sessionId
            );
            if (!sessionSummary) {
              console.error(
                `Session ${payload.sessionId} was not found in workspace ${payload.workspaceId}`
              );
              return;
            }

            const latest = latestNotificationStateRef.current;
            const projectName =
              latest.projectsById[payload.projectId]?.name ??
              latest.t('windowManager.projectFallbackName');
            const title = attentionTitle(payload, projectName, latest.t);
            const sessionName = resolveSummaryDisplayName(
              sessionSummary,
              latest.t
            );
            const workspaceName =
              sessionSummary.workspace_name ?? payload.workspaceId;
            const description =
              payload.message?.trim() ||
              payload.title?.trim() ||
              `${sessionName} · ${workspaceName}`;
            const windowFocused = await isApplicationCurrentlyFocused();
            if (cancelled) return;

            setProjectAlert({
              projectId: payload.projectId,
              workspaceId: payload.workspaceId,
              sessionId: sessionSummary.id,
              taskId: sessionSummary.task_id,
              kind: payload.kind === 'completed' ? 'success' : 'error',
              unread:
                payload.projectId !== latest.activeProjectId || !windowFocused,
              createdAt: sessionSummary.updated_at,
              title,
              description,
            });

            if (
              payload.kind === 'completed' &&
              latest.consumeStopToastSuppression(payload.workspaceId)
            ) {
              return;
            }

            void deliverDesktopNotification({
              windowFocused,
              notifyWhen:
                latest.config?.notifications.notify_when ?? 'unfocused',
              soundEnabled: latest.config?.notifications.sound_enabled ?? false,
              soundFile:
                latest.config?.notifications.sound_file ??
                SoundFile.ABSTRACT_SOUND1,
              pushEnabled: latest.config?.notifications.push_enabled ?? false,
              playSound: configApi.playNotificationSound,
              showPush: () =>
                showDesktopToast({
                  projectId: payload.projectId,
                  workspaceId: payload.workspaceId,
                  sessionId: sessionSummary.id,
                  title,
                  description,
                  kind: payload.kind === 'completed' ? 'success' : 'error',
                  durationMs: 15000,
                }),
            }).catch((error) => {
              console.error(
                'Failed to deliver session attention notification:',
                error
              );
            });
          })
          .catch((error) => {
            console.error(
              'Failed to load session summary for desktop toast notification:',
              error
            );
          });
      }
    ).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isApplicationCurrentlyFocused, setProjectAlert]);

  return null;
}

function ProjectActivityTracker({
  projectId,
  isActive,
}: {
  projectId: string;
  isActive: boolean;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const { sessions, isLoading, sessionsResolved } =
    useKanbanProjectSessions(projectId);
  const setProjectSnapshot = useWindowProjectsStore(
    (state) => state.setProjectSnapshot
  );
  const markProjectAlertRead = useWindowProjectsStore(
    (state) => state.markProjectAlertRead
  );
  const projectAlert = useWindowProjectsStore(
    (state) => state.projectAlerts[projectId]
  );
  const previousSnapshotSignatureRef = useRef<string>('');

  const snapshot = useMemo(() => {
    const recentSessions = sessions.slice(0, 5).map((session) => {
      const visualState = session.isRunning
        ? 'loading'
        : session.isErrored
          ? 'error'
          : session.status === 'done' || session.status === 'inreview'
            ? 'success'
            : 'idle';

      return {
        sessionId: session.id,
        workspaceId: session.workspace.id,
        taskId: session.taskId,
        title: session.fullName,
        subtitle: session.workspaceDisplayLabel,
        statusLabel: getSessionStatusLabel(session, t),
        visualState,
        updatedAt: session.updatedAt,
      } as const;
    });

    return {
      isLoading,
      hasRunning: sessions.some((session) => session.isRunning),
      runningCount: sessions.filter((session) => session.isRunning).length,
      hasError: sessions.some((session) => session.isErrored),
      hasSessions: sessions.length > 0,
      recentSessions,
    };
  }, [isLoading, sessions, t]);

  useEffect(() => {
    const nextSignature = `${sessionsResolved ? '1' : '0'}:${JSON.stringify(snapshot)}`;
    if (previousSnapshotSignatureRef.current === nextSignature) {
      return;
    }

    previousSnapshotSignatureRef.current = nextSignature;
    if (!sessionsResolved && snapshot.recentSessions.length === 0) {
      const previous =
        useWindowProjectsStore.getState().projectSnapshots[projectId];
      if (previous?.recentSessions.length) {
        return;
      }
    }
    setProjectSnapshot(projectId, snapshot);
  }, [projectId, sessionsResolved, setProjectSnapshot, snapshot]);

  useEffect(() => {
    if (isActive && projectAlert?.unread) {
      markProjectAlertRead(projectId);
      void attemptsApi.markSeen(projectAlert.workspaceId).catch(() => {
        // Ignore passive sync failures.
      });
    }
  }, [isActive, markProjectAlertRead, projectAlert, projectId]);

  return null;
}

export function ProjectWindowManager() {
  const location = useLocation();
  const { projectId } = useProject();
  const {
    projects,
    projectsById,
    isLoading: isProjectsLoading,
  } = useProjects();
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const rememberProjectRoute = useWindowProjectsStore(
    (state) => state.rememberProjectRoute
  );
  const openProjectIds = useWindowProjectsStore(
    (state) => state.openProjectIds
  );
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const removedProjectIds = useWindowProjectsStore(
    (state) => state.removedProjectIds
  );
  const pruneProjectState = useWindowProjectsStore(
    (state) => state.pruneProjectState
  );
  const isAppManagementRoute =
    location.pathname.startsWith('/settings') ||
    location.pathname.startsWith('/plugins');
  const shouldManageProjectWindows = !isAppManagementRoute;

  useEffect(() => {
    if (
      !shouldManageProjectWindows ||
      !projectId ||
      removedProjectIds[projectId]
    ) {
      return;
    }

    ensureProjectOpen(projectId);
    rememberProjectRoute(
      projectId,
      `${location.pathname}${location.search}${location.hash}`
    );
  }, [
    ensureProjectOpen,
    location.hash,
    location.pathname,
    location.search,
    projectId,
    rememberProjectRoute,
    removedProjectIds,
    shouldManageProjectWindows,
  ]);

  useEffect(() => {
    if (
      !shouldManageProjectWindows ||
      isProjectsLoading ||
      projects.length === 0
    ) {
      return;
    }

    pruneProjectState(projects.map((project) => project.id));
  }, [
    isProjectsLoading,
    projects,
    pruneProjectState,
    shouldManageProjectWindows,
  ]);

  const trackedProjectIds = useMemo(() => {
    if (!shouldManageProjectWindows) {
      return [];
    }

    return buildTrackedProjectIds(
      projectId,
      openProjectIds,
      projectsById,
      false
    );
  }, [openProjectIds, projectId, projectsById, shouldManageProjectWindows]);

  const effectiveTrackedProjectIds = useMemo(() => {
    if (!shouldManageProjectWindows) {
      return trackedProjectIds;
    }

    return railVisible
      ? buildTrackedProjectIds(projectId, openProjectIds, projectsById, true)
      : trackedProjectIds;
  }, [
    openProjectIds,
    projectId,
    projectsById,
    railVisible,
    shouldManageProjectWindows,
    trackedProjectIds,
  ]);

  return (
    <>
      <ProjectNotificationBridge />
      {effectiveTrackedProjectIds.map((trackedProjectId) => (
        <ProjectActivityTracker
          key={trackedProjectId}
          projectId={trackedProjectId}
          isActive={trackedProjectId === projectId}
        />
      ))}
    </>
  );
}
