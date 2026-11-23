import { backendCall } from '@/lib/backendTransport';
import { unregisterElectronBrowserTab } from './electronBrowserSurfaceStore';

export type LiveBrowserSurface = {
  tabId: string;
  url: string;
};

export type BrowserSurfaceHost = 'dockview' | 'canvas';

export type SurfaceBoundsPayload = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  visible: boolean;
};

export type BrowserDispatchFn = (
  operation: string,
  input?: Record<string, unknown>
) => Promise<unknown>;

export type DockviewContainerApiLike = {
  getPanel?: (panelId: string) => unknown;
};

export function isLiveDockviewContainer(
  containerApi?: DockviewContainerApiLike | null
): boolean {
  if (!containerApi || typeof containerApi.getPanel !== 'function') {
    return false;
  }
  const internal = containerApi as {
    isDisposed?: boolean;
    component?: { isDisposed?: boolean };
  };
  return (
    internal.isDisposed !== true && internal.component?.isDisposed !== true
  );
}

type SurfaceQueueState = {
  inFlight: Promise<void> | null;
  pendingBounds: SurfaceBoundsPayload | null;
  pendingDispatch: BrowserDispatchFn | null;
  pendingResolvers: Array<() => void>;
  closed: boolean;
};

const liveSurfaces = new Map<string, LiveBrowserSurface>();
const surfacePlugins = new Map<string, string>();
const surfaceQueues = new Map<string, SurfaceQueueState>();
const closedTabIds = new Set<string>();

function rememberClosedTabId(tabId: string): void {
  closedTabIds.add(tabId);
  if (closedTabIds.size > 128) {
    const oldest = closedTabIds.values().next().value;
    if (oldest) closedTabIds.delete(oldest);
  }
}

export function browserPanelSurfaceKey(
  projectKey: string,
  panelId: string,
  surfaceHost: BrowserSurfaceHost = 'dockview'
): string {
  return surfaceHost === 'canvas'
    ? `canvas::${projectKey}::${panelId}`
    : `${projectKey}::${panelId}`;
}

export function markBrowserTabOpen(tabId: string): void {
  if (!tabId) return;
  closedTabIds.delete(tabId);
  const queue = surfaceQueues.get(tabId);
  if (queue) {
    queue.closed = false;
  }
}

export function rememberBrowserSurface(
  key: string,
  surface: LiveBrowserSurface,
  pluginId?: string
): void {
  if (!key || !surface.tabId) return;
  markBrowserTabOpen(surface.tabId);
  liveSurfaces.set(key, surface);
  if (pluginId) {
    surfacePlugins.set(key, pluginId);
  }
}

export function recallBrowserSurface(
  key: string
): LiveBrowserSurface | undefined {
  return liveSurfaces.get(key);
}

export function forgetBrowserSurface(key: string): void {
  liveSurfaces.delete(key);
  surfacePlugins.delete(key);
}

export function clearAllBrowserSurfaces(): void {
  liveSurfaces.clear();
  surfacePlugins.clear();
  surfaceQueues.clear();
  closedTabIds.clear();
}

export function serializedLayoutHasPanel(
  layout: unknown,
  panelId: string
): boolean {
  if (!panelId || layout == null || typeof layout !== 'object') return false;
  const panels = (layout as { panels?: Record<string, unknown> }).panels;
  if (panels && Object.prototype.hasOwnProperty.call(panels, panelId)) {
    return true;
  }
  return walkForPanelId(layout, panelId);
}

function walkForPanelId(value: unknown, panelId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some(
      (entry) => entry === panelId || walkForPanelId(entry, panelId)
    );
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.views) && record.views.includes(panelId)) {
    return true;
  }
  return Object.values(record).some((entry) => walkForPanelId(entry, panelId));
}

export function projectLayoutStillHasBrowserPanel(
  state: {
    currentProjectKey: string;
    serializedLayout?: unknown;
    projectLayouts?: Record<string, { serializedLayout?: unknown }>;
  },
  projectKey: string,
  panelId: string
): boolean {
  if (!projectKey || !panelId) return false;
  if (state.currentProjectKey === projectKey) {
    if (state.serializedLayout != null) {
      return serializedLayoutHasPanel(state.serializedLayout, panelId);
    }
    const savedCurrent = state.projectLayouts?.[projectKey]?.serializedLayout;
    return serializedLayoutHasPanel(savedCurrent, panelId);
  }
  const saved = state.projectLayouts?.[projectKey]?.serializedLayout;
  return serializedLayoutHasPanel(saved, panelId);
}

