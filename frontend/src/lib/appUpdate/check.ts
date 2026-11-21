import { configApi, type AppReleaseStatus } from '@/lib/api';
import { getDesktopShell } from '@/lib/desktopShell';

import { resolveAppUpdate } from './resolve';
import {
  clearLastCheck,
  DISMISSED_VERSION_KEY,
  readDismissedVersion,
  readLastCheck,
  writeDismissedVersion,
  writeLastCheck,
  writePostUpdateRestoreRoute,
} from './storage';
import type {
  AppUpdateLifecycleState,
  AppUpdateSnapshot,
  GitHubReleaseCheck,
  SignedFeedUpdate,
} from './types';

export const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 15_000;
const APP_UPDATE_EVENT = 'dimo:app-update-checked';
const APP_UPDATE_STATE_EVENT = 'dimo:app-update-state';
const APP_UPDATE_DISMISSED_EVENT = 'dimo:app-update-dismissed';

const INITIAL_LIFECYCLE_STATE: AppUpdateLifecycleState = {
  status: 'idle',
  version: null,
  downloaded: 0,
  total: null,
  error: null,
};

let inFlight: Promise<AppUpdateSnapshot> | null = null;
let updateInFlight: Promise<void> | null = null;
let lifecycleState: AppUpdateLifecycleState = { ...INITIAL_LIFECYCLE_STATE };
let stagedUpdate: {
  install: () => Promise<void>;
  close?: () => Promise<void>;
} | null = null;

/// Move session data out of the install tree before the updater replaces it.
/// A failure aborts the install: continuing on macOS deletes the only database.
async function evacuateUserDataBeforeReplacingInstall(): Promise<void> {
  await getDesktopShell().invoke('evacuate_user_data_before_update');
}

function setLifecycleState(next: AppUpdateLifecycleState): void {
  lifecycleState = next;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(APP_UPDATE_STATE_EVENT, { detail: next })
    );
  }
}

export function getAppUpdateState(): AppUpdateLifecycleState {
  return lifecycleState;
}

export function subscribeAppUpdateState(
  listener: (state: AppUpdateLifecycleState) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onState = (event: Event) => {
    listener((event as CustomEvent<AppUpdateLifecycleState>).detail);
  };
  window.addEventListener(APP_UPDATE_STATE_EVENT, onState);
  return () => {
    window.removeEventListener(APP_UPDATE_STATE_EVENT, onState);
  };
}

export function getDismissedAppUpdateVersion(): string | null {
  return readDismissedVersion();
}

export function dismissAppUpdateVersion(version: string | null): void {
  writeDismissedVersion(version);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(APP_UPDATE_DISMISSED_EVENT, { detail: version })
    );
  }
}

