import {
  createElement,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { getDesktopShell } from '@/lib/desktopShell';
import type { BrowserSurfaceHost } from './browserPanelLifetime';
import {
  getElectronBrowserCallbacks,
  subscribeLiveSurfaceGeometry,
  useElectronBrowserSurfaceStore,
  type LiveSurfaceGeometry,
} from './electronBrowserSurfaceStore';
import {
  computeHostedWebviewStyles,
  type ElectronBrowserRect,
} from './electronBrowserViewportLayout';

export const WEBVIEW_POINTER_DOWN_CHANNEL = 'dimo-browser:pointer-down';
export const MAX_WEBVIEW_CRASH_RECOVERIES = 3;

interface ElectronWebviewElement extends HTMLElement {
  getWebContentsId?: () => number;
  canGoBack?: () => boolean;
  getURL?: () => string;
  src?: string;
}

interface IpcMessageEvent extends Event {
  channel?: string;
  args?: unknown[];
}

interface RenderProcessGoneEvent extends Event {
  reason?: string;
}

export function electronPartitionForProfile(
  profileId: string,
  tabId: string
): string {
  const sanitize = (raw: string) => {
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 64) : 'default';
  };

  const trimmed = profileId.trim();
  if (trimmed === 'ephemeral') {
    return `dimo-browser-ephemeral-${sanitize(tabId || 'session')}`;
  }
  return `persist:dimo-browser-${sanitize(trimmed || 'default')}`;
}

function dispatchHostPointerDown(slotElement: HTMLElement | null): void {
  const target =
    slotElement && slotElement.isConnected
      ? slotElement
      : typeof document !== 'undefined'
        ? document.body
        : null;
  if (!target) return;
  try {
    const EventCtor =
      typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    target.dispatchEvent(
      new EventCtor('pointerdown', {
        bubbles: true,
        cancelable: true,
      })
    );
  } catch {
    target.dispatchEvent(
      new Event('pointerdown', { bubbles: true, cancelable: true })
    );
  }
}

function applyLiveGeometryToDom(
  wrapper: HTMLDivElement | null,
  webview: ElectronWebviewElement | null,
  geometry: LiveSurfaceGeometry,
  keepPaintableWhenInactive?: boolean
): void {
  if (!wrapper || !webview) return;
  const { wrapperStyle, webviewStyle } = computeHostedWebviewStyles({
    ...geometry,
    ...(keepPaintableWhenInactive !== undefined
      ? { keepPaintableWhenInactive }
      : {}),
  });

  wrapper.style.position = String(wrapperStyle.position ?? 'fixed');
  wrapper.style.left = String(wrapperStyle.left ?? '0px');
  wrapper.style.top = String(wrapperStyle.top ?? '0px');
  wrapper.style.width = String(wrapperStyle.width ?? '1px');
  wrapper.style.height = String(wrapperStyle.height ?? '1px');
  wrapper.style.zIndex = String(wrapperStyle.zIndex ?? -1);
  wrapper.style.overflow = String(wrapperStyle.overflow ?? 'hidden');
  wrapper.style.borderRadius =
    typeof wrapperStyle.borderRadius === 'number'
      ? `${wrapperStyle.borderRadius}px`
      : String(wrapperStyle.borderRadius ?? '0px');
  wrapper.style.clipPath = wrapperStyle.clipPath
    ? String(wrapperStyle.clipPath)
    : '';
  wrapper.style.visibility = String(wrapperStyle.visibility ?? 'hidden');
  wrapper.style.pointerEvents = String(wrapperStyle.pointerEvents ?? 'none');
  if (wrapperStyle.backgroundColor) {
    wrapper.style.backgroundColor = String(wrapperStyle.backgroundColor);
  }

  webview.style.display = 'flex';
  webview.style.width = String(webviewStyle.width ?? '100%');
  webview.style.height = String(webviewStyle.height ?? '100%');
  webview.style.transformOrigin = webviewStyle.transformOrigin
    ? String(webviewStyle.transformOrigin)
    : '';
  webview.style.transform = webviewStyle.transform
    ? String(webviewStyle.transform)
    : '';
  webview.style.transformStyle = webviewStyle.transformStyle
    ? String(webviewStyle.transformStyle)
    : '';
}

