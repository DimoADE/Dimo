import { useSyncExternalStore } from 'react';
import {
  isDocumentForegroundActive,
  subscribeDocumentForeground,
} from '@/lib/sessionQueryCache';

/**
 * Returns true while the application window is visible and focused in the
 * foreground. Used to gate automatic session review completion (`inreview` ->
 * `done`) so background completions stay in review until the user returns.
 */
export function useDocumentForegroundActive(): boolean {
  return useSyncExternalStore(
    subscribeDocumentForeground,
    isDocumentForegroundActive,
    () => true
  );
}
