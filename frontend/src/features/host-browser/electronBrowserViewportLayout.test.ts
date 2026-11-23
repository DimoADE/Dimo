import { describe, expect, it } from 'vitest';
import {
  HOST_BROWSER_DOCKVIEW_Z_INDEX,
  HOST_BROWSER_MAX_Z_INDEX,
  HOST_BROWSER_MIN_Z_INDEX,
  OFFSCREEN_HIDE_COORD_PX,
  computeClipPathInset,
  computeHostedWebviewStyles,
  isSurfaceRectIntersectingClip,
  resolveHostBrowserZIndex,
  shouldKeepPaintableWhenInactive,
} from './electronBrowserViewportLayout';

describe('electronBrowserViewportLayout', () => {
  it('resolves z-index safely below modal and floating canvas control layers', () => {
    expect(resolveHostBrowserZIndex('dockview', 99)).toBe(
      HOST_BROWSER_DOCKVIEW_Z_INDEX
    );
    expect(resolveHostBrowserZIndex('canvas', undefined)).toBe(
      HOST_BROWSER_MIN_Z_INDEX
    );
    expect(resolveHostBrowserZIndex('canvas', 0)).toBe(
      HOST_BROWSER_MIN_Z_INDEX
    );
    expect(resolveHostBrowserZIndex('canvas', 5)).toBe(
      HOST_BROWSER_MIN_Z_INDEX + 5
    );
    expect(resolveHostBrowserZIndex('canvas', 250)).toBe(
      HOST_BROWSER_MAX_Z_INDEX
    );
    expect(resolveHostBrowserZIndex('canvas', -10)).toBe(
      HOST_BROWSER_MIN_Z_INDEX
    );
  });

  it('detects macOS paint-keeping policy accurately across platforms', () => {
    expect(shouldKeepPaintableWhenInactive('MacIntel', '')).toBe(true);
    expect(
      shouldKeepPaintableWhenInactive(
        '',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      )
    ).toBe(true);
    expect(
      shouldKeepPaintableWhenInactive(
        'Win32',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
    ).toBe(false);
    expect(shouldKeepPaintableWhenInactive('Linux x86_64', 'Linux')).toBe(
      false
    );
  });

  it('computes clip-path inset only when the surface overflows the stage clip rect', () => {
    expect(
      computeClipPathInset(
        { x: 100, y: 100, width: 400, height: 300 },
        { left: 50, top: 50, right: 600, bottom: 500 }
      )
    ).toBeUndefined();

    expect(
      computeClipPathInset(
        { x: 80, y: 40, width: 400, height: 300 },
        { left: 100, top: 60, right: 450, bottom: 320 }
      )
    ).toBe('inset(20px 30px 20px 20px)');
  });

  it('checks intersection with stage clip rect including optional hibernation margin', () => {
    const clip = { left: 100, top: 100, right: 900, bottom: 700 };
    expect(
      isSurfaceRectIntersectingClip(
        { x: 200, y: 200, width: 300, height: 200 },
        clip,
        0
      )
    ).toBe(true);
    expect(
      isSurfaceRectIntersectingClip(
        { x: 950, y: 200, width: 300, height: 200 },
        clip,
        0
      )
    ).toBe(false);
    expect(
      isSurfaceRectIntersectingClip(
        { x: 950, y: 200, width: 300, height: 200 },
        clip,
        120
      )
    ).toBe(true);
    expect(
      isSurfaceRectIntersectingClip(
        { x: 1200, y: 200, width: 300, height: 200 },
        clip,
        120
      )
    ).toBe(false);
  });

  it('always applies display: flex on webview and matrix3d preserve-3d scaling for canvas zoom', () => {
    const styles = computeHostedWebviewStyles({
      visible: true,
      rect: { x: 120, y: 80, width: 400, height: 300 },
      clipRect: { left: 140, top: 60, right: 500, bottom: 400 },
      scale: 0.5,
      zIndex: 22,
      cornerRadius: 12,
      interactive: true,
      backgroundColor: '#14171f',
    });

    expect(styles.webviewStyle.display).toBe('flex');
    expect(styles.webviewStyle.width).toBe('800px');
    expect(styles.webviewStyle.height).toBe('600px');
    expect(styles.webviewStyle.transformOrigin).toBe('0 0');
    expect(styles.webviewStyle.transform).toBe(
      'matrix3d(0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)'
    );
    expect(styles.webviewStyle.transformStyle).toBe('preserve-3d');

    expect(styles.wrapperStyle).toMatchObject({
      position: 'fixed',
      left: '120px',
      top: '80px',
      width: '400px',
      height: '300px',
      zIndex: 22,
      borderRadius: '12px',
      clipPath: 'inset(0px 20px 0px 20px)',
      visibility: 'visible',
      pointerEvents: 'auto',
      backgroundColor: '#14171f',
    });
  });

  it('disables pointer-events when canvas interaction is active', () => {
    const styles = computeHostedWebviewStyles({
      visible: true,
      rect: { x: 100, y: 100, width: 600, height: 400 },
      clipRect: null,
      scale: 1,
      zIndex: 20,
      cornerRadius: 0,
      interactive: false,
    });

    expect(styles.wrapperStyle.pointerEvents).toBe('none');
    expect(styles.webviewStyle.transform).toBeUndefined();
  });

  it('parks hidden webviews offscreen with platform-appropriate visibility', () => {
    const macHidden = computeHostedWebviewStyles({
      visible: false,
      rect: { x: 100, y: 100, width: 600, height: 400 },
      clipRect: null,
      scale: 1,
      zIndex: 20,
      cornerRadius: 0,
      interactive: false,
      keepPaintableWhenInactive: true,
    });
    expect(macHidden.wrapperStyle.left).toBe(`${OFFSCREEN_HIDE_COORD_PX}px`);
    expect(macHidden.wrapperStyle.top).toBe(`${OFFSCREEN_HIDE_COORD_PX}px`);
    expect(macHidden.wrapperStyle.visibility).toBe('visible');
    expect(macHidden.wrapperStyle.pointerEvents).toBe('none');
    expect(macHidden.webviewStyle.display).toBe('flex');

    const winHidden = computeHostedWebviewStyles({
      visible: false,
      rect: { x: 100, y: 100, width: 600, height: 400 },
      clipRect: null,
      scale: 1,
      zIndex: 20,
      cornerRadius: 0,
      interactive: false,
      keepPaintableWhenInactive: false,
    });
    expect(winHidden.wrapperStyle.visibility).toBe('hidden');
  });
});
