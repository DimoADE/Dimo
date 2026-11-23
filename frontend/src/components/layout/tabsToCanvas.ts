import type { SerializedDockview } from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import {
  findEmptyCanvasPlacement,
  isSessionNode,
  openSessionWindow,
} from '@/components/kanban/canvas/canvasGrouping';
import {
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  createCanvasNode,
  createCanvasPanelNode,
  isPanelCanvasNode,
  nextDropPoint,
  type SessionCanvasNode,
} from '@/components/kanban/canvas/canvasModel';
import {
  getActiveCanvasEntry,
  updateWorkspaceActiveDocument,
  type SessionCanvasWorkspace,
} from '@/components/kanban/canvas/canvasStorage';
import { extractSessionIdFromPanelId } from '@/lib/workspaceSessionTabSlots';
import {
  EDITOR_GROUP_PREFIX,
  GROUP_IDS,
  PANEL_IDS,
} from '@/stores/useLayoutStore';
import {
  LEFT_GROUP_PREFIX,
  LEFT_PANEL_IDS,
  RIGHT_GROUP_PREFIX,
  isBottomGroup,
  isLeftGroup,
  isPlaceholderPanelId,
  isSessionGroup,
  isSessionPanelId,
} from '@/utils/dockviewGroupPolicy';
import { MAX_CANVAS_TABS_FROM_STAGE } from './canvasToTabs';

const PLUGIN_PANEL_COMPONENT = 'plugin-panel';

export interface DockviewPanelSnapshot {
  id: string;
  title?: string;
  component: string;
  params?: Record<string, unknown>;
}

export interface DockviewGroupSnapshot {
  id: string;
  role: 'left' | 'editor' | 'session' | 'bottom';
  visible: boolean;
  activePanelId?: string | null;
  panels: readonly DockviewPanelSnapshot[];
}

export interface DockviewStageSnapshot {
  activePanelId?: string | null;
  groups: readonly DockviewGroupSnapshot[];
}

