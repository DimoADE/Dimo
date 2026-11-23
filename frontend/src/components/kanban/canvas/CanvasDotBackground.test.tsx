import { createRef } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

type Transform = [number, number, number];

let mockTransform: Transform = [0, 0, 1];
const listeners = new Set<() => void>();

vi.mock('@xyflow/react', () => ({
  useStoreApi: () => ({
    getState: () => ({ transform: mockTransform }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }),
}));

import {
  CanvasDotBackground,
  type CanvasDotBackgroundHandle,
} from './CanvasDotBackground';

function setMockTransform(next: Transform) {
  mockTransform = next;
  for (const listener of listeners) {
    listener();
  }
}

describe('CanvasDotBackground', () => {
  it('pans via translate3d without React re-renders or SVG pattern mutations', () => {
    mockTransform = [0, 0, 1];
    const renderCount = vi.fn();

    function TrackedBackground() {
      renderCount();
      return (
        <CanvasDotBackground gap={24} size={1.5} className="canvas-dots" />
      );
    }

    const { container } = render(<TrackedBackground />);
    expect(renderCount).toHaveBeenCalledTimes(1);

    const svg = container.querySelector('svg.canvas-dots') as SVGSVGElement;
    const pattern = svg.querySelector('pattern') as SVGPatternElement;
    expect(svg).toBeTruthy();
    expect(pattern).toBeTruthy();
    expect(pattern.getAttribute('width')).toBe('24');
    expect(pattern.getAttribute('height')).toBe('24');

    const patternSetAttrSpy = vi.spyOn(pattern, 'setAttribute');

    setMockTransform([10, 15, 1]);
    setMockTransform([30, -5, 1]);
    setMockTransform([100, 200, 1]);

    // Zero React re-renders and zero pattern mutations on pure panning.
    expect(renderCount).toHaveBeenCalledTimes(1);
    expect(patternSetAttrSpy).not.toHaveBeenCalled();
    // 100 % 24 = 4 => 4 - 24 = -20; 200 % 24 = 8 => 8 - 24 = -16
    expect(svg.style.transform).toBe('translate3d(-20px, -16px, 0)');

    // Zooming updates the pattern imperatively, still with zero React re-renders.
    setMockTransform([100, 200, 2]);
    expect(renderCount).toHaveBeenCalledTimes(1);
    expect(pattern.getAttribute('width')).toBe('48');
    expect(pattern.getAttribute('height')).toBe('48');
    expect(svg.style.width).toBe('calc(100% + 48px)');
  });

  it('supports imperative applyTransform for zero-store-churn drag panning', () => {
    mockTransform = [0, 0, 1];
    const ref = createRef<CanvasDotBackgroundHandle>();
    const { container } = render(
      <CanvasDotBackground
        ref={ref}
        gap={24}
        size={1.5}
        className="canvas-dots"
      />
    );
    const svg = container.querySelector('svg.canvas-dots') as SVGSVGElement;
    expect(svg).toBeTruthy();

    ref.current?.applyTransform(50, -10, 1);
    // 50 % 24 = 2 => -22; (-10 % 24 + 24) % 24 = 14 => -10
    expect(svg.style.transform).toBe('translate3d(-22px, -10px, 0)');

    // Committing the exact same transform to the store on pan-end is a no-op
    // and preserves the identical translate3d offset.
    setMockTransform([50, -10, 1]);
    expect(svg.style.transform).toBe('translate3d(-22px, -10px, 0)');
  });
});
