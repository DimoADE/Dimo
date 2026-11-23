import { useEffect, useRef, type RefObject } from 'react';
import { CANVAS_DROP_IGNORE_SELECTOR } from '@/components/kanban/session-hub/sessionListDrag';
import { DRAG_HANDLE_SELECTOR } from './canvasModel';

const MIDDLE_BUTTON = 1;
const RIGHT_BUTTON = 2;
const RIGHT_BUTTON_MASK = 2;
const MIDDLE_CLICK_SLOP_PX = 6;
const RIGHT_PAN_SLOP_PX = 6;
const NODE_MENU_SELECTOR = `${DRAG_HANDLE_SELECTOR}, .canvas-node-context-menu`;

export type CanvasRightPanDelta = { x: number; y: number; gestureId: number };

function isSessionListEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest(CANVAS_DROP_IGNORE_SELECTOR))
    : false;
}

function isCanvasEventTarget(
  surface: HTMLElement,
  target: EventTarget | null
): boolean {
  if (!(target instanceof Element)) return false;
  if (isSessionListEventTarget(target)) return false;
  if (surface.contains(target)) return true;
  return Boolean(
    target.closest(
      '.react-flow, .react-flow__nodesselection, .react-flow__nodesselection-rect'
    )
  );
}

function isRightPanTarget(
  surface: HTMLElement,
  target: EventTarget | null
): boolean {
  if (!(target instanceof Element)) return false;
  if (!isCanvasEventTarget(surface, target)) return false;
  if (target.closest(NODE_MENU_SELECTOR)) return false;
  if (
    target.closest(
      'button, a, input, textarea, select, [role="menu"], [role="menuitem"], [contenteditable="true"]'
    )
  ) {
    return false;
  }
  if (target.closest('.react-flow__panel, .react-flow__minimap')) {
    return false;
  }
  return true;
}

/**
 * Own right-button pan in capture. React Flow cannot pan over `nopan`
 * cards, so this hook owns the gesture everywhere on the board except
 * chrome that has its own right-drag (panels, minimap, session list,
 * form controls). Codeg uses the same split: `panOnDrag={[]}` plus a
 * window-level mouse pan that starts on cards and empty canvas alike.
 *
 * Node headers and collapsed cards own their context menus. Other surfaces
 * pan only after slop; a short press on the canvas is a no-op.
 *
 * Middle-click must be claimed in capture: the selection overlay still
 * treats middle-press as a pan. WebKit may deliver the click as
 * `auxclick` instead of a paired pointerup.
 */
