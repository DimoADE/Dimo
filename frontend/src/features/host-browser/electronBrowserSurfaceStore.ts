import { create } from 'zustand';
import type { BrowserSurfaceHost } from './browserPanelLifetime';
import type {
  ElectronBrowserClipRect,
  ElectronBrowserRect,
} from './electronBrowserViewportLayout';

export interface RegisteredElectronBrowserTab {
  tabId: string;
  url: string;
  profileId: string;
  backgroundColor?: string;
  hibernated: boolean;
  inline: boolean;
}

export interface ElectronBrowserSurfacePresentation {
  leaseToken: symbol;
  geometrySeq: number;
  rect: ElectronBrowserRect;
  clipRect: ElectronBrowserClipRect | null;
  visible: boolean;
  scale: number;
  zIndex: number;
  cornerRadius: number;
  interactive: boolean;
  surfaceHost: BrowserSurfaceHost;
  slotElement: HTMLElement | null;
}

export interface LiveSurfaceGeometry {
  geometrySeq: number;
  rect: ElectronBrowserRect;
  clipRect: ElectronBrowserClipRect | null;
  visible: boolean;
  scale: number;
  zIndex: number;
  cornerRadius: number;
  interactive: boolean;
  backgroundColor?: string;
}

export interface ElectronBrowserTabCallbacks {
  onHistoryAvailabilityChange?: (canGoBack: boolean) => void;
  onPointerDown?: () => void;
  onLoadFinished?: () => void;
}

interface ElectronBrowserSurfaceState {
  hostMounted: boolean;
  tabOrder: string[];
  tabs: Record<string, RegisteredElectronBrowserTab>;
  presentations: Record<string, ElectronBrowserSurfacePresentation>;
  canvasInteracting: boolean;
  overlayDragging: boolean;
  canvasZoom: number;
}

let nextGeometrySeq = 1;

const geometryListeners = new Map<
  string,
  Set<(geometry: LiveSurfaceGeometry) => void>
>();
const tabCallbacks = new Map<string, ElectronBrowserTabCallbacks>();
const canvasViewportListeners = new Set<() => void>();

export const useElectronBrowserSurfaceStore =
  create<ElectronBrowserSurfaceState>(() => ({
    hostMounted: false,
    tabOrder: [],
    tabs: {},
    presentations: {},
    canvasInteracting: false,
    overlayDragging: false,
    canvasZoom: 1,
  }));

export function setElectronBrowserHostMounted(mounted: boolean): void {
  useElectronBrowserSurfaceStore.setState((state) =>
    state.hostMounted === mounted ? state : { ...state, hostMounted: mounted }
  );
}

export function registerElectronBrowserTab(input: {
  tabId: string;
  url: string;
  profileId: string;
  backgroundColor?: string;
  hibernated?: boolean;
  inline?: boolean;
}): void {
  const { tabId } = input;
  if (!tabId) return;
  useElectronBrowserSurfaceStore.setState((state) => {
    const existing = state.tabs[tabId];
    const nextTab: RegisteredElectronBrowserTab = {
      tabId,
      url: input.url || existing?.url || 'about:blank',
      profileId: input.profileId || existing?.profileId || 'default',
      backgroundColor: input.backgroundColor ?? existing?.backgroundColor,
      hibernated: input.hibernated ?? existing?.hibernated ?? false,
      inline: input.inline ?? existing?.inline ?? false,
    };
    if (
      existing &&
      existing.url === nextTab.url &&
      existing.profileId === nextTab.profileId &&
      existing.backgroundColor === nextTab.backgroundColor &&
      existing.hibernated === nextTab.hibernated &&
      existing.inline === nextTab.inline
    ) {
      return state;
    }
    const nextOrder = state.tabOrder.includes(tabId)
      ? state.tabOrder
      : [...state.tabOrder, tabId];
    return {
      ...state,
      tabOrder: nextOrder,
      tabs: {
        ...state.tabs,
        [tabId]: nextTab,
      },
    };
  });
}

