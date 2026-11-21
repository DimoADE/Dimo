import { getAppRouteMode } from '@/appRouteMode';
import { getDesktopShell } from '@/lib/desktopShell';
import { isSettingsSurfacePath } from '@/lib/settingsPreload';
import { isDesktopShell } from '@/utils/platform';

export function shouldRevealDesktopWindowOnBoot(pathname: string): boolean {
  if (getAppRouteMode(pathname) === 'desktop-toast') return false;
  return !isSettingsSurfacePath(pathname);
}

export const REVEAL_RETRY_DELAYS_MS = [0, 80, 250] as const;

async function fallbackRevealMainWindow(): Promise<void> {
  await getDesktopShell().invoke('reveal_main_window');
}

export async function revealDesktopWindow(): Promise<void> {
  if (!isDesktopShell()) return;
  if (getAppRouteMode(window.location.pathname) === 'desktop-toast') return;

  const shell = getDesktopShell();
  let showError: unknown = null;

  try {
    await shell.window.show();
  } catch (err) {
    showError = err;
  }

  if (showError !== null) {
    try {
      await fallbackRevealMainWindow();
    } catch (fallbackErr) {
      throw fallbackErr ?? showError;
    }
  }

  try {
    await shell.window.setFocus();
  } catch (focusErr) {
    console.warn(
      '[revealDesktopWindow] Window shown, but setFocus failed:',
      focusErr
    );
  }
}

export async function revealDesktopWindowWithRetry(
  delays: readonly number[] = REVEAL_RETRY_DELAYS_MS,
  shouldCancel?: () => boolean
): Promise<boolean> {
  if (!isDesktopShell()) return false;
  if (getAppRouteMode(window.location.pathname) === 'desktop-toast') {
    return false;
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (shouldCancel?.()) return false;
    const delayMs = delays[attempt] ?? 0;
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
      if (shouldCancel?.()) return false;
    }

    try {
      await revealDesktopWindow();
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  if (!shouldCancel?.() && lastError !== null) {
    console.warn(
      '[revealDesktopWindow] Failed to reveal desktop window after retries; relying on native fallback:',
      lastError
    );
  }
  return false;
}

export function revealDesktopWindowAfterPaint(
  delays: readonly number[] = REVEAL_RETRY_DELAYS_MS
): () => void {
  if (!isDesktopShell()) return () => undefined;
  if (getAppRouteMode(window.location.pathname) === 'desktop-toast') {
    return () => undefined;
  }

  let cancelled = false;
  let innerFrame = 0;
  const outerFrame = requestAnimationFrame(() => {
    if (cancelled) return;
    innerFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      void revealDesktopWindowWithRetry(delays, () => cancelled);
    });
  });

  return () => {
    cancelled = true;
    cancelAnimationFrame(outerFrame);
    if (innerFrame) {
      cancelAnimationFrame(innerFrame);
    }
  };
}
