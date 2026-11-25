import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetConversationKeepaliveForTests,
  retainConversationKeepalive,
} from './conversationKeepalive';

describe('conversation keepalive', () => {
  afterEach(() => {
    resetConversationKeepaliveForTests();
    vi.useRealTimers();
  });

  it('registers each surface once and does not repeat on a timer', async () => {
    vi.useFakeTimers();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);

    const releaseFirst = retainConversationKeepalive('a', first);
    const releaseSecond = retainConversationKeepalive('b', second);
    await vi.runAllTicks();

    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.runAllTicks();
    expect(first).toHaveBeenCalledWith(false);
    expect(second).not.toHaveBeenCalledWith(false);

    releaseSecond();
    expect(second).toHaveBeenLastCalledWith(false);
  });

  it('a replaced registration does not release the newer watch', async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const releaseFirst = retainConversationKeepalive('a', first);
    const releaseSecond = retainConversationKeepalive('a', second);
    await Promise.resolve();

    releaseFirst();
    await Promise.resolve();
    expect(second).not.toHaveBeenCalledWith(false);

    releaseSecond();
    expect(second).toHaveBeenCalledWith(false);
    expect(first).not.toHaveBeenCalledWith(false);
  });

  it('forgets every registration when the page is hidden for unload', async () => {
    const watch = vi.fn().mockResolvedValue(undefined);
    retainConversationKeepalive('a', watch);
    await Promise.resolve();

    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();

    expect(watch).toHaveBeenCalledWith(false);
  });

  it('serializes rapid release and remount so final watch state stays true', async () => {
    const calls: boolean[] = [];
    const resolvers: Array<() => void> = [];
    const setWatch = vi.fn((watch: boolean) => {
      calls.push(watch);
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    });

    const releaseFirst = retainConversationKeepalive('conv-race', setWatch);
    expect(calls).toEqual([true]);

    // Unmount and immediately remount while the initial watch=true RPC is still in flight.
    releaseFirst();
    const releaseSecond = retainConversationKeepalive('conv-race', setWatch);
    expect(calls).toEqual([true]);

    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();

    // Since desired settled back to true before drain resumed, no spurious false RPC is emitted.
    expect(calls).toEqual([true]);

    // Now unmount for real while idle, then remount while false is in flight.
    releaseSecond();
    expect(calls).toEqual([true, false]);
    const releaseThird = retainConversationKeepalive('conv-race', setWatch);
    expect(calls).toEqual([true, false]);

    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([true, false, true]);
    resolvers.shift()?.();
    await Promise.resolve();
    releaseThird();
  });
});
