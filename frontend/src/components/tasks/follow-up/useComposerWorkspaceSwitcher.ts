import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
} from 'react-router-dom';
import type { GitBranch, Repo, Session, Workspace } from 'shared/types';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { deriveWorkspaceRootPath } from '@/components/panels/workspaceRootPath';
import { toast } from '@/components/ui/toast';
import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { useOptionalWorktree } from '@/contexts/WorktreeContext';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { attemptsApi, sessionsApi } from '@/lib/api';
import { paths } from '@/lib/paths';
import {
  buildBranchSegment,
  orderWorkspacesForSelector,
  type BranchSegmentEntry,
} from '@/lib/workspaceBranchSegment';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import {
  createWorkspaceWithSession,
  type WorkspaceWithSession,
} from '@/types/attempt';

export interface ComposerWorkspaceOption {
  id: string;
  workspace: Workspace;
  label: string;
  branchLabel: string | null;
  isWorktree: boolean;
  isSelected: boolean;
  copyPath: string | null;
}

export interface ComposerWorkspaceSwitcherConfig {
  workspaces: ComposerWorkspaceOption[];
  branches: BranchSegmentEntry[];
  canSwitchBranch: boolean;
  canEnsureDefaultDirectory: boolean;
  defaultDirectoryLabel: string;
  defaultDirectoryBranch: string | null;
  isSwitching: boolean;
  disabled: boolean;
  onSelectWorkspace: (workspace: Workspace) => void | Promise<void>;
  onSelectDefaultDirectory?: () => void | Promise<void>;
  onSelectBranch?: (entry: BranchSegmentEntry) => void | Promise<void>;
}

function switcherErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
}

