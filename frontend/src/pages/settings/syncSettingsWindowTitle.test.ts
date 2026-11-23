import { beforeEach, describe, expect, it, vi } from 'vitest';

const setTitle = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const getWindowLabel = vi.hoisted(() => vi.fn(() => 'settings'));

vi.mock('@/lib/desktopShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/desktopShell')>();
  return {
    ...actual,
    getDesktopShell: () => {
      const shell = actual.getDesktopShell();
      return {
        ...shell,
        getWindowLabel,
        window: {
          ...shell.window,
          getLabel: async () => getWindowLabel(),
          setTitle,
        },
      };
    },
  };
});

import { syncSettingsWindowTitle } from './syncSettingsWindowTitle';

describe('syncSettingsWindowTitle', () => {
  beforeEach(() => {
    setTitle.mockClear();
    getWindowLabel.mockReset();
    getWindowLabel.mockReturnValue('settings');
  });

  it('sets the native title only on the settings window', async () => {
    await syncSettingsWindowTitle('设置');

    expect(setTitle).toHaveBeenCalledWith('设置');
  });

  it('does not retitle the main window', async () => {
    getWindowLabel.mockReturnValue('main');

    await syncSettingsWindowTitle('Settings');

    expect(setTitle).not.toHaveBeenCalled();
  });

  it('ignores missing native window APIs', async () => {
    getWindowLabel.mockImplementation(() => {
      throw new Error('not a desktop window');
    });

    await expect(syncSettingsWindowTitle('Settings')).resolves.toBeUndefined();
    expect(setTitle).not.toHaveBeenCalled();
  });
});
