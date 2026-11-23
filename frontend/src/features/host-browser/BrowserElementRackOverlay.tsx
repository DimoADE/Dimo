import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Layers, Minus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { cn } from '@/lib/utils';
import type { BrowserSurfaceHost } from './browserPanelLifetime';
import {
  clearBrowserElementDrag,
  clearStagedBrowserElements,
  dispatchBrowserElementDrop,
  removeStagedBrowserElement,
  startBrowserElementDrag,
  updateBrowserElementDragPointer,
  useBrowserElementRackStore,
  type StagedBrowserElement,
} from './browserElementRack';
import { setBrowserOverlayDragging } from './electronBrowserSurfaceStore';

const PANEL_WIDTH = 224;
const HEADER_HEIGHT = 30;
const ROW_HEIGHT = 34;
const ROW_GAP = 4;
const LIST_PADDING_Y = 12;
const RESIZE_HANDLE_HEIGHT = 10;
const DEFAULT_VISIBLE_ROWS = 3;

export const DEFAULT_RACK_PANEL_HEIGHT =
  HEADER_HEIGHT +
  DEFAULT_VISIBLE_ROWS * ROW_HEIGHT +
  (DEFAULT_VISIBLE_ROWS - 1) * ROW_GAP +
  LIST_PADDING_Y +
  RESIZE_HANDLE_HEIGHT;

export const MIN_RACK_PANEL_HEIGHT =
  HEADER_HEIGHT + ROW_HEIGHT + LIST_PADDING_Y + RESIZE_HANDLE_HEIGHT;

const BALL_SIZE = 40;
const PAGE_INSET = 10;
const CHIP_DRAG_THRESHOLD_PX = 5;
const PANEL_DRAG_THRESHOLD_PX = 4;
const BALL_DRAG_THRESHOLD_PX = 4;

interface BoundsRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface SurfaceBounds {
  bounds: BoundsRect;
  scaleX: number;
  scaleY: number;
  visible: boolean;
}

interface RackLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface BrowserElementRackOverlayProps {
  tabId: string;
  surfaceHost: BrowserSurfaceHost;
  hostRef: RefObject<HTMLElement | null>;
  panelVisible?: boolean;
}

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(min, value), max);
}

function makeBounds(
  left: number,
  top: number,
  right: number,
  bottom: number
): BoundsRect {
  const safeRight = Math.max(left, right);
  const safeBottom = Math.max(top, bottom);
  return {
    left,
    top,
    right: safeRight,
    bottom: safeBottom,
    width: safeRight - left,
    height: safeBottom - top,
  };
}

function clampRectWithinBounds(
  desiredX: number,
  desiredY: number,
  desiredWidth: number,
  desiredHeight: number,
  bounds: BoundsRect
): { x: number; y: number; width: number; height: number } {
  const maxWidth = Math.max(1, Math.floor(bounds.width));
  const maxHeight = Math.max(1, Math.floor(bounds.height));
  const width = Math.min(Math.round(desiredWidth), maxWidth);
  const height = Math.min(Math.round(desiredHeight), maxHeight);

  const insetX =
    bounds.width >= width + PAGE_INSET * 2
      ? PAGE_INSET
      : Math.max(0, Math.floor((bounds.width - width) / 2));
  const insetY =
    bounds.height >= height + PAGE_INSET * 2
      ? PAGE_INSET
      : Math.max(0, Math.floor((bounds.height - height) / 2));

  const minX = bounds.left + insetX;
  const maxX = Math.max(minX, bounds.right - width - insetX);
  const minY = bounds.top + insetY;
  const maxY = Math.max(minY, bounds.bottom - height - insetY);

  return {
    x: Math.round(clampNumber(desiredX, minX, maxX)),
    y: Math.round(clampNumber(desiredY, minY, maxY)),
    width,
    height,
  };
}

function splitChipLabel(label: string): { prefix: string; name: string } {
  if (label.startsWith('@') && label.length > 1) {
    return { prefix: '@', name: label.slice(1) };
  }
  return { prefix: '', name: label };
}

