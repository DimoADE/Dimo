import { useEffect } from 'react';
import { hasElectronDesktopRuntime } from '@/lib/desktopShell';
import { HostedElectronBrowserWebview } from './HostedElectronBrowserWebview';
import {
  setElectronBrowserHostMounted,
  useElectronBrowserSurfaceStore,
} from './electronBrowserSurfaceStore';

/**
 * App-root fixed-order host for all Electron `<webview>` guests.
 *
 * Electron destroys a `<webview>` guest WebContents whenever its DOM element is
 * reparented or reordered. Mounting all live `<webview>` nodes here in stable
 * insertion order decouples guest lifetimes from Dockview tab drags, split
 * reparenting, `display: none` / `visibility: hidden` stage switches, and
 * React Flow `orderCanvasNodes` reordering.
 */
export function ElectronBrowserHost() {
  const isElectron = hasElectronDesktopRuntime();
  const tabOrder = useElectronBrowserSurfaceStore((state) => state.tabOrder);

  useEffect(() => {
    if (!isElectron) {
      return undefined;
    }
    setElectronBrowserHostMounted(true);
    return () => {
      setElectronBrowserHostMounted(false);
    };
  }, [isElectron]);

  if (!isElectron) {
    return null;
  }

  return (
    <div
      data-testid="electron-browser-host"
      aria-hidden={tabOrder.length === 0 || undefined}
      style={{ display: 'contents' }}
    >
      {tabOrder.map((tabId) => (
        <HostedElectronBrowserWebview key={tabId} tabId={tabId} />
      ))}
    </div>
  );
}