export function updateElectronBrowserTab(
  tabId: string,
  patch: Partial<Omit<RegisteredElectronBrowserTab, 'tabId'>>
): void {
  if (!tabId) return;
  useElectronBrowserSurfaceStore.setState((state) => {
    const existing = state.tabs[tabId];
    if (!existing) return state;
    const nextTab: RegisteredElectronBrowserTab = {
      ...existing,
      ...patch,
    };
    if (
      existing.url === nextTab.url &&
      existing.profileId === nextTab.profileId &&
      existing.backgroundColor === nextTab.backgroundColor &&
      existing.hibernated === nextTab.hibernated &&
      existing.inline === nextTab.inline
    ) {
      return state;
    }
    return {
      ...state,
      tabs: {
        ...state.tabs,
        [tabId]: nextTab,
      },
    };
  });
}

export function unregisterElectronBrowserTab(tabId: string): void {
  if (!tabId) return;
  tabCallbacks.delete(tabId);
  geometryListeners.delete(tabId);
  useElectronBrowserSurfaceStore.setState((state) => {
    if (!state.tabs[tabId] && !state.presentations[tabId]) {
      return state;
    }
    const nextTabs = { ...state.tabs };
    delete nextTabs[tabId];
    const nextPresentations = { ...state.presentations };
    delete nextPresentations[tabId];
    return {
      ...state,
      tabOrder: state.tabOrder.filter((id) => id !== tabId),
      tabs: nextTabs,
      presentations: nextPresentations,
    };
  });
}

function rectsNearlyEqual(
  a: ElectronBrowserRect,
  b: ElectronBrowserRect
): boolean {
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

function clipRectsNearlyEqual(
  a: ElectronBrowserClipRect | null,
  b: ElectronBrowserClipRect | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.right) === Math.round(b.right) &&
    Math.round(a.bottom) === Math.round(b.bottom)
  );
}

export interface ElectronBrowserSurfaceLease {
  readonly token: symbol;
  present: (
    presentation: Omit<
      ElectronBrowserSurfacePresentation,
      'leaseToken' | 'geometrySeq'
    >
  ) => boolean;
  pushLive: (geometry: Omit<LiveSurfaceGeometry, 'geometrySeq'>) => void;
  release: () => void;
}

export function acquireElectronBrowserSurface(
  tabId: string
): ElectronBrowserSurfaceLease {
  const token = Symbol(`electron-browser-surface:${tabId}`);
  let released = false;

  useElectronBrowserSurfaceStore.setState((state) => {
    const existing = state.presentations[tabId];
    return {
      ...state,
      presentations: {
        ...state.presentations,
        [tabId]: {
          leaseToken: token,
          geometrySeq: nextGeometrySeq++,
          rect: existing?.rect ?? { x: 0, y: 0, width: 1, height: 1 },
          clipRect: existing?.clipRect ?? null,
          visible: false,
          scale: existing?.scale ?? 1,
          zIndex: existing?.zIndex ?? 20,
          cornerRadius: existing?.cornerRadius ?? 0,
          interactive: false,
          surfaceHost: existing?.surfaceHost ?? 'dockview',
          slotElement: existing?.slotElement ?? null,
        },
      },
    };
  });

  return {
    token,
    present(presentation) {
      if (released) return false;
      const state = useElectronBrowserSurfaceStore.getState();
      const current = state.presentations[tabId];
      if (current && current.leaseToken !== token) {
        return false;
      }
      const next: ElectronBrowserSurfacePresentation = {
        ...presentation,
        leaseToken: token,
        geometrySeq: nextGeometrySeq++,
      };
      if (
        current &&
        current.visible === next.visible &&
        current.zIndex === next.zIndex &&
        current.cornerRadius === next.cornerRadius &&
        current.interactive === next.interactive &&
        current.surfaceHost === next.surfaceHost &&
        current.slotElement === next.slotElement &&
        Math.abs(current.scale - next.scale) < 0.001 &&
        rectsNearlyEqual(current.rect, next.rect) &&
        clipRectsNearlyEqual(current.clipRect, next.clipRect)
      ) {
        return true;
      }
      useElectronBrowserSurfaceStore.setState((prev) => {
        const latest = prev.presentations[tabId];
        if (latest && latest.leaseToken !== token) {
          return prev;
        }
        return {
          ...prev,
          presentations: {
            ...prev.presentations,
            [tabId]: next,
          },
        };
      });
      return true;
    },
    pushLive(geometry) {
      if (released) return;
      const current =
        useElectronBrowserSurfaceStore.getState().presentations[tabId];
      if (current && current.leaseToken !== token) {
        return;
      }
      const listeners = geometryListeners.get(tabId);
      if (!listeners || listeners.size === 0) return;
      const stamped: LiveSurfaceGeometry = {
        ...geometry,
        geometrySeq: nextGeometrySeq++,
      };
      for (const listener of listeners) {
        listener(stamped);
      }
    },
    release() {
      if (released) return;
      released = true;
      useElectronBrowserSurfaceStore.setState((state) => {
        const current = state.presentations[tabId];
        if (!current || current.leaseToken !== token) {
          return state;
        }
        return {
          ...state,
          presentations: {
            ...state.presentations,
            [tabId]: {
              ...current,
              geometrySeq: nextGeometrySeq++,
              visible: false,
              interactive: false,
              keepPaintableWhenInactive: undefined,
              slotElement: null,
            },
          },
        };
      });
    },
  };
}

