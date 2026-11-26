import { describe, expect, it } from 'vitest';
import {
  EDGE_INSET,
  THUMB_PX,
  attachOverlayScrollbars,
  findScroller,
  thumbGeometry,
} from './scrollbarOverlay';

describe('thumbGeometry', () => {
  it('returns null when the content fits', () => {
    expect(
      thumbGeometry({
        clientSize: 100,
        scrollSize: 100,
        scrollOffset: 0,
        trackSize: 100,
        minThumb: 24,
      })
    ).toBeNull();
  });

  it('places a thumb along the overflow without growing the track', () => {
    const geo = thumbGeometry({
      clientSize: 100,
      scrollSize: 400,
      scrollOffset: 150,
      trackSize: 100,
      minThumb: 24,
    });

    expect(geo).toEqual({ size: 25, offset: 37.5 });
  });
});

describe('overlay scrollbar host', () => {
  it('ignores scrollbars that already paint their own indicator', () => {
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'clientHeight', { value: 40 });
    Object.defineProperty(scroller, 'scrollHeight', { value: 200 });
    editor.append(scroller);
    document.body.append(editor);

    expect(findScroller(scroller, 'y')).toBeNull();
    editor.remove();
  });

  it('shows a thumb on scroll without narrowing the scroller', () => {
    const vertical = document.createElement('div');
    const horizontal = document.createElement('div');
    document.body.append(vertical, horizontal);
    const detach = attachOverlayScrollbars(document, {
      vertical,
      horizontal,
    });
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.style.overflowX = 'hidden';
    document.body.append(scroller);
    Object.defineProperty(scroller, 'clientWidth', { value: 200 });
    Object.defineProperty(scroller, 'clientHeight', { value: 100 });
    Object.defineProperty(scroller, 'scrollWidth', { value: 200 });
    Object.defineProperty(scroller, 'scrollHeight', { value: 400 });
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
    });
    scroller.getBoundingClientRect = () =>
      ({
        top: 10,
        left: 20,
        right: 220,
        bottom: 110,
        width: 200,
        height: 100,
        x: 20,
        y: 10,
        toJSON: () => ({}),
      }) as DOMRect;
    scroller.getClientRects = () =>
      ({
        length: 1,
        0: scroller.getBoundingClientRect(),
        item: () => scroller.getBoundingClientRect(),
      }) as unknown as DOMRectList;

    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

    expect(scroller.clientWidth).toBe(200);
    expect(vertical.classList.contains('is-visible')).toBe(true);
    expect(vertical.style.width).toBe(`${THUMB_PX}px`);
    expect(vertical.style.left).toBe(`${220 - THUMB_PX - EDGE_INSET}px`);
    detach();
    vertical.remove();
    horizontal.remove();
    scroller.remove();
  });

  it('hides the thumb immediately when the pointer moves to another panel', () => {
    const vertical = document.createElement('div');
    const horizontal = document.createElement('div');
    document.body.append(vertical, horizontal);
    const detach = attachOverlayScrollbars(document, {
      vertical,
      horizontal,
    });
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.append(scroller);
    Object.defineProperty(scroller, 'clientHeight', { value: 100 });
    Object.defineProperty(scroller, 'scrollHeight', { value: 400 });
    Object.defineProperty(scroller, 'clientWidth', { value: 200 });
    Object.defineProperty(scroller, 'scrollWidth', { value: 200 });
    scroller.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    scroller.getClientRects = () =>
      ({
        length: 1,
        item: () => scroller.getBoundingClientRect(),
      }) as unknown as DOMRectList;

    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(vertical.classList.contains('is-visible')).toBe(true);

    const otherPanel = document.createElement('button');
    document.body.append(otherPanel);
    otherPanel.dispatchEvent(new Event('pointerover', { bubbles: true }));

    expect(vertical.classList.contains('is-visible')).toBe(false);
    detach();
    vertical.remove();
    horizontal.remove();
    scroller.remove();
    otherPanel.remove();
  });

  it('clips nested scroller thumb to clipping ancestor bounds and hides when scrolled out', () => {
    const vertical = document.createElement('div');
    const horizontal = document.createElement('div');
    document.body.append(vertical, horizontal);
    const detach = attachOverlayScrollbars(document, {
      vertical,
      horizontal,
    });

    const ancestor = document.createElement('div');
    ancestor.style.overflowY = 'auto';
    ancestor.style.overflowX = 'hidden';
    ancestor.getBoundingClientRect = () =>
      ({
        top: 60,
        left: 10,
        right: 310,
        bottom: 460,
        width: 300,
        height: 400,
        x: 10,
        y: 60,
        toJSON: () => ({}),
      }) as DOMRect;

    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'clientWidth', { value: 260 });
    Object.defineProperty(scroller, 'clientHeight', { value: 900 });
    Object.defineProperty(scroller, 'scrollWidth', { value: 260 });
    Object.defineProperty(scroller, 'scrollHeight', { value: 2400 });
    Object.defineProperty(scroller, 'scrollTop', {
      value: 1500,
      writable: true,
    });
    let scrollerRect = {
      top: -100,
      left: 20,
      right: 280,
      bottom: 800,
      width: 260,
      height: 900,
      x: 20,
      y: -100,
      toJSON: () => ({}),
    } as DOMRect;
    scroller.getBoundingClientRect = () => scrollerRect;
    scroller.getClientRects = () =>
      ({
        length: 1,
        0: scrollerRect,
        item: () => scrollerRect,
      }) as unknown as DOMRectList;

    ancestor.append(scroller);
    document.body.append(ancestor);

    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(vertical.classList.contains('is-visible')).toBe(true);
    const top = parseFloat(vertical.style.top);
    const height = parseFloat(vertical.style.height);
    expect(top).toBeGreaterThanOrEqual(60);
    expect(top + height).toBeLessThanOrEqual(460.5);

    // Move scroller completely above the clipped ancestor viewport -> thumb must hide
    scrollerRect = {
      ...scrollerRect,
      top: -950,
      bottom: 50,
    };
    ancestor.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(vertical.classList.contains('is-visible')).toBe(false);

    detach();
    vertical.remove();
    horizontal.remove();
    ancestor.remove();
  });

  it('tracks a nested horizontal scroller independently from its outer vertical scroller', () => {
    const vertical = document.createElement('div');
    const horizontal = document.createElement('div');
    document.body.append(vertical, horizontal);
    const detach = attachOverlayScrollbars(document, {
      vertical,
      horizontal,
    });

    const outer = document.createElement('div');
    outer.style.overflowY = 'auto';
    outer.style.overflowX = 'hidden';
    Object.defineProperty(outer, 'clientWidth', { value: 400 });
    Object.defineProperty(outer, 'clientHeight', { value: 300 });
    Object.defineProperty(outer, 'scrollWidth', { value: 400 });
    Object.defineProperty(outer, 'scrollHeight', { value: 1200 });
    Object.defineProperty(outer, 'scrollTop', { value: 0, writable: true });
    outer.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        right: 400,
        bottom: 300,
        width: 400,
        height: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    outer.getClientRects = () =>
      ({
        length: 1,
        0: outer.getBoundingClientRect(),
        item: () => outer.getBoundingClientRect(),
      }) as unknown as DOMRectList;

    const inner = document.createElement('div');
    inner.style.overflowX = 'auto';
    inner.style.overflowY = 'hidden';
    Object.defineProperty(inner, 'clientWidth', { value: 360 });
    Object.defineProperty(inner, 'clientHeight', { value: 120 });
    Object.defineProperty(inner, 'scrollWidth', { value: 900 });
    Object.defineProperty(inner, 'scrollHeight', { value: 120 });
    Object.defineProperty(inner, 'scrollLeft', { value: 0, writable: true });
    inner.getBoundingClientRect = () =>
      ({
        top: 40,
        left: 20,
        right: 380,
        bottom: 160,
        width: 360,
        height: 120,
        x: 20,
        y: 40,
        toJSON: () => ({}),
      }) as DOMRect;
    inner.getClientRects = () =>
      ({
        length: 1,
        0: inner.getBoundingClientRect(),
        item: () => inner.getBoundingClientRect(),
      }) as unknown as DOMRectList;

    outer.append(inner);
    document.body.append(outer);

    inner.dispatchEvent(new Event('pointerover', { bubbles: true }));

    expect(vertical.classList.contains('is-visible')).toBe(true);
    expect(horizontal.classList.contains('is-visible')).toBe(true);
    expect(parseFloat(horizontal.style.top)).toBe(160 - THUMB_PX - EDGE_INSET);

    detach();
    vertical.remove();
    horizontal.remove();
    outer.remove();
  });

  it('skips only the horizontal overlay thumb when data-overlay-scrollbar-x="off" is set', () => {
    const outer = document.createElement('div');
    outer.style.overflowY = 'auto';
    outer.style.overflowX = 'hidden';
    Object.defineProperty(outer, 'clientWidth', { value: 400 });
    Object.defineProperty(outer, 'clientHeight', { value: 300 });
    Object.defineProperty(outer, 'scrollWidth', { value: 400 });
    Object.defineProperty(outer, 'scrollHeight', { value: 1000 });

    const tableScroll = document.createElement('div');
    tableScroll.dataset.overlayScrollbarX = 'off';
    tableScroll.style.overflowX = 'auto';
    tableScroll.style.overflowY = 'hidden';
    Object.defineProperty(tableScroll, 'clientWidth', { value: 360 });
    Object.defineProperty(tableScroll, 'clientHeight', { value: 120 });
    Object.defineProperty(tableScroll, 'scrollWidth', { value: 900 });
    Object.defineProperty(tableScroll, 'scrollHeight', { value: 120 });

    const cell = document.createElement('span');
    tableScroll.append(cell);
    outer.append(tableScroll);
    document.body.append(outer);

    expect(findScroller(cell, 'x')).toBeNull();
    expect(findScroller(cell, 'y')).toBe(outer);

    outer.remove();
  });
});
