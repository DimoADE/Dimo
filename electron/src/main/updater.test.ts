import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
}));

import {
  DesktopUpdaterManager,
  ProgressDeltaTracker,
  isUpdateNewer,
  normalizeReleaseNotes,
  type AutoUpdaterLike,
  type UpdaterCheckResultLike,
} from './updater';

class FakeAutoUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  forceDevUpdateConfig = false;
  updateConfigPath: string | null = null;

  checkImpl: () => Promise<UpdaterCheckResultLike | null> = async () => null;
  downloadImpl: () => Promise<unknown> = async () => [];
  quitAndInstall = vi.fn();

  checkForUpdates(): Promise<UpdaterCheckResultLike | null> {
    return this.checkImpl();
  }

  downloadUpdate(): Promise<unknown> {
    return this.downloadImpl();
  }
}

describe('Electron M5 DesktopUpdaterManager', () => {
  it('compares SemVer versions accurately including prereleases', () => {
    expect(isUpdateNewer('0.6.0', '0.5.2')).toBe(true);
    expect(isUpdateNewer('v0.5.3', '0.5.2')).toBe(true);
    expect(isUpdateNewer('0.5.2', '0.5.2')).toBe(false);
    expect(isUpdateNewer('0.5.1', '0.5.2')).toBe(false);
    expect(isUpdateNewer('0.6.0', '0.6.0-beta.1')).toBe(true);
    expect(isUpdateNewer('0.6.0-beta.2', '0.6.0-beta.1')).toBe(true);
    expect(isUpdateNewer('0.6.0-beta.1', '0.6.0')).toBe(false);
  });

  it('normalizes string and structured release notes', () => {
    expect(normalizeReleaseNotes('  Hello release  ')).toBe('Hello release');
    expect(normalizeReleaseNotes('   ')).toBeNull();
    expect(
      normalizeReleaseNotes([
        { version: '0.6.0', note: 'Added Electron shell' },
        { version: '0.5.9', note: 'Bug fixes' },
      ])
    ).toBe('## 0.6.0\nAdded Electron shell\n\n## 0.5.9\nBug fixes');
  });

  it('converts cumulative electron-updater progress into incremental chunk deltas', () => {
    const tracker = new ProgressDeltaTracker();
    const first = tracker.handleProgress('tok-1', {
      total: 1000,
      transferred: 250,
    });
    expect(first).toEqual([
      { token: 'tok-1', event: 'Started', data: { contentLength: 1000 } },
      { token: 'tok-1', event: 'Progress', data: { chunkLength: 250 } },
    ]);

    const second = tracker.handleProgress('tok-1', {
      total: 1000,
      transferred: 700,
    });
    expect(second).toEqual([
      { token: 'tok-1', event: 'Progress', data: { chunkLength: 450 } },
    ]);

    const done = tracker.finish('tok-1');
    expect(done).toEqual([
      { token: 'tok-1', event: 'Progress', data: { chunkLength: 300 } },
      { token: 'tok-1', event: 'Finished' },
    ]);
  });

  it('returns null when app is unpackaged in dev mode', async () => {
    const fake = new FakeAutoUpdater();
    const manager = new DesktopUpdaterManager({
      currentVersion: '0.5.2',
      beforeQuitForUpdate: vi.fn().mockResolvedValue(undefined),
      isPackaged: () => false,
      loadAutoUpdater: () => fake,
    });
    expect(await manager.check()).toBeNull();
  });

  it('drives check -> download -> beforeQuitForUpdate -> quitAndInstall lifecycle', async () => {
    const fake = new FakeAutoUpdater();
    const callOrder: string[] = [];

    fake.checkImpl = async () => ({
      updateInfo: {
        version: '0.6.0',
        releaseDate: '2026-11-20T00:00:00Z',
        releaseNotes: 'Electron migration release',
      },
    });
    fake.downloadImpl = async () => {
      fake.emit('download-progress', { total: 500, transferred: 200 });
      fake.emit('download-progress', { total: 500, transferred: 500 });
      return ['/tmp/Dimo-0.6.0-setup.exe'];
    };
    fake.quitAndInstall.mockImplementation(() => {
      callOrder.push('quitAndInstall');
    });

    const beforeQuit = vi.fn(async () => {
      callOrder.push('beforeQuitForUpdate');
    });
    const relaunchApp = vi.fn();
    const exitApp = vi.fn();

    const manager = new DesktopUpdaterManager({
      currentVersion: '0.5.2',
      beforeQuitForUpdate: beforeQuit,
      isPackaged: () => true,
      loadAutoUpdater: () => fake,
      relaunchApp,
      exitApp,
    });

    const update = await manager.check({ timeout: 5_000 });
    expect(update).not.toBeNull();
    expect(update?.version).toBe('0.6.0');
    expect(update?.body).toBe('Electron migration release');
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);

    // Installing before download must fail
    await expect(manager.install(update!.token)).rejects.toThrow(
      /must be downloaded/
    );

    const events: unknown[] = [];
    await manager.download(update!.token, (ev) => events.push(ev));
    expect(events).toEqual([
      {
        token: update!.token,
        event: 'Started',
        data: { contentLength: 500 },
      },
      {
        token: update!.token,
        event: 'Progress',
        data: { chunkLength: 200 },
      },
      {
        token: update!.token,
        event: 'Progress',
        data: { chunkLength: 300 },
      },
      { token: update!.token, event: 'Finished' },
    ]);

    await manager.install(update!.token);
    expect(callOrder).toEqual(['beforeQuitForUpdate', 'quitAndInstall']);
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true);

    // Subsequent relaunch call after install is a safe no-op
    await manager.relaunch();
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it('shuts down sidecar cleanly before plain relaunch', async () => {
    const callOrder: string[] = [];
    const manager = new DesktopUpdaterManager({
      currentVersion: '0.5.2',
      beforeQuitForUpdate: async () => {
        callOrder.push('shutdown');
      },
      isPackaged: () => true,
      loadAutoUpdater: () => new FakeAutoUpdater(),
      relaunchApp: () => callOrder.push('relaunch'),
      exitApp: () => callOrder.push('exit'),
    });

    await manager.relaunch();
    expect(callOrder).toEqual(['shutdown', 'relaunch', 'exit']);
  });
});
