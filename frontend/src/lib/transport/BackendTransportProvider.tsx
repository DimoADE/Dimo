import {
  createContext,
  type PropsWithChildren,
  useContext,
  useLayoutEffect,
} from 'react';

import type { BackendTransport } from './backendTransport';
import {
  fallbackDesktopTransport,
  mountBackendTransport,
} from './transportRegistry';

const BackendTransportContext = createContext<BackendTransport>(
  fallbackDesktopTransport
);

export function BackendTransportProvider({
  transport,
  children,
}: PropsWithChildren<{ transport: BackendTransport }>) {
  useLayoutEffect(() => {
    return mountBackendTransport(transport);
  }, [transport]);

  return (
    <BackendTransportContext.Provider value={transport}>
      {children}
    </BackendTransportContext.Provider>
  );
}

export function useBackendTransport(): BackendTransport {
  return useContext(BackendTransportContext);
}
