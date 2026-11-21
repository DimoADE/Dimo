import { createElement, useEffect, useRef, useState } from 'react';
import { getDesktopShell } from '@/lib/desktopShell';
import type { BrowserSurfaceHost } from './browserPanelLifetime';

export const CANVAS_HIBERNATE_DELAY_MS = 60_000;

interface ElectronWebviewElement extends HTMLElement {
  getWebContentsId?: () => number;
  canGoBack?: () => boolean;
  getURL?: () => string;
  src?: string;
}

interface FreezeThumbnailPayload {
  mime?: string;
  data?: string;
}

export function electronPartitionForProfile(
  profileId: string,
  tabId: string
): string {
  const sanitize = (raw: string) => {
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 64) : 'default';
  };

  const trimmed = profileId.trim();
  if (trimmed === 'ephemeral') {
    return `dimo-browser-ephemeral-${sanitize(tabId || 'session')}`;
  }
  return `persist:dimo-browser-${sanitize(trimmed || 'default')}`;
}

export interface ElectronBrowserWebviewProps {
  tabId: string;
  url: string;
  profileId: string;
  surfaceHost: BrowserSurfaceHost;
  panelVisible: boolean;
  canHibernate?: boolean;
  hibernateDelayMs?: number;
  onHistoryAvailabilityChange?: (canGoBack: boolean) => void;
}

/**
 * Renders an Electron `<webview>` directly inside Chromium's DOM compositor tree,
 * attaches its `webContentsId` to Electron Main's `ElectronBrowserController`, and
 * hibernates offscreen infinite-canvas cards to a lightweight snapshot to cap memory.
 */
export function ElectronBrowserWebview({
  tabId,
  url,
  profileId,
  surfaceHost,
  panelVisible,
  canHibernate = true,
  hibernateDelayMs = CANVAS_HIBERNATE_DELAY_MS,
  onHistoryAvailabilityChange,
}: ElectronBrowserWebviewProps) {
  const webviewRef = useRef<ElectronWebviewElement | null>(null);
  const attachedWcIdRef = useRef<number | null>(null);
  const lastUrlRef = useRef<string>(url || 'about:blank');
  const [mountSrc, setMountSrc] = useState<string>(url || 'about:blank');
  const [hibernated, setHibernated] = useState(false);
  const [hibernatedSnapshot, setHibernatedSnapshot] = useState<string | null>(
    null
  );
  const onHistoryChangeRef = useRef(onHistoryAvailabilityChange);
  onHistoryChangeRef.current = onHistoryAvailabilityChange;

  const partition = electronPartitionForProfile(profileId, tabId);

  // Track latest external URL for wake-up restoration without reloading mounted webviews.
  useEffect(() => {
    if (url && url.trim().length > 0) {
      lastUrlRef.current = url;
    }
  }, [url]);

  // Reset initial src if the logical tabId changes.
  useEffect(() => {
    setHibernated(false);
    setHibernatedSnapshot(null);
    setMountSrc(url || 'about:blank');
    lastUrlRef.current = url || 'about:blank';
    // Only reset on tabId switch, not on in-page URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Infinite-canvas hibernation: release guest Chromium process after offscreen idle.
  useEffect(() => {
    if (surfaceHost !== 'canvas' || !canHibernate) {
      if (hibernated) {
        setMountSrc(lastUrlRef.current || url || 'about:blank');
        setHibernated(false);
      }
      return undefined;
    }

    if (panelVisible) {
      if (hibernated) {
        setMountSrc(lastUrlRef.current || url || 'about:blank');
        setHibernated(false);
      }
      return undefined;
    }

    if (hibernated) {
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        let dataUrl: string | null = null;
        try {
          const frame = await getDesktopShell().invoke<FreezeThumbnailPayload | null>(
            'electron_browser_capture_thumbnail',
            { tabId }
          );
          if (frame?.data) {
            const mime = frame.mime || 'image/jpeg';
            dataUrl = `data:${mime};base64,${frame.data}`;
          }
        } catch {
          // Hibernation proceeds even if thumbnail capture is unavailable.
        }
        if (cancelled) return;
        setHibernatedSnapshot(dataUrl);
        setHibernated(true);
      })();
    }, hibernateDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [canHibernate, hibernateDelayMs, hibernated, panelVisible, surfaceHost, tabId, url]);

  // Attach/detach the live <webview> guest WebContents with Electron Main.
  useEffect(() => {
    if (hibernated) {
      return undefined;
    }
    const el = webviewRef.current;
    if (!el) {
      return undefined;
    }

    let disposed = false;

    const attach = () => {
      if (disposed || typeof el.getWebContentsId !== 'function') {
        return;
      }
      let wcId: number;
      try {
        wcId = el.getWebContentsId();
      } catch {
        return;
      }
      if (!Number.isFinite(wcId) || wcId <= 0 || attachedWcIdRef.current === wcId) {
        return;
      }
      attachedWcIdRef.current = wcId;
      const currentUrl =
        (typeof el.getURL === 'function' ? el.getURL() : '') ||
        lastUrlRef.current ||
        'about:blank';
      void getDesktopShell()
        .invoke('electron_browser_attach', {
          tabId,
          webContentsId: wcId,
          profileId,
          url: currentUrl,
        })
        .catch(() => undefined);
    };

    const syncHistory = () => {
      if (disposed) return;
      if (typeof el.getURL === 'function') {
        const nextUrl = el.getURL();
        if (nextUrl) lastUrlRef.current = nextUrl;
      }
      if (typeof el.canGoBack === 'function') {
        try {
          onHistoryChangeRef.current?.(Boolean(el.canGoBack()));
        } catch {
          // Ignore before dom-ready
        }
      }
    };

    const onDomReady = () => {
      attach();
      syncHistory();
    };

    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('did-navigate', syncHistory);
    el.addEventListener('did-navigate-in-page', syncHistory);
    el.addEventListener('did-stop-loading', syncHistory);

    // Attempt immediate attach in case the guest is already initialized.
    attach();

    return () => {
      disposed = true;
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('did-navigate', syncHistory);
      el.removeEventListener('did-navigate-in-page', syncHistory);
      el.removeEventListener('did-stop-loading', syncHistory);
      const wcId = attachedWcIdRef.current;
      attachedWcIdRef.current = null;
      void getDesktopShell()
        .invoke('electron_browser_detach', {
          tabId,
          ...(wcId !== null ? { webContentsId: wcId } : {}),
        })
        .catch(() => undefined);
    };
  }, [hibernated, profileId, tabId]);

  if (hibernated) {
    return (
      <button
        type="button"
        data-testid="electron-browser-hibernated"
        onClick={() => {
          setMountSrc(lastUrlRef.current || url || 'about:blank');
          setHibernated(false);
        }}
        className="relative block h-full w-full cursor-pointer overflow-hidden border-0 bg-background p-0 text-left"
      >
        {hibernatedSnapshot ? (
          <img
            src={hibernatedSnapshot}
            alt=""
            draggable={false}
            className="h-full w-full select-none object-cover opacity-90"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            {lastUrlRef.current}
          </div>
        )}
      </button>
    );
  }

  return createElement('webview', {
    ref: webviewRef,
    src: mountSrc,
    partition,
    allowpopups: 'true',
    'data-testid': 'electron-browser-webview',
    'data-tab-id': tabId,
    className: 'block h-full w-full border-0',
    style: { width: '100%', height: '100%' },
  });
}
