import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getDesktopShell } from '@/lib/desktopShell';
import type { BrowserSurfaceHost } from './browserPanelLifetime';
import {
  canvasLayerCoversBrowser,
  clipBrowserSurfaceRect,
} from './browserSurfaceBounds';
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

function resolveCornerRadius(
  element: HTMLElement,
  surfaceHost: BrowserSurfaceHost
): number {
  if (surfaceHost === 'canvas') {
    return 12;
  }
  const group = element.closest('.dv-groupview') as HTMLElement | null;
  if (!group) return 0;
  const isBottomCorner =
    group.getAttribute('data-stage-bottommost') === 'true' &&
    (group.getAttribute('data-stage-leftmost') === 'true' ||
      group.getAttribute('data-stage-rightmost') === 'true');
  return isBottomCorner ? 14 : 0;
}

function measureSlotScale(
  element: HTMLElement,
  rect: DOMRect,
  surfaceHost: BrowserSurfaceHost
): number {
  if (surfaceHost !== 'canvas') {
    return 1;
  }
  if (element.offsetWidth > 1 && rect.width > 1) {
    const ratio = rect.width / element.offsetWidth;
    if (Number.isFinite(ratio) && ratio > 0.05 && ratio < 10) {
      return ratio;
    }
  }
  return useElectronBrowserSurfaceStore.getState().canvasZoom || 1;
}

