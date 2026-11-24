import { useEffect, useMemo, useState } from 'react';

import type { BackendTransport } from './backendTransport';
import { useBackendTransport } from './BackendTransportProvider';

const MAX_CAPABILITIES_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;

function readInitialCapabilities(
  transport: BackendTransport
): Set<string> | null {
  const cached = transport.getCachedCapabilities?.();
  if (cached) {
    return new Set(cached.capabilities);
  }
  if (!transport.capabilities) {
    return new Set();
  }
  return null;
}

export function useBackendCapabilities() {
  const transport = useBackendTransport();
  const [capabilities, setCapabilities] = useState<Set<string> | null>(() =>
    readInitialCapabilities(transport)
  );
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const initial = readInitialCapabilities(transport);
    setCapabilities(initial);
    setError(null);

    if (initial !== null || !transport.capabilities) {
      return;
    }

    let attempt = 0;
    const load = () => {
      if (!active || !transport.capabilities) {
        return;
      }
      void transport
        .capabilities()
        .then((result) => {
          if (!active) return;
          setCapabilities(new Set(result.capabilities));
          setError(null);
        })
        .catch((nextError) => {
          if (!active) return;
          setError(nextError);
          if (attempt < MAX_CAPABILITIES_RETRIES) {
            const delayMs = Math.min(
              INITIAL_RETRY_DELAY_MS * 2 ** attempt,
              MAX_RETRY_DELAY_MS
            );
            attempt += 1;
            retryTimer = setTimeout(load, delayMs);
            return;
          }
          setCapabilities(new Set());
        });
    };

    load();

    return () => {
      active = false;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
    };
  }, [transport]);

  return useMemo(
    () => ({
      capabilities,
      loading: capabilities === null,
      error,
      supports: (capability: string) => capabilities?.has(capability) ?? false,
    }),
    [capabilities, error]
  );
}
