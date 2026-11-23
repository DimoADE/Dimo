import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedDockview } from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import {
  getActiveCanvasEntry,
  loadCanvasWorkspace,
  saveCanvasWorkspace,
  updateWorkspaceActiveDocument,
} from '@/components/kanban/canvas/canvasStorage';
import {
  registerCanvasWorkspaceController,
  type CanvasWorkspaceController,
} from '@/components/kanban/canvas/canvasWorkspaceBridge';
import {
  browserPanelSurfaceKey,
  forgetBrowserSurface,
  rememberBrowserSurface,
} from '@/features/host-browser/browserPanelLifetime';
import {
  resetWorkspaceStageStyle,
  setWorkspaceStageStyle,
} from '@/lib/workspaceStageStyle';
import { useLayoutStore } from '@/stores/useLayoutStore';
import {
  useTabsToCanvasHandoff,
  type UseTabsToCanvasHandoffOptions,
} from './useTabsToCanvasHandoff';

function Harness(props: UseTabsToCanvasHandoffOptions) {
  useTabsToCanvasHandoff(props);
  return null;
}

function createBrowserDockviewApi(params: {
  panelId: string;
  title?: string;
  requestedUrl?: string;
  nativeTabId?: string;
}): DockviewApi {
  return {
    activePanel: { id: params.panelId },
    groups: [
      {
        id: 'group-editor-1',
        api: { isVisible: true },
        activePanel: { id: params.panelId },
        panels: [
          {
            id: params.panelId,
            title: params.title ?? 'Browser',
            view: { contentComponent: 'plugin-panel' },
            params: {
              pluginId: 'acme.browser-plugin',
              contributionId: 'browser',
              ...(params.requestedUrl !== undefined
                ? { requestedUrl: params.requestedUrl }
                : {}),
              ...(params.nativeTabId !== undefined
                ? { nativeTabId: params.nativeTabId }
                : {}),
            },
          },
        ],
      },
    ],
  } as unknown as DockviewApi;
}

