import { backendListen } from '@/lib/backendTransport';
import { getDesktopShell } from '@/lib/desktopShell';
import { getBackendTransport } from '@/lib/transport';

export const COLLABORATION_SPACE_CHANGED_EVENT =
  'dimo://collaboration-space-changed' as const;

export async function collaborationCall<T>(
  capability: 'collaboration' | 'workspace',
  operation: string,
  input: Record<string, unknown> = {}
): Promise<T> {
  return getBackendTransport().call('collaboration_call', {
    capability,
    operation,
    input,
  }) as Promise<T>;
}

export function listenCollaborationSpaceChanged(
  handler: (payload: unknown) => void
): Promise<() => void> {
  return backendListen(COLLABORATION_SPACE_CHANGED_EVENT, handler);
}

export async function currentWindowLabel(): Promise<string> {
  try {
    return (await getDesktopShell().window.getLabel())?.trim() ?? '';
  } catch {
    return '';
  }
}
