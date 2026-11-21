import { getDesktopShell } from '@/lib/desktopShell';

export async function syncSettingsWindowTitle(title: string): Promise<void> {
  try {
    const shell = getDesktopShell();
    const label = await shell.window.getLabel();
    if (label !== 'settings') return;
    await shell.window.setTitle(title);
  } catch {
    // Browser, tests, and windows without a native title stay unchanged.
  }
}