export function subscribeDismissedAppUpdateVersion(
  listener: (version: string | null) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onCustom = (event: Event) => {
    listener((event as CustomEvent<string | null>).detail);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== DISMISSED_VERSION_KEY) return;
    listener(readDismissedVersion());
  };

  window.addEventListener(APP_UPDATE_DISMISSED_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(APP_UPDATE_DISMISSED_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

export function resetAppUpdateStateForTests(): void {
  if (stagedUpdate?.close) {
    void stagedUpdate.close().catch(() => undefined);
  }
  stagedUpdate = null;
  updateInFlight = null;
  inFlight = null;
  lifecycleState = { ...INITIAL_LIFECYCLE_STATE };
}

function toGitHubCheck(status: AppReleaseStatus): GitHubReleaseCheck {
  return {
    current_version: status.current_version,
    latest_version: status.latest_version,
    update_available: status.update_available,
    release_url: status.release_url,
    repository: status.repository,
    checked: status.checked,
    error: status.error,
    body: status.body ?? null,
    published_at: status.published_at ?? null,
    checked_at: status.checked_at ?? new Date().toISOString(),
    http_status: status.http_status ?? null,
    endpoint: status.endpoint ?? null,
    proxy_source: status.proxy_source ?? null,
  };
}

async function getCurrentVersion(): Promise<string> {
  try {
    return await getDesktopShell().getAppVersion();
  } catch {
    return '';
  }
}

async function checkSignedFeed(): Promise<SignedFeedUpdate | null> {
  if (import.meta.env.DEV) return null;

  const update = await getDesktopShell().updater.check({
    timeout: MANIFEST_TIMEOUT_MS,
  });
  if (!update) return null;

  try {
    return {
      version: update.version,
      body: update.body ?? '',
      date: update.date ?? null,
    };
  } finally {
    try {
      await update.close?.();
    } catch {
      // One leaked resource slot is better than losing the check result.
    }
  }
}

async function checkGitHubRelease(): Promise<GitHubReleaseCheck> {
  return toGitHubCheck(await configApi.checkAppRelease());
}

function snapshotFromCache(): AppUpdateSnapshot | null {
  const cached = readLastCheck();
  if (!cached) return null;
  return {
    currentVersion: cached.currentVersion,
    update: cached.update,
    lastCheckedAt: cached.at,
    checked: true,
    error: null,
  };
}

function persist(snapshot: AppUpdateSnapshot): void {
  writeLastCheck({
    at: snapshot.lastCheckedAt,
    currentVersion: snapshot.currentVersion,
    update: snapshot.update,
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(APP_UPDATE_EVENT, { detail: snapshot })
    );
  }
}

export function readCachedAppUpdate(): AppUpdateSnapshot | null {
  return snapshotFromCache();
}

export function subscribeAppUpdate(
  listener: (snapshot: AppUpdateSnapshot) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onCustom = (event: Event) => {
    listener((event as CustomEvent<AppUpdateSnapshot>).detail);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== 'dimo.appUpdate.lastCheck') {
      return;
    }
    const cached = snapshotFromCache();
    if (cached) listener(cached);
  };

  window.addEventListener(APP_UPDATE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(APP_UPDATE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

export async function checkAppUpdate(options?: {
  force?: boolean;
}): Promise<AppUpdateSnapshot> {
  if (inFlight) return inFlight;

  const force = options?.force === true;
  if (!force) {
    const cached = readLastCheck();
    if (cached && Date.now() - cached.at < CHECK_TTL_MS) {
      const currentVersion = await getCurrentVersion().catch(() => '');
      if (
        !currentVersion ||
        !cached.currentVersion ||
        currentVersion === cached.currentVersion
      ) {
        return {
          currentVersion: currentVersion || cached.currentVersion,
          update: cached.update,
          lastCheckedAt: cached.at,
          checked: true,
          error: null,
        };
      }
      clearLastCheck();
    }
  }

  inFlight = (async () => {
    const snapshot = await resolveAppUpdate({
      getCurrentVersion,
      checkSignedFeed,
      checkGitHubRelease,
      now: () => Date.now(),
    });
    persist(snapshot);
    return snapshot;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export async function installSignedUpdate(
  onProgress?: (percent: number) => void
): Promise<void> {
  if (updateInFlight) return updateInFlight;

  updateInFlight = (async () => {
    writePostUpdateRestoreRoute();

    if (stagedUpdate?.close) {
      await stagedUpdate.close().catch(() => undefined);
      stagedUpdate = null;
    }

    const cachedVersion = readLastCheck()?.update?.version ?? null;
    const update = await getDesktopShell().updater.check({
      timeout: MANIFEST_TIMEOUT_MS,
    });
    if (!update) {
      const message = 'No signed update is available to install';
      setLifecycleState({
        status: 'error',
        version: cachedVersion,
        downloaded: 0,
        total: null,
        error: message,
      });
      throw new Error(message);
    }

    const targetVersion = update.version || cachedVersion;
    let total: number | null = null;
    let downloaded = 0;
    let closeOnExit = true;

    setLifecycleState({
      status: 'downloading',
      version: targetVersion,
      downloaded: 0,
      total: null,
      error: null,
    });

    const handleDownloadEvent = (event: {
      event: 'Started' | 'Progress' | 'Finished';
      data?: { contentLength?: number; chunkLength?: number };
    }) => {
      if (event.event === 'Started') {
        total =
          typeof event.data?.contentLength === 'number' &&
          event.data.contentLength > 0
            ? event.data.contentLength
            : null;
        setLifecycleState({
          status: 'downloading',
          version: targetVersion,
          downloaded: 0,
          total,
          error: null,
        });
        onProgress?.(0);
      } else if (event.event === 'Progress') {
        downloaded += event.data?.chunkLength ?? 0;
        setLifecycleState({
          status: 'downloading',
          version: targetVersion,
          downloaded,
          total,
          error: null,
        });
        onProgress?.(
          total && total > 0
            ? Math.min(100, Math.round((downloaded / total) * 100))
            : 0
        );
      } else if (event.event === 'Finished') {
        onProgress?.(100);
      }
    };

    try {
      const download = update.download;
      const install = update.install;

      if (typeof download === 'function' && typeof install === 'function') {
        await download.call(update, handleDownloadEvent);
        stagedUpdate = {
          install: () => install.call(update),
          close:
            typeof update.close === 'function'
              ? () => update.close!()
              : undefined,
        };
        closeOnExit = false;
      } else {
        await evacuateUserDataBeforeReplacingInstall();
        await update.downloadAndInstall((event) => {
          handleDownloadEvent(event);
          if (event.event === 'Finished') {
            setLifecycleState({
              status: 'installing',
              version: targetVersion,
              downloaded,
              total,
              error: null,
            });
          }
        });
      }

      clearLastCheck();
      setLifecycleState({
        status: 'ready_to_restart',
        version: targetVersion,
        downloaded,
        total,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLifecycleState({
        status: 'error',
        version: targetVersion,
        downloaded: 0,
        total: null,
        error: message,
      });
      throw error;
    } finally {
      if (closeOnExit && typeof update.close === 'function') {
        try {
          await update.close();
        } catch {
          // ignore
        }
      }
    }
  })().finally(() => {
    updateInFlight = null;
  });

  return updateInFlight;
}

export const startAppUpdate = installSignedUpdate;

function isWindowClosingIpcError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return /object has been destroyed|render frame was disposed|reply was never sent|channel closed|window.*(closed|destroyed)/i.test(
    message
  );
}

export async function relaunchApp(): Promise<void> {
  writePostUpdateRestoreRoute();
  clearLastCheck();
  setLifecycleState({
    ...lifecycleState,
    status: 'restarting',
    error: null,
  });

  const pendingUpdate = stagedUpdate;
  stagedUpdate = null;

  let windowClosing = false;
  const markWindowClosing = () => {
    windowClosing = true;
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', markWindowClosing, { once: true });
    window.addEventListener('pagehide', markWindowClosing, { once: true });
  }

  try {
    try {
      await evacuateUserDataBeforeReplacingInstall();
    } catch (error) {
      stagedUpdate = pendingUpdate;
      throw error;
    }

    const shell = getDesktopShell();
    let installedViaHandle = false;

    if (pendingUpdate) {
      try {
        await pendingUpdate.install();
        installedViaHandle = true;
      } catch (error) {
        if (windowClosing || isWindowClosingIpcError(error)) {
          return;
        }
        throw error;
      } finally {
        if (
          !windowClosing &&
          !(installedViaHandle && shell.kind === 'electron') &&
          typeof pendingUpdate.close === 'function'
        ) {
          try {
            await pendingUpdate.close();
          } catch {
            // Best-effort cleanup; ignore if the window/IPC is tearing down.
          }
        }
      }
    }

    // In Electron, `pendingUpdate.install()` hands off directly to
    // `autoUpdater.quitAndInstall()`, which terminates and restarts the app.
    if ((installedViaHandle && shell.kind === 'electron') || windowClosing) {
      return;
    }

    try {
      await shell.updater.relaunch();
    } catch (error) {
      if (windowClosing || isWindowClosingIpcError(error)) {
        return;
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLifecycleState({
      ...lifecycleState,
      status: 'error',
      error: message,
    });
    throw error;
  } finally {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', markWindowClosing);
      window.removeEventListener('pagehide', markWindowClosing);
    }
  }
}
