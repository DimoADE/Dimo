import { useLayoutEffect, useRef, useState } from 'react';

export function useFloatingComposerInset({
  enabled,
  onInsetChange,
}: {
  enabled: boolean;
  onInsetChange?: (height: number) => void;
}) {
  const dockRef = useRef<HTMLDivElement | null>(null);
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

    const element = dockRef.current;
    if (!element) return;

    const measure = () => {
      const rectHeight = element.getBoundingClientRect().height;
      const next = Math.max(
        0,
        Math.ceil(rectHeight > 0 ? rectHeight : element.offsetHeight)
      );
      if (next === heightRef.current) return;
      heightRef.current = next;
      setHeight(next);
    };

    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure, { passive: true });
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);

  useLayoutEffect(() => {
    if (!enabled) return;
    if (height === committedHeightRef.current) return;
    committedHeightRef.current = height;
    onInsetChangeRef.current?.(height);
  }, [enabled, height]);

  return { dockRef, height };
}
