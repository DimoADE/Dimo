import type { DesktopShellCommand } from 'shared/hostCommands';

import type { BackendEnvironment } from '@/lib/transport/backendTransport';
import { useBackendTransport } from '@/lib/transport/BackendTransportProvider';
import { getBackendTransport } from '@/lib/transport/transportRegistry';

import {
  getElectronShellBridge,
  hasElectronDesktopRuntime,
} from './electronShellBridge';
import type { DesktopShellBridge, DesktopShellKind } from './types';
import { webShellBridge } from './webShellBridge';

export type {
  DesktopDialogFilter,
  DesktopDragDropEvent,
  DesktopDragDropPayload,
  DesktopDragDropPosition,
  DesktopOpenDialogOptions,
  DesktopSaveDialogOptions,
  DesktopShellAssetsApi,
  DesktopShellBridge,
  DesktopShellDialogApi,
  DesktopShellEventsApi,
  DesktopShellExternalApi,
  DesktopShellFsApi,
  DesktopShellKind,
  DesktopShellPathApi,
  DesktopShellUpdaterApi,
  DesktopShellWindowApi,
  DesktopUpdateDownloadEvent,
  DesktopUpdateHandle,
  ElectronBackendConnectionInfo,
  ElectronDesktopBridge,
} from './types';

export { hasElectronDesktopRuntime };

export class DesktopCapabilityError extends Error {
  readonly code = 'capability_unavailable';

  constructor(command: string) {
    super(`Desktop ability ${command} is not available`);
    this.name = 'DesktopCapabilityError';
  }
}

export function getDesktopShellKind(): DesktopShellKind {
  return hasElectronDesktopRuntime() ? 'electron' : 'web';
}

export function hasDesktopShell(): boolean {
  return hasElectronDesktopRuntime();
}

/**
 * Returns true when the Electron desktop shell preload bridge is present on `window`.
 */
export function hasAnyDesktopRuntime(): boolean {
  return hasElectronDesktopRuntime();
}

/**
 * Returns the active desktop shell bridge.
 *
 * When running inside Electron (`window.dimoDesktop` present), routes all
 * shell calls through the Electron preload bridge. Otherwise returns a safe
 * web fallback bridge.
 */
export function getDesktopShell(): DesktopShellBridge {
  if (typeof window !== 'undefined' && window.dimoDesktop) {
    return getElectronShellBridge(window.dimoDesktop);
  }
  return webShellBridge;
}

/**
 * Synchronous best-effort window label lookup.
 * Returns `'main'` when running outside a multi-window desktop shell.
 */
export function getDesktopWindowLabel(): string {
  try {
    return getDesktopShell().getWindowLabel();
  } catch {
    return 'main';
  }
}

/**
 * Opens an external URL or local path via the active desktop shell, falling
 * back to `window.open` when running in a plain browser.
 */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    await getDesktopShell().shell.openExternal(url);
  } catch {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
}

export function isLocalDesktopHost(
  environment: BackendEnvironment = getBackendTransport().environment
): boolean {
  return environment === 'desktop';
}

export function isDesktopClient(
  environment: BackendEnvironment = getBackendTransport().environment
): boolean {
  return environment === 'desktop' || environment === 'remote-desktop';
}

export function isTauriClient(
  environment: BackendEnvironment = getBackendTransport().environment
): boolean {
  return isDesktopClient(environment);
}

export function useLocalDesktopHost(): boolean {
  return isLocalDesktopHost(useBackendTransport().environment);
}

export function useDesktopClient(): boolean {
  return isDesktopClient(useBackendTransport().environment);
}

export function useTauriClient(): boolean {
  return isTauriClient(useBackendTransport().environment);
}

export async function desktopShellCall<T>(
  command: DesktopShellCommand,
  args?: Record<string, unknown>
): Promise<T> {
  if (!isDesktopClient()) {
    throw new DesktopCapabilityError(command);
  }
  return getDesktopShell().invoke<T>(command, args);
}
