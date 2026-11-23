import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getDesktopShell } from '@/lib/desktopShell';
import type { BrowserSurfaceHost } from './browserPanelLifetime';
import {
  acquireElectronBrowserSurface,
  registerElectronBrowserCallbacks,
  registerElectronBrowserTab,
  subscribeCanvasBrowserViewportChange,
  updateElectronBrowserTab,
  useElectronBrowserSurfaceStore,
  type ElectronBrowserSurfaceLease,
} from './electronBrowserSurfaceStore';
import {
  isSurfaceRectIntersectingClip,
  resolveHostBrowserZIndex,
  type ElectronBrowserClipRect,
  type ElectronBrowserRect,
} from './electronBrowserViewportLayout';
import {
  HostedElectronBrowserWebview,
  electronPartitionForProfile,
} from './HostedElectronBrowserWebview';

export { electronPartitionForProfile };

export const CANVAS_HIBERNATE_DELAY_MS = 60_000;
const CANVAS_HIBERNATE_VIEWPORT_MARGIN_PX = 120;
const DOCKVIEW_CLIP_SELECTOR =
  '.dv-content-container, .dv-groupview, .workspace-stage-host';
const CANVAS_CLIP_SELECTOR =
  '[data-testid="workspace-canvas-stage"], [data-canvas-surface], .react-flow, .workspace-stage-host';

interface FreezeThumbnailPayload {
  mime?: string;
  data?: string;
}

export interface ElectronBrowserWebviewProps {
  tabId: string;
  url: string;
  profileId: string;
  surfaceHost: BrowserSurfaceHost;
  panelVisible: boolean;
  canHibernate?: boolean;
  hibernateDelayMs?: number;
  surfaceZIndex?: number | null;
  backgroundColor?: string;
  onHistoryAvailabilityChange?: (canGoBack: boolean) => void;
  onSurfacePointerDown?: () => void;
}

function resolveStageClipRect(
  element: HTMLElement,
  surfaceHost: BrowserSurfaceHost
): ElectronBrowserClipRect | null {
  const selector =
    surfaceHost === 'canvas' ? CANVAS_CLIP_SELECTOR : DOCKVIEW_CLIP_SELECTOR;
  let clip: ElectronBrowserClipRect | null = null;
  let parent = element.parentElement;
  while (
    parent &&
    parent !== document.body &&
    parent !== document.documentElement
  ) {
    if (parent.matches(selector)) {
      const bounds = parent.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        if (!clip) {
          clip = {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
          };
        } else {
          clip = {
            left: Math.max(clip.left, bounds.left),
            top: Math.max(clip.top, bounds.top),
            right: Math.min(clip.right, bounds.right),
            bottom: Math.min(clip.bottom, bounds.bottom),
          };
        }
      }
    }
    parent = parent.parentElement;
  }
  return clip;
}

function resolveDockviewCornerRadius(element: HTMLElement): number {
  const group = element.closest('.dv-groupview') as HTMLElement | null;
  if (!group) return 0;
  const isBottomCorner =
    group.getAttribute('data-stage-bottommost') === 'true' &&
    (group.getAttribute('data-stage-leftmost') === 'true' ||
      group.getAttribute('data-stage-rightmost') === 'true');
  return isBottomCorner ? 14 : 0;
}

/**
 * Slot controller for an Electron Host Browser surface.
 *
 * - On Infinite Canvas (`surfaceHost === 'canvas'`), renders `<webview>`
 *   directly inline inside the canvas node so CSS z-index, clipping, transforms,
 *   minimap/HUD overlays, and sibling cards compose natively without any
 *   Tauri-era occlusion or freeze-frame patchwork.
 * - In Dockview (`surfaceHost === 'dockview'`), leases a persistent root-mounted
 *   `<webview>` from `<ElectronBrowserHost />` so dragging tabs across split
 *   panes never reparents or reloads the guest WebContents.
 */
