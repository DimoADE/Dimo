import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackendTransport, ServerCapabilities } from './backendTransport';
import { BackendTransportProvider } from './BackendTransportProvider';
import { useBackendCapabilities } from './useBackendCapabilities';

const FULL_CAPS: ServerCapabilities = {
  protocol_version: '1.0',
  server_version: '0.5.4',
  minimum_client_version: '0.5.0',
  capabilities: ['application.call', 'desktop.electron', 'plugin.read'],
};

describe('useBackendCapabilities', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('hydrates synchronously on frame 0 from transport.getCachedCapabilities()', () => {
    const capabilitiesMock = vi.fn(async () => FULL_CAPS);
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(),
      getCachedCapabilities: () => FULL_CAPS,
      capabilities: capabilitiesMock,
    };

    const { result } = renderHook(() => useBackendCapabilities(), {
      wrapper: ({ children }) => (
        <BackendTransportProvider transport={transport}>
          {children}
        </BackendTransportProvider>
      ),
    });

    // Frame 0: already populated without waiting for async effect
    expect(result.current.loading).toBe(false);
    expect(result.current.capabilities).toEqual(
      new Set(FULL_CAPS.capabilities)
    );
    expect(result.current.supports('application.call')).toBe(true);
    expect(result.current.supports('desktop.electron')).toBe(true);
    expect(result.current.supports('plugin.read')).toBe(true);
  });

  it('retries with exponential backoff on transient failures instead of locking to an empty set', async () => {
    vi.useFakeTimers();
    const capabilitiesMock = vi
      .fn<() => Promise<ServerCapabilities>>()
      .mockRejectedValueOnce(new Error('transient timeout 1'))
      .mockRejectedValueOnce(new Error('transient timeout 2'))
      .mockResolvedValueOnce(FULL_CAPS);

    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(),
      getCachedCapabilities: () => null,
      capabilities: capabilitiesMock,
    };

    const { result } = renderHook(() => useBackendCapabilities(), {
      wrapper: ({ children }) => (
        <BackendTransportProvider transport={transport}>
          {children}
        </BackendTransportProvider>
      ),
    });

    // Initial attempt fails -> still loading / retrying, NOT permanently locked to empty set
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(capabilitiesMock).toHaveBeenCalledTimes(1);
    expect(result.current.capabilities).toBeNull();
    expect(result.current.loading).toBe(true);

    // Retry #1 after 500ms fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(capabilitiesMock).toHaveBeenCalledTimes(2);
    expect(result.current.capabilities).toBeNull();
    expect(result.current.loading).toBe(true);

    // Retry #2 after 1000ms succeeds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(capabilitiesMock).toHaveBeenCalledTimes(3);
    expect(result.current.capabilities).toEqual(
      new Set(FULL_CAPS.capabilities)
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.supports('application.call')).toBe(true);
    expect(result.current.supports('plugin.read')).toBe(true);
  });
});