export function useComposerWorkspaceSwitcher({
  isGitDirectory = true,
  projectId,
  projectName,
  session,
  sessionId,
  workspace,
  workspaceId,
  primaryRepo,
  primaryRepoBranches,
  workspaceRepoNames,
  mainDirectoryBranch,
  currentBranchName,
  disabled = false,
}: {
  isGitDirectory?: boolean;
  projectId?: string;
  projectName?: string | null;
  session?: Session;
  sessionId?: string;
  workspace?: Workspace;
  workspaceId?: string;
  primaryRepo?: Pick<Repo, 'id' | 'name' | 'path' | 'default_target_branch'>;
  primaryRepoBranches: GitBranch[];
  workspaceRepoNames: Array<{ name: string; path?: string | null }>;
  mainDirectoryBranch: string | null;
  currentBranchName: string | null;
  disabled?: boolean;
}): ComposerWorkspaceSwitcherConfig | null {
  const { t } = useTranslation(['conversation', 'panels']);
  const queryClient = useQueryClient();
  const worktree = useOptionalWorktree();
  const kanbanSession = useOptionalKanbanSessionContext();
  const panelActions = useOptionalPanelActionsContext();
  const navContext = useContext(UNSAFE_NavigationContext);
  const locationContext = useContext(UNSAFE_LocationContext);

  const { worktrees } = useProjectWorktrees(
    isGitDirectory ? projectId : undefined
  );
  const [isSwitching, setIsSwitching] = useState(false);
  const switchLockRef = useRef(false);

  const currentWorkspaceId = workspaceId ?? workspace?.id ?? null;

  const selectorWorkspaces = useMemo(() => {
    const nextWorkspaces = worktrees.map((item) => item.workspace);
    if (workspace && !nextWorkspaces.some((item) => item.id === workspace.id)) {
      nextWorkspaces.unshift(workspace);
    }
    return orderWorkspacesForSelector(
      nextWorkspaces,
      currentWorkspaceId ?? undefined
    );
  }, [currentWorkspaceId, workspace, worktrees]);

  const projectRootWorkspace = useMemo(
    () => selectorWorkspaces.find((item) => !item.use_worktree) ?? null,
    [selectorWorkspaces]
  );

  const activeWorkspace = useMemo(
    () =>
      selectorWorkspaces.find((item) => item.id === currentWorkspaceId) ??
      workspace ??
      null,
    [currentWorkspaceId, selectorWorkspaces, workspace]
  );
  const inWorktree = Boolean(activeWorkspace?.use_worktree);

  const defaultDirectoryLabel =
    projectName?.trim() || t('conversation:composerContext.defaultDirectory');

  const workspaceOptions = useMemo<ComposerWorkspaceOption[]>(
    () =>
      selectorWorkspaces.map((item) => {
        const isWorktreeItem = Boolean(item.use_worktree);
        const branchLabel = isWorktreeItem
          ? item.branch?.trim() || null
          : mainDirectoryBranch || item.branch?.trim() || null;
        const label = isWorktreeItem
          ? branchLabel ||
            item.name?.trim() ||
            t('conversation:composerContext.worktree')
          : defaultDirectoryLabel;
        return {
          id: item.id,
          workspace: item,
          label,
          branchLabel,
          isWorktree: isWorktreeItem,
          isSelected: item.id === currentWorkspaceId,
          copyPath: deriveWorkspaceRootPath(item, workspaceRepoNames),
        };
      }),
    [
      currentWorkspaceId,
      defaultDirectoryLabel,
      mainDirectoryBranch,
      selectorWorkspaces,
      t,
      workspaceRepoNames,
    ]
  );

  const branchEntries = useMemo(
    () =>
      buildBranchSegment({
        branches: primaryRepoBranches,
        inWorktree,
        currentDirectoryBranch: currentBranchName,
        mainDirectoryBranch,
        projectRootWorkspaceId: projectRootWorkspace?.id ?? null,
      }),
    [
      currentBranchName,
      inWorktree,
      mainDirectoryBranch,
      primaryRepoBranches,
      projectRootWorkspace?.id,
    ]
  );

  const syncWorkspaceSelection = useCallback(
    (
      targetWorkspace: Workspace,
      updatedSession: Session | null,
      previousWorkspaceId: string | null
    ) => {
      queryClient.setQueryData(
        ['attempt', targetWorkspace.id],
        targetWorkspace
      );
      queryClient.setQueryData(
        ['taskAttempt', targetWorkspace.id],
        targetWorkspace
      );

      if (updatedSession) {
        queryClient.setQueryData(
          ['session', updatedSession.id],
          updatedSession
        );
        queryClient.setQueryData(
          ['taskAttemptWithSession', targetWorkspace.id],
          createWorkspaceWithSession(targetWorkspace, updatedSession)
        );
        panelActions?.openSessionTab({
          sessionId: updatedSession.id,
          workspaceId: targetWorkspace.id,
          title: session?.name ?? updatedSession.name ?? undefined,
          agentId: session?.agent_id ?? updatedSession.agent_id ?? undefined,
        });
        kanbanSession?.replaceRightSession({
          sessionId: updatedSession.id,
          workspaceId: targetWorkspace.id,
        });
      }

      worktree?.setActiveWorktree(targetWorkspace.id, targetWorkspace.task_id);

      const fileTreeState = useFileTreeStore.getState();
      fileTreeState.setRootPath(
        deriveWorkspaceRootPath(targetWorkspace, workspaceRepoNames)
      );
      fileTreeState.setSelectedFilePath(null);
      fileTreeState.setDiffFilePath(null);

      const pathname = locationContext?.location?.pathname ?? '';
      if (
        projectId &&
        navContext?.navigator &&
        pathname.includes('/workspaces/')
      ) {
        const nextPath = updatedSession
          ? paths.projectSession(
              projectId,
              targetWorkspace.id,
              updatedSession.id
            )
          : paths.projectWorkspace(projectId, targetWorkspace.id);
        navContext.navigator.replace(nextPath);
      }

      if (previousWorkspaceId && previousWorkspaceId !== targetWorkspace.id) {
        void queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', previousWorkspaceId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['taskAttemptWithSession', previousWorkspaceId],
        });
      }
      void queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', targetWorkspace.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ['taskAttemptWithSession', targetWorkspace.id],
      });
      if (projectId) {
        void queryClient.invalidateQueries({
          queryKey: ['projectWorktrees', projectId],
        });
      }
      void queryClient.invalidateQueries({
        queryKey: ['attemptRepo', targetWorkspace.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ['attemptBranch', targetWorkspace.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ['workspaceBranchStatus', targetWorkspace.id],
      });
      if (updatedSession) {
        void queryClient.invalidateQueries({
          queryKey: ['session', updatedSession.id],
        });
      }
    },
    [
      kanbanSession,
      locationContext?.location?.pathname,
      navContext?.navigator,
      panelActions,
      projectId,
      queryClient,
      session?.agent_id,
      session?.name,
      workspaceRepoNames,
      worktree,
    ]
  );

  const handleSelectWorkspace = useCallback(
    async (targetWorkspace: Workspace) => {
      if (
        disabled ||
        switchLockRef.current ||
        !targetWorkspace.id ||
        targetWorkspace.id === currentWorkspaceId
      ) {
        return;
      }

      switchLockRef.current = true;
      setIsSwitching(true);
      try {
        if (sessionId) {
          const updatedSession = await sessionsApi.updateWorkspace(
            sessionId,
            targetWorkspace.id
          );
          syncWorkspaceSelection(
            targetWorkspace,
            updatedSession,
            currentWorkspaceId
          );
        } else {
          syncWorkspaceSelection(targetWorkspace, null, currentWorkspaceId);
        }
      } catch (error) {
        toast.error(
          switcherErrorMessage(
            error,
            t('conversation:composerContext.workspaceSwitchFailed')
          )
        );
      } finally {
        switchLockRef.current = false;
        setIsSwitching(false);
      }
    },
    [currentWorkspaceId, disabled, sessionId, syncWorkspaceSelection, t]
  );

  const handleSelectDefaultDirectory = useCallback(
    async (branchHint?: string | null) => {
      if (disabled || switchLockRef.current) {
        return;
      }
      if (projectRootWorkspace) {
        await handleSelectWorkspace(projectRootWorkspace);
        return;
      }
      if (!projectId) {
        toast.error(t('conversation:composerContext.workspaceSwitchFailed'));
        return;
      }

      switchLockRef.current = true;
      setIsSwitching(true);
      try {
        const ensured = await sessionsApi.ensureProjectWorkspace({
          project_id: projectId,
          branch: branchHint ?? mainDirectoryBranch,
        });
        if (sessionId) {
          const updatedSession = await sessionsApi.updateWorkspace(
            sessionId,
            ensured.id
          );
          syncWorkspaceSelection(ensured, updatedSession, currentWorkspaceId);
        } else {
          syncWorkspaceSelection(ensured, null, currentWorkspaceId);
        }
      } catch (error) {
        toast.error(
          switcherErrorMessage(
            error,
            t('conversation:composerContext.workspaceSwitchFailed')
          )
        );
      } finally {
        switchLockRef.current = false;
        setIsSwitching(false);
      }
    },
    [
      currentWorkspaceId,
      disabled,
      handleSelectWorkspace,
      mainDirectoryBranch,
      projectId,
      projectRootWorkspace,
      sessionId,
      syncWorkspaceSelection,
      t,
    ]
  );

  const handleCheckoutBranch = useCallback(
    async (branchName: string) => {
      if (
        disabled ||
        !currentWorkspaceId ||
        !primaryRepo?.id ||
        switchLockRef.current
      ) {
        return;
      }

      switchLockRef.current = true;
      setIsSwitching(true);
      try {
        const result = await ConfirmDialog.show({
          title: t('panels:worktreeSelector.branchSwitchTitle'),
          message: t('panels:worktreeSelector.branchSwitchMessage'),
          confirmText: t('panels:worktreeSelector.branchSwitchConfirm'),
          cancelText: t('panels:worktreeSelector.branchSwitchCancel'),
          variant: 'info',
        });
        if (result !== 'confirmed') {
          return;
        }

        const previousBranch = currentBranchName;
        await attemptsApi.checkoutBranch(
          currentWorkspaceId,
          primaryRepo.id,
          branchName
        );
        const withBranch = (item: Workspace) =>
          item.id === currentWorkspaceId
            ? { ...item, branch: branchName }
            : item;

        if (projectId) {
          queryClient.setQueryData<Workspace[]>(
            ['projectWorktrees', projectId],
            (current) => current?.map(withBranch)
          );
        }
        queryClient.setQueryData<Workspace>(
          ['taskAttempt', currentWorkspaceId],
          (current) => (current ? withBranch(current) : current)
        );
        queryClient.setQueryData<Workspace>(
          ['attempt', currentWorkspaceId],
          (current) => (current ? withBranch(current) : current)
        );
        queryClient.setQueryData<WorkspaceWithSession>(
          ['taskAttemptWithSession', currentWorkspaceId],
          (current) =>
            current
              ? { ...withBranch(current), session: current.session }
              : current
        );
        queryClient.setQueryData<GitBranch[]>(
          ['repoBranches', primaryRepo.id],
          (current) =>
            current?.map((branch) => {
              const isTarget =
                branch.name.trim().toLowerCase() ===
                branchName.trim().toLowerCase();
              const isPrevious =
                previousBranch != null &&
                branch.name.trim().toLowerCase() ===
                  previousBranch.trim().toLowerCase();
              if (!inWorktree) {
                return { ...branch, is_current: isTarget };
              }
              if (isTarget) {
                return {
                  ...branch,
                  is_worktree: true,
                  worktree_path:
                    activeWorkspace?.container_ref ?? branch.worktree_path,
                };
              }
              if (isPrevious) {
                return {
                  ...branch,
                  is_worktree: false,
                  worktree_path: null,
                };
              }
              return branch;
            })
        );
        void queryClient.invalidateQueries({
          queryKey: ['repoBranches', primaryRepo.id],
        });
        if (projectId) {
          void queryClient.invalidateQueries({
            queryKey: ['projectWorktrees', projectId],
          });
        }
        void queryClient.invalidateQueries({
          queryKey: ['workspaceBranchStatus', currentWorkspaceId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['attemptBranch', currentWorkspaceId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['taskAttempt', currentWorkspaceId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['taskAttemptWithSession', currentWorkspaceId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['attempt', currentWorkspaceId],
        });
        void queryClient.invalidateQueries({
          queryKey: ['gitStatus'],
        });
      } catch (error) {
        toast.error(
          switcherErrorMessage(
            error,
            t('panels:worktreeSelector.branchSwitchFailed')
          )
        );
      } finally {
        switchLockRef.current = false;
        setIsSwitching(false);
      }
    },
    [
      activeWorkspace?.container_ref,
      currentBranchName,
      currentWorkspaceId,
      disabled,
      inWorktree,
      primaryRepo?.id,
      projectId,
      queryClient,
      t,
    ]
  );

  const handleSelectBranch = useCallback(
    async (entry: BranchSegmentEntry) => {
      if (entry.role === 'current') {
        return;
      }
      if (entry.role === 'main-directory') {
        const target =
          selectorWorkspaces.find((item) => item.id === entry.workspaceId) ??
          projectRootWorkspace;
        if (target) {
          await handleSelectWorkspace(target);
          return;
        }
        await handleSelectDefaultDirectory(entry.name);
        return;
      }
      await handleCheckoutBranch(entry.name);
    },
    [
      handleCheckoutBranch,
      handleSelectDefaultDirectory,
      handleSelectWorkspace,
      projectRootWorkspace,
      selectorWorkspaces,
    ]
  );

  const canSwitchBranch = Boolean(primaryRepo?.id && currentWorkspaceId);
  const canEnsureDefaultDirectory = Boolean(projectId && !projectRootWorkspace);

  if (!isGitDirectory) {
    return null;
  }

  if (!projectId && workspaceOptions.length === 0 && !canSwitchBranch) {
    return null;
  }

  return {
    workspaces: workspaceOptions,
    branches: branchEntries,
    canSwitchBranch,
    canEnsureDefaultDirectory,
    defaultDirectoryLabel,
    defaultDirectoryBranch: mainDirectoryBranch,
    isSwitching,
    disabled,
    onSelectWorkspace: handleSelectWorkspace,
    onSelectDefaultDirectory: canEnsureDefaultDirectory
      ? () => handleSelectDefaultDirectory()
      : undefined,
    onSelectBranch: canSwitchBranch ? handleSelectBranch : undefined,
  };
}
