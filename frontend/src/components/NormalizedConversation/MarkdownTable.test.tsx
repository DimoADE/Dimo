import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MarkdownTable,
  computeTableScrollbarMetrics,
} from './MarkdownTable';

type ResizeObserverCallbackEntry = {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
};

let activeResizeObservers: ResizeObserverCallbackEntry[] = [];
const originalResizeObserver = globalThis.ResizeObserver;

function triggerResizeObservers() {
  for (const entry of activeResizeObservers) {
    entry.callback([], {} as ResizeObserver);
  }
}

function setHorizontalGeometry(
  el: HTMLElement,
  {
    clientWidth,
    scrollWidth,
    scrollLeft = 0,
  }: { clientWidth: number; scrollWidth: number; scrollLeft?: number }
) {
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    get: () => clientWidth,
  });
  Object.defineProperty(el, 'scrollWidth', {
    configurable: true,
    get: () => scrollWidth,
  });
  let currentScrollLeft = scrollLeft;
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    get: () => currentScrollLeft,
    set: (value: number) => {
      currentScrollLeft = value;
    },
  });
}

describe('computeTableScrollbarMetrics', () => {
  it('returns null when table content fits within the viewport', () => {
    expect(
      computeTableScrollbarMetrics({
        clientWidth: 400,
        scrollWidth: 400,
        scrollLeft: 0,
        trackWidth: 400,
      })
    ).toBeNull();
    expect(
      computeTableScrollbarMetrics({
        clientWidth: 400,
        scrollWidth: 401,
        scrollLeft: 0,
        trackWidth: 400,
      })
    ).toBeNull();
  });

  it('computes proportional thumb size, offset, and percent when overflowing', () => {
    expect(
      computeTableScrollbarMetrics({
        clientWidth: 200,
        scrollWidth: 800,
        scrollLeft: 300,
        trackWidth: 200,
      })
    ).toEqual({
      thumbWidth: 50,
      offset: 75,
      travel: 150,
      overflow: 600,
      percent: 50,
    });
  });

  it('clamps thumb width to minThumb for very wide tables', () => {
    const metrics = computeTableScrollbarMetrics({
      clientWidth: 100,
      scrollWidth: 4000,
      scrollLeft: 3900,
      trackWidth: 200,
      minThumb: 36,
    });
    expect(metrics).toEqual({
      thumbWidth: 36,
      offset: 164,
      travel: 164,
      overflow: 3900,
      percent: 100,
    });
  });
});

describe('MarkdownTable horizontal scrollbar', () => {
  beforeEach(() => {
    activeResizeObservers = [];
    globalThis.ResizeObserver = class MockResizeObserver {
      private entry: ResizeObserverCallbackEntry;
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() };
        activeResizeObservers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        this.entry.targets.clear();
        activeResizeObservers = activeResizeObservers.filter(
          (item) => item !== this.entry
        );
      }
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    vi.restoreAllMocks();
  });

  it('omits the horizontal scrollbar when the table fits', () => {
    const { container } = render(
      <MarkdownTable>
        <thead>
          <tr>
            <th>Col A</th>
            <th>Col B</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1</td>
            <td>2</td>
          </tr>
        </tbody>
      </MarkdownTable>
    );
    const scrollEl = container.querySelector('.conv-md-table-scroll') as HTMLDivElement;
    expect(scrollEl).toHaveAttribute('data-overlay-scrollbar-x', 'off');

    setHorizontalGeometry(scrollEl, { clientWidth: 400, scrollWidth: 400 });
    act(() => {
      triggerResizeObservers();
    });

    expect(screen.queryByTestId('conv-md-table-scrollbar')).toBeNull();
  });

  it('renders a persistent interactive horizontal scrollbar when the table overflows', () => {
    const { container } = render(
      <MarkdownTable>
        <thead>
          <tr>
            <th>Verification</th>
            <th>Command</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Rust tests</td>
            <td>cargo test --workspace</td>
            <td>All passed</td>
          </tr>
        </tbody>
      </MarkdownTable>
    );

    const scrollEl = container.querySelector('.conv-md-table-scroll') as HTMLDivElement;
    setHorizontalGeometry(scrollEl, {
      clientWidth: 200,
      scrollWidth: 800,
      scrollLeft: 0,
    });

    act(() => {
      triggerResizeObservers();
    });

    const track = screen.getByTestId('conv-md-table-scrollbar');
    const thumb = screen.getByTestId('conv-md-table-scrollbar-thumb');
    expect(track).toHaveAttribute('role', 'scrollbar');
    expect(track).toHaveAttribute('aria-orientation', 'horizontal');

    Object.defineProperty(track, 'clientWidth', {
      configurable: true,
      get: () => 200,
    });
    track.getBoundingClientRect = () =>
      ({
        left: 100,
        right: 300,
        top: 0,
        bottom: 14,
        width: 200,
        height: 14,
        x: 100,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    // Sync after giving track concrete width
    act(() => {
      triggerResizeObservers();
    });
    expect(thumb.style.width).toBe('50px');
    expect(thumb.style.transform).toBe('translateX(0px)');

    // Native scroll updates thumb offset and aria-valuenow
    scrollEl.scrollLeft = 300;
    fireEvent.scroll(scrollEl);
    expect(thumb.style.transform).toBe('translateX(75px)');
    expect(track).toHaveAttribute('aria-valuenow', '50');

    // Dragging thumb moves scrollLeft proportionally
    fireEvent.pointerDown(thumb, { button: 0, clientX: 175, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 250 });
    fireEvent.pointerUp(window);
    expect(scrollEl.scrollLeft).toBe(600);
    expect(thumb.style.transform).toBe('translateX(150px)');
    expect(track).toHaveAttribute('aria-valuenow', '100');

    // Clicking track jumps scrollLeft to the clicked position
    fireEvent.pointerDown(track, { button: 0, clientX: 125 });
    expect(scrollEl.scrollLeft).toBe(0);
    expect(thumb.style.transform).toBe('translateX(0px)');
  });
});