export interface HostedElectronBrowserWebviewProps {
  tabId: string;
  inlineFallback?: boolean;
  panelVisible?: boolean;
  surfaceHost?: BrowserSurfaceHost;
}

/**
 * Renders a single persistent Electron `<webview>` guest either inside the
 * fixed-order root host (for Dockview tabs that reparent across splits) or
 * directly inline inside an Infinite Canvas browser card so CSS stacking,
 * clipping, transforms, and HUD overlays work natively.
 */
export const HostedElectronBrowserWebview = memo(
  function HostedElectronBrowserWebview({
    tabId,
    inlineFallback = false,
    panelVisible = true,
    surfaceHost = 'dockview',
  }: HostedElectronBrowserWebviewProps) {
    const tab = useElectronBrowserSurfaceStore((state) => state.tabs[tabId]);
    const presentation = useElectronBrowserSurfaceStore(
      (state) => state.presentations[tabId]
    );
    const canvasInteracting = useElectronBrowserSurfaceStore(
      (state) => state.canvasInteracting
    );
    const overlayDragging = useElectronBrowserSurfaceStore(
      (state) => state.overlayDragging
    );

    const hasTab = Boolean(tab);
    const tabUrl = tab?.url;
    const tabUrlRef = useRef<string>(tabUrl || 'about:blank');
    tabUrlRef.current = tabUrl || 'about:blank';

    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const webviewRef = useRef<ElectronWebviewElement | null>(null);
    const attachedWcIdRef = useRef<number | null>(null);
    const hasAttachedRef = useRef(false);
    const lastUrlRef = useRef<string>(tabUrl || 'about:blank');
    const crashCountRef = useRef(0);
    const lastRectRef = useRef<ElectronBrowserRect>({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    const latestLiveGeometryRef = useRef<LiveSurfaceGeometry | null>(null);
    const surfaceHostRef = useRef(presentation?.surfaceHost ?? 'dockview');
    surfaceHostRef.current = presentation?.surfaceHost ?? 'dockview';

    const [mountSrc, setMountSrc] = useState<string | null>(() =>
      tabUrl && tabUrl.trim().length > 0 ? tabUrl : null
    );
    const [generation, setGeneration] = useState(0);
    const [hasAttached, setHasAttached] = useState(false);

    const profileId = tab?.profileId || 'default';
    const hibernated = Boolean(tab?.hibernated);
    const partition = electronPartitionForProfile(profileId, tabId);
    const effectiveMountSrc =
      mountSrc ?? (tabUrl && tabUrl.trim().length > 0 ? tabUrl : 'about:blank');

    useLayoutEffect(() => {
      if (mountSrc === null && tabUrl && tabUrl.trim().length > 0) {
        setMountSrc(tabUrl);
      }
    }, [mountSrc, tabUrl]);

    useEffect(() => {
      if (tabUrl && tabUrl.trim().length > 0) {
        lastUrlRef.current = tabUrl;
      }
    }, [tabUrl]);

    // Reset initial src only when waking from hibernation.
    const prevHibernatedRef = useRef(hibernated);
    useEffect(() => {
      if (hibernated) {
        hasAttachedRef.current = false;
        setHasAttached(false);
      } else if (prevHibernatedRef.current) {
        hasAttachedRef.current = false;
        setHasAttached(false);
        setMountSrc(lastUrlRef.current || tabUrlRef.current || 'about:blank');
        crashCountRef.current = 0;
      }
      prevHibernatedRef.current = hibernated;
    }, [hibernated]);

    if (
      presentation?.rect &&
      presentation.rect.width > 0 &&
      presentation.rect.height > 0
    ) {
      lastRectRef.current = presentation.rect;
    }

    // Subscribe to imperative 60fps geometry updates during canvas pan/zoom/drag.
    useLayoutEffect(() => {
      if (inlineFallback || hibernated) {
        latestLiveGeometryRef.current = null;
        return undefined;
      }
      return subscribeLiveSurfaceGeometry(tabId, (geometry) => {
        latestLiveGeometryRef.current = geometry;
        if (geometry.rect.width > 0 && geometry.rect.height > 0) {
          lastRectRef.current = geometry.rect;
        }
        const store = useElectronBrowserSurfaceStore.getState();
        const effectiveInteractive =
          geometry.interactive &&
          !store.overlayDragging &&
          !(surfaceHostRef.current === 'canvas' && store.canvasInteracting);
        applyLiveGeometryToDom(
          wrapperRef.current,
          webviewRef.current,
          {
            ...geometry,
            interactive: effectiveInteractive,
          },
          !hasAttachedRef.current ? true : undefined
        );
      });
    }, [hibernated, inlineFallback, tabId]);

    // Attach/detach guest WebContents on did-attach & dom-ready, handle pointerdown & crash recovery.
    useEffect(() => {
      if (!hasTab || hibernated) {
        hasAttachedRef.current = false;
        setHasAttached(false);
        return undefined;
      }
      const el = webviewRef.current;
      if (!el) {
        return undefined;
      }

      let disposed = false;

      const attach = () => {
        if (disposed || typeof el.getWebContentsId !== 'function') {
          return;
        }
        let wcId: number;
        try {
          wcId = el.getWebContentsId();
        } catch {
          return;
        }
        if (
          !Number.isFinite(wcId) ||
          wcId <= 0 ||
          attachedWcIdRef.current === wcId
        ) {
          return;
        }
        attachedWcIdRef.current = wcId;
        if (!hasAttachedRef.current) {
          hasAttachedRef.current = true;
          setHasAttached(true);
        }
        const currentUrl =
          (typeof el.getURL === 'function' ? el.getURL() : '') ||
          lastUrlRef.current ||
          'about:blank';
        void getDesktopShell()
          .invoke('electron_browser_attach', {
            tabId,
            webContentsId: wcId,
            profileId,
            url: currentUrl,
          })
          .catch(() => undefined);
      };

      const syncHistory = () => {
        if (disposed) return;
        if (typeof el.getURL === 'function') {
          const nextUrl = el.getURL();
          if (nextUrl) lastUrlRef.current = nextUrl;
        }
        if (typeof el.canGoBack === 'function') {
          try {
            getElectronBrowserCallbacks(tabId)?.onHistoryAvailabilityChange?.(
              Boolean(el.canGoBack())
            );
          } catch {
            // Ignore before dom-ready
          }
        }
      };

      const onDidAttach = () => {
        attach();
      };

      const onDomReady = () => {
        crashCountRef.current = 0;
        attach();
        syncHistory();
        getElectronBrowserCallbacks(tabId)?.onLoadFinished?.();
      };

      const onDidStopLoading = () => {
        syncHistory();
        getElectronBrowserCallbacks(tabId)?.onLoadFinished?.();
      };

      const notifyHostPointerInteraction = () => {
        if (disposed) return;
        const slotElement = inlineFallback
          ? (webviewRef.current?.parentElement ?? null)
          : (useElectronBrowserSurfaceStore.getState().presentations[tabId]
              ?.slotElement ?? null);
        dispatchHostPointerDown(slotElement);
        getElectronBrowserCallbacks(tabId)?.onPointerDown?.();
      };

      const onIpcMessage = (event: Event) => {
        const ipcEvent = event as IpcMessageEvent;
        if (ipcEvent.channel === WEBVIEW_POINTER_DOWN_CHANNEL) {
          notifyHostPointerInteraction();
        }
      };

      const onFocus = () => {
        notifyHostPointerInteraction();
      };

      const onRenderProcessGone = (event: Event) => {
        if (disposed) return;
        const goneEvent = event as RenderProcessGoneEvent;
        if (goneEvent.reason === 'clean-exit') {
          return;
        }
        if (crashCountRef.current >= MAX_WEBVIEW_CRASH_RECOVERIES) {
          return;
        }
        crashCountRef.current += 1;
        attachedWcIdRef.current = null;
        hasAttachedRef.current = false;
        setHasAttached(false);
        setMountSrc(lastUrlRef.current || tabUrlRef.current || 'about:blank');
        setGeneration((prev) => prev + 1);
      };

      el.addEventListener('did-attach', onDidAttach);
      el.addEventListener('dom-ready', onDomReady);
      el.addEventListener('did-navigate', syncHistory);
      el.addEventListener('did-navigate-in-page', syncHistory);
      el.addEventListener('did-stop-loading', onDidStopLoading);
      el.addEventListener('ipc-message', onIpcMessage);
      el.addEventListener('focus', onFocus);
      el.addEventListener('render-process-gone', onRenderProcessGone);

      attach();

      return () => {
        disposed = true;
        el.removeEventListener('did-attach', onDidAttach);
        el.removeEventListener('dom-ready', onDomReady);
        el.removeEventListener('did-navigate', syncHistory);
        el.removeEventListener('did-navigate-in-page', syncHistory);
        el.removeEventListener('did-stop-loading', onDidStopLoading);
        el.removeEventListener('ipc-message', onIpcMessage);
        el.removeEventListener('focus', onFocus);
        el.removeEventListener('render-process-gone', onRenderProcessGone);
        const wcId = attachedWcIdRef.current;
        attachedWcIdRef.current = null;
        hasAttachedRef.current = false;
        if (wcId !== null) {
          void getDesktopShell()
            .invoke('electron_browser_detach', {
              tabId,
              webContentsId: wcId,
            })
            .catch(() => undefined);
        }
      };
    }, [generation, hasTab, hibernated, inlineFallback, profileId, tabId]);

    if (!tab || hibernated) {
      return null;
    }

    if (inlineFallback) {
      const inlineInteractive =
        panelVisible &&
        !overlayDragging &&
        !(surfaceHost === 'canvas' && canvasInteracting);
      return createElement('webview', {
        key: `${tabId}:${generation}`,
        ref: webviewRef,
        src: effectiveMountSrc,
        partition,
        allowpopups: 'true',
        'data-testid': 'electron-browser-webview',
        'data-tab-id': tabId,
        'data-generation': String(generation),
        'data-surface-host': surfaceHost,
        className: 'flex h-full w-full border-0',
        style: {
          display: 'flex',
          width: '100%',
          height: '100%',
          border: 0,
          pointerEvents: inlineInteractive ? 'auto' : 'none',
          visibility: panelVisible ? 'visible' : 'hidden',
          backgroundColor: tab.backgroundColor,
        },
      });
    }

    const liveGeometry =
      latestLiveGeometryRef.current &&
      latestLiveGeometryRef.current.geometrySeq >
        (presentation?.geometrySeq ?? 0)
        ? latestLiveGeometryRef.current
        : null;

    const activeGeometry = liveGeometry ?? presentation;
    const isVisible = Boolean(activeGeometry?.visible);
    const effectiveInteractive =
      Boolean(activeGeometry?.interactive) &&
      !overlayDragging &&
      !(presentation?.surfaceHost === 'canvas' && canvasInteracting);

    // Keep unattached `<webview>` guests paintable offscreen on Windows/Linux so
    // Electron always initializes and binds `webContentsId`.
    const keepPaintable = !hasAttached;
    const { wrapperStyle, webviewStyle } = computeHostedWebviewStyles({
      visible: isVisible,
      rect: activeGeometry?.rect ?? lastRectRef.current,
      clipRect: activeGeometry?.clipRect ?? null,
      scale: activeGeometry?.scale ?? 1,
      zIndex: activeGeometry?.zIndex ?? 20,
      cornerRadius: activeGeometry?.cornerRadius ?? 0,
      interactive: effectiveInteractive,
      backgroundColor: tab.backgroundColor,
      ...(keepPaintable ? { keepPaintableWhenInactive: true } : {}),
    });

    return (
      <div
        ref={wrapperRef}
        data-testid="electron-browser-host-wrapper"
        data-tab-id={tabId}
        data-visible={isVisible ? 'true' : 'false'}
        data-surface-host={presentation?.surfaceHost ?? 'dockview'}
        style={wrapperStyle}
      >
        {createElement('webview', {
          key: `${tabId}:${generation}`,
          ref: webviewRef,
          src: effectiveMountSrc,
          partition,
          allowpopups: 'true',
          'data-testid': 'electron-browser-webview',
          'data-tab-id': tabId,
          'data-generation': String(generation),
          className: 'flex border-0',
          style: webviewStyle,
        })}
      </div>
    );
  }
);
