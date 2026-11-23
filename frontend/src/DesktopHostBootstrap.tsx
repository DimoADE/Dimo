import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { hostClientApi } from '@/lib/api';
import { getDesktopShell, getDesktopWindowLabel } from '@/lib/desktopShell';
import { isHostBoundWindowLabel } from '@/lib/hostBoundWindow';
import {
  BackendTransportProvider,
  RemoteDesktopTransport,
  getLocalDesktopTransport,
  type BackendTransport,
} from '@/lib/transport';
import { BoundHostTransport } from '@/lib/transport/boundHostTransport';
import { isDesktopShell } from '@/utils/platform';
import { getAppRouteMode } from './appRouteMode';

const HOST_CLIENT_CHANGED = 'host-client-changed';

function shouldBindAppShell(): boolean {
  return (
    isDesktopShell() &&
    getAppRouteMode(window.location.pathname) !== 'desktop-toast'
  );
}

function currentWindowLabel(): string {
  return getDesktopWindowLabel();
}

export function DesktopHostBootstrap({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const bindShell = shouldBindAppShell();
  const [transport, setTransport] = useState<BackendTransport>(() =>
    getLocalDesktopTransport()
  );
  const [shellKey, setShellKey] = useState('desktop');
  const [ready, setReady] = useState(
    () => !bindShell || !isHostBoundWindowLabel(currentWindowLabel())
  );

  useEffect(() => {
    if (!bindShell) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let boundOrigin: string | null | undefined = undefined;
    let activeBoundTransport: BoundHostTransport | null = null;
    let applyEpoch = 0;

    const releaseBoundTransport = () => {
      if (activeBoundTransport) {
        activeBoundTransport.detach();
        activeBoundTransport = null;
      }
    };

    const apply = async () => {
      const epoch = ++applyEpoch;
      try {
        const status = await hostClientApi.status();
        if (cancelled || epoch !== applyEpoch) return;
        const nextOrigin =
          isHostBoundWindowLabel(currentWindowLabel()) &&
          status.connected &&
          status.profile?.origin
            ? status.profile.origin
            : null;
        if (nextOrigin === boundOrigin) return;
        const hadPreviousOrigin = boundOrigin !== undefined;
        boundOrigin = nextOrigin;
        releaseBoundTransport();
        if (hadPreviousOrigin || nextOrigin !== null) {
          queryClient.clear();
        }
        if (nextOrigin) {
          const remote = RemoteDesktopTransport.attach({
            profileId: 'active-host-client',
            baseUrl: nextOrigin,
          });
          const nextTransport = new BoundHostTransport(remote);
          activeBoundTransport = nextTransport;
          setTransport(nextTransport);
          setShellKey(`remote:${nextOrigin}`);
        } else {
          setTransport(getLocalDesktopTransport());
          setShellKey('desktop');
        }
      } catch {
        if (!cancelled && epoch === applyEpoch && !boundOrigin) {
          setTransport(getLocalDesktopTransport());
          setShellKey('desktop');
        }
      } finally {
        if (!cancelled && epoch === applyEpoch) {
          setReady(true);
        }
      }
    };

    void apply();
    const listenPromise =
      getLocalDesktopTransport().listen?.(HOST_CLIENT_CHANGED, () => {
        void apply();
      }) ??
      getDesktopShell().events.listen(HOST_CLIENT_CHANGED, () => {
        void apply();
      });
    void listenPromise
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      applyEpoch += 1;
      unlisten?.();
      releaseBoundTransport();
    };
  }, [bindShell, queryClient]);

  if (!bindShell) {
    return children;
  }

  if (!ready) {
    return null;
  }

  return (
    <BackendTransportProvider key={shellKey} transport={transport}>
      {children}
    </BackendTransportProvider>
  );
}
