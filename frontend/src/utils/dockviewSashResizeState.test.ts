import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installDockviewSashResizeGuard,
  isDockviewSashResizing,
  subscribeDockviewSashResize,
} from './dockviewSashResizeState';

function dispatchPointerEvent(
  target: EventTarget,
  type: 'pointerdown' | 'pointerup' | 'pointercancel',
  init: { button?: number; pointerType?: string } = {}
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'button', { value: init.button ?? 0 });
  Object.defineProperty(event, 'pointerType', {
    value: init.pointerType ?? 'mouse',
  });
  target.dispatchEvent(event);
}

describe('dockviewSashResizeState', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('tracks active .dv-sash pointer drags and notifies subscribers', () => {
    const root = document.createElement('div');
    const sash = document.createElement('div');
    sash.className = 'dv-sash';
    const content = document.createElement('div');
    content.className = 'dv-content-container';
    root.append(sash, content);
    document.body.append(root);

    const events: boolean[] = [];
    const unsubscribe = subscribeDockviewSashResize((resizing) => {
      events.push(resizing);
    });
    const dispose = installDockviewSashResizeGuard(root);

    expect(isDockviewSashResizing()).toBe(false);
    expect(root.getAttribute('data-dockview-sash-resizing')).toBeNull();

    // Non-sash pointerdown must not activate sash resize mode.
    dispatchPointerEvent(content, 'pointerdown');
    expect(isDockviewSashResizing()).toBe(false);
    expect(events).toEqual([]);

    // Non-primary mouse button on sash must not activate sash resize mode.
    dispatchPointerEvent(sash, 'pointerdown', { button: 2 });
    expect(isDockviewSashResizing()).toBe(false);
    expect(events).toEqual([]);

    // Primary button on sash activates resize mode and clears on pointerup.
    dispatchPointerEvent(sash, 'pointerdown');
    expect(isDockviewSashResizing()).toBe(true);
    expect(root.getAttribute('data-dockview-sash-resizing')).toBe('true');
    expect(events).toEqual([true]);

    dispatchPointerEvent(document, 'pointerup');
    expect(isDockviewSashResizing()).toBe(false);
    expect(root.getAttribute('data-dockview-sash-resizing')).toBeNull();
    expect(events).toEqual([true, false]);

    // Cleans up cleanly if disposed mid-drag or window loses focus.
    dispatchPointerEvent(sash, 'pointerdown');
    expect(isDockviewSashResizing()).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(isDockviewSashResizing()).toBe(false);

    const listener = vi.fn();
    const unsub2 = subscribeDockviewSashResize(listener);
    dispatchPointerEvent(sash, 'pointerdown');
    dispose();
    expect(isDockviewSashResizing()).toBe(false);
    expect(root.getAttribute('data-dockview-sash-resizing')).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(false);

    unsub2();
    unsubscribe();
  });
});