export function subscribeLiveSurfaceGeometry(
  tabId: string,
  listener: (geometry: LiveSurfaceGeometry) => void
): () => void {
  let set = geometryListeners.get(tabId);
  if (!set) {
    set = new Set();
    geometryListeners.set(tabId, set);
  }
  set.add(listener);
  return () => {
    const existing = geometryListeners.get(tabId);
    if (!existing) return;
    existing.delete(listener);
    if (existing.size === 0) {
      geometryListeners.delete(tabId);
    }
  };
}

export function registerElectronBrowserCallbacks(
  tabId: string,
  callbacks: ElectronBrowserTabCallbacks
): () => void {
  tabCallbacks.set(tabId, callbacks);
  return () => {
    if (tabCallbacks.get(tabId) === callbacks) {
      tabCallbacks.delete(tabId);
    }
  };
}

export function getElectronBrowserCallbacks(
  tabId: string
): ElectronBrowserTabCallbacks | undefined {
  return tabCallbacks.get(tabId);
}

export function setCanvasBrowserInteracting(interacting: boolean): void {
  useElectronBrowserSurfaceStore.setState((state) =>
    state.canvasInteracting === interacting
      ? state
      : { ...state, canvasInteracting: interacting }
  );
}

export function setBrowserOverlayDragging(dragging: boolean): void {
  useElectronBrowserSurfaceStore.setState((state) =>
    state.overlayDragging === dragging
      ? state
      : { ...state, overlayDragging: dragging }
  );
}

export function notifyCanvasBrowserViewportChange(zoom?: number): void {
  if (typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0) {
    const currentZoom = useElectronBrowserSurfaceStore.getState().canvasZoom;
    if (Math.abs(currentZoom - zoom) > 0.001) {
      useElectronBrowserSurfaceStore.setState({ canvasZoom: zoom });
    }
  }
  for (const listener of canvasViewportListeners) {
    listener();
  }
}

export function subscribeCanvasBrowserViewportChange(
  listener: () => void
): () => void {
  canvasViewportListeners.add(listener);
  return () => {
    canvasViewportListeners.delete(listener);
  };
}

export function resetElectronBrowserSurfaceStoreForTests(): void {
  nextGeometrySeq = 1;
  geometryListeners.clear();
  tabCallbacks.clear();
  canvasViewportListeners.clear();
  useElectronBrowserSurfaceStore.setState({
    hostMounted: false,
    tabOrder: [],
    tabs: {},
    presentations: {},
    canvasInteracting: false,
    overlayDragging: false,
    canvasZoom: 1,
  });
}
