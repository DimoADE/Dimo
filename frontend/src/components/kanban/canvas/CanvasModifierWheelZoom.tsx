import { memo, useEffect, useRef } from 'react';
import { useReactFlow, useStore, type Viewport } from '@xyflow/react';
import { isMac } from '@/utils/platform';
import {
  isCanvasModifierZoomWheel,
  nextCanvasModifierZoom,
} from './canvasModifierZoom';

/**
 * React Flow refuses wheel gestures whose target sits inside `.nowheel`.
 * Expanded canvas nodes use that class so a plain scroll moves the thread
 * instead of the board. Capture Ctrl/Cmd+wheel on the flow root first and
 * zoom toward the pointer even when it is over a node.
 */
export const CanvasModifierWheelZoom = memo(function CanvasModifierWheelZoom({
  minZoom,
  maxZoom,
}: {
  minZoom: number;
  maxZoom: number;
}) {
  const { getViewport, setViewport } = useReactFlow();
  const domNode = useStore((state) => state.domNode);
  const getViewportRef = useRef(getViewport);
  const setViewportRef = useRef(setViewport);
  getViewportRef.current = getViewport;
  setViewportRef.current = setViewport;

  useEffect(() => {
    if (!domNode) return;

    let cachedBounds: DOMRect | null = null;
    let rafId: number | null = null;
    let lastAppliedViewport: Viewport | null = null;
    let pendingViewport: Viewport | null = null;

    const invalidateBounds = () => {
      cachedBounds = null;
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(invalidateBounds)
        : null;
    resizeObserver?.observe(domNode);
    window.addEventListener('resize', invalidateBounds);

    const flushZoomFrame = () => {
      rafId = null;
      const next = pendingViewport;
      pendingViewport = null;
      if (!next) {
        lastAppliedViewport = null;
        cachedBounds = null;
        return;
      }
      lastAppliedViewport = next;
      void setViewportRef.current(next);
      rafId = window.requestAnimationFrame(flushZoomFrame);
    };

    const onWheel = (event: WheelEvent) => {
      if (!isCanvasModifierZoomWheel(event)) return;
      event.preventDefault();
      event.stopPropagation();

      if (!cachedBounds) {
        cachedBounds = domNode.getBoundingClientRect();
      }
      const baseViewport =
        pendingViewport ?? lastAppliedViewport ?? getViewportRef.current();
      const next = nextCanvasModifierZoom({
        viewport: baseViewport,
        pointerX: event.clientX - cachedBounds.left,
        pointerY: event.clientY - cachedBounds.top,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        pinchBoost: event.ctrlKey && isMac(),
        minZoom,
        maxZoom,
      });

      if (rafId === null) {
        lastAppliedViewport = next;
        pendingViewport = null;
        void setViewportRef.current(next);
        rafId = window.requestAnimationFrame(flushZoomFrame);
      } else {
        pendingViewport = next;
      }
    };

    domNode.addEventListener('wheel', onWheel, {
      capture: true,
      passive: false,
    });
    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener('resize', invalidateBounds);
      domNode.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, [domNode, maxZoom, minZoom]);

  return null;
});