describe('useTabsToCanvasHandoff', () => {
  const projectId = 'proj-tabs-to-canvas';
  const projectKey = 'project-key-1';
  let unregisterController: (() => void) | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    resetWorkspaceStageStyle();
    useLayoutStore.setState({
      currentProjectKey: projectKey,
      serializedLayout: null,
    });
  });

  afterEach(() => {
    unregisterController?.();
    unregisterController = null;
    forgetBrowserSurface(
      browserPanelSurfaceKey(projectKey, 'browser-remembered', 'dockview')
    );
    window.localStorage.clear();
    resetWorkspaceStageStyle();
    vi.restoreAllMocks();
  });

  it('converts an open browser tab into a canvas node when switching from tabs to canvas', () => {
    setWorkspaceStageStyle('tabs');
    const liveApi = createBrowserDockviewApi({
      panelId: 'browser-tab-1',
      title: 'Example Docs',
      requestedUrl: 'https://example.com/guide',
      nativeTabId: 'dockview-native-1',
    });

    render(
      <Harness
        projectId={projectId}
        readLiveDockviewApi={() => liveApi}
        isRightPanelVisible={true}
        isEditorAreaVisible={true}
      />
    );

    act(() => {
      setWorkspaceStageStyle('canvas');
    });

    const nodes = getActiveCanvasEntry(loadCanvasWorkspace(projectId)).document
      .nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      panelId: 'browser-tab-1',
      panelComponent: 'plugin-panel',
      panelTitle: 'Example Docs',
      expanded: true,
      panelParams: {
        pluginId: 'acme.browser-plugin',
        contributionId: 'browser',
        requestedUrl: 'https://example.com/guide',
      },
    });
    expect(nodes[0]?.panelParams).not.toHaveProperty('nativeTabId');
  });

  it('falls back to remembered dockview browser URL when panel params omit requestedUrl', () => {
    setWorkspaceStageStyle('tabs');
    rememberBrowserSurface(
      browserPanelSurfaceKey(projectKey, 'browser-remembered', 'dockview'),
      {
        tabId: 'dockview-tab-99',
        url: 'http://localhost:3000/dashboard',
      }
    );
    const liveApi = createBrowserDockviewApi({
      panelId: 'browser-remembered',
      title: 'Browser',
    });

    render(
      <Harness
        projectId={projectId}
        readLiveDockviewApi={() => liveApi}
        isRightPanelVisible={true}
        isEditorAreaVisible={true}
      />
    );

    act(() => {
      setWorkspaceStageStyle('canvas');
    });

    const nodes = getActiveCanvasEntry(loadCanvasWorkspace(projectId)).document
      .nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.panelParams).toEqual({
      pluginId: 'acme.browser-plugin',
      contributionId: 'browser',
      requestedUrl: 'http://localhost:3000/dashboard',
    });
  });

  it('converts open browser tabs on cross-window storage event and focuses the node on a saved viewport', () => {
    setWorkspaceStageStyle('tabs');
    const base = loadCanvasWorkspace('');
    saveCanvasWorkspace(
      projectId,
      updateWorkspaceActiveDocument(base, {
        ...getActiveCanvasEntry(base).document,
        nodes: [],
        links: [],
        viewport: { x: 120, y: 80, zoom: 0.9 },
      })
    );

    const liveApi = createBrowserDockviewApi({
      panelId: 'browser-cross-window',
      title: 'Cross Window',
      requestedUrl: 'https://cross.example.com',
    });

    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    render(
      <Harness
        projectId={projectId}
        readLiveDockviewApi={() => liveApi}
        isRightPanelVisible={true}
        isEditorAreaVisible={true}
      />
    );

    act(() => {
      window.localStorage.setItem('dimo:workspace-stage-style', 'canvas');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'dimo:workspace-stage-style',
          newValue: 'canvas',
          oldValue: 'tabs',
        })
      );
    });

    const nodes = getActiveCanvasEntry(loadCanvasWorkspace(projectId)).document
      .nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.panelId).toBe('browser-cross-window');

    const focusNode = vi.fn();
    const controller: CanvasWorkspaceController = {
      openOrFocusPanel: vi.fn(() => ''),
      openOrFocusSession: vi.fn(() => ''),
      dropSessionAt: vi.fn(),
      dropPanelAt: vi.fn(() => ''),
      closeNode: vi.fn(),
      closeOtherNodes: vi.fn(),
      closeAllNodes: vi.fn(),
      duplicateNode: vi.fn(() => null),
      focusNode,
    };

    act(() => {
      unregisterController = registerCanvasWorkspaceController(controller);
      for (const cb of rafCallbacks) {
        cb(0);
      }
    });

    expect(focusNode).toHaveBeenCalledWith(nodes[0]?.id);
  });

  it('converts serialized tabs once when remounting after an in-window settings switch', () => {
    setWorkspaceStageStyle('tabs');
    useLayoutStore.setState({
      currentProjectKey: projectKey,
      serializedLayout: {
        activeGroup: 'group-editor-1',
        grid: {
          orientation: 0,
          width: 1000,
          height: 700,
          root: {
            type: 'leaf',
            visible: true,
            data: {
              id: 'group-editor-1',
              views: ['browser-from-settings'],
              activeView: 'browser-from-settings',
            },
          },
        },
        panels: {
          'browser-from-settings': {
            id: 'browser-from-settings',
            contentComponent: 'plugin-panel',
            title: 'From Settings',
            params: {
              pluginId: 'acme.browser-plugin',
              contributionId: 'browser',
              requestedUrl: 'https://settings.example.com',
            },
          },
        },
      } as unknown as SerializedDockview,
    });

    // Switch stage style while IDELayout is unmounted (e.g. web /settings route).
    setWorkspaceStageStyle('canvas');

    const { unmount } = render(
      <Harness
        projectId={projectId}
        readLiveDockviewApi={() => null}
        isRightPanelVisible={true}
        isEditorAreaVisible={true}
      />
    );

    const nodes = getActiveCanvasEntry(loadCanvasWorkspace(projectId)).document
      .nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      panelId: 'browser-from-settings',
      panelTitle: 'From Settings',
      panelParams: {
        pluginId: 'acme.browser-plugin',
        contributionId: 'browser',
        requestedUrl: 'https://settings.example.com',
      },
    });

    unmount();

    // Clearing the canvas and remounting without a new transition should NOT re-import.
    const emptyBase = loadCanvasWorkspace('');
    saveCanvasWorkspace(
      projectId,
      updateWorkspaceActiveDocument(emptyBase, {
        ...getActiveCanvasEntry(emptyBase).document,
        nodes: [],
        links: [],
        viewport: null,
      })
    );

    render(
      <Harness
        projectId={projectId}
        readLiveDockviewApi={() => null}
        isRightPanelVisible={true}
        isEditorAreaVisible={true}
      />
    );

    expect(
      getActiveCanvasEntry(loadCanvasWorkspace(projectId)).document.nodes
    ).toHaveLength(0);
  });
});
