import { openExternalUrl } from '@/lib/desktopShell';

/** Opens a site page in the system browser; a plain web build falls back to a new tab. */
export async function openExternal(url: string): Promise<void> {
  await openExternalUrl(url);
}
