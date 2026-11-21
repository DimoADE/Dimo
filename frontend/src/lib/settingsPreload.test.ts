import { describe, expect, it } from 'vitest';

import { isSettingsSurfacePath } from './settingsPreload';

describe('isSettingsSurfacePath', () => {
  it.each(['/settings', '/settings/agents', '/plugins', '/plugins/office'])(
    'treats %s as the settings surface',
    (pathname) => {
      expect(isSettingsSurfacePath(pathname)).toBe(true);
    }
  );

  it.each(['/', '/local-projects', '/local-projects/p1/sessions'])(
    'does not treat %s as the settings surface',
    (pathname) => {
      expect(isSettingsSurfacePath(pathname)).toBe(false);
    }
  );
});

describe('preloadSettingsPath', () => {
  it('ignores unknown paths', async () => {
    const { preloadSettingsPath } = await import('./settingsPreload');
    expect(() => preloadSettingsPath('/not-a-settings-page')).not.toThrow();
  });

  it('does not export a full settings-page preload', async () => {
    const settingsPreload = await import('./settingsPreload');
    expect(settingsPreload).not.toHaveProperty('preloadRemainingSettingsPages');
    expect(settingsPreload).not.toHaveProperty(
      'scheduleRemainingSettingsPreload'
    );
  });

  it('exports SettingsAppRoutes and PluginSettingsPage loaders for parallel surface warming', async () => {
    const settingsPreload = await import('./settingsPreload');
    expect(typeof settingsPreload.loadSettingsAppRoutes).toBe('function');
    expect(typeof settingsPreload.loadPluginSettingsPage).toBe('function');
    expect(() =>
      settingsPreload.warmDefaultSettingsSurface('/settings/agents')
    ).not.toThrow();
    expect(() =>
      settingsPreload.warmDefaultSettingsSurface('/settings/plugin/demo/page')
    ).not.toThrow();
    expect(() =>
      settingsPreload.warmDefaultSettingsSurface('/plugins/demo')
    ).not.toThrow();
  });
});
