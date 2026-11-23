import { describe, expect, it } from 'vitest';
import type { SerializedDockview } from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import {
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  createCanvasNode,
  createCanvasPanelNode,
} from '@/components/kanban/canvas/canvasModel';
import {
  getActiveCanvasEntry,
  loadCanvasWorkspace,
  updateWorkspaceActiveDocument,
  type SessionCanvasDocument,
  type SessionCanvasWorkspace,
} from '@/components/kanban/canvas/canvasStorage';
import { GROUP_IDS, PANEL_IDS } from '@/stores/useLayoutStore';
import {
  mergeTabsIntoCanvasWorkspace,
  planCanvasNodesFromTabs,
  snapshotDockviewForCanvas,
  snapshotSerializedDockviewForCanvas,
  type DockviewStageSnapshot,
} from './tabsToCanvas';

function buildWorkspace(
  doc: Partial<SessionCanvasDocument>
): SessionCanvasWorkspace {
  const base = loadCanvasWorkspace('');
  const active = getActiveCanvasEntry(base).document;
  return updateWorkspaceActiveDocument(base, {
    ...active,
    ...doc,
  });
}

describe('tabsToCanvas', () => {
  it('converts open browser plugin tabs while stripping nativeTabId and __component', () => {
    const snapshot: DockviewStageSnapshot = {
      activePanelId: 'plugin-browser-2',
      groups: [
        {
          id: 'group-editor-1',
          role: 'editor',
          visible: true,
          activePanelId: 'plugin-browser-2',
          panels: [
            {
              id: 'plugin-browser-1',
              title: 'Docs',
              component: 'plugin-panel',
              params: {
                pluginId: 'acme.browser-plugin',
                contributionId: 'browser',
                requestedUrl: 'https://example.com/docs',
                nativeTabId: 'native-tab-1',
                faviconUrl: 'https://example.com/favicon.ico',
                __component: 'plugin-panel',
              },
            },
            {
              id: 'plugin-browser-2',
              title: 'Preview',
              component: 'plugin-panel',
              params: {
                pluginId: 'acme.browser-plugin',
                contributionId: 'browser',
                nativeTabId: 'native-tab-2',
              },
            },
          ],
        },
      ],
    };

    const requests = planCanvasNodesFromTabs(snapshot, {
      resolveBrowserUrl: (panelId) =>
        panelId === 'plugin-browser-2' ? 'http://localhost:5173/app' : null,
    });

    expect(requests).toEqual([
      {
        kind: 'panel',
        panelId: 'plugin-browser-1',
        component: 'plugin-panel',
        title: 'Docs',
        params: {
          pluginId: 'acme.browser-plugin',
          contributionId: 'browser',
          requestedUrl: 'https://example.com/docs',
          faviconUrl: 'https://example.com/favicon.ico',
        },
        activate: false,
      },
      {
        kind: 'panel',
        panelId: 'plugin-browser-2',
        component: 'plugin-panel',
        title: 'Preview',
        params: {
          pluginId: 'acme.browser-plugin',
          contributionId: 'browser',
          requestedUrl: 'http://localhost:5173/app',
        },
        activate: true,
      },
    ]);
  });

  it('excludes Zone A left dock, hidden groups, placeholders, welcome, kanban, and empty ai-chat', () => {
    const snapshot: DockviewStageSnapshot = {
      activePanelId: 'plugin-browser-1',
      groups: [
        {
          id: GROUP_IDS.LEFT,
          role: 'left',
          visible: true,
          activePanelId: PANEL_IDS.FILE_TREE,
          panels: [
            { id: PANEL_IDS.FILE_TREE, title: 'Files', component: 'file-tree' },
            { id: PANEL_IDS.GIT, title: 'Git', component: 'git' },
          ],
        },
        {
          id: GROUP_IDS.BOTTOM,
          role: 'bottom',
          visible: false,
          activePanelId: PANEL_IDS.TERMINAL,
          panels: [
            {
              id: PANEL_IDS.TERMINAL,
              title: 'Terminal',
              component: 'terminal',
            },
          ],
        },
        {
          id: 'group-editor-1',
          role: 'editor',
          visible: true,
          activePanelId: 'plugin-browser-1',
          panels: [
            { id: PANEL_IDS.WELCOME, title: 'Welcome', component: 'welcome' },
            { id: PANEL_IDS.KANBAN, title: 'Kanban', component: 'kanban' },
            { id: PANEL_IDS.AI_CHAT, title: 'Chat', component: 'ai-chat' },
            {
              id: 'plugin-browser-1',
              title: 'Browser',
              component: 'plugin-panel',
              params: {
                pluginId: 'acme.browser-plugin',
                contributionId: 'browser',
                requestedUrl: 'https://example.org',
              },
            },
          ],
        },
        {
          id: GROUP_IDS.RIGHT,
          role: 'session',
          visible: true,
          activePanelId: 'ai-chat-session-sess-1',
          panels: [
            {
              id: 'ai-chat-session-sess-1',
              title: 'Agent',
              component: 'ai-chat',
              params: { sessionId: 'sess-1' },
            },
          ],
        },
      ],
    };

    const requests = planCanvasNodesFromTabs(snapshot);

    expect(requests).toEqual([
      {
        kind: 'session',
        sessionId: 'sess-1',
        activate: false,
      },
      {
        kind: 'panel',
        panelId: 'plugin-browser-1',
        component: 'plugin-panel',
        title: 'Browser',
        params: {
          pluginId: 'acme.browser-plugin',
          contributionId: 'browser',
          requestedUrl: 'https://example.org',
        },
        activate: true,
      },
    ]);
  });

  it('caps at 10 tabs and puts the globally active tab last with activate=true', () => {
    const panels = Array.from({ length: 12 }, (_, index) => ({
      id: `plugin-browser-${index}`,
      title: `Tab ${index}`,
      component: 'plugin-panel',
      params: {
        pluginId: 'acme.browser-plugin',
        contributionId: 'browser',
        requestedUrl: `https://example.com/${index}`,
      },
    }));

    const requests = planCanvasNodesFromTabs({
      activePanelId: 'plugin-browser-11',
      groups: [
        {
          id: 'group-editor-1',
          role: 'editor',
          visible: true,
          activePanelId: 'plugin-browser-11',
          panels,
        },
      ],
    });

    expect(requests).toHaveLength(10);
    expect(requests[9]).toMatchObject({
      kind: 'panel',
      panelId: 'plugin-browser-11',
      activate: true,
    });
    expect(requests.slice(0, 9).every((request) => !request.activate)).toBe(
      true
    );
  });

  it('snapshots live DockviewApi and serialized layouts accurately', () => {
    const liveApi = {
      activePanel: { id: 'plugin-browser-live' },
      groups: [
        {
          id: GROUP_IDS.LEFT,
          api: { isVisible: true },
          activePanel: { id: PANEL_IDS.FILE_TREE },
          panels: [
            {
              id: PANEL_IDS.FILE_TREE,
              title: 'Files',
              view: { contentComponent: 'file-tree' },
              params: {},
            },
          ],
        },
        {
          id: 'group-editor-main',
          api: { isVisible: true },
          activePanel: { id: 'plugin-browser-live' },
          panels: [
            {
              id: 'plugin-browser-live',
              title: 'Browser',
              view: { contentComponent: 'plugin-panel' },
              params: {
                pluginId: 'acme.browser-plugin',
                contributionId: 'browser',
                requestedUrl: 'https://live.example.com',
                nativeTabId: 'live-native-tab',
              },
            },
          ],
        },
      ],
    } as unknown as DockviewApi;

    const liveSnapshot = snapshotDockviewForCanvas(liveApi, {
      isRightPanelVisible: true,
      isEditorAreaVisible: true,
    });
    expect(planCanvasNodesFromTabs(liveSnapshot)).toEqual([
      {
        kind: 'panel',
        panelId: 'plugin-browser-live',
        component: 'plugin-panel',
        title: 'Browser',
        params: {
          pluginId: 'acme.browser-plugin',
          contributionId: 'browser',
          requestedUrl: 'https://live.example.com',
        },
        activate: true,
      },
    ]);

    const serialized = {
      activeGroup: 'group-editor-main',
      grid: {
        orientation: 0,
        width: 1200,
        height: 800,
        root: {
          type: 'branch',
          data: [
            {
              type: 'leaf',
              visible: true,
              data: {
                id: 'group-editor-main',
                views: ['plugin-browser-serialized', 'terminal-1'],
                activeView: 'plugin-browser-serialized',
              },
            },
          ],
        },
      },
      panels: {
        'plugin-browser-serialized': {
          id: 'plugin-browser-serialized',
          contentComponent: 'plugin-panel',
          title: 'Browser',
          params: {
            pluginId: 'acme.browser-plugin',
            contributionId: 'browser',
            requestedUrl: 'https://serialized.example.com',
            nativeTabId: 'stale-native-id',
          },
        },
        'terminal-1': {
          id: 'terminal-1',
          contentComponent: 'terminal',
          title: 'Terminal',
          params: { cwd: '/repo' },
        },
      },
    } as unknown as SerializedDockview;

    const serializedSnapshot = snapshotSerializedDockviewForCanvas(serialized, {
      isRightPanelVisible: true,
      isEditorAreaVisible: true,
    });
    expect(planCanvasNodesFromTabs(serializedSnapshot)).toEqual([
      {
        kind: 'panel',
        panelId: 'terminal-1',
        component: 'terminal',
        title: 'Terminal',
        params: { cwd: '/repo' },
        activate: false,
      },
      {
        kind: 'panel',
        panelId: 'plugin-browser-serialized',
        component: 'plugin-panel',
        title: 'Browser',
        params: {
          pluginId: 'acme.browser-plugin',
          contributionId: 'browser',
          requestedUrl: 'https://serialized.example.com',
        },
        activate: true,
      },
    ]);
  });

  it('merges new and existing browser/session nodes without duplicates or nativeTabId leakage', () => {
    const existingBrowser = createCanvasPanelNode({
      id: 'node-browser-existing',
      panelId: 'plugin-browser-1',
      panelComponent: 'plugin-panel',
      panelTitle: 'Old Title',
      panelParams: {
        pluginId: 'acme.browser-plugin',
        contributionId: 'browser',
        requestedUrl: 'https://old.example.com',
        nativeTabId: 'should-be-stripped',
      },
      position: { x: 0, y: 0 },
      expanded: false,
    });
    const existingSession = {
      ...createCanvasNode('sess-1', { x: 400, y: 0 }, 'node-session-1'),
      expanded: false,
    };
    const workspace = buildWorkspace({
      nodes: [existingBrowser, existingSession],
      links: [],
      viewport: { x: 10, y: 20, zoom: 1 },
    });

    const result = mergeTabsIntoCanvasWorkspace(workspace, [
      {
        kind: 'panel',
        panelId: 'plugin-browser-1',
        component: 'plugin-panel',
        title: 'Updated Docs',
        params: {
          pluginId: 'acme.browser-plugin',
          contributionId: 'browser',
          requestedUrl: 'https://new.example.com',
        },
        activate: false,
      },
      {
        kind: 'panel',
        panelId: 'plugin-browser-2',
        component: 'plugin-panel',
        title: 'Second Browser',
        params: {
          pluginId: 'acme.browser-plugin',
          contributionId: 'browser',
          requestedUrl: 'https://second.example.com',
        },
        activate: true,
      },
    ]);

    expect(result.changed).toBe(true);
    const nodes = getActiveCanvasEntry(result.workspace).document.nodes;
    expect(nodes).toHaveLength(3);

    const updated = nodes.find((node) => node.id === 'node-browser-existing');
    expect(updated).toMatchObject({
      panelTitle: 'Updated Docs',
      panelParams: {
        pluginId: 'acme.browser-plugin',
        contributionId: 'browser',
        requestedUrl: 'https://new.example.com',
      },
    });
    expect(updated?.panelParams).not.toHaveProperty('nativeTabId');

    const added = nodes.find((node) => node.panelId === 'plugin-browser-2');
    expect(added).toMatchObject({
      panelComponent: 'plugin-panel',
      panelTitle: 'Second Browser',
      expanded: true,
      width: DETAIL_CARD_WIDTH,
      height: DETAIL_CARD_HEIGHT,
      panelParams: {
        pluginId: 'acme.browser-plugin',
        contributionId: 'browser',
        requestedUrl: 'https://second.example.com',
      },
    });
    expect(result.focusNodeId).toBe(added?.id);
  });

  it('expands an existing collapsed browser node when it is the active tab', () => {
    const collapsedBrowser = createCanvasPanelNode({
      id: 'node-browser-collapsed',
      panelId: 'plugin-browser-1',
      panelComponent: 'plugin-panel',
      panelTitle: 'Browser',
      panelParams: {
        pluginId: 'acme.browser-plugin',
        contributionId: 'browser',
        requestedUrl: 'https://keep-me.example.com',
      },
      position: { x: 0, y: 0 },
      expanded: false,
    });
    const workspace = buildWorkspace({
      nodes: [collapsedBrowser],
      links: [],
      viewport: null,
    });

    const result = mergeTabsIntoCanvasWorkspace(workspace, [
      {
        kind: 'panel',
        panelId: 'plugin-browser-1',
        component: 'plugin-panel',
        title: 'Browser',
        params: {
          pluginId: 'acme.browser-plugin',
          contributionId: 'browser',
          requestedUrl: '',
        },
        activate: true,
      },
    ]);

    expect(result.changed).toBe(true);
    expect(result.focusNodeId).toBe('node-browser-collapsed');
    const [node] = getActiveCanvasEntry(result.workspace).document.nodes;
    expect(node?.expanded).toBe(true);
    expect(node?.panelParams).toEqual({
      pluginId: 'acme.browser-plugin',
      contributionId: 'browser',
      requestedUrl: 'https://keep-me.example.com',
    });
  });
});
