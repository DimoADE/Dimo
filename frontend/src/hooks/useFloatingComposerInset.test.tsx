import { act, render, screen } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFloatingComposerInset } from './useFloatingComposerInset';

let resizeCallbacks: ResizeObserverCallback[] = [];
let observedElements = new Map<ResizeObserverCallback, Element | null>();
const originalResizeObserver = globalThis.ResizeObserver;

function Harness({
  enabled,
  dockKey = 'dock-a',
  showDock = true,
  onInsetChange,
}: {
  enabled: boolean;
  dockKey?: string;
  showDock?: boolean;
  onInsetChange?: (height: number, cssVarValue: string) => void;
}) {
  const { dockRef, height } = useFloatingComposerInset({
    enabled,
    onInsetChange: (nextHeight) => {
      const stage = document.querySelector<HTMLElement>(
        '[data-testid="stage"]'
      );
      const cssVarValue =
        stage?.style.getPropertyValue('--conv-floating-composer-height') ?? '';
      onInsetChange?.(nextHeight, cssVarValue);
    },
  });

  return (
    <div
      data-testid="stage"
      style={
        {
          '--conv-floating-composer-height': `${height}px`,
        } as CSSProperties
      }
    >
      {showDock ? <div key={dockKey} ref={dockRef} data-testid="dock" /> : null}
    </div>
  );
}

describe('useFloatingComposerInset', () => {
  beforeEach(() => {
    resizeCallbacks = [];
    observedElements = new Map();
    globalThis.ResizeObserver = class MockResizeObserver {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeCallbacks.push(callback);
        observedElements.set(callback, null);
      }
      observe(target: Element) {
        observedElements.set(this.callback, target);
      }
      unobserve() {}
      disconnect() {
        resizeCallbacks = resizeCallbacks.filter((cb) => cb !== this.callback);
        observedElements.delete(this.callback);
      }
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    vi.restoreAllMocks();
  });

  it('measures dock height and invokes onInsetChange after committing the CSS custom property', () => {
    const onInsetChange = vi.fn();
    let currentHeight = 128;

    render(<Harness enabled={true} onInsetChange={onInsetChange} />);
    const stage = screen.getByTestId('stage');
    const dock = screen.getByTestId('dock');

    dock.getBoundingClientRect = () =>
      ({
        height: currentHeight,
        width: 600,
        top: 0,
        left: 0,
        right: 600,
        bottom: currentHeight,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    act(() => {
      resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });

    expect(
      stage.style.getPropertyValue('--conv-floating-composer-height')
    ).toBe('128px');
    expect(onInsetChange).toHaveBeenLastCalledWith(128, '128px');

    currentHeight = 184;
    act(() => {
      resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });

    expect(
      stage.style.getPropertyValue('--conv-floating-composer-height')
    ).toBe('184px');
    expect(onInsetChange).toHaveBeenLastCalledWith(184, '184px');
  });

  it('resets height to 0 when disabled', () => {
    const { rerender } = render(<Harness enabled={true} />);
    const stage = screen.getByTestId('stage');
    const dock = screen.getByTestId('dock');

    dock.getBoundingClientRect = () =>
      ({
        height: 120,
        width: 600,
        top: 0,
        left: 0,
        right: 600,
        bottom: 120,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    act(() => {
      resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });
    expect(
      stage.style.getPropertyValue('--conv-floating-composer-height')
    ).toBe('120px');

    rerender(<Harness enabled={false} />);
    expect(
      stage.style.getPropertyValue('--conv-floating-composer-height')
    ).toBe('0px');
  });

  it('re-attaches ResizeObserver when the dock mounts late or remounts under a new key while enabled stays true', () => {
    const { rerender } = render(<Harness enabled={true} showDock={false} />);
    const stage = screen.getByTestId('stage');
    expect(resizeCallbacks).toHaveLength(0);

    // Mount dock after enabled is already true
    rerender(<Harness enabled={true} showDock={true} dockKey="session-1" />);
    const firstDock = screen.getByTestId('dock');
    expect(resizeCallbacks).toHaveLength(1);
    expect(observedElements.get(resizeCallbacks[0]!)).toBe(firstDock);

    Object.defineProperty(firstDock, 'offsetHeight', {
      configurable: true,
      get: () => 132,
    });
    act(() => {
      resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });
    expect(
      stage.style.getPropertyValue('--conv-floating-composer-height')
    ).toBe('132px');

    // Remount dock (e.g. session switch via ConversationStatusProvider key)
    rerender(<Harness enabled={true} showDock={true} dockKey="session-2" />);
    const secondDock = screen.getByTestId('dock');
    expect(secondDock).not.toBe(firstDock);
    expect(resizeCallbacks).toHaveLength(1);
    expect(observedElements.get(resizeCallbacks[0]!)).toBe(secondDock);

    Object.defineProperty(secondDock, 'offsetHeight', {
      configurable: true,
      get: () => 240,
    });
    act(() => {
      resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });
    expect(
      stage.style.getPropertyValue('--conv-floating-composer-height')
    ).toBe('240px');
  });

  it('uses unscaled borderBoxSize/offsetHeight instead of transform-scaled bounding rect and ignores transient hidden 0px reports', () => {
    render(<Harness enabled={true} />);
    const stage = screen.getByTestId('stage');
    const dock = screen.getByTestId('dock');

    // Simulate a zoomed-out canvas card (zoom = 0.5): layout offsetHeight is 180px
    // while getBoundingClientRect().height is shrunk to 90px.
    let offsetHeight = 180;
    Object.defineProperty(dock, 'offsetHeight', {
      configurable: true,
      get: () => offsetHeight,
    });
    dock.getBoundingClientRect = () =>
      ({
        height: offsetHeight * 0.5,
        width: 300,
        top: 0,
        left: 0,
        right: 300,
        bottom: offsetHeight * 0.5,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    act(() => {
      resizeCallbacks.forEach((cb) =>
        cb(
          [
            {
              target: dock,
              borderBoxSize: [{ blockSize: 180.2, inlineSize: 600 }],
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver
        )
      );
    });
    expect(
      stage.style.getPropertyValue('--conv-floating-composer-height')
    ).toBe('181px');

    // Transiently hidden tab (display: none -> 0px) preserves the last known inset.
    offsetHeight = 0;
    act(() => {
      resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });
    expect(
      stage.style.getPropertyValue('--conv-floating-composer-height')
    ).toBe('181px');
  });
});
