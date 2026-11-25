import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainDesktopOpenFiles,
  enqueueDesktopOpenFiles,
  hasPendingDesktopOpenFiles,
  requeueDesktopOpenFiles,
  resetDesktopOpenFilesForTest,
  subscribeDesktopOpenFiles,
} from './desktopOpenFiles';

describe('desktopOpenFiles queue', () => {
  beforeEach(() => {
    resetDesktopOpenFilesForTest();
  });

  it('deduplicates queued paths, notifies subscribers, and drains cleanly', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDesktopOpenFiles(listener);

    enqueueDesktopOpenFiles([
      'D:\\notes\\config.yaml',
      '  ',
      'D:\\notes\\config.yaml',
      'D:\\notes\\Cargo.toml',
    ]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(hasPendingDesktopOpenFiles()).toBe(true);
    expect(drainDesktopOpenFiles()).toEqual([
      'D:\\notes\\config.yaml',
      'D:\\notes\\Cargo.toml',
    ]);
    expect(hasPendingDesktopOpenFiles()).toBe(false);
    expect(drainDesktopOpenFiles()).toEqual([]);

    unsubscribe();
    enqueueDesktopOpenFiles(['/tmp/other.md']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('requeues files at the front without re-triggering listeners', () => {
    const listener = vi.fn();
    subscribeDesktopOpenFiles(listener);

    enqueueDesktopOpenFiles(['/tmp/second.yaml']);
    expect(listener).toHaveBeenCalledTimes(1);

    requeueDesktopOpenFiles(['/tmp/first.toml', '/tmp/second.yaml']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(drainDesktopOpenFiles()).toEqual([
      '/tmp/first.toml',
      '/tmp/second.yaml',
    ]);
  });
});
