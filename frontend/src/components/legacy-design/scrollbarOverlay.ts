export const THUMB_PX = 6;
export const EDGE_INSET = 0;
const MIN_THUMB = 24;
const HIDE_DELAY_MS = 700;

const SKIP =
  '.monaco-editor, .monaco-scrollable-element, .dv-tabs-and-actions-container, .dv-scrollable, .composer-at-reference-tabs, [data-overlay-scrollbar="off"]';
const SKIP_X = '[data-overlay-scrollbar-x="off"]';

export function thumbGeometry(input: {
  clientSize: number;
  scrollSize: number;
  scrollOffset: number;
  trackSize: number;
  minThumb: number;
}): { size: number; offset: number } | null {
  const overflow = input.scrollSize - input.clientSize;
  if (overflow <= 1 || input.trackSize <= 1) return null;
  const size = Math.min(
    input.trackSize,
    Math.max(
      input.minThumb,
      (input.clientSize / input.scrollSize) * input.trackSize
    )
  );
  const travel = Math.max(0, input.trackSize - size);
  const offset = Math.min(
    travel,
    Math.max(0, (input.scrollOffset / overflow) * travel)
  );
  return { size, offset };
}

function isShownScroller(el: HTMLElement): boolean {
  if (!el.isConnected || el.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse';
}

function canScroll(el: HTMLElement, axis: 'x' | 'y'): boolean {
  const style = getComputedStyle(el);
  const overflow = axis === 'y' ? style.overflowY : style.overflowX;
  if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') {
    return false;
  }
  if (axis === 'y') return el.scrollHeight - el.clientHeight > 1;
  return el.scrollWidth - el.clientWidth > 1;
}

export function findScroller(
  target: EventTarget | null,
  axis: 'x' | 'y'
): HTMLElement | null {
  if (!(target instanceof Element) || target.closest(SKIP)) return null;
  if (axis === 'x' && target.closest(SKIP_X)) return null;
  let node: Element | null = target;
  while (node) {
    if (node instanceof HTMLElement && canScroll(node, axis)) return node;
    node = node.parentElement;
  }
  return null;
}

const CLIPPING_OVERFLOW = new Set([
  'hidden',
  'clip',
  'auto',
  'scroll',
  'overlay',
]);

type RectBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function clippedBounds(scroller: HTMLElement): RectBounds {
  const rect = scroller.getBoundingClientRect();
  let left = Math.max(rect.left, 0);
  let top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, window.innerHeight);

  let parent: Element | null = scroller.parentElement;
  while (parent && parent !== document.documentElement) {
    const style = getComputedStyle(parent);
    const clipX = CLIPPING_OVERFLOW.has(style.overflowX);
    const clipY = CLIPPING_OVERFLOW.has(style.overflowY);
    if (clipX || clipY) {
      const pRect = parent.getBoundingClientRect();
      if (clipX) {
        left = Math.max(left, pRect.left);
        right = Math.min(right, pRect.right);
      }
      if (clipY) {
        top = Math.max(top, pRect.top);
        bottom = Math.min(bottom, pRect.bottom);
      }
    }
    parent = parent.parentElement;
  }

  return { left, top, right, bottom };
}

type ThumbPlacement = {
  visible: boolean;
  top?: number;
  left?: number;
  width?: number;
  height?: number;
};

type CachedThumbStyle = {
  visible: boolean;
  top: string;
  left: string;
  width: string;
  height: string;
};

function computeThumbPlacement(
  scroller: HTMLElement,
  rect: DOMRect,
  clip: RectBounds,
  axis: 'x' | 'y'
): ThumbPlacement {
  if (clip.bottom - clip.top <= 1 || clip.right - clip.left <= 1) {
    return { visible: false };
  }
  if (
    axis === 'y' &&
    (rect.right <= clip.left + THUMB_PX || rect.left >= clip.right)
  ) {
    return { visible: false };
  }
  if (
    axis === 'x' &&
    (rect.bottom <= clip.top + THUMB_PX || rect.top >= clip.bottom)
  ) {
    return { visible: false };
  }
  const start = axis === 'y' ? clip.top : clip.left;
  const end = axis === 'y' ? clip.bottom : clip.right;
  const geo = thumbGeometry({
    clientSize: axis === 'y' ? scroller.clientHeight : scroller.clientWidth,
    scrollSize: axis === 'y' ? scroller.scrollHeight : scroller.scrollWidth,
    scrollOffset: axis === 'y' ? scroller.scrollTop : scroller.scrollLeft,
    trackSize: end - start,
    minThumb: MIN_THUMB,
  });
  if (!geo) {
    return { visible: false };
  }
  if (axis === 'y') {
    const rightEdge = Math.min(rect.right, clip.right);
    return {
      visible: true,
      top: start + geo.offset,
      left: rightEdge - THUMB_PX - EDGE_INSET,
      width: THUMB_PX,
      height: geo.size,
    };
  }
  const bottomEdge = Math.min(rect.bottom, clip.bottom);
  return {
    visible: true,
    left: start + geo.offset,
    top: bottomEdge - THUMB_PX - EDGE_INSET,
    height: THUMB_PX,
    width: geo.size,
  };
}