export function useCanvasRightDragPan(
  surfaceRef: RefObject<HTMLElement | null>,
  onMiddleClick?: (event: PointerEvent | MouseEvent) => void,
  onRightPan?: (delta: CanvasRightPanDelta) => void,
  onRightPanStateChange?: (panning: boolean) => void
): void {
  const onMiddleClickRef = useRef(onMiddleClick);
  onMiddleClickRef.current = onMiddleClick;
  const onRightPanRef = useRef(onRightPan);
  onRightPanRef.current = onRightPan;
  const onRightPanStateChangeRef = useRef(onRightPanStateChange);
  onRightPanStateChangeRef.current = onRightPanStateChange;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    let pendingMiddle = false;
    let middleStartX = 0;
    let middleStartY = 0;
    let rightGestureId = 0;
    let rightSession: {
      inputKind: 'pointer' | 'mouse';
      activePointerId: number | null;
      capturedPointerId: number | null;
      gestureId: number;
      startX: number;
      startY: number;
      panning: boolean;
      lastEmittedX: number;
      lastEmittedY: number;
      pendingDelta: { x: number; y: number } | null;
      rafId: number | null;
    } | null = null;

    const onContextMenu = (event: MouseEvent) => {
      if (isSessionListEventTarget(event.target)) return;
      if (
        event.target instanceof Element &&
        event.target.closest(NODE_MENU_SELECTOR)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    const isMiddleClick = (event: PointerEvent | MouseEvent) =>
      Math.hypot(event.clientX - middleStartX, event.clientY - middleStartY) <=
      MIDDLE_CLICK_SLOP_PX;

    const beginMiddle = (event: PointerEvent | MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON) return;
      if (!isCanvasEventTarget(surface, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      pendingMiddle = true;
      middleStartX = event.clientX;
      middleStartY = event.clientY;
    };

    const finishMiddle = (event: PointerEvent | MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON || !pendingMiddle) return;
      pendingMiddle = false;
      event.preventDefault();
      event.stopPropagation();
      if (!isMiddleClick(event)) return;
      onMiddleClickRef.current?.(event);
    };

    const onAuxClick = (event: MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON) return;
      if (!isCanvasEventTarget(surface, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!pendingMiddle || !isMiddleClick(event)) {
        pendingMiddle = false;
        return;
      }
      pendingMiddle = false;
      onMiddleClickRef.current?.(event);
    };

    const captureRightPointer = (event: PointerEvent | MouseEvent) => {
      if (!rightSession || !('pointerId' in event)) return;
      rightSession.activePointerId = event.pointerId;
      try {
        surface.setPointerCapture(event.pointerId);
        rightSession.capturedPointerId = event.pointerId;
      } catch {
        rightSession.capturedPointerId = null;
      }
    };

    const releaseRightPointer = () => {
      if (!rightSession || rightSession.capturedPointerId == null) return;
      if (surface.hasPointerCapture?.(rightSession.capturedPointerId)) {
        try {
          surface.releasePointerCapture(rightSession.capturedPointerId);
        } catch {
          /* already released */
        }
      }
    };

    const emitPanDelta = (
      session: NonNullable<typeof rightSession>,
      dx: number,
      dy: number
    ) => {
      if (dx === session.lastEmittedX && dy === session.lastEmittedY) {
        return;
      }
      session.lastEmittedX = dx;
      session.lastEmittedY = dy;
      onRightPanRef.current?.({
        x: dx,
        y: dy,
        gestureId: session.gestureId,
      });
    };

    const flushRightPanFrame = () => {
      const session = rightSession;
      if (!session) return;
      session.rafId = null;
      const pending = session.pendingDelta;
      session.pendingDelta = null;
      if (!pending || !session.panning) return;
      if (
        pending.x === session.lastEmittedX &&
        pending.y === session.lastEmittedY
      ) {
        return;
      }
      emitPanDelta(session, pending.x, pending.y);
      // Keep the frame gate armed so burst events within this frame wait
      // until the next vsync instead of issuing synchronous viewport updates.
      session.rafId = window.requestAnimationFrame(flushRightPanFrame);
    };

    const endRight = () => {
      const session = rightSession;
      if (!session) return;
      if (session.rafId != null) {
        window.cancelAnimationFrame(session.rafId);
        session.rafId = null;
      }
      if (session.panning && session.pendingDelta) {
        const pending = session.pendingDelta;
        session.pendingDelta = null;
        emitPanDelta(session, pending.x, pending.y);
      }
      const wasPanning = session.panning;
      releaseRightPointer();
      rightSession = null;
      if (wasPanning) {
        surface.removeAttribute('data-canvas-panning');
        surface.removeAttribute('data-canvas-drag-panning');
        onRightPanStateChangeRef.current?.(false);
      }
    };

    const beginRight = (event: PointerEvent | MouseEvent) => {
      if (event.button !== RIGHT_BUTTON) return;
      if (!isRightPanTarget(surface, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (rightSession) return;
      rightGestureId += 1;
      rightSession = {
        inputKind: event.type.startsWith('pointer') ? 'pointer' : 'mouse',
        activePointerId: null,
        capturedPointerId: null,
        gestureId: rightGestureId,
        startX: event.clientX,
        startY: event.clientY,
        panning: false,
        lastEmittedX: Number.NaN,
        lastEmittedY: Number.NaN,
        pendingDelta: null,
        rafId: null,
      };
      captureRightPointer(event);
    };

    const moveRight = (event: PointerEvent | MouseEvent) => {
      const session = rightSession;
      if (!session) return;
      // Browsers dispatch both pointermove and mousemove for each hardware
      // sample. Ignore mousemove once a gesture was claimed via pointerdown.
      if (session.inputKind === 'pointer') {
        if (event.type === 'mousemove') return;
        if (
          'pointerId' in event &&
          session.activePointerId != null &&
          event.pointerId !== session.activePointerId
        ) {
          return;
        }
      }
      if ((event.buttons & RIGHT_BUTTON_MASK) === 0) {
        endRight();
        return;
      }
      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (!session.panning) {
        if (Math.hypot(dx, dy) <= RIGHT_PAN_SLOP_PX) return;
        session.panning = true;
        surface.setAttribute('data-canvas-panning', '');
        surface.setAttribute('data-canvas-drag-panning', '');
        onRightPanStateChangeRef.current?.(true);
      }
      event.preventDefault();
      if (session.rafId === null) {
        emitPanDelta(session, dx, dy);
        session.rafId = window.requestAnimationFrame(flushRightPanFrame);
      } else {
        session.pendingDelta = { x: dx, y: dy };
      }
    };

    const finishRight = (event: PointerEvent | MouseEvent) => {
      const session = rightSession;
      if (!session) return;
      if (
        session.inputKind === 'pointer' &&
        event.type === 'pointerup' &&
        'pointerId' in event &&
        session.activePointerId != null &&
        event.pointerId !== session.activePointerId
      ) {
        return;
      }
      if (event.type !== 'pointercancel' && event.button !== RIGHT_BUTTON) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      endRight();
    };

    surface.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('pointerdown', beginMiddle, true);
    window.addEventListener('mousedown', beginMiddle, true);
    window.addEventListener('pointerup', finishMiddle, true);
    window.addEventListener('mouseup', finishMiddle, true);
    window.addEventListener('auxclick', onAuxClick, true);
    window.addEventListener('pointerdown', beginRight, true);
    window.addEventListener('mousedown', beginRight, true);
    window.addEventListener('pointermove', moveRight, true);
    window.addEventListener('mousemove', moveRight, true);
    window.addEventListener('pointerup', finishRight, true);
    window.addEventListener('mouseup', finishRight, true);
    window.addEventListener('pointercancel', finishRight, true);
    window.addEventListener('blur', endRight);
    return () => {
      endRight();
      surface.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('pointerdown', beginMiddle, true);
      window.removeEventListener('mousedown', beginMiddle, true);
      window.removeEventListener('pointerup', finishMiddle, true);
      window.removeEventListener('mouseup', finishMiddle, true);
      window.removeEventListener('auxclick', onAuxClick, true);
      window.removeEventListener('pointerdown', beginRight, true);
      window.removeEventListener('mousedown', beginRight, true);
      window.removeEventListener('pointermove', moveRight, true);
      window.removeEventListener('mousemove', moveRight, true);
      window.removeEventListener('pointerup', finishRight, true);
      window.removeEventListener('mouseup', finishRight, true);
      window.removeEventListener('pointercancel', finishRight, true);
      window.removeEventListener('blur', endRight);
    };
  }, [surfaceRef]);
}
