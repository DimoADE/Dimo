import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DesktopCapabilityError,
  desktopShellCall,
  getDesktopShell,
  isLocalDesktopHost,
  isTauriClient,
} from './desktopShell';
import { configureBackendTransport } from './backendTransport';
import { fallbackDesktopTransport } from './transport/transportRegistry';
import type { BackendTransport } from './transport';

function transport(
  environment: BackendTransport['environment']
): BackendTransport {
  return {
    environment,
    call: vi.fn(),
  };
}

describe('desktop shell calls', () => {
  afterEach(() => {
    configureBackendTransport(fallbackDesktopTransport);
    vi.restoreAllMocks();
  });

  it('treats only the local desktop host as Host-path OS integration', () => {
    expect(isLocalDesktopHost('desktop')).toBe(true);
    expect(isLocalDesktopHost('remote-desktop')).toBe(false);
    expect(isLocalDesktopHost('web')).toBe(false);
    expect(isTauriClient('desktop')).toBe(true);
    expect(isTauriClient('remote-desktop')).toBe(true);
    expect(isTauriClient('web')).toBe(false);
  });

  it('invokes local desktop shell for desktop-shell commands', async () => {
    const shellInvoke = vi
      .spyOn(getDesktopShell(), 'invoke')
      .mockResolvedValue(undefined);
    configureBackendTransport(transport('desktop'));
    await expect(
      desktopShellCall('reveal_in_file_manager', { path: '/tmp/demo' })
    ).resolves.toBeUndefined();
    expect(shellInvoke).toHaveBeenCalledWith('reveal_in_file_manager', {
      path: '/tmp/demo',
    });
  });

  it('keeps client chrome available on remote-desktop', async () => {
    const shellInvoke = vi
      .spyOn(getDesktopShell(), 'invoke')
      .mockResolvedValue(undefined);
    configureBackendTransport(transport('remote-desktop'));
    await desktopShellCall('update_tray_badge', { count: 2 });
    expect(shellInvoke).toHaveBeenCalledWith('update_tray_badge', { count: 2 });
  });

  it('refuses desktop-shell commands in the web environment', async () => {
    const shellInvoke = vi
      .spyOn(getDesktopShell(), 'invoke')
      .mockResolvedValue(undefined);
    configureBackendTransport(transport('web'));
    await expect(
      desktopShellCall('open_project_in_editor', { id: 'project-1' })
    ).rejects.toMatchObject({
      name: 'DesktopCapabilityError',
      code: 'capability_unavailable',
    });
    expect(shellInvoke).not.toHaveBeenCalled();
    await expect(
      desktopShellCall('open_project_in_editor', { id: 'project-1' })
    ).rejects.toBeInstanceOf(DesktopCapabilityError);
  });
});
