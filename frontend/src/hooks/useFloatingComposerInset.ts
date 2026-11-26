import { useLayoutEffect, useRef, useState } from 'react';

function readBorderBoxBlockSize(entry?: ResizeObserverEntry): number | null {
  if (!entry?.borderBoxSize) return null;
  const first = Array.isArray(entry.borderBoxSize)
    ? entry.borderBoxSize[0]
    : (entry.borderBoxSize as { blockSize?: number });
  const blockSize = first?.blockSize;
  return typeof blockSize === 'number' && Number.isFinite(blockSize)
    ? blockSize
    : null;
}

function measureUnscaledDockHeight(
  element: HTMLElement,
  entry?: ResizeObserverEntry
): number {
  const borderBoxHeight = readBorderBoxBlockSize(entry);
  if (borderBoxHeight !== null && borderBoxHeight > 0) {
    return Math.ceil(borderBoxHeight);
  }
  if (element.offsetHeight > 0) {
    return Math.ceil(element.offsetHeight);
  }
  const rectHeight = element.getBoundingClientRect().height;
  return Math.max(0, Math.ceil(rectHeight));
}

export function useFloatingComposerInset({
  enabled,
  onInsetChange,
}: {
  enabled: boolean;
  onInsetChange?: (height: number) => void;
}) {
  const [dockElement, setDockElement] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  const heightRef = useRef(0);
  const committedHeightRef = useRef(0);
  const onInsetChangeRef = useRef(onInsetChange);
  onInsetChangeRef.current = onInsetChange;

  useLayoutEffect(() => {
    if (!enabled) {
      heightRef.current = 0;
      committedHeightRef.current = 0;
      setHeight(0);
      return;
    }

    if (!dockElement) return;

    const measure = (entries?: ResizeObserverEntry[]) => {
      const matchedEntry = entries?.find(
        (entry) => entry.target === dockElement
      );
      const next = measureUnscaledDockHeight(dockElement, matchedEntry);
      if (next <= 0 && heightRef.current > 0) {
        // Hidden tabs / keep-alive surfaces transiently report 0 height; keep
        // the last known inset until visible so scroll positions aren't clamped.
        return;
      }
      if (next === heightRef.current) return;
      heightRef.current = next;
      setHeight(next);
    };

    measure();

    if (typeof ResizeObserver === 'undefined') {
      const handleResize = () => measure();
      window.addEventListener('resize', handleResize, { passive: true });
      return () => window.removeEventListener('resize', handleResize);
    }

    const observer = new ResizeObserver((entries) => {
      measure(entries);
    });
    observer.observe(dockElement);
    return () => observer.disconnect();
  }, [dockElement, enabled]);

  useLayoutEffect(() => {
    if (!enabled) return;
    if (height === committedHeightRef.current) return;
    committedHeightRef.current = height;
    onInsetChangeRef.current?.(height);
  }, [enabled, height]);

  return { dockRef: setDockElement, height };
}
