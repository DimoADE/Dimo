type SashResizeListener = (resizing: boolean) => void;

const listeners = new Set<SashResizeListener>();
let activeDragCount = 0;

function notifyListeners(resizing: boolean): void {
  for (const listener of listeners) {
    listener(resizing);
  }
}

export function isDockviewSashResizing(): boolean {
  return activeDragCount > 0;
}

export function subscribeDockviewSashResize(
  listener: SashResizeListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tracks active Dockview `.dv-sash` pointer drags on the workspace stage host
 * so CSS can suspend expensive hit-testing/backdrop-blur passes and JS layout
 * observers can defer non-critical work until the drag settles.
 */
export function installDockviewSashResizeGuard(
  dockviewRootEl: HTMLElement
): () => void {
  let dragging = false;

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    dockviewRootEl.removeAttribute('data-dockview-sash-resizing');
    document.removeEventListener('pointerup', endDrag, true);
    document.removeEventListener('pointercancel', endDrag, true);
    document.removeEventListener('contextmenu', endDrag, true);
    window.removeEventListener('blur', endDrag);
    activeDragCount = Math.max(0, activeDragCount - 1);
    if (activeDragCount === 0) {
      notifyListeners(false);
    }
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const target = event.target;
    if (!(target instanceof Element) || !dockviewRootEl.contains(target)) {
      return;
    }
    if (!target.closest('.dv-sash')) return;
    if (dragging) return;

    dragging = true;
    dockviewRootEl.setAttribute('data-dockview-sash-resizing', 'true');
    activeDragCount += 1;
    if (activeDragCount === 1) {
      notifyListeners(true);
    }
    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);
    document.addEventListener('contextmenu', endDrag, true);
    window.addEventListener('blur', endDrag);
  };

  dockviewRootEl.addEventListener('pointerdown', handlePointerDown, true);

  return () => {
    dockviewRootEl.removeEventListener('pointerdown', handlePointerDown, true);
    endDrag();
  };
}