export type TabsToCanvasRequest =
  | {
      kind: 'session';
      sessionId: string;
      activate: boolean;
    }
  | {
      kind: 'panel';
      panelId: string;
      component: string;
      title: string;
      params?: Record<string, unknown>;
      activate: boolean;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readLivePanelComponent(panel: DockviewApi['panels'][number]): string {
  const view = (panel as { view?: { contentComponent?: unknown } }).view;
  if (
    typeof view?.contentComponent === 'string' &&
    view.contentComponent.trim().length > 0
  ) {
    return view.contentComponent.trim();
  }
  const params = asRecord(panel.params);
  if (
    typeof params?.__component === 'string' &&
    params.__component.trim().length > 0
  ) {
    return params.__component.trim();
  }
  return panel.id;
}

export function snapshotDockviewForCanvas(
  api: DockviewApi,
  options?: {
    isRightPanelVisible?: boolean;
    isEditorAreaVisible?: boolean;
  }
): DockviewStageSnapshot {
  const groups: DockviewGroupSnapshot[] = api.groups.map((group) => {
    const role: DockviewGroupSnapshot['role'] = isLeftGroup(group)
      ? 'left'
      : isBottomGroup(group)
        ? 'bottom'
        : isSessionGroup(group)
          ? 'session'
          : 'editor';

    const rawVisible = group.api?.isVisible !== false;
    const visible =
      role === 'session'
        ? rawVisible || options?.isRightPanelVisible === true
        : role === 'editor'
          ? options?.isEditorAreaVisible === false
            ? false
            : rawVisible
          : rawVisible;

    return {
      id: group.id,
      role,
      visible,
      activePanelId: group.activePanel?.id ?? null,
      panels: group.panels.map((panel) => ({
        id: panel.id,
        title: panel.title,
        component: readLivePanelComponent(panel),
        params: asRecord(panel.params),
      })),
    };
  });

  return {
    activePanelId: api.activePanel?.id ?? null,
    groups,
  };
}

interface SerializedGridNode {
  type?: string;
  visible?: boolean;
  data?: unknown;
}

function classifySerializedGroupRole(
  groupId: string,
  panelIds: readonly string[]
): DockviewGroupSnapshot['role'] {
  if (groupId === GROUP_IDS.LEFT || groupId.startsWith(LEFT_GROUP_PREFIX)) {
    return 'left';
  }
  if (groupId === GROUP_IDS.RIGHT || groupId.startsWith(RIGHT_GROUP_PREFIX)) {
    return 'session';
  }
  if (groupId === GROUP_IDS.BOTTOM) {
    return 'bottom';
  }
  if (groupId.startsWith(EDITOR_GROUP_PREFIX)) {
    return 'editor';
  }
  if (panelIds.some((id) => LEFT_PANEL_IDS.has(id))) {
    return 'left';
  }
  if (panelIds.some((id) => isSessionPanelId(id))) {
    return 'session';
  }
  return 'editor';
}

export function snapshotSerializedDockviewForCanvas(
  layout: SerializedDockview | null | undefined,
  options?: {
    isRightPanelVisible?: boolean;
    isEditorAreaVisible?: boolean;
  }
): DockviewStageSnapshot | null {
  if (!layout || typeof layout !== 'object') return null;
  const panelsMap = asRecord(layout.panels) ?? {};
  const groups: DockviewGroupSnapshot[] = [];
  const activeGroupId =
    typeof layout.activeGroup === 'string' ? layout.activeGroup : null;
  let activePanelId: string | null = null;

  const visit = (node: SerializedGridNode | null | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'branch' && Array.isArray(node.data)) {
      for (const child of node.data) {
        visit(child as SerializedGridNode);
      }
      return;
    }
    if (node.type !== 'leaf') return;
    const data = asRecord(node.data);
    if (!data) return;
    const id = typeof data.id === 'string' ? data.id : '';
    const views = Array.isArray(data.views)
      ? data.views.filter((view): view is string => typeof view === 'string')
      : [];
    if (!id || views.length === 0) return;

    const role = classifySerializedGroupRole(id, views);
    const groupActiveView =
      typeof data.activeView === 'string'
        ? data.activeView
        : (views[0] ?? null);
    if (id === activeGroupId && groupActiveView) {
      activePanelId = groupActiveView;
    }

    const nodeVisible = node.visible !== false && data.visible !== false;
    const visible =
      role === 'session'
        ? options?.isRightPanelVisible !== false && nodeVisible
        : role === 'editor'
          ? options?.isEditorAreaVisible !== false && nodeVisible
          : nodeVisible;

    const panels: DockviewPanelSnapshot[] = [];
    for (const viewId of views) {
      const serialized = asRecord(panelsMap[viewId]);
      const params = asRecord(serialized?.params);
      const component =
        typeof serialized?.contentComponent === 'string' &&
        serialized.contentComponent.trim().length > 0
          ? serialized.contentComponent.trim()
          : typeof params?.__component === 'string' &&
              params.__component.trim().length > 0
            ? params.__component.trim()
            : viewId;
      const title =
        typeof serialized?.title === 'string' ? serialized.title : undefined;
      panels.push({
        id: viewId,
        title,
        component,
        params,
      });
    }

    groups.push({
      id,
      role,
      visible,
      activePanelId: groupActiveView,
      panels,
    });
  };

  visit(layout.grid?.root as SerializedGridNode | undefined);

  if (groups.length === 0) return null;
  return { activePanelId, groups };
}

