import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSurfaceHost } from './browserPanelLifetime';
import {
  attachPickedBrowserElementImage,
  BROWSER_ELEMENT_DROP_EVENT,
  resetBrowserElementRackForTests,
  stagePickedBrowserElement,
  useBrowserElementRackStore,
  type StagedBrowserElement,
} from './browserElementRack';
import {
  BrowserElementRackOverlay,
  DEFAULT_RACK_PANEL_HEIGHT,
  MIN_RACK_PANEL_HEIGHT,
} from './BrowserElementRackOverlay';
import {
  resetElectronBrowserSurfaceStoreForTests,
  useElectronBrowserSurfaceStore,
} from './electronBrowserSurfaceStore';

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
}));

interface HostRectSpec {
  left: number;
  top: number;
  width: number;
  height: number;
  clientWidth?: number;
  clientHeight?: number;
}

function makeStagedElement(
  label: string,
  selector: string,
  tabId = 'tab-1'
): string {
  return stagePickedBrowserElement({
    tabId,
    label,
    tokenValue: `@{${label}:<${selector}>}`,
    selector,
    description: `${label} element`,
  });
}

function renderRackInHost({
  tabId = 'tab-1',
  surfaceHost = 'canvas',
  panelVisible = true,
  rect = { left: 100, top: 80, width: 640, height: 480 },
}: {
  tabId?: string;
  surfaceHost?: BrowserSurfaceHost;
  panelVisible?: boolean;
  rect?: HostRectSpec;
} = {}) {
  function Harness() {
    const hostRef = useRef<HTMLDivElement | null>(null);
    return (
      <div
        ref={(node) => {
          hostRef.current = node;
          if (!node) return;
          if (typeof rect.clientWidth === 'number') {
            Object.defineProperty(node, 'clientWidth', {
              configurable: true,
              value: rect.clientWidth,
            });
          }
          if (typeof rect.clientHeight === 'number') {
            Object.defineProperty(node, 'clientHeight', {
              configurable: true,
              value: rect.clientHeight,
            });
          }
          vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => ({
            left: rect.left,
            top: rect.top,
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            right: rect.left + rect.width,
            bottom: rect.top + rect.height,
            toJSON: () => ({}),
          }));
        }}
        data-testid="mock-browser-host"
      >
        <BrowserElementRackOverlay
          tabId={tabId}
          surfaceHost={surfaceHost}
          hostRef={hostRef}
          panelVisible={panelVisible}
        />
      </div>
    );
  }

  return render(<Harness />);
}

