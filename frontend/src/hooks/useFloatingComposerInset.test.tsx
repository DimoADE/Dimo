import { act, render, screen } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFloatingComposerInset } from './useFloatingComposerInset';

let resizeCallbacks: ResizeObserverCallback[] = [];
const originalResizeObserver = globalThis.ResizeObserver;

function Harness({
  enabled,
  onInsetChange,
}: {
  enabled: boolean;
  onInsetChange?: (height: number, cssVarValue: string) => void;
}) {
  const { dockRef, height } = useFloatingComposerInset({
    enabled,
    onInsetChange: (nextHeight) => {
      const stage = document.querySelector<HTMLElement>('[data-testid="stage"]');
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
      <div ref={dockRef} data-testid="dock" />
    </div>
  );
}

describe('useFloatingComposerInset', () => {
  beforeEach(() => {
    resizeCallbacks = [];
    globalThis.ResizeObserver = class MockResizeObserver {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks = resizeCallbacks.filter((cb) => cb !== this.callback);
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

    expect(stage.style.getPropertyValue('--conv-floating-composer-height')).toBe(
      '128px'
    );
    expect(onInsetChange).toHaveBeenLastCalledWith(128, '128px');

    currentHeight = 184;
    act(() => {
      resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });

    expect(stage.style.getPropertyValue('--conv-floating-composer-height')).toBe(
      '184px'
    );
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
    expect(stage.style.getPropertyValue('--conv-floating-composer-height')).toBe(
      '120px'
    );

    rerender(<Harness enabled={false} />);
    expect(stage.style.getPropertyValue('--conv-floating-composer-height')).toBe(
      '0px'
    );
  });
});