function sanitizeCanvasPanelParams(
  component: string,
  panelId: string,
  rawParams: Record<string, unknown> | undefined,
  resolveBrowserUrl?: (panelId: string) => string | null | undefined
): Record<string, unknown> | undefined {
  const sanitized: Record<string, unknown> = rawParams ? { ...rawParams } : {};
  delete sanitized.nativeTabId;
  delete sanitized.__component;

  if (component === PLUGIN_PANEL_COMPONENT) {
    const existingUrl =
      typeof sanitized.requestedUrl === 'string'
        ? sanitized.requestedUrl.trim()
        : '';
    if (!existingUrl) {
      const rememberedUrl = resolveBrowserUrl?.(panelId)?.trim() ?? '';
      if (rememberedUrl && rememberedUrl !== 'about:blank') {
        sanitized.requestedUrl = rememberedUrl;
      }
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function isExcludedStagePanel(panelId: string, component: string): boolean {
  if (!panelId || !component) return true;
  if (isPlaceholderPanelId(panelId)) return true;
  if (LEFT_PANEL_IDS.has(panelId) || LEFT_PANEL_IDS.has(component)) return true;
  if (panelId === PANEL_IDS.WELCOME || component === PANEL_IDS.WELCOME) {
    return true;
  }
  if (panelId === PANEL_IDS.KANBAN || component === PANEL_IDS.KANBAN) {
    return true;
  }
  return false;
}

interface RankedTabCandidate {
  key: string;
  priority: number;
  order: number;
  request: TabsToCanvasRequest;
}

/**
 * Convert open Zone B free tabs into canvas node requests, ordered so the
 * active tab is placed and focused last. Capped to keep canvas handoff bounded.
 */
export function planCanvasNodesFromTabs(
  snapshot: DockviewStageSnapshot | null | undefined,
  options?: {
    limit?: number;
    resolveBrowserUrl?: (panelId: string) => string | null | undefined;
  }
): TabsToCanvasRequest[] {
  if (!snapshot) return [];
  const limit = options?.limit ?? MAX_CANVAS_TABS_FROM_STAGE;
  const best = new Map<string, RankedTabCandidate>();
  let order = 0;

  for (const group of snapshot.groups) {
    if (group.role === 'left' || !group.visible) continue;
    for (const panel of group.panels) {
      const component = panel.component.trim();
      if (isExcludedStagePanel(panel.id, component)) continue;

      const isGlobalActive = snapshot.activePanelId === panel.id;
      const isGroupActive = group.activePanelId === panel.id;
      const priority = isGlobalActive ? 2 : isGroupActive ? 1 : 0;

      if (isSessionPanelId(panel.id) || component === PANEL_IDS.AI_CHAT) {
        const paramSessionId =
          typeof panel.params?.sessionId === 'string'
            ? panel.params.sessionId.trim()
            : '';
        const sessionId =
          paramSessionId || extractSessionIdFromPanelId(panel.id) || '';
        if (!sessionId) continue;
        const key = `session:${sessionId}`;
        const candidate: RankedTabCandidate = {
          key,
          priority,
          order: order++,
          request: {
            kind: 'session',
            sessionId,
            activate: false,
          },
        };
        const existing = best.get(key);
        if (!existing || candidate.priority > existing.priority) {
          best.set(key, candidate);
        }
        continue;
      }

      const key = `panel:${panel.id}`;
      const params = sanitizeCanvasPanelParams(
        component,
        panel.id,
        panel.params,
        options?.resolveBrowserUrl
      );
      const candidate: RankedTabCandidate = {
        key,
        priority,
        order: order++,
        request: {
          kind: 'panel',
          panelId: panel.id,
          component,
          title: panel.title?.trim() || component,
          ...(params ? { params } : {}),
          activate: false,
        },
      };
      const existing = best.get(key);
      if (!existing || candidate.priority > existing.priority) {
        best.set(key, candidate);
      }
    }
  }

  if (best.size === 0) return [];

  // Select up to `limit` highest-priority tabs (breaking ties by tab order),
  // then emit lowest-priority first so the active tab is last and activated.
  const selected = [...best.values()]
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      return left.order - right.order;
    })
    .slice(0, limit)
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.order - right.order;
    });

  const requests = selected.map((entry) => entry.request);
  if (requests.length > 0) {
    const last = requests.length - 1;
    requests[last] = { ...requests[last], activate: true };
  }
  return requests;
}