export function BrowserElementRackOverlay({
  tabId,
  surfaceHost,
  hostRef,
  panelVisible = true,
}: BrowserElementRackOverlayProps) {
  const { t } = useTranslation('panels');
  const allItems = useBrowserElementRackStore((state) => state.items);
  const items = useMemo(
    () => allItems.filter((item) => item.tabId === tabId),
    [allItems, tabId]
  );

  // On Infinite Canvas, `<webview>` renders inline inside `hostRef`, so placing
  // the rack inline (`position: absolute`) makes it a pure DOM child of the
  // browser node with native transforms, native clipping, and single-boundary
  // clamping to the browser node itself.
  // In Dockview, `<webview>` is mounted at the app root (`z-20`), so the rack
  // portals to `document.body` (`z-1200`) while staying owned by HostBrowserPanel
  // and bounded strictly by the browser tab's own `hostRef` rect.
  const isInline = surfaceHost === 'canvas';

  const rackRef = useRef<HTMLDivElement | null>(null);
  const relOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const collapsedRef = useRef(false);
  collapsedRef.current = collapsed;

  const [desiredPanelHeight, setDesiredPanelHeight] = useState(
    DEFAULT_RACK_PANEL_HEIGHT
  );
  const desiredPanelHeightRef = useRef(DEFAULT_RACK_PANEL_HEIGHT);
  desiredPanelHeightRef.current = desiredPanelHeight;

  const [layout, setLayout] = useState<RackLayout>({
    x: PAGE_INSET,
    y: PAGE_INSET,
    width: PANEL_WIDTH,
    height: DEFAULT_RACK_PANEL_HEIGHT,
    visible: false,
  });
  const layoutRef = useRef<RackLayout>(layout);
  layoutRef.current = layout;

  const [isMovingRack, setIsMovingRack] = useState(false);
  const [isResizingRack, setIsResizingRack] = useState(false);
  const [draggingChip, setDraggingChip] = useState<{
    item: StagedBrowserElement;
    x: number;
    y: number;
  } | null>(null);

  // Reset layout state whenever this tab's staged list empties.
  useEffect(() => {
    if (items.length === 0) {
      relOffsetRef.current = null;
      collapsedRef.current = false;
      setCollapsed(false);
      desiredPanelHeightRef.current = DEFAULT_RACK_PANEL_HEIGHT;
      setDesiredPanelHeight(DEFAULT_RACK_PANEL_HEIGHT);
    }
  }, [items.length]);

  const resolveSurfaceBounds = useCallback((): SurfaceBounds | null => {
    const hostEl =
      hostRef.current ?? (isInline ? rackRef.current?.parentElement : null);
    if (!hostEl || !hostEl.isConnected) {
      return null;
    }
    const domRect = hostEl.getBoundingClientRect();
    if (isInline) {
      const localWidth =
        hostEl.clientWidth > 0 ? hostEl.clientWidth : domRect.width;
      const localHeight =
        hostEl.clientHeight > 0 ? hostEl.clientHeight : domRect.height;
      if (localWidth <= 0 || localHeight <= 0) {
        return null;
      }
      const scaleX =
        hostEl.clientWidth > 0 && domRect.width > 0
          ? domRect.width / hostEl.clientWidth
          : 1;
      const scaleY =
        hostEl.clientHeight > 0 && domRect.height > 0
          ? domRect.height / hostEl.clientHeight
          : 1;
      const bounds = makeBounds(0, 0, localWidth, localHeight);
      return {
        bounds,
        scaleX: scaleX > 0.05 ? scaleX : 1,
        scaleY: scaleY > 0.05 ? scaleY : 1,
        visible:
          panelVisible &&
          bounds.width >= BALL_SIZE &&
          bounds.height >= BALL_SIZE,
      };
    }

    if (domRect.width <= 0 || domRect.height <= 0) {
      return null;
    }
    const bounds = makeBounds(
      domRect.left,
      domRect.top,
      domRect.right,
      domRect.bottom
    );
    return {
      bounds,
      scaleX: 1,
      scaleY: 1,
      visible:
        panelVisible && bounds.width >= BALL_SIZE && bounds.height >= BALL_SIZE,
    };
  }, [hostRef, isInline, panelVisible]);

  const computeCurrentLayout = useCallback(
    (
      nextCollapsed = collapsedRef.current,
      nextPanelHeight = desiredPanelHeightRef.current
    ): RackLayout => {
      const surface = resolveSurfaceBounds();
      const targetWidth = nextCollapsed ? BALL_SIZE : PANEL_WIDTH;
      const targetHeight = nextCollapsed ? BALL_SIZE : nextPanelHeight;

      if (!surface) {
        return {
          x: PAGE_INSET,
          y: PAGE_INSET,
          width: targetWidth,
          height: targetHeight,
          visible: false,
        };
      }

      const { bounds, visible } = surface;
      const rel = relOffsetRef.current;
      const desiredX = rel
        ? bounds.left + rel.x
        : bounds.right - targetWidth - PAGE_INSET;
      const desiredY = rel ? bounds.top + rel.y : bounds.top + PAGE_INSET;

      const clamped = clampRectWithinBounds(
        desiredX,
        desiredY,
        targetWidth,
        targetHeight,
        bounds
      );
      return {
        ...clamped,
        visible,
      };
    },
    [resolveSurfaceBounds]
  );

  const syncLayout = useCallback(() => {
    const next = computeCurrentLayout();
    layoutRef.current = next;
    setLayout((prev) =>
      prev.x === next.x &&
      prev.y === next.y &&
      prev.width === next.width &&
      prev.height === next.height &&
      prev.visible === next.visible
        ? prev
        : next
    );
  }, [computeCurrentLayout]);

  useLayoutEffect(() => {
    if (!panelVisible || items.length === 0) return;
    syncLayout();
  }, [collapsed, desiredPanelHeight, items.length, panelVisible, syncLayout]);

  // Re-clamp when the browser page itself resizes (and in Dockview portal mode,
  // when window layout/scroll shifts the tab slot). Also sync once after mount
  // because parent DOM refs attach after child layout effects on initial render.
  useEffect(() => {
    if (!panelVisible || items.length === 0) return undefined;
    syncLayout();
    const hostEl =
      hostRef.current ?? (isInline ? rackRef.current?.parentElement : null);
    const resizeObserver =
      hostEl && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            syncLayout();
          })
        : null;
    if (hostEl && resizeObserver) {
      resizeObserver.observe(hostEl);
    }

    if (isInline) {
      return () => {
        resizeObserver?.disconnect();
      };
    }

    const onViewportChange = () => {
      syncLayout();
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [hostRef, isInline, items.length, panelVisible, syncLayout]);

  // Safety cleanup if unmounted mid-drag.
  useEffect(() => {
    return () => {
      setBrowserOverlayDragging(false);
      clearBrowserElementDrag();
    };
  }, []);

  const handleCollapseToBall = useCallback(() => {
    const surface = resolveSurfaceBounds();
    if (!surface) {
      collapsedRef.current = true;
      setCollapsed(true);
      return;
    }
    const { bounds, visible } = surface;
    const current = layoutRef.current;
    const onRightHalf =
      current.x + current.width / 2 >= bounds.left + bounds.width / 2;
    const desiredBallX = onRightHalf
      ? current.x + current.width - BALL_SIZE
      : current.x;
    const desiredBallY = current.y;
    const clamped = clampRectWithinBounds(
      desiredBallX,
      desiredBallY,
      BALL_SIZE,
      BALL_SIZE,
      bounds
    );
    relOffsetRef.current = {
      x: clamped.x - bounds.left,
      y: clamped.y - bounds.top,
    };
    collapsedRef.current = true;
    setCollapsed(true);
    const nextLayout: RackLayout = { ...clamped, visible };
    layoutRef.current = nextLayout;
    setLayout(nextLayout);
  }, [resolveSurfaceBounds]);

  const handleExpandFromBall = useCallback(() => {
    const surface = resolveSurfaceBounds();
    if (!surface) {
      collapsedRef.current = false;
      setCollapsed(false);
      return;
    }
    const { bounds, visible } = surface;
    const ball = layoutRef.current;
    const targetWidth = Math.min(
      PANEL_WIDTH,
      Math.max(1, Math.floor(bounds.width))
    );
    const targetHeight = Math.min(
      desiredPanelHeightRef.current,
      Math.max(1, Math.floor(bounds.height))
    );

    const onRightHalf =
      ball.x + ball.width / 2 >= bounds.left + bounds.width / 2;
    const onBottomHalf =
      ball.y + ball.height / 2 >= bounds.top + bounds.height / 2;

    const desiredX = onRightHalf ? ball.x + ball.width - targetWidth : ball.x;
    const desiredY = onBottomHalf
      ? ball.y + ball.height - targetHeight
      : ball.y;

    const clamped = clampRectWithinBounds(
      desiredX,
      desiredY,
      targetWidth,
      targetHeight,
      bounds
    );
    relOffsetRef.current = {
      x: clamped.x - bounds.left,
      y: clamped.y - bounds.top,
    };
    collapsedRef.current = false;
    setCollapsed(false);
    const nextLayout: RackLayout = { ...clamped, visible };
    layoutRef.current = nextLayout;
    setLayout(nextLayout);
  }, [resolveSurfaceBounds]);

  const handlePanelPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-rack-chip], [data-rack-resize], button')) {
        return;
      }
      // Do NOT call event.preventDefault() here: canceling pointerdown suppresses
      // compatibility mousedown/dblclick events in Chromium, breaking header
      // double-click-to-collapse. Text selection is disabled via `select-none`.
      event.stopPropagation();

      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const startX = layoutRef.current.x;
      const startY = layoutRef.current.y;
      let moved = false;

      const onMove = (moveEvent: PointerEvent) => {
        if (
          !moved &&
          Math.hypot(
            moveEvent.clientX - startClientX,
            moveEvent.clientY - startClientY
          ) < PANEL_DRAG_THRESHOLD_PX
        ) {
          return;
        }
        if (!moved) {
          moved = true;
          setIsMovingRack(true);
          setBrowserOverlayDragging(true);
        }
        const surface = resolveSurfaceBounds();
        if (!surface) return;
        const { bounds, scaleX, scaleY, visible } = surface;
        const desiredX = startX + (moveEvent.clientX - startClientX) / scaleX;
        const desiredY = startY + (moveEvent.clientY - startClientY) / scaleY;
        const clamped = clampRectWithinBounds(
          desiredX,
          desiredY,
          PANEL_WIDTH,
          desiredPanelHeightRef.current,
          bounds
        );
        relOffsetRef.current = {
          x: clamped.x - bounds.left,
          y: clamped.y - bounds.top,
        };
        const nextLayout: RackLayout = { ...clamped, visible };
        layoutRef.current = nextLayout;
        setLayout(nextLayout);
      };

      const onEnd = () => {
        if (moved) {
          setIsMovingRack(false);
          setBrowserOverlayDragging(false);
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    [resolveSurfaceBounds]
  );

  const handleBallPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const startX = layoutRef.current.x;
      const startY = layoutRef.current.y;
      let moved = false;
      setBrowserOverlayDragging(true);

      const onMove = (moveEvent: PointerEvent) => {
        if (
          !moved &&
          Math.hypot(
            moveEvent.clientX - startClientX,
            moveEvent.clientY - startClientY
          ) < BALL_DRAG_THRESHOLD_PX
        ) {
          return;
        }
        if (!moved) {
          moved = true;
          setIsMovingRack(true);
        }
        const surface = resolveSurfaceBounds();
        if (!surface) return;
        const { bounds, scaleX, scaleY, visible } = surface;
        const desiredX = startX + (moveEvent.clientX - startClientX) / scaleX;
        const desiredY = startY + (moveEvent.clientY - startClientY) / scaleY;
        const clamped = clampRectWithinBounds(
          desiredX,
          desiredY,
          BALL_SIZE,
          BALL_SIZE,
          bounds
        );
        relOffsetRef.current = {
          x: clamped.x - bounds.left,
          y: clamped.y - bounds.top,
        };
        const nextLayout: RackLayout = { ...clamped, visible };
        layoutRef.current = nextLayout;
        setLayout(nextLayout);
      };

      const onEnd = (endEvent: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        setIsMovingRack(false);
        setBrowserOverlayDragging(false);
        if (!moved && endEvent.type === 'pointerup') {
          handleExpandFromBall();
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    [handleExpandFromBall, resolveSurfaceBounds]
  );

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const startClientY = event.clientY;
      const startHeight = layoutRef.current.height;
      const fixedTop = layoutRef.current.y;
      setIsResizingRack(true);
      setBrowserOverlayDragging(true);

      const onMove = (moveEvent: PointerEvent) => {
        const surface = resolveSurfaceBounds();
        if (!surface) return;
        const { bounds, scaleY, visible } = surface;
        const insetY =
          bounds.height >= MIN_RACK_PANEL_HEIGHT + PAGE_INSET * 2
            ? PAGE_INSET
            : 0;
        const maxBelowTop = Math.floor(bounds.bottom - fixedTop - insetY);
        const maxInBounds = Math.floor(bounds.height - insetY * 2);
        const maxAllowed = Math.max(
          Math.min(MIN_RACK_PANEL_HEIGHT, maxInBounds),
          Math.min(maxBelowTop, maxInBounds)
        );
        const minAllowed = Math.min(MIN_RACK_PANEL_HEIGHT, maxAllowed);
        const rawHeight =
          startHeight + (moveEvent.clientY - startClientY) / scaleY;
        const nextHeight = Math.round(
          clampNumber(rawHeight, minAllowed, maxAllowed)
        );
        desiredPanelHeightRef.current = nextHeight;
        setDesiredPanelHeight(nextHeight);

        const clamped = clampRectWithinBounds(
          layoutRef.current.x,
          fixedTop,
          PANEL_WIDTH,
          nextHeight,
          bounds
        );
        relOffsetRef.current = {
          x: clamped.x - bounds.left,
          y: clamped.y - bounds.top,
        };
        const nextLayout: RackLayout = { ...clamped, visible };
        layoutRef.current = nextLayout;
        setLayout(nextLayout);
      };

      const onEnd = () => {
        setIsResizingRack(false);
        setBrowserOverlayDragging(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    [resolveSurfaceBounds]
  );

  const handleHeaderDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('button')) return;
      event.stopPropagation();
      handleCollapseToBall();
    },
    [handleCollapseToBall]
  );

  const handleChipPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, item: StagedBrowserElement) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('button')) return;
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      setBrowserOverlayDragging(true);

      const onMove = (moveEvent: PointerEvent) => {
        if (
          !active &&
          Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) <
            CHIP_DRAG_THRESHOLD_PX
        ) {
          return;
        }
        if (!active) {
          active = true;
          startBrowserElementDrag(item, {
            x: moveEvent.clientX,
            y: moveEvent.clientY,
          });
        } else {
          updateBrowserElementDragPointer({
            x: moveEvent.clientX,
            y: moveEvent.clientY,
          });
        }
        setDraggingChip({
          item,
          x: moveEvent.clientX,
          y: moveEvent.clientY,
        });
      };

      const onEnd = (endEvent: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);

        setDraggingChip(null);
        setBrowserOverlayDragging(false);

        if (active && endEvent.type === 'pointerup') {
          const rackNode = rackRef.current;
          const prevPointerEvents = rackNode?.style.pointerEvents ?? '';
          if (rackNode) rackNode.style.pointerEvents = 'none';
          const dropped = dispatchBrowserElementDrop(
            endEvent.clientX,
            endEvent.clientY,
            item
          );
          if (rackNode) rackNode.style.pointerEvents = prevPointerEvents;
          if (dropped && !endEvent.altKey) {
            removeStagedBrowserElement(item.id);
          }
        }
        clearBrowserElementDrag();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    []
  );

  if (!panelVisible || items.length === 0) {
    return null;
  }

  const ghostParts = draggingChip
    ? splitChipLabel(draggingChip.item.label)
    : null;
  const isInteracting = isMovingRack || isResizingRack || Boolean(draggingChip);
  const positionClass = isInline ? 'absolute z-30' : 'fixed z-[1200]';

  const rackElement = collapsed ? (
    <div
      ref={rackRef}
      data-testid="browser-element-rack"
      data-collapsed="true"
      data-surface-host={surfaceHost}
      style={{
        left: `${layout.x}px`,
        top: `${layout.y}px`,
        width: `${layout.width}px`,
        height: `${layout.height}px`,
        ...(layout.visible
          ? {}
          : { opacity: 0, pointerEvents: 'none' as const }),
      }}
      className={cn('nodrag nopan nowheel select-none', positionClass)}
    >
      {isInteracting ? <NativeSurfaceOcclusionHold /> : null}
      <button
        type="button"
        data-testid="browser-element-rack-ball"
        aria-label={t('browserPanel.elementRackExpand', {
          count: items.length,
        })}
        title={t('browserPanel.elementRackExpand', { count: items.length })}
        onPointerDown={handleBallPointerDown}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleExpandFromBall();
          }
        }}
        className={cn(
          'relative flex h-full w-full items-center justify-center rounded-full border border-border/50 bg-[hsl(var(--popover)/0.84)] shadow-[var(--shadow-floating-bar)] ring-1 ring-inset ring-foreground/[0.05] backdrop-blur-2xl backdrop-saturate-150 transition-[box-shadow,border-color,transform] duration-150',
          isMovingRack
            ? 'scale-[1.04] cursor-grabbing border-[hsl(var(--live-read)/0.55)] shadow-[var(--shadow-popover)]'
            : 'cursor-grab hover:border-[hsl(var(--live-read)/0.5)] hover:shadow-[var(--shadow-popover)]'
        )}
      >
        <Layers className="h-4 w-4 text-[color:hsl(var(--live-read))]" />
        <span
          data-testid="browser-element-rack-ball-count"
          className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[hsl(var(--live-read))] px-1 font-mono text-[10px] font-semibold leading-none text-primary-foreground shadow-[var(--shadow-card)] tabular-nums"
        >
          {items.length}
        </span>
      </button>
    </div>
  ) : (
    <div
      ref={rackRef}
      role="region"
      aria-label={t('browserPanel.elementRack')}
      data-testid="browser-element-rack"
      data-collapsed="false"
      data-surface-host={surfaceHost}
      onPointerDown={handlePanelPointerDown}
      style={{
        left: `${layout.x}px`,
        top: `${layout.y}px`,
        width: `${layout.width}px`,
        height: `${layout.height}px`,
        ...(layout.visible
          ? {}
          : { opacity: 0, pointerEvents: 'none' as const }),
      }}
      className={cn(
        'nodrag nopan nowheel flex select-none flex-col overflow-hidden rounded-xl border border-border/50 bg-[hsl(var(--popover)/0.78)] shadow-[var(--shadow-floating-bar)] ring-1 ring-inset ring-foreground/[0.04] backdrop-blur-2xl backdrop-saturate-150 transition-[box-shadow,border-color] duration-150',
        positionClass,
        isMovingRack || isResizingRack
          ? 'border-[hsl(var(--live-read)/0.5)] shadow-[var(--shadow-popover)]'
          : 'hover:border-border/75'
      )}
    >
      {isInteracting ? <NativeSurfaceOcclusionHold /> : null}
      <div
        data-testid="browser-element-rack-header"
        title={t('browserPanel.elementRackDragHint')}
        onDoubleClick={handleHeaderDoubleClick}
        className={cn(
          'flex h-[30px] shrink-0 items-center justify-between gap-2 border-b border-border/35 px-2.5',
          isMovingRack ? 'cursor-grabbing' : 'cursor-grab'
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--live-read))]"
          />
          <span className="truncate text-[11.5px] font-medium tracking-[-0.01em] text-foreground/90">
            {t('browserPanel.elementRack')}
          </span>
          <span className="shrink-0 rounded-full bg-muted/70 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-muted-foreground tabular-nums">
            {items.length}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {items.length >= 2 ? (
            <button
              type="button"
              data-testid="browser-element-rack-clear"
              aria-label={t('browserPanel.elementRackClear')}
              title={t('browserPanel.elementRackClear')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                clearStagedBrowserElements(tabId);
              }}
              className="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground/75 transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          ) : null}
          <button
            type="button"
            data-testid="browser-element-rack-collapse"
            aria-label={t('browserPanel.elementRackCollapse')}
            title={t('browserPanel.elementRackCollapse')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              handleCollapseToBall();
            }}
            className="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-accent/70 hover:text-foreground"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div
        data-testid="browser-element-rack-list"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 py-1.5 [scrollbar-width:thin]"
      >
        {items.map((item) => {
          const isDraggingThis = draggingChip?.item.id === item.id;
          const { prefix, name } = splitChipLabel(item.label);
          const chipTitle = [item.description, item.selector]
            .filter(Boolean)
            .join(' · ');
          const secondaryText =
            item.description &&
            item.description.trim() !== name &&
            item.description.trim() !== item.label
              ? item.description.trim()
              : '';

          return (
            <div
              key={item.id}
              data-rack-chip=""
              data-testid="browser-element-rack-chip"
              title={chipTitle || item.label}
              onPointerDown={(event) => handleChipPointerDown(event, item)}
              className={cn(
                'group/chip flex h-[34px] shrink-0 cursor-grab items-center gap-2 rounded-lg border border-border/45 bg-[hsl(var(--card)/0.9)] px-2.5 shadow-[var(--shadow-card)] transition-[opacity,border-color,background-color] duration-150 hover:border-[hsl(var(--live-read)/0.45)] hover:bg-[hsl(var(--card))] active:cursor-grabbing',
                isDraggingThis && 'border-dashed opacity-30'
              )}
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--live-read))]"
              />
              <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="shrink-0 font-mono text-[11.5px] font-medium leading-none tracking-[-0.01em] text-foreground">
                  {prefix ? (
                    <span className="text-[color:hsl(var(--live-read))]">
                      {prefix}
                    </span>
                  ) : null}
                  {name}
                </span>
                {secondaryText ? (
                  <span className="min-w-0 truncate text-[10.5px] leading-none text-muted-foreground/75">
                    {secondaryText}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                data-testid="browser-element-rack-remove"
                aria-label={t('browserPanel.elementRackRemove', {
                  label: item.label,
                })}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  removeStagedBrowserElement(item.id);
                }}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/45 transition-colors group-hover/chip:text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div
        data-rack-resize=""
        data-testid="browser-element-rack-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('browserPanel.elementRackResize')}
        title={t('browserPanel.elementRackResize')}
        onPointerDown={handleResizePointerDown}
        className="group/resize flex h-[10px] shrink-0 cursor-ns-resize items-center justify-center border-t border-border/25"
      >
        <span
          aria-hidden="true"
          className="h-[3px] w-7 rounded-full bg-muted-foreground/25 transition-colors group-hover/resize:bg-foreground/45"
        />
      </div>
    </div>
  );

  const ghostElement =
    draggingChip && ghostParts ? (
      <div
        data-testid="browser-element-rack-ghost"
        style={{
          left: `${draggingChip.x}px`,
          top: `${draggingChip.y}px`,
        }}
        className="pointer-events-none fixed z-[9999] inline-flex h-8 -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-lg border border-[hsl(var(--live-read)/0.5)] bg-[hsl(var(--popover)/0.9)] pl-2.5 pr-2.5 font-mono text-[11.5px] font-medium text-foreground shadow-[var(--shadow-popover)] backdrop-blur-xl backdrop-saturate-150"
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--live-read))]"
        />
        <span className="leading-none">
          {ghostParts.prefix ? (
            <span className="text-[color:hsl(var(--live-read))]">
              {ghostParts.prefix}
            </span>
          ) : null}
          {ghostParts.name}
        </span>
        {draggingChip.item.description ? (
          <span className="max-w-[140px] truncate font-sans text-[11px] font-normal text-muted-foreground">
            {draggingChip.item.description}
          </span>
        ) : null}
      </div>
    ) : null;

  const canPortal = typeof document !== 'undefined' && Boolean(document.body);

  return (
    <>
      {isInline
        ? rackElement
        : canPortal
          ? createPortal(rackElement, document.body)
          : rackElement}
      {ghostElement && canPortal
        ? createPortal(ghostElement, document.body)
        : ghostElement}
    </>
  );
}