function applyThumbPlacement(
  thumb: HTMLElement,
  placement: ThumbPlacement,
  cache: CachedThumbStyle
): boolean {
  if (!placement.visible) {
    if (cache.visible) {
      thumb.classList.remove('is-visible');
      cache.visible = false;
    }
    return false;
  }
  const top = `${placement.top}px`;
  const left = `${placement.left}px`;
  const width = `${placement.width}px`;
  const height = `${placement.height}px`;
  if (cache.top !== top) {
    thumb.style.top = top;
    cache.top = top;
  }
  if (cache.left !== left) {
    thumb.style.left = left;
    cache.left = left;
  }
  if (cache.width !== width) {
    thumb.style.width = width;
    cache.width = width;
  }
  if (cache.height !== height) {
    thumb.style.height = height;
    cache.height = height;
  }
  if (!cache.visible) {
    thumb.classList.add('is-visible');
    cache.visible = true;
  }
  return true;
}

export function attachOverlayScrollbars(
  root: Document,
  thumbs: { vertical: HTMLElement; horizontal: HTMLElement }
): () => void {
  let activeVertical: HTMLElement | null = null;
  let activeHorizontal: HTMLElement | null = null;
  let pointerInside = false;
  let dragging: 'x' | 'y' | null = null;
  let hideTimer = 0;
  let frame = 0;
  const verticalCache: CachedThumbStyle = {
    visible: thumbs.vertical.classList.contains('is-visible'),
    top: '',
    left: '',
    width: '',
    height: '',
  };
  const horizontalCache: CachedThumbStyle = {
    visible: thumbs.horizontal.classList.contains('is-visible'),
    top: '',
    left: '',
    width: '',
    height: '',
  };

  const hideAxis = (axis: 'x' | 'y') => {
    const thumb = axis === 'y' ? thumbs.vertical : thumbs.horizontal;
    const cache = axis === 'y' ? verticalCache : horizontalCache;
    if (cache.visible) {
      thumb.classList.remove('is-visible');
      cache.visible = false;
    }
  };

  const hideNow = () => {
    window.clearTimeout(hideTimer);
    hideAxis('y');
    hideAxis('x');
  };

  const scheduleHide = () => {
    window.clearTimeout(hideTimer);
    if (dragging || pointerInside) return;
    hideTimer = window.setTimeout(() => {
      if (dragging || pointerInside) return;
      hideNow();
    }, HIDE_DELAY_MS);
  };

  const reconnectObservers = () => {
    observer.disconnect();
    resizeObserver.disconnect();
    const targets = new Set<HTMLElement>();
    if (activeVertical) targets.add(activeVertical);
    if (activeHorizontal) targets.add(activeHorizontal);
    for (const scroller of targets) {
      observer.observe(scroller, {
        childList: true,
        subtree: true,
      });
      resizeObserver.observe(scroller);
    }
  };

  const releaseAxis = (axis: 'x' | 'y') => {
    if (axis === 'y') activeVertical = null;
    else activeHorizontal = null;
    hideAxis(axis);
    if (!activeVertical && !activeHorizontal) {
      pointerInside = false;
    }
    reconnectObservers();
  };

  const place = () => {
    if (activeVertical && !isShownScroller(activeVertical)) {
      releaseAxis('y');
    }
    if (activeHorizontal && !isShownScroller(activeHorizontal)) {
      releaseAxis('x');
    }

    // Read all layout geometry before mutating either thumb style to avoid forced reflows.
    const sameScroller =
      activeVertical !== null && activeVertical === activeHorizontal;
    const sharedRect = sameScroller
      ? activeVertical!.getBoundingClientRect()
      : null;
    const sharedClip = sameScroller ? clippedBounds(activeVertical!) : null;

    const verticalPlacement: ThumbPlacement = activeVertical
      ? computeThumbPlacement(
          activeVertical,
          sharedRect ?? activeVertical.getBoundingClientRect(),
          sharedClip ?? clippedBounds(activeVertical),
          'y'
        )
      : { visible: false };

    const horizontalPlacement: ThumbPlacement = activeHorizontal
      ? computeThumbPlacement(
          activeHorizontal,
          sharedRect ?? activeHorizontal.getBoundingClientRect(),
          sharedClip ?? clippedBounds(activeHorizontal),
          'x'
        )
      : { visible: false };

    const vertical = applyThumbPlacement(
      thumbs.vertical,
      verticalPlacement,
      verticalCache
    );
    const horizontal = applyThumbPlacement(
      thumbs.horizontal,
      horizontalPlacement,
      horizontalCache
    );
    if (!vertical && !horizontal) scheduleHide();
  };

  const schedulePlace = () => {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (activeVertical || activeHorizontal) place();
    });
  };

  const observer = new MutationObserver(() => {
    if (activeVertical || activeHorizontal) schedulePlace();
  });
  const resizeObserver = new ResizeObserver(() => {
    if (!activeVertical && !activeHorizontal) return;
    schedulePlace();
  });

  const watch = (
    nextVertical: HTMLElement | null,
    nextHorizontal: HTMLElement | null
  ) => {
    const changed =
      nextVertical !== activeVertical || nextHorizontal !== activeHorizontal;
    activeVertical = nextVertical;
    activeHorizontal = nextHorizontal;
    if (changed) {
      reconnectObservers();
    }
    if (!activeVertical && !activeHorizontal) {
      hideNow();
      return;
    }
    place();
  };

  const syncFrom = (target: EventTarget | null, inside: boolean) => {
    if (
      target instanceof Element &&
      target.closest('.overlay-scrollbar-thumb')
    ) {
      return;
    }
    const nextVertical = findScroller(target, 'y');
    const nextHorizontal = findScroller(target, 'x');
    pointerInside =
      inside && (nextVertical !== null || nextHorizontal !== null);
    watch(nextVertical, nextHorizontal);
  };

  const onPointer = (event: Event) => {
    syncFrom(event.target, true);
  };

  const onScroll = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest(SKIP)) {
      if (
        target instanceof Element &&
        ((activeVertical && target.contains(activeVertical)) ||
          (activeHorizontal && target.contains(activeHorizontal)))
      ) {
        place();
      }
      return;
    }

    const scrollableY = canScroll(target, 'y');
    const scrollableX = !target.closest(SKIP_X) && canScroll(target, 'x');
    if (!scrollableY && !scrollableX) {
      if (
        (activeVertical && target.contains(activeVertical)) ||
        (activeHorizontal && target.contains(activeHorizontal))
      ) {
        place();
      }
      return;
    }

    const nextVertical = scrollableY ? target : activeVertical;
    const nextHorizontal = scrollableX ? target : activeHorizontal;
    watch(nextVertical, nextHorizontal);
    if (!pointerInside) scheduleHide();
  };

  const onWindowResize = () => {
    if (activeVertical || activeHorizontal) schedulePlace();
  };

  const bindDrag = (thumb: HTMLElement, axis: 'x' | 'y') => {
    let startPointer = 0;
    let startScroll = 0;
    let travel = 1;
    let overflow = 0;
    const getActive = () => (axis === 'y' ? activeVertical : activeHorizontal);
    const onDown = (event: PointerEvent) => {
      const scroller = getActive();
      if (!scroller || event.button !== 0) return;
      dragging = axis;
      thumb.classList.add('is-dragging');
      startPointer = axis === 'y' ? event.clientY : event.clientX;
      startScroll = axis === 'y' ? scroller.scrollTop : scroller.scrollLeft;
      const client =
        axis === 'y' ? scroller.clientHeight : scroller.clientWidth;
      const scroll =
        axis === 'y' ? scroller.scrollHeight : scroller.scrollWidth;
      const clip = clippedBounds(scroller);
      const visibleTrack = Math.max(
        1,
        axis === 'y' ? clip.bottom - clip.top : clip.right - clip.left
      );
      const thumbSize = axis === 'y' ? thumb.offsetHeight : thumb.offsetWidth;
      travel = Math.max(1, visibleTrack - thumbSize);
      overflow = Math.max(1, scroll - client);
      thumb.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };
    const onMove = (event: PointerEvent) => {
      const scroller = getActive();
      if (dragging !== axis || !scroller) return;
      const pointer = axis === 'y' ? event.clientY : event.clientX;
      const delta = ((pointer - startPointer) / travel) * overflow;
      if (axis === 'y') scroller.scrollTop = startScroll + delta;
      else scroller.scrollLeft = startScroll + delta;
      event.preventDefault();
    };
    const onUp = () => {
      if (dragging !== axis) return;
      dragging = null;
      thumb.classList.remove('is-dragging');
      if (!pointerInside) scheduleHide();
    };
    thumb.addEventListener('pointerdown', onDown);
    thumb.addEventListener('pointermove', onMove);
    thumb.addEventListener('pointerup', onUp);
    thumb.addEventListener('pointercancel', onUp);
    return () => {
      thumb.removeEventListener('pointerdown', onDown);
      thumb.removeEventListener('pointermove', onMove);
      thumb.removeEventListener('pointerup', onUp);
      thumb.removeEventListener('pointercancel', onUp);
    };
  };

  const unbindVertical = bindDrag(thumbs.vertical, 'y');
  const unbindHorizontal = bindDrag(thumbs.horizontal, 'x');
  const onPointerDown = () => {
    window.requestAnimationFrame(() => {
      if (activeVertical && !isShownScroller(activeVertical)) {
        releaseAxis('y');
      }
      if (activeHorizontal && !isShownScroller(activeHorizontal)) {
        releaseAxis('x');
      }
    });
  };
  root.addEventListener('pointerover', onPointer, {
    capture: true,
    passive: true,
  });
  root.addEventListener('pointerdown', onPointerDown, {
    capture: true,
    passive: true,
  });
  root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onWindowResize, { passive: true });

  return () => {
    window.clearTimeout(hideTimer);
    window.cancelAnimationFrame(frame);
    observer.disconnect();
    resizeObserver.disconnect();
    root.removeEventListener('pointerover', onPointer, true);
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onWindowResize);
    unbindVertical();
    unbindHorizontal();
  };
}