/**
 * Slot controller for an Electron Host Browser surface.
 *
 * When `<ElectronBrowserHost />` is mounted at app root, this component renders
 * only a lightweight placeholder slot and leases the persistent root-mounted
 * `<webview>` to overlay this slot's geometry (with stage clipping, canvas zoom
 * scaling, occlusion freeze fallback, and true offscreen-viewport hibernation).
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
  const [occluded, setOccluded] = useState(false);
  const [occlusionSnapshot, setOcclusionSnapshot] = useState<string | null>(
    null
  );
  const [occlusionCaptureNonce, setOcclusionCaptureNonce] = useState(0);
  const [inCanvasViewport, setInCanvasViewport] = useState(true);

  const occludedRef = useRef(false);
  occludedRef.current = occluded;
  const occlusionCaptureInFlightRef = useRef(false);
  const lastCapturedOcclusionKeyRef = useRef<string | null>(null);
  const hibernatedRef = useRef(false);
  hibernatedRef.current = hibernated;
  const panelVisibleRef = useRef(panelVisible);
  panelVisibleRef.current = panelVisible;
  const surfaceHostRef = useRef(surfaceHost);
  surfaceHostRef.current = surfaceHost;
  const surfaceZIndexRef = useRef(surfaceZIndex);
  surfaceZIndexRef.current = surfaceZIndex;
  const backgroundColorRef = useRef(backgroundColor);
  backgroundColorRef.current = backgroundColor;

  useEffect(() => {
    if (url && url.trim().length > 0) {
      lastUrlRef.current = url;
    }
  }, [url]);

  // Register tab in root host store & keep metadata synced.
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
    });
  }, [backgroundColor, hibernated, profileId, tabId, url]);

  // Register callbacks for history, guest pointerdown, and load completion notifications.
  useEffect(() => {
    const callbacks = {
      onHistoryAvailabilityChange,
      onPointerDown: onSurfacePointerDown,
      onLoadFinished: () => {
        if (
          occludedRef.current &&
          surfaceHostRef.current === 'canvas' &&
          !hibernatedRef.current
        ) {
          setOcclusionCaptureNonce((prev) => prev + 1);
        }
      },
    };
    return registerElectronBrowserCallbacks(tabId, callbacks);
  }, [onHistoryAvailabilityChange, onSurfacePointerDown, tabId]);

  // Reset local hibernation/occlusion state on logical tabId switch.
  useEffect(() => {
    const nextUrl = latestUrlPropRef.current || 'about:blank';
    setHibernated(false);
    setHibernatedSnapshot(null);
    setOccluded(false);
    setOcclusionSnapshot(null);
    setOcclusionCaptureNonce(0);
    lastCapturedOcclusionKeyRef.current = null;
    setInCanvasViewport(true);
    lastUrlRef.current = nextUrl;
  }, [tabId]);

  // Trigger a snapshot when a higher-z-index canvas node covers this browser card.
  useEffect(() => {
    if (!occluded || surfaceHost !== 'canvas' || hibernated) {
      lastCapturedOcclusionKeyRef.current = null;
      return undefined;
    }
    const captureKey = `${tabId}:${url}:${occlusionCaptureNonce}`;
    if (
      lastCapturedOcclusionKeyRef.current === captureKey ||
      occlusionCaptureInFlightRef.current
    ) {
      return undefined;
    }
    let cancelled = false;
    occlusionCaptureInFlightRef.current = true;
    void (async () => {
      try {
        const frame =
          await getDesktopShell().invoke<FreezeThumbnailPayload | null>(
            'electron_browser_capture_thumbnail',
            { tabId }
          );
        if (!cancelled && frame?.data) {
          const mime = frame.mime || 'image/jpeg';
          lastCapturedOcclusionKeyRef.current = captureKey;
          setOcclusionSnapshot(`data:${mime};base64,${frame.data}`);
        }
      } catch {
        // Proceed without snapshot if unavailable.
      } finally {
        occlusionCaptureInFlightRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hibernated, occluded, occlusionCaptureNonce, surfaceHost, tabId, url]);

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

  // Acquire surface lease and synchronize slot geometry -> root ElectronBrowserHost.
  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el || hibernated) {
      leaseRef.current?.release();
      leaseRef.current = null;
      return undefined;
    }

    let lease = acquireElectronBrowserSurface(tabId);
    leaseRef.current = lease;
    let rafId: number | null = null;

    const measureAndSync = (liveOnly: boolean) => {
      const target = slotRef.current;
      if (!target) return;

      const domRect = target.getBoundingClientRect();
      const rect: ElectronBrowserRect = {
        x: Math.round(domRect.x),
        y: Math.round(domRect.y),
        width: Math.max(0, Math.round(domRect.width)),
        height: Math.max(0, Math.round(domRect.height)),
      };
      const hostKind = surfaceHostRef.current;
      const clipRect = resolveStageClipRect(target, hostKind);
      const scale = measureSlotScale(target, domRect, hostKind);
      const zIndex = resolveHostBrowserZIndex(
        hostKind,
        surfaceZIndexRef.current
      );
      const cornerRadius = resolveCornerRadius(target, hostKind);

      let nextOccluded = false;
      if (hostKind === 'canvas' && rect.width > 1 && rect.height > 1) {
        const clipped = clipBrowserSurfaceRect(target, {
          left: domRect.left,
          top: domRect.top,
          right: domRect.right,
          bottom: domRect.bottom,
        });
        if (
          clipped.right - clipped.left >= 2 &&
          clipped.bottom - clipped.top >= 2
        ) {
          nextOccluded = canvasLayerCoversBrowser(target);
        }
      }
      if (nextOccluded !== occludedRef.current) {
        occludedRef.current = nextOccluded;
        setOccluded(nextOccluded);
        if (!nextOccluded) {
          setOcclusionSnapshot(null);
        }
      }

      const intersectsStage = isSurfaceRectIntersectingClip(rect, clipRect, 0);
      if (hostKind === 'canvas') {
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
      }

      const visible =
        panelVisibleRef.current &&
        !hibernatedRef.current &&
        !nextOccluded &&
        rect.width > 0 &&
        rect.height > 0 &&
        intersectsStage;

      const interactive =
        visible &&
        !(
          hostKind === 'canvas' &&
          useElectronBrowserSurfaceStore.getState().canvasInteracting
        );

      if (liveOnly) {
        lease.pushLive({
          rect,
          clipRect,
          visible,
          scale,
          zIndex,
          cornerRadius,
          interactive,
          backgroundColor: backgroundColorRef.current,
        });
        return;
      }

      const presented = lease.present({
        rect,
        clipRect,
        visible,
        scale,
        zIndex,
        cornerRadius,
        interactive,
        surfaceHost: hostKind,
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
          scale,
          zIndex,
          cornerRadius,
          interactive,
          surfaceHost: hostKind,
          slotElement: target,
        });
      }
    };

    const scheduleFullSync = () => {
      measureAndSync(false);
    };

    const scheduleLiveSync = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        measureAndSync(true);
      });
    };

    measureAndSync(false);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleFullSync)
        : null;
    if (resizeObserver) {
      resizeObserver.observe(el);
      const groupEl = el.closest('.dv-groupview');
      if (groupEl) resizeObserver.observe(groupEl);
      const stageEl = el.closest(
        '[data-testid="workspace-canvas-stage"], .workspace-stage-host'
      );
      if (stageEl) resizeObserver.observe(stageEl);
    }

    let canvasMutationObserver: MutationObserver | null = null;
    if (surfaceHost === 'canvas' && typeof MutationObserver !== 'undefined') {
      const flowRoot =
        el.closest('.react-flow') ?? el.closest('[data-canvas-surface]');
      if (flowRoot) {
        canvasMutationObserver = new MutationObserver((mutations) => {
          const interacting =
            useElectronBrowserSurfaceStore.getState().canvasInteracting;
          const liveTransformOnly =
            mutations.length > 0 &&
            mutations.every((mutation) => {
              if (
                mutation.type !== 'attributes' ||
                mutation.attributeName !== 'style' ||
                !(mutation.target instanceof Element)
              ) {
                return false;
              }
              if (mutation.target.classList.contains('react-flow__viewport')) {
                return true;
              }
              return (
                interacting &&
                mutation.target.classList.contains('react-flow__node')
              );
            });
          if (liveTransformOnly) {
            scheduleLiveSync();
            return;
          }
          scheduleFullSync();
        });
        canvasMutationObserver.observe(flowRoot, {
          attributes: true,
          attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
          childList: true,
          subtree: true,
        });
      }
    }

    const unsubscribeCanvasViewport =
      surfaceHost === 'canvas'
        ? subscribeCanvasBrowserViewportChange(scheduleLiveSync)
        : undefined;

    window.addEventListener('resize', scheduleFullSync);
    window.addEventListener('scroll', scheduleFullSync, true);

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      resizeObserver?.disconnect();
      canvasMutationObserver?.disconnect();
      unsubscribeCanvasViewport?.();
      window.removeEventListener('resize', scheduleFullSync);
      window.removeEventListener('scroll', scheduleFullSync, true);
      lease.release();
      if (leaseRef.current === lease) {
        leaseRef.current = null;
      }
    };
  }, [
    backgroundColor,
    hibernated,
    panelVisible,
    surfaceHost,
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
      data-occluded={occluded ? 'true' : 'false'}
      className="relative flex h-full w-full overflow-hidden"
    >
      {occluded && occlusionSnapshot ? (
        <img
          src={occlusionSnapshot}
          alt=""
          draggable={false}
          data-testid="electron-browser-occlusion-snapshot"
          className="pointer-events-none h-full w-full select-none object-cover"
        />
      ) : null}
      {!hostMounted ? (
        <HostedElectronBrowserWebview tabId={tabId} inlineFallback />
      ) : null}
    </div>
  );
}
