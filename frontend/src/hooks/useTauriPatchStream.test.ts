import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackendTransport, RemoteEvent } from '@/lib/transport';
import { mountBackendTransport } from '@/lib/transport/transportRegistry';
import { usePatchStream } from './useTauriPatchStream';

describe('usePatchStream', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resets isConnected and sets error when stream terminates unexpectedly, then retries cleanly', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    let resolveSecondEvent:
      | ((value: IteratorResult<RemoteEvent>) => void)
      | undefined;

    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      subscribe: vi.fn(() => {
        attempt += 1;
        const currentAttempt = attempt;
        let step = 0;
        const iterator: AsyncIterator<RemoteEvent> = {
          next: async (): Promise<IteratorResult<RemoteEvent>> => {
            if (currentAttempt === 1) {
              step += 1;
              if (step === 1) {
                return {
                  done: false,
                  value: {
                    sequence: 1n,
                    kind: 'patch',
                    payload: 'Ready',
                  },
                };
              }
              return { done: true, value: undefined };
            }
            step += 1;
            if (step === 1) {
              return {
                done: false,
                value: {
                  sequence: 1n,
                  kind: 'patch',
                  payload: 'Ready',
                },
              };
            }
            return new Promise<IteratorResult<RemoteEvent>>((resolve) => {
              resolveSecondEvent = resolve;
            });
          },
          return: async (): Promise<IteratorResult<RemoteEvent>> => ({
            done: true,
            value: undefined,
          }),
        };
        return {
          [Symbol.asyncIterator]: () => iterator,
        };
      }),
    };

    const unmountTransport = mountBackendTransport(transport);
    try {
      const initialData = () => ({ items: {} as Record<string, unknown> });
      const { result, unmount } = renderHook(() =>
        usePatchStream({
          subscribeCommand: 'subscribe_diff_stream',
          eventChannel: 'diff-stream',
          initialData,
          enabled: true,
        })
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBe('Stream disconnected unexpectedly');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_250);
        await Promise.resolve();
      });

      expect(attempt).toBe(2);
      expect(result.current.isConnected).toBe(true);
      expect(result.current.error).toBeNull();

      resolveSecondEvent?.({ done: true, value: undefined });
      unmount();
    } finally {
      unmountTransport();
    }
  });

  it('resets isConnected to false when subscription rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      subscribe: vi.fn(() => {
        const iterator: AsyncIterator<RemoteEvent> = {
          next: async (): Promise<IteratorResult<RemoteEvent>> => {
            throw Object.assign(new Error('Subscription crashed'), {
              retryable: false,
            });
          },
          return: async (): Promise<IteratorResult<RemoteEvent>> => ({
            done: true,
            value: undefined,
          }),
        };
        return {
          [Symbol.asyncIterator]: () => iterator,
        };
      }),
    };

    const unmountTransport = mountBackendTransport(transport);
    try {
      const initialData = () => ({ items: {} as Record<string, unknown> });
      const { result, unmount } = renderHook(() =>
        usePatchStream({
          subscribeCommand: 'subscribe_diff_stream',
          eventChannel: 'diff-stream',
          initialData,
          enabled: true,
        })
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBe('Subscription crashed');
      expect(errorSpy).toHaveBeenCalled();

      unmount();
    } finally {
      unmountTransport();
    }
  });

  it('recovers when a snapshot-backed stream stalls without emitting Ready', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    let closedStalledIterator = false;
    let resolveLiveTail:
      | ((value: IteratorResult<RemoteEvent>) => void)
      | undefined;

    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(),
      subscribe: vi.fn(() => {
        attempt += 1;
        const currentAttempt = attempt;
        let step = 0;
        const iterator: AsyncIterator<RemoteEvent> = {
          next: async (): Promise<IteratorResult<RemoteEvent>> => {
            if (currentAttempt === 1) {
              return new Promise<IteratorResult<RemoteEvent>>(() => {});
            }
            step += 1;
            if (step === 1) {
              return {
                done: false,
                value: {
                  sequence: 1n,
                  kind: 'patch',
                  payload: {
                    JsonPatch: [
                      {
                        op: 'replace',
                        path: '/projects',
                        value: { p1: { id: 'p1', name: 'Demo' } },
                      },
                    ],
                  },
                },
              };
            }
            if (step === 2) {
              return {
                done: false,
                value: {
                  sequence: 2n,
                  kind: 'patch',
                  payload: 'Ready',
                },
              };
            }
            return new Promise<IteratorResult<RemoteEvent>>((resolve) => {
              resolveLiveTail = resolve;
            });
          },
          return: async (): Promise<IteratorResult<RemoteEvent>> => {
            if (currentAttempt === 1) {
              closedStalledIterator = true;
            }
            return { done: true, value: undefined };
          },
        };
        return {
          [Symbol.asyncIterator]: () => iterator,
        };
      }),
    };

    const unmountTransport = mountBackendTransport(transport);
    try {
      const initialData = () => ({ projects: {} as Record<string, unknown> });
      const { result, unmount } = renderHook(() =>
        usePatchStream({
          subscribeCommand: 'subscribe_projects_stream',
          eventChannel: 'projects-stream',
          initialData,
          enabled: true,
        })
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(attempt).toBe(1);
      expect(result.current.isInitialized).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
        await Promise.resolve();
      });

      expect(closedStalledIterator).toBe(true);
      expect(result.current.error).toBe(
        'Timed out waiting for initial stream snapshot'
      );
      expect(result.current.isRetrying).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_250);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(attempt).toBe(2);
      expect(result.current.isInitialized).toBe(true);
      expect(result.current.error).toBeNull();
      expect(result.current.data).toEqual({
        projects: { p1: { id: 'p1', name: 'Demo' } },
      });

      resolveLiveTail?.({ done: true, value: undefined });
      unmount();
    } finally {
      unmountTransport();
    }
  });

  it('does not tear down and resubscribe when callback prop identities change across renders', async () => {
    let subscribeCount = 0;
    let resolveNext: ((value: IteratorResult<RemoteEvent>) => void) | undefined;

    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      subscribe: vi.fn(() => {
        subscribeCount += 1;
        let sentReady = false;
        const iterator: AsyncIterator<RemoteEvent> = {
          next: async (): Promise<IteratorResult<RemoteEvent>> => {
            if (!sentReady) {
              sentReady = true;
              return {
                done: false,
                value: { sequence: 1n, kind: 'patch', payload: 'Ready' },
              };
            }
            return new Promise<IteratorResult<RemoteEvent>>((resolve) => {
              resolveNext = resolve;
            });
          },
          return: async (): Promise<IteratorResult<RemoteEvent>> => ({
            done: true,
            value: undefined,
          }),
        };
        return { [Symbol.asyncIterator]: () => iterator };
      }),
    };

    const unmountTransport = mountBackendTransport(transport);
    try {
      const { rerender, unmount } = renderHook(
        ({ version }: { version: number }) =>
          usePatchStream({
            subscribeCommand: 'subscribe_diff_stream',
            eventChannel: 'diff-stream',
            initialData: () => ({ items: { version } }),
            injectInitialEntry: () => undefined,
            deduplicatePatches: (patches) => patches,
            enabled: true,
          }),
        { initialProps: { version: 1 } }
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(subscribeCount).toBe(1);

      rerender({ version: 2 });
      rerender({ version: 3 });

      await act(async () => {
        await Promise.resolve();
      });
      expect(subscribeCount).toBe(1);

      resolveNext?.({ done: true, value: undefined });
      unmount();
    } finally {
      unmountTransport();
    }
  });

  it('applies randomized ±25% jitter to reconnect backoff delays', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempt = 0;

    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      subscribe: vi.fn(() => {
        attempt += 1;
        const iterator: AsyncIterator<RemoteEvent> = {
          next: async (): Promise<IteratorResult<RemoteEvent>> => ({
            done: true,
            value: undefined,
          }),
          return: async (): Promise<IteratorResult<RemoteEvent>> => ({
            done: true,
            value: undefined,
          }),
        };
        return { [Symbol.asyncIterator]: () => iterator };
      }),
    };

    const unmountTransport = mountBackendTransport(transport);
    try {
      const { unmount } = renderHook(() =>
        usePatchStream({
          subscribeCommand: 'subscribe_diff_stream',
          eventChannel: 'diff-stream',
          initialData: () => ({ items: {} }),
          enabled: true,
        })
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(attempt).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(749);
      });
      expect(attempt).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
      });
      expect(attempt).toBe(2);

      unmount();
    } finally {
      unmountTransport();
    }
  });
});
