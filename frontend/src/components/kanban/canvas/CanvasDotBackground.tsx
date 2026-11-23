import { memo, useEffect, useId, useLayoutEffect, useRef } from 'react';
import { useStoreApi } from '@xyflow/react';
import { cn } from '@/lib/utils';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface CanvasDotBackgroundProps {
  gap: number;
  size?: number;
  className?: string;
}

function wrapTileOffset(offset: number, period: number): number {
  const mod = ((offset % period) + period) % period;
  return mod - period;
}

/**
 * GPU-composited dot grid for React Flow canvases.
 *
 * Unlike `@xyflow/react`'s `<Background>`, this subscribes imperatively to the
 * flow store (zero React re-renders during pan/zoom) and keeps `<pattern>`
 * fixed at `(0, 0)` while panning by translating an oversized SVG layer with
 * `translate3d`, avoiding full-viewport SVG pattern re-rasterization on every
 * frame.
 */
export const CanvasDotBackground = memo(function CanvasDotBackground({
  gap,
  size = 1.5,
  className,
}: CanvasDotBackgroundProps) {
  const store = useStoreApi();
  const rawId = useId();
  const patternId = `canvas-dot-pattern-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const patternRef = useRef<SVGPatternElement>(null);
  const circleRef = useRef<SVGCircleElement>(null);

  const initialTransform = store?.getState?.()?.transform ?? [0, 0, 1];
  const initialZoom = initialTransform[2] || 1;
  const initialGap = gap * initialZoom || 1;
  const initialPad = Math.ceil(initialGap);
  const initialRadius = (size * initialZoom) / 2;
  const initialModX = wrapTileOffset(initialTransform[0] ?? 0, initialGap);
  const initialModY = wrapTileOffset(initialTransform[1] ?? 0, initialGap);

  useIsomorphicLayoutEffect(() => {
    let prevX = Number.NaN;
    let prevY = Number.NaN;
    let prevZoom = Number.NaN;

    const applyTransform = () => {
      const transform = store?.getState?.()?.transform;
      if (!transform) return;
      const tx = transform[0] ?? 0;
      const ty = transform[1] ?? 0;
      const zoom = transform[2] || 1;
      if (tx === prevX && ty === prevY && zoom === prevZoom) return;

      const zoomChanged = zoom !== prevZoom;
      prevX = tx;
      prevY = ty;
      prevZoom = zoom;

      const svg = svgRef.current;
      if (!svg) return;

      const scaledGap = gap * zoom || 1;
      if (zoomChanged) {
        const pad = Math.ceil(scaledGap);
        const radius = (size * zoom) / 2;
        const halfGap = scaledGap / 2;
        const pattern = patternRef.current;
        if (pattern) {
          pattern.setAttribute('width', String(scaledGap));
          pattern.setAttribute('height', String(scaledGap));
          pattern.setAttribute(
            'patternTransform',
            `translate(-${halfGap},-${halfGap})`
          );
        }
        const circle = circleRef.current;
        if (circle) {
          const rStr = String(radius);
          circle.setAttribute('cx', rStr);
          circle.setAttribute('cy', rStr);
          circle.setAttribute('r', rStr);
        }
        svg.style.width = `calc(100% + ${pad}px)`;
        svg.style.height = `calc(100% + ${pad}px)`;
      }

      const modX = wrapTileOffset(tx, scaledGap);
      const modY = wrapTileOffset(ty, scaledGap);
      svg.style.transform = `translate3d(${modX}px, ${modY}px, 0)`;
    };

    applyTransform();
    if (typeof store?.subscribe !== 'function') return undefined;
    return store.subscribe(applyTransform);
  }, [gap, size, store]);

  return (
    <div
      data-testid="canvas-background"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: -1, contain: 'strict' }}
    >
      <svg
        ref={svgRef}
        data-testid="rf__background"
        className={cn('react-flow__background', className)}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `calc(100% + ${initialPad}px)`,
          height: `calc(100% + ${initialPad}px)`,
          willChange: 'transform',
          transform: `translate3d(${initialModX}px, ${initialModY}px, 0)`,
        }}
      >
        <pattern
          ref={patternRef}
          id={patternId}
          x="0"
          y="0"
          width={initialGap}
          height={initialGap}
          patternUnits="userSpaceOnUse"
          patternTransform={`translate(-${initialGap / 2},-${initialGap / 2})`}
        >
          <circle
            ref={circleRef}
            cx={initialRadius}
            cy={initialRadius}
            r={initialRadius}
            className="react-flow__background-pattern dots"
          />
        </pattern>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill={`url(#${patternId})`}
        />
      </svg>
    </div>
  );
});