export function shouldKeepBrowserSurfaceOnUnmount(options: {
  surfaceHost: BrowserSurfaceHost;
  panelId: string;
  projectKey: string;
  containerApi?: DockviewContainerApiLike | null;
  layoutState: {
    currentProjectKey: string;
    serializedLayout?: unknown;
    projectLayouts?: Record<string, { serializedLayout?: unknown }>;
  };
}): boolean {
  const { surfaceHost, panelId, projectKey, containerApi, layoutState } =
    options;
  if (surfaceHost !== 'dockview' || !panelId) return false;

  if (
    isLiveDockviewContainer(containerApi) &&
    layoutState.currentProjectKey === projectKey
  ) {
    return Boolean(containerApi!.getPanel!(panelId));
  }

  return projectLayoutStillHasBrowserPanel(layoutState, projectKey, panelId);
}

function resolveResolvers(resolvers: Array<() => void>): void {
  while (resolvers.length > 0) {
    const resolve = resolvers.shift();
    resolve?.();
  }
}

export function enqueueSurfaceBounds(
  tabId: string,
  dispatch: BrowserDispatchFn,
  bounds: SurfaceBoundsPayload
): Promise<void> {
  if (!tabId || closedTabIds.has(tabId)) {
    return Promise.resolve();
  }
  let state = surfaceQueues.get(tabId);
  if (!state) {
    state = {
      inFlight: null,
      pendingBounds: null,
      pendingDispatch: null,
      pendingResolvers: [],
      closed: false,
    };
    surfaceQueues.set(tabId, state);
  }
  if (state.closed) {
    return Promise.resolve();
  }

  if (state.inFlight) {
    state.pendingBounds = bounds;
    state.pendingDispatch = dispatch;
    return new Promise<void>((resolve) => {
      state!.pendingResolvers.push(resolve);
    });
  }

  const dispatchCurrent = (
    currentDispatch: BrowserDispatchFn,
    currentBounds: SurfaceBoundsPayload,
    attachedResolvers: Array<() => void>
  ): Promise<void> => {
    const work = Promise.resolve(
      currentDispatch('surface.set', { tabId, bounds: currentBounds })
    )
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        resolveResolvers(attachedResolvers);
        const latest = surfaceQueues.get(tabId);
        if (!latest || latest.inFlight !== work) return;
        latest.inFlight = null;
        if (latest.closed) {
          latest.pendingBounds = null;
          latest.pendingDispatch = null;
          resolveResolvers(latest.pendingResolvers);
          surfaceQueues.delete(tabId);
          return;
        }
        if (latest.pendingBounds && latest.pendingDispatch) {
          const nextBounds = latest.pendingBounds;
          const nextDispatch = latest.pendingDispatch;
          const nextResolvers = latest.pendingResolvers.splice(
            0,
            latest.pendingResolvers.length
          );
          latest.pendingBounds = null;
          latest.pendingDispatch = null;
          void dispatchCurrent(nextDispatch, nextBounds, nextResolvers);
          return;
        }
        surfaceQueues.delete(tabId);
      });
    state!.inFlight = work;
    return work;
  };

  return dispatchCurrent(dispatch, bounds, []);
}

export function closeBrowserTabOnce(
  dispatch: BrowserDispatchFn,
  tabId: string
): Promise<unknown> | null {
  if (!tabId) return null;
  unregisterElectronBrowserTab(tabId);
  const state = surfaceQueues.get(tabId);
  if (state) {
    state.closed = true;
    state.pendingBounds = null;
    state.pendingDispatch = null;
    resolveResolvers(state.pendingResolvers);
    if (!state.inFlight) {
      surfaceQueues.delete(tabId);
    }
  }
  if (closedTabIds.has(tabId)) return null;
  rememberClosedTabId(tabId);
  return Promise.resolve(dispatch('tab.close', { tabId })).catch(
    () => undefined
  );
}

export function closeRemovedDockviewBrowserPanel(
  projectKey: string,
  panelId: string,
  dispatchOverride?: BrowserDispatchFn
): boolean {
  if (!projectKey || !panelId) return false;
  const key = browserPanelSurfaceKey(projectKey, panelId, 'dockview');
  const surface = liveSurfaces.get(key);
  if (!surface) return false;

  const pluginId = surfacePlugins.get(key);
  forgetBrowserSurface(key);

  const dispatch: BrowserDispatchFn | null =
    dispatchOverride ??
    (pluginId
      ? (operation, input = {}) =>
          backendCall<unknown>('plugin_invoke_contribution', {
            pluginId,
            handler: 'browser.dispatch',
            input: { operation, input },
          })
      : null);
  if (!dispatch) return false;
  closeBrowserTabOnce(dispatch, surface.tabId);
  return true;
}

const HIDDEN_BOUNDS = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  scale: 1,
  visible: false,
};

export function hiddenBrowserBounds() {
  return { ...HIDDEN_BOUNDS };
}
