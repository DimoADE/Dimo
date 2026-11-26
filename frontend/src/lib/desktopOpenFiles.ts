export const DESKTOP_OPEN_FILE_EVENT = 'desktop-open-file';

export interface DesktopOpenFilePayload {
  paths?: string[];
}

type OpenFileListener = () => void;

const pendingFiles: string[] = [];
const listeners = new Set<OpenFileListener>();

export function enqueueDesktopOpenFiles(paths: readonly string[]): void {
  let added = false;
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || pendingFiles.includes(trimmed)) continue;
    pendingFiles.push(trimmed);
    added = true;
  }
  if (!added) return;
  for (const listener of listeners) {
    listener();
  }
}

export function requeueDesktopOpenFiles(paths: readonly string[]): void {
  const unique: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (
      !trimmed ||
      unique.includes(trimmed) ||
      pendingFiles.includes(trimmed)
    ) {
      continue;
    }
    unique.push(trimmed);
  }
  if (unique.length > 0) {
    pendingFiles.unshift(...unique);
  }
}

export function drainDesktopOpenFiles(): string[] {
  return pendingFiles.splice(0);
}

export function hasPendingDesktopOpenFiles(): boolean {
  return pendingFiles.length > 0;
}

export function subscribeDesktopOpenFiles(
  listener: OpenFileListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetDesktopOpenFilesForTest(): void {
  pendingFiles.length = 0;
  listeners.clear();
}
