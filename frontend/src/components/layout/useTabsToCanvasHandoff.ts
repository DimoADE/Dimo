import { useLayoutEffect, useRef } from 'react';
import type { DockviewApi } from 'dockview-react';
import {
  flushCanvasDocumentPersist,
  getActiveCanvasEntry,
  loadCanvasWorkspace,
  saveCanvasWorkspace,
} from '@/components/kanban/canvas/canvasStorage';
import {
  getCanvasWorkspaceController,
  subscribeCanvasWorkspaceController,
  type CanvasWorkspaceController,
} from '@/components/kanban/canvas/canvasWorkspaceBridge';
import {
  browserPanelSurfaceKey,
  recallBrowserSurface,
} from '@/features/host-browser/browserPanelLifetime';
import {
  consumePendingWorkspaceStageTransition,
  getWorkspaceStageStyle,
  subscribeWorkspaceStageStyle,
  type WorkspaceStageStyle,
} from '@/lib/workspaceStageStyle';
import { useLayoutStore } from '@/stores/useLayoutStore';
import {
  mergeTabsIntoCanvasWorkspace,
  planCanvasNodesFromTabs,
  snapshotDockviewForCanvas,
  snapshotSerializedDockviewForCanvas,
} from './tabsToCanvas';

export interface UseTabsToCanvasHandoffOptions {
  projectId: string | undefined;
  readLiveDockviewApi: () => DockviewApi | null;
  isRightPanelVisible: boolean;
  isEditorAreaVisible: boolean;
}

/**
 * When the workspace switches from free tabs to infinite canvas, convert open
 * Zone B tabs (browser plugin panels, terminals, files, sessions, etc.) into
 * canvas nodes before the canvas stage mounts so panels open cleanly at their
 * current state without reloading stale URLs.
 */
export function useTabsToCanvasHandoff({
  projectId,
  readLiveDockviewApi,
  isRightPanelVisible,
  isEditorAreaVisible,
}: UseTabsToCanvasHandoffOptions): void {
  const previousStyleRef = useRef<WorkspaceStageStyle>(
    getWorkspaceStageStyle()
  );
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const readLiveApiRef = useRef(readLiveDockviewApi);
  readLiveApiRef.current = readLiveDockviewApi;
  const rightVisibleRef = useRef(isRightPanelVisible);
  rightVisibleRef.current = isRightPanelVisible;
  const editorVisibleRef = useRef(isEditorAreaVisible);
  editorVisibleRef.current = isEditorAreaVisible;

  useLayoutEffect(() => {
    let cancelPendingFocus: (() => void) | null = null;

    const clearPendingFocus = () => {
      cancelPendingFocus?.();
      cancelPendingFocus = null;
    };

    const scheduleFocusNode = (nodeId: string) => {
      clearPendingFocus();
      let cancelled = false;
      let frame = 0;
      let unsubscribeController: (() => void) | null = null;

      const cancel = () => {
        cancelled = true;
        if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
        unsubscribeController?.();
        unsubscribeController = null;
      };

      const dispatchFocus = (controller: CanvasWorkspaceController) => {
        unsubscribeController?.();
        unsubscribeController = null;
        if (typeof window.requestAnimationFrame === 'function') {
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            if (cancelled || getWorkspaceStageStyle() !== 'canvas') return;
            controller.focusNode?.(nodeId);
            cancelPendingFocus = null;
          });
        } else {
          if (cancelled || getWorkspaceStageStyle() !== 'canvas') return;
          controller.focusNode?.(nodeId);
          cancelPendingFocus = null;
        }
      };

      cancelPendingFocus = cancel;

      const liveController = getCanvasWorkspaceController();
      if (liveController) {
        dispatchFocus(liveController);
        return;
      }

      unsubscribeController = subscribeCanvasWorkspaceController(
        (controller) => {
          if (cancelled || getWorkspaceStageStyle() !== 'canvas') {
            clearPendingFocus();
            return;
          }
          if (!controller) return;
          dispatchFocus(controller);
        }
      );
    };

    const runHandoff = () => {
      const currentProjectId = projectIdRef.current;
      if (!currentProjectId) return false;

      const layoutState = useLayoutStore.getState();
      const visibility = {
        isRightPanelVisible: rightVisibleRef.current,
        isEditorAreaVisible: editorVisibleRef.current,
      };
      const liveApi = readLiveApiRef.current();
      const snapshot = liveApi
        ? snapshotDockviewForCanvas(liveApi, visibility)
        : snapshotSerializedDockviewForCanvas(
            layoutState.serializedLayout,
            visibility
          );

      const projectKey = layoutState.currentProjectKey;
      const requests = planCanvasNodesFromTabs(snapshot, {
        resolveBrowserUrl: (panelId) => {
          if (!projectKey) return null;
          return (
            recallBrowserSurface(
              browserPanelSurfaceKey(projectKey, panelId, 'dockview')
            )?.url ?? null
          );
        },
      });
      if (requests.length === 0) return true;

      flushCanvasDocumentPersist();
      const currentWorkspace = loadCanvasWorkspace(currentProjectId);
      const hadSavedViewport =
        getActiveCanvasEntry(currentWorkspace).document.viewport != null;
      const { workspace, changed, focusNodeId } = mergeTabsIntoCanvasWorkspace(
        currentWorkspace,
        requests
      );
      if (changed) {
        saveCanvasWorkspace(currentProjectId, workspace);
      }
      if (focusNodeId && hadSavedViewport) {
        scheduleFocusNode(focusNodeId);
      }
      return true;
    };

    if (projectId && getWorkspaceStageStyle() === 'canvas') {
      const pending = consumePendingWorkspaceStageTransition('canvas');
      if (pending?.from === 'tabs') {
        previousStyleRef.current = 'canvas';
        runHandoff();
      }
    }

    const unsubscribeStage = subscribeWorkspaceStageStyle(() => {
      const next = getWorkspaceStageStyle();
      const previous = previousStyleRef.current;
      previousStyleRef.current = next;
      if (next !== 'canvas') {
        clearPendingFocus();
        return;
      }
      if (previous !== 'tabs') return;
      if (projectIdRef.current) {
        consumePendingWorkspaceStageTransition('canvas');
        runHandoff();
      }
    });

    return () => {
      unsubscribeStage();
      clearPendingFocus();
    };
  }, [projectId]);
}