function shallowEqualRecords(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function mergePanelParams(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!existing && !incoming) return undefined;
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  if (incoming) {
    for (const [key, value] of Object.entries(incoming)) {
      if (key === 'nativeTabId' || key === '__component') continue;
      if (value === undefined) continue;
      if (
        key === 'requestedUrl' &&
        (value === null ||
          (typeof value === 'string' && value.trim() === '')) &&
        typeof merged.requestedUrl === 'string' &&
        merged.requestedUrl.trim().length > 0
      ) {
        continue;
      }
      merged[key] = value;
    }
  }
  delete merged.nativeTabId;
  delete merged.__component;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeTabsIntoCanvasWorkspace(
  workspace: SessionCanvasWorkspace,
  requests: readonly TabsToCanvasRequest[]
): {
  workspace: SessionCanvasWorkspace;
  changed: boolean;
  focusNodeId: string | null;
} {
  if (requests.length === 0) {
    return { workspace, changed: false, focusNodeId: null };
  }

  const active = getActiveCanvasEntry(workspace);
  let nodes: SessionCanvasNode[] = [...active.document.nodes];
  let changed = false;
  let focusNodeId: string | null = null;
  const expandedSize = {
    width: DETAIL_CARD_WIDTH,
    height: DETAIL_CARD_HEIGHT,
  };

  for (const request of requests) {
    if (request.kind === 'session') {
      const existing = nodes.find(
        (node) => isSessionNode(node) && node.sessionId === request.sessionId
      );
      if (existing) {
        if (request.activate && !existing.expanded) {
          const opened = openSessionWindow(nodes, existing.id);
          if (opened !== nodes) {
            nodes = opened;
            changed = true;
          }
          const expandedNode =
            nodes.find(
              (node) =>
                isSessionNode(node) &&
                node.sessionId === request.sessionId &&
                node.expanded
            ) ?? existing;
          focusNodeId = expandedNode.id;
        } else if (request.activate) {
          focusNodeId = existing.id;
        }
        continue;
      }

      const point =
        nodes.length === 0
          ? { x: 0, y: 0 }
          : findEmptyCanvasPlacement(nodes, expandedSize, nextDropPoint(nodes));
      const created: SessionCanvasNode = {
        ...createCanvasNode(request.sessionId, point, undefined, expandedSize),
        expanded: true,
      };
      nodes = [...nodes, created];
      changed = true;
      if (request.activate || focusNodeId === null) {
        focusNodeId = created.id;
      }
      continue;
    }

    const existing = nodes.find(
      (node) => isPanelCanvasNode(node) && node.panelId === request.panelId
    );
    if (existing) {
      const nextTitle = request.title || existing.panelTitle;
      const nextParams = mergePanelParams(existing.panelParams, request.params);
      const shouldExpand = request.activate && !existing.expanded;
      const paramsChanged = !shallowEqualRecords(
        existing.panelParams,
        nextParams
      );
      const titleChanged = nextTitle !== existing.panelTitle;
      if (paramsChanged || titleChanged || shouldExpand) {
        nodes = nodes.map((node) =>
          node.id === existing.id
            ? {
                ...node,
                panelTitle: nextTitle,
                panelParams: nextParams,
                ...(shouldExpand
                  ? {
                      expanded: true,
                      width: Math.max(node.width, DETAIL_CARD_WIDTH),
                      height: Math.max(node.height, DETAIL_CARD_HEIGHT),
                    }
                  : {}),
              }
            : node
        );
        changed = true;
      }
      if (request.activate) {
        focusNodeId = existing.id;
      }
      continue;
    }

    const point =
      nodes.length === 0
        ? { x: 0, y: 0 }
        : findEmptyCanvasPlacement(nodes, expandedSize, nextDropPoint(nodes));
    const created = createCanvasPanelNode({
      panelId: request.panelId,
      panelComponent: request.component,
      panelTitle: request.title,
      panelParams: request.params,
      position: point,
      expanded: true,
      size: expandedSize,
    });
    nodes = [...nodes, created];
    changed = true;
    if (request.activate || focusNodeId === null) {
      focusNodeId = created.id;
    }
  }

  if (!changed) {
    return { workspace, changed: false, focusNodeId };
  }

  return {
    workspace: updateWorkspaceActiveDocument(workspace, {
      ...active.document,
      nodes,
    }),
    changed: true,
    focusNodeId,
  };
}