export function ElectronBrowserWebview({
  tabId,
  url,
  profileId,
  surfaceHost,
  panelVisible,
  canHibernate = true,
  hibernateDelayMs = CANVAS_HIBERNATE_DELAY_MS,
  surfaceZIndex,
  backgroundColor,
  onHistoryAvailabilityChange,
  onSurfacePointerDown,
}: ElectronBrowserWebviewProps) {
  const hostMounted = useElectronBrowserSurfaceStore(
    (state) => state.hostMounted
  );

  const renderInline = surfaceHost === 'canvas' || !hostMounted;

  const slotRef = useRef<HTMLDivElement | null>(null);
  const leaseRef = useRef<ElectronBrowserSurfaceLease | null>(null);
  const lastUrlTabIdRef = useRef<string>(tabId);
  const lastUrlRef = useRef<string>(url || 'about:blank');
  const latestUrlPropRef = useRef<string>(url);
  latestUrlPropRef.current = url;

  const [hibernated, setHibernated] = useState(false);
  const [hibernatedSnapshot, setHibernatedSnapshot] = useState<string | null>(
    null
  );
  const [inCanvasViewport, setInCanvasViewport] = useState(true);

  const hibernatedRef = useRef(false);
  hibernatedRef.current = hibernated;
  const panelVisibleRef = useRef(panelVisible);
  panelVisibleRef.current = panelVisible;
  const surfaceZIndexRef = useRef(surfaceZIndex);
  surfaceZIndexRef.current = surfaceZIndex;

  useEffect(() => {
    if (url && url.trim().length > 0) {
      lastUrlRef.current = url;
    }
  }, [url]);

  // Register tab metadata in store; canvas tabs are marked `inline: true` so
  // root ElectronBrowserHost never mounts a duplicate `<webview>`.
  useLayoutEffect(() => {
    if (lastUrlTabIdRef.current !== tabId) {
      lastUrlTabIdRef.current = tabId;
      lastUrlRef.current = url || 'about:blank';
    } else if (url && url.trim().length > 0) {
      lastUrlRef.current = url;
    }
    registerElectronBrowserTab({
      tabId,
      url: url || lastUrlRef.current || 'about:blank',
      profileId,
      backgroundColor,
      hibernated,
      inline: surfaceHost === 'canvas',
    });
  }, [backgroundColor, hibernated, profileId, surfaceHost, tabId, url]);

  // Register callbacks for history and guest pointerdown notifications.
  useEffect(() => {
    const callbacks = {
      onHistoryAvailabilityChange,
      onPointerDown: onSurfacePointerDown,
    };
    return registerElectronBrowserCallbacks(tabId, callbacks);
  }, [onHistoryAvailabilityChange, onSurfacePointerDown, tabId]);

  // Reset local hibernation state on logical tabId switch.
  useEffect(() => {
    const nextUrl = latestUrlPropRef.current || 'about:blank';
    setHibernated(false);
    setHibernatedSnapshot(null);
    setInCanvasViewport(true);
    lastUrlRef.current = nextUrl;
  }, [tabId]);

  // Track whether a canvas browser card is outside the stage viewport for idle hibernation.
  useLayoutEffect(() => {
    if (surfaceHost !== 'canvas' || hibernated) {
      return undefined;
    }
    const el = slotRef.current;
    if (!el) return undefined;

    const checkViewport = () => {
      const target = slotRef.current;
      if (!target) return;
      const domRect = target.getBoundingClientRect();
      const rect: ElectronBrowserRect = {
        x: Math.round(domRect.x),
        y: Math.round(domRect.y),
        width: Math.max(0, Math.round(domRect.width)),
        height: Math.max(0, Math.round(domRect.height)),
      };
      const clipRect = resolveStageClipRect(target, 'canvas');
      const withinHibernateMargin =
        rect.width > 0 &&
        rect.height > 0 &&
        isSurfaceRectIntersectingClip(
          rect,
          clipRect,
          CANVAS_HIBERNATE_VIEWPORT_MARGIN_PX
        );
      setInCanvasViewport((prev) =>
        prev === withinHibernateMargin ? prev : withinHibernateMargin
      );
    };

    checkViewport();

    let rafId: number | null = null;
    const scheduleCheck = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        checkViewport();
      });
    };

    const unsubscribeViewport =
      subscribeCanvasBrowserViewportChange(scheduleCheck);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(checkViewport)
        : null;
    resizeObserver?.observe(el);
    window.addEventListener('resize', checkViewport);
    window.addEventListener('scroll', checkViewport, true);

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      unsubscribeViewport();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', checkViewport);
      window.removeEventListener('scroll', checkViewport, true);
    };
  }, [hibernated, surfaceHost, tabId]);

  // Infinite-canvas hibernation: release guest Chromium process only after offscreen idle.
  const effectivelyVisibleForHibernate =
    surfaceHost === 'canvas' ? panelVisible && inCanvasViewport : panelVisible;

  useEffect(() => {
    if (surfaceHost !== 'canvas' || !canHibernate) {
      if (hibernated) {
        updateElectronBrowserTab(tabId, { hibernated: false });
        setHibernated(false);
      }
      return undefined;
    }

    if (effectivelyVisibleForHibernate) {
      if (hibernated) {
        updateElectronBrowserTab(tabId, { hibernated: false });
        setHibernated(false);
      }
      return undefined;
    }

    if (hibernated) {
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        let dataUrl: string | null = null;
        try {
          const frame =
            await getDesktopShell().invoke<FreezeThumbnailPayload | null>(
              'electron_browser_capture_thumbnail',
              { tabId }
            );
          if (frame?.data) {
            const mime = frame.mime || 'image/jpeg';
            dataUrl = `data:${mime};base64,${frame.data}`;
          }
        } catch {
          // Hibernation proceeds even if thumbnail capture is unavailable.
        }
        if (cancelled) return;
        setHibernatedSnapshot(dataUrl);
        updateElectronBrowserTab(tabId, { hibernated: true });
        setHibernated(true);
      })();
    }, hibernateDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    canHibernate,
    effectivelyVisibleForHibernate,
    hibernateDelayMs,
    hibernated,
    surfaceHost,
    tabId,
    url,
  ]);

  // Dockview surface lease: synchronize slot geometry -> root ElectronBrowserHost.
  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el || hibernated || renderInline) {
      leaseRef.current?.release();
      leaseRef.current = null;
      return undefined;
    }

    let lease = acquireElectronBrowserSurface(tabId);
    leaseRef.current = lease;

    const syncGeometry = () => {
      const target = slotRef.current;
      if (!target) return;

      const domRect = target.getBoundingClientRect();
      const rect: ElectronBrowserRect = {
        x: Math.round(domRect.x),
        y: Math.round(domRect.y),
        width: Math.max(0, Math.round(domRect.width)),
        height: Math.max(0, Math.round(domRect.height)),
      };
      const clipRect = resolveStageClipRect(target, 'dockview');
      const zIndex = resolveHostBrowserZIndex(
        'dockview',
        surfaceZIndexRef.current
      );
      const cornerRadius = resolveDockviewCornerRadius(target);
      const intersectsStage = isSurfaceRectIntersectingClip(rect, clipRect, 0);
      const visible =
        panelVisibleRef.current &&
        !hibernatedRef.current &&
        rect.width > 0 &&
        rect.height > 0 &&
        intersectsStage;

      const presented = lease.present({
        rect,
        clipRect,
        visible,
        scale: 1,
        zIndex,
        cornerRadius,
        interactive: visible,
        surfaceHost: 'dockview',
        slotElement: target,
      });
      if (visible && !presented) {
        lease.release();
        lease = acquireElectronBrowserSurface(tabId);
        leaseRef.current = lease;
        lease.present({
          rect,
          clipRect,
          visible,
          scale: 1,
          zIndex,
          cornerRadius,
          interactive: visible,
          surfaceHost: 'dockview',
          slotElement: target,
        });
      }
    };

    syncGeometry();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(syncGeometry)
        : null;
    if (resizeObserver) {
      resizeObserver.observe(el);
      const groupEl = el.closest('.dv-groupview');
      if (groupEl) resizeObserver.observe(groupEl);
      const stageEl = el.closest('.workspace-stage-host');
      if (stageEl) resizeObserver.observe(stageEl);
    }

    window.addEventListener('resize', syncGeometry);
    window.addEventListener('scroll', syncGeometry, true);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', syncGeometry);
      window.removeEventListener('scroll', syncGeometry, true);
      lease.release();
      if (leaseRef.current === lease) {
        leaseRef.current = null;
      }
    };
  }, [
    backgroundColor,
    hibernated,
    panelVisible,
    renderInline,
    surfaceZIndex,
    tabId,
  ]);

  if (hibernated) {
    return (
      <button
        type="button"
        data-testid="electron-browser-hibernated"
        onClick={() => {
          updateElectronBrowserTab(tabId, { hibernated: false });
          setHibernated(false);
        }}
        className="relative block h-full w-full cursor-pointer overflow-hidden border-0 bg-background p-0 text-left"
      >
        {hibernatedSnapshot ? (
          <img
            src={hibernatedSnapshot}
            alt=""
            draggable={false}
            className="h-full w-full select-none object-cover opacity-90"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            {lastUrlRef.current}
          </div>
        )}
      </button>
    );
  }

  return (
    <div
      ref={slotRef}
      data-testid="electron-browser-surface-slot"
      data-browser-surface-slot={tabId}
      data-surface-host={surfaceHost}
      className="relative flex h-full w-full overflow-hidden"
    >
      {renderInline ? (
        <HostedElectronBrowserWebview
          tabId={tabId}
          inlineFallback
          panelVisible={panelVisible}
          surfaceHost={surfaceHost}
        />
      ) : null}
    </div>
  );
}
