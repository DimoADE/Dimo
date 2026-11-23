import type { CSSProperties } from 'react';
import type { BrowserSurfaceHost } from './browserPanelLifetime';

export interface ElectronBrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElectronBrowserClipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const HOST_BROWSER_MIN_Z_INDEX = 15;
export const HOST_BROWSER_MAX_Z_INDEX = 29;
export const HOST_BROWSER_DOCKVIEW_Z_INDEX = 20;
export const OFFSCREEN_HIDE_COORD_PX = -100_000;

export function resolveHostBrowserZIndex(
  surfaceHost: BrowserSurfaceHost,
  nodeZIndex?: number | null
): number {
  if (surfaceHost === 'dockview') {
    return HOST_BROWSER_DOCKVIEW_Z_INDEX;
  }
  const normalized =
    typeof nodeZIndex === 'number' && Number.isFinite(nodeZIndex)
      ? Math.max(0, Math.round(nodeZIndex))
      : 0;
  return Math.min(
    HOST_BROWSER_MAX_Z_INDEX,
    HOST_BROWSER_MIN_Z_INDEX + normalized
  );
}

export function shouldKeepPaintableWhenInactive(
  platform?: string,
  userAgent?: string
): boolean {
  const resolvedPlatform =
    platform ??
    (typeof navigator !== 'undefined' ? navigator.platform : '') ??
    '';
  const resolvedUa =
    userAgent ??
    (typeof navigator !== 'undefined' ? navigator.userAgent : '') ??
    '';
  return (
    /mac/i.test(resolvedPlatform) || /macintosh|mac os x/i.test(resolvedUa)
  );
}

export function computeClipPathInset(
  surfaceRect: ElectronBrowserRect,
  clipRect: ElectronBrowserClipRect | null
): string | undefined {
  if (!clipRect) {
    return undefined;
  }
  const surfaceRight = surfaceRect.x + surfaceRect.width;
  const surfaceBottom = surfaceRect.y + surfaceRect.height;
  const top = Math.max(0, Math.round(clipRect.top - surfaceRect.y));
  const right = Math.max(0, Math.round(surfaceRight - clipRect.right));
  const bottom = Math.max(0, Math.round(surfaceBottom - clipRect.bottom));
  const left = Math.max(0, Math.round(clipRect.left - surfaceRect.x));
  if (top === 0 && right === 0 && bottom === 0 && left === 0) {
    return undefined;
  }
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}

export function isSurfaceRectIntersectingClip(
  surfaceRect: ElectronBrowserRect,
  clipRect: ElectronBrowserClipRect | null,
  marginPx = 0
): boolean {
  if (surfaceRect.width <= 0 || surfaceRect.height <= 0) {
    return false;
  }
  if (!clipRect) {
    return true;
  }
  const left = Math.max(surfaceRect.x - marginPx, clipRect.left);
  const top = Math.max(surfaceRect.y - marginPx, clipRect.top);
  const right = Math.min(
    surfaceRect.x + surfaceRect.width + marginPx,
    clipRect.right
  );
  const bottom = Math.min(
    surfaceRect.y + surfaceRect.height + marginPx,
    clipRect.bottom
  );
  return right - left >= 1 && bottom - top >= 1;
}

export interface HostedWebviewStyleInput {
  visible: boolean;
  rect: ElectronBrowserRect;
  clipRect: ElectronBrowserClipRect | null;
  scale: number;
  zIndex: number;
  cornerRadius: number;
  interactive: boolean;
  backgroundColor?: string;
  keepPaintableWhenInactive?: boolean;
}

export function computeHostedWebviewStyles(input: HostedWebviewStyleInput): {
  wrapperStyle: CSSProperties;
  webviewStyle: CSSProperties;
} {
  const safeScale =
    Number.isFinite(input.scale) && input.scale > 0.05 ? input.scale : 1;
  const width = Math.max(1, Math.round(input.rect.width));
  const height = Math.max(1, Math.round(input.rect.height));
  const logicalWidth = Math.max(1, Math.round(width / safeScale));
  const logicalHeight = Math.max(1, Math.round(height / safeScale));
  const isScaled = Math.abs(safeScale - 1) > 0.001;

  const webviewStyle: CSSProperties = {
    display: 'flex',
    width: `${logicalWidth}px`,
    height: `${logicalHeight}px`,
    border: 0,
    ...(isScaled
      ? {
          transformOrigin: '0 0',
          transform: `matrix3d(${safeScale}, 0, 0, 0, 0, ${safeScale}, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)`,
          transformStyle: 'preserve-3d',
        }
      : {}),
  };

  if (!input.visible) {
    const keepPaintable =
      input.keepPaintableWhenInactive ?? shouldKeepPaintableWhenInactive();
    return {
      wrapperStyle: {
        position: 'fixed',
        left: `${OFFSCREEN_HIDE_COORD_PX}px`,
        top: `${OFFSCREEN_HIDE_COORD_PX}px`,
        width: `${width}px`,
        height: `${height}px`,
        zIndex: -1,
        overflow: 'hidden',
        pointerEvents: 'none',
        visibility: keepPaintable ? 'visible' : 'hidden',
        backgroundColor: input.backgroundColor,
      },
      webviewStyle,
    };
  }

  const clipPath = computeClipPathInset(
    { x: Math.round(input.rect.x), y: Math.round(input.rect.y), width, height },
    input.clipRect
  );

  return {
    wrapperStyle: {
      position: 'fixed',
      left: `${Math.round(input.rect.x)}px`,
      top: `${Math.round(input.rect.y)}px`,
      width: `${width}px`,
      height: `${height}px`,
      zIndex: input.zIndex,
      overflow: 'hidden',
      borderRadius:
        input.cornerRadius > 0 ? `${Math.round(input.cornerRadius)}px` : 0,
      clipPath,
      visibility: 'visible',
      pointerEvents: input.interactive ? 'auto' : 'none',
      backgroundColor: input.backgroundColor,
    },
    webviewStyle,
  };
}