describe('BrowserElementRackOverlay', () => {
  const originalElementFromPoint = document.elementFromPoint;

  beforeEach(() => {
    resetBrowserElementRackForTests();
    resetElectronBrowserSurfaceStoreForTests();
  });

  afterEach(() => {
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      writable: true,
      value: originalElementFromPoint,
    });
  });

  it('renders nothing when no elements are staged for its tabId and unmounts with its host panel', () => {
    makeStagedElement('@div', 'div.other', 'tab-other');
    const { unmount } = renderRackInHost({ tabId: 'tab-1' });
    expect(screen.queryByTestId('browser-element-rack')).toBeNull();

    act(() => {
      makeStagedElement('@button', 'button.own', 'tab-1');
    });
    expect(screen.getByTestId('browser-element-rack')).toBeInTheDocument();

    unmount();
    expect(screen.queryByTestId('browser-element-rack')).toBeNull();
  });

  it('renders a vertical list without element images, removes individually, and shows clear-all for 2+ items', () => {
    const firstId = makeStagedElement('@button', 'button.primary');
    attachPickedBrowserElementImage(
      firstId,
      new File(['png'], 'el.png', { type: 'image/png' })
    );
    renderRackInHost({ surfaceHost: 'canvas' });

    const rack = screen.getByTestId('browser-element-rack');
    expect(rack).toBeInTheDocument();
    expect(rack.style.height).toBe(`${DEFAULT_RACK_PANEL_HEIGHT}px`);
    expect(screen.getAllByTestId('browser-element-rack-chip')).toHaveLength(1);
    expect(rack.querySelectorAll('img')).toHaveLength(0);
    expect(screen.queryByTestId('browser-element-rack-clear')).toBeNull();

    act(() => {
      makeStagedElement('@header', 'header.top');
    });
    expect(screen.getAllByTestId('browser-element-rack-chip')).toHaveLength(2);
    expect(
      screen.getByTestId('browser-element-rack-clear')
    ).toBeInTheDocument();

    const removeButtons = screen.getAllByTestId('browser-element-rack-remove');
    fireEvent.click(removeButtons[0]);
    expect(screen.getAllByTestId('browser-element-rack-chip')).toHaveLength(1);
    expect(screen.queryByTestId('browser-element-rack-clear')).toBeNull();

    act(() => {
      makeStagedElement('@nav', 'nav.main');
    });
    fireEvent.click(screen.getByTestId('browser-element-rack-clear'));
    expect(screen.queryByTestId('browser-element-rack')).toBeNull();
  });

  it('renders inline inside the canvas browser node with single node-only bounds and collapses on header double-click', () => {
    makeStagedElement('@button', 'button.primary');
    makeStagedElement('@input', 'input.email');
    makeStagedElement('@link', 'a.docs');
    makeStagedElement('@footer', 'footer.site');

    // Simulate a canvas browser node positioned far outside window viewport
    // (e.g. left = 1800) to confirm there is NO double viewport/stage clamping.
    renderRackInHost({
      surfaceHost: 'canvas',
      rect: {
        left: 1800,
        top: 600,
        width: 640,
        height: 480,
        clientWidth: 640,
        clientHeight: 480,
      },
    });

    const host = screen.getByTestId('mock-browser-host');
    const rack = screen.getByTestId('browser-element-rack');
    const header = screen.getByTestId('browser-element-rack-header');

    // Mounted directly inside the browser node surface (pure inline child)
    expect(host.contains(rack)).toBe(true);
    expect(rack.className).toContain('absolute');
    expect(rack.style.opacity).toBe('');

    // Local coordinates inside 640x480 browser node:
    // left = 640 - 224 - 10 = 406, top = 10
    expect(rack.style.left).toBe('406px');
    expect(rack.style.top).toBe('10px');

    // Pointer down on header must NOT cancel default so Chromium fires dblclick
    const pointerDownEvent = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 420,
      clientY: 20,
    });
    header.dispatchEvent(pointerDownEvent);
    expect(pointerDownEvent.defaultPrevented).toBe(false);

    // Drag inside browser node bounds
    fireEvent.pointerMove(window, { clientX: 250, clientY: 160 });
    expect(useElectronBrowserSurfaceStore.getState().overlayDragging).toBe(
      true
    );
    expect(rack.style.left).toBe('236px');
    expect(rack.style.top).toBe('150px');

    // Dragging past left/top edge clamps strictly to browser node inset (10, 10)
    fireEvent.pointerMove(window, { clientX: -300, clientY: -300 });
    expect(rack.style.left).toBe('10px');
    expect(rack.style.top).toBe('10px');

    fireEvent.pointerUp(window, { clientX: -300, clientY: -300 });
    expect(useElectronBrowserSurfaceStore.getState().overlayDragging).toBe(
      false
    );

    // Resize panel height via bottom handle
    const resizeHandle = screen.getByTestId(
      'browser-element-rack-resize-handle'
    );
    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      clientX: 200,
      clientY: 250,
    });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 310 });
    expect(rack.style.height).toBe(`${DEFAULT_RACK_PANEL_HEIGHT + 60}px`);

    // Shrink below minimum -> clamped to MIN_RACK_PANEL_HEIGHT
    fireEvent.pointerMove(window, { clientX: 200, clientY: 50 });
    expect(rack.style.height).toBe(`${MIN_RACK_PANEL_HEIGHT}px`);
    fireEvent.pointerUp(window, { clientX: 200, clientY: 50 });

    // Double-click header collapses the rack into the floating ball
    fireEvent.doubleClick(header);
    expect(rack.getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('browser-element-rack-ball')).toBeInTheDocument();
  });

  it('scales pointer drag deltas accurately when the canvas browser node is CSS-zoomed', () => {
    makeStagedElement('@button', 'button.zoomed');
    // Unscaled node is 640x480, rendered at 0.5x canvas zoom (320x240)
    renderRackInHost({
      surfaceHost: 'canvas',
      rect: {
        left: 100,
        top: 100,
        width: 320,
        height: 240,
        clientWidth: 640,
        clientHeight: 480,
      },
    });

    const rack = screen.getByTestId('browser-element-rack');
    const header = screen.getByTestId('browser-element-rack-header');
    // Starts at local (406, 10)
    expect(rack.style.left).toBe('406px');
    expect(rack.style.top).toBe('10px');

    // Moving pointer by (-50px, +40px) in screen space at 0.5x zoom = (-100px, +80px) local
    fireEvent.pointerDown(header, { button: 0, clientX: 300, clientY: 110 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 150 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 150 });

    expect(rack.style.left).toBe('306px');
    expect(rack.style.top).toBe('90px');
  });

  it('collapses to a draggable floating ball and clamps inside the browser node bounds when expanded from any corner', () => {
    makeStagedElement('@button', 'button');
    makeStagedElement('@input', 'input');

    const nodeWidth = 320;
    const nodeHeight = 260;
    renderRackInHost({
      surfaceHost: 'canvas',
      rect: {
        left: 200,
        top: 140,
        width: nodeWidth,
        height: nodeHeight,
        clientWidth: nodeWidth,
        clientHeight: nodeHeight,
      },
    });

    fireEvent.click(screen.getByTestId('browser-element-rack-collapse'));

    const ball = screen.getByTestId('browser-element-rack-ball');
    expect(ball).toBeInTheDocument();
    expect(
      screen.getByTestId('browser-element-rack-ball-count')
    ).toHaveTextContent('2');

    const rack = screen.getByTestId('browser-element-rack');
    expect(rack.getAttribute('data-collapsed')).toBe('true');

    // Drag the floating ball to the extreme bottom-right corner of the canvas browser node
    const startLeft = Number.parseInt(rack.style.left, 10);
    const startTop = Number.parseInt(rack.style.top, 10);
    fireEvent.pointerDown(ball, {
      button: 0,
      clientX: startLeft + 20,
      clientY: startTop + 20,
    });
    fireEvent.pointerMove(window, { clientX: 900, clientY: 900 });
    fireEvent.pointerUp(window, { clientX: 900, clientY: 900 });

    const ballLeft = Number.parseInt(rack.style.left, 10);
    const ballTop = Number.parseInt(rack.style.top, 10);
    expect(ballLeft).toBe(nodeWidth - 40 - 10);
    expect(ballTop).toBe(nodeHeight - 40 - 10);

    // Click the ball to expand -> expanded panel stays strictly inside local node bounds
    fireEvent.pointerDown(ball, {
      button: 0,
      clientX: ballLeft + 20,
      clientY: ballTop + 20,
    });
    fireEvent.pointerUp(window, {
      button: 0,
      clientX: ballLeft + 20,
      clientY: ballTop + 20,
    });

    expect(rack.getAttribute('data-collapsed')).toBe('false');
    const expandedLeft = Number.parseInt(rack.style.left, 10);
    const expandedTop = Number.parseInt(rack.style.top, 10);
    const expandedWidth = Number.parseInt(rack.style.width, 10);
    const expandedHeight = Number.parseInt(rack.style.height, 10);

    expect(expandedLeft).toBeGreaterThanOrEqual(0);
    expect(expandedTop).toBeGreaterThanOrEqual(0);
    expect(expandedLeft + expandedWidth).toBeLessThanOrEqual(nodeWidth);
    expect(expandedTop + expandedHeight).toBeLessThanOrEqual(nodeHeight);
  });

  it('portals above Dockview webviews using only the browser tab rect and hides when panelVisible is false', () => {
    makeStagedElement('@button', 'button.submit');
    const { rerender } = renderRackInHost({
      surfaceHost: 'dockview',
      panelVisible: true,
      rect: { left: 100, top: 80, width: 640, height: 480 },
    });

    const host = screen.getByTestId('mock-browser-host');
    const rack = screen.getByTestId('browser-element-rack');
    expect(host.contains(rack)).toBe(false);
    expect(rack.className).toContain('fixed');
    // right = 740 -> left = 740 - 224 - 10 = 506, top = 80 + 10 = 90
    expect(rack.style.left).toBe('506px');
    expect(rack.style.top).toBe('90px');

    rerender(
      <div data-testid="mock-browser-host">
        <BrowserElementRackOverlay
          tabId="tab-1"
          surfaceHost="dockview"
          hostRef={{ current: host }}
          panelVisible={false}
        />
      </div>
    );
    expect(screen.queryByTestId('browser-element-rack')).toBeNull();
  });

  it('drops a dragged chip onto the targeted composer drop zone without thumbnail images and removes it from the rack', () => {
    const firstId = makeStagedElement('@button', 'button.submit');
    attachPickedBrowserElementImage(
      firstId,
      new File(['png'], 'submit.png', { type: 'image/png' })
    );
    makeStagedElement('@input', 'input.email');

    const zoneA = document.createElement('div');
    zoneA.setAttribute('data-file-reference-drop-zone', 'true');
    const zoneB = document.createElement('div');
    zoneB.setAttribute('data-file-reference-drop-zone', 'true');
    document.body.append(zoneA, zoneB);

    const receivedA: StagedBrowserElement[] = [];
    const receivedB: StagedBrowserElement[] = [];
    zoneA.addEventListener(BROWSER_ELEMENT_DROP_EVENT, (event) => {
      event.preventDefault();
      receivedA.push((event as CustomEvent<StagedBrowserElement>).detail);
    });
    zoneB.addEventListener(BROWSER_ELEMENT_DROP_EVENT, (event) => {
      event.preventDefault();
      receivedB.push((event as CustomEvent<StagedBrowserElement>).detail);
    });

    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      writable: true,
      value: vi.fn(() => zoneB),
    });

    renderRackInHost({ surfaceHost: 'canvas' });
    const chips = screen.getAllByTestId('browser-element-rack-chip');

    fireEvent.pointerDown(chips[0], { button: 0, clientX: 100, clientY: 100 });
    expect(useElectronBrowserSurfaceStore.getState().overlayDragging).toBe(
      true
    );
    fireEvent.pointerMove(window, { clientX: 220, clientY: 320 });
    const ghost = screen.getByTestId('browser-element-rack-ghost');
    expect(ghost).toBeInTheDocument();
    expect(ghost.querySelectorAll('img')).toHaveLength(0);

    fireEvent.pointerUp(window, { clientX: 220, clientY: 320 });

    expect(useElectronBrowserSurfaceStore.getState().overlayDragging).toBe(
      false
    );
    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);
    expect(receivedB[0]?.label).toBe('@button');
    expect(receivedB[0]?.imageFile).toBeInstanceOf(File);
    expect(
      useBrowserElementRackStore.getState().items.map((i) => i.label)
    ).toEqual(['@input']);

    // Alt-drop keeps the chip staged as a copy.
    const remainingChip = screen.getByTestId('browser-element-rack-chip');
    fireEvent.pointerDown(remainingChip, {
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(window, { clientX: 220, clientY: 320 });
    fireEvent.pointerUp(window, {
      clientX: 220,
      clientY: 320,
      altKey: true,
    });
    expect(receivedB).toHaveLength(2);
    expect(
      useBrowserElementRackStore.getState().items.map((i) => i.label)
    ).toEqual(['@input']);

    zoneA.remove();
    zoneB.remove();
  });

  it('keeps the chip staged when dropped outside any composer drop zone', () => {
    makeStagedElement('@div', 'div.card');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      writable: true,
      value: vi.fn(() => document.body),
    });

    renderRackInHost({ surfaceHost: 'canvas' });
    const chip = screen.getByTestId('browser-element-rack-chip');

    fireEvent.pointerDown(chip, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 300 });

    expect(
      useBrowserElementRackStore.getState().items.map((i) => i.label)
    ).toEqual(['@div']);
  });
});
