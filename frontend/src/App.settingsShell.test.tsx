import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mounted = {
  projectProvider: false,
  searchProvider: false,
  agentWorkbenchProvider: false,
  basicGuideProvider: false,
  projectWindowManager: false,
  trayBadgeSync: false,
  focusConversationListener: false,
  accountHostConfigSyncBridge: false,
  pluginSync: false,
};

vi.mock('@/components/ConfigProvider', () => ({
  UserSystemProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  useUserSystem: () => ({
    config: { theme: 'SYSTEM' },
    updateAndSaveConfig: vi.fn(),
    updateConfig: vi.fn(),
  }),
}));

vi.mock('@/components/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('@/components/ui/toast', () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

vi.mock('@/components/AppErrorBoundary', () => ({
  AppErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/context-menu', () => ({
  AppContextMenuHost: ({ children }: { children: ReactNode }) => (
    <div data-testid="app-context-menu-host">{children}</div>
  ),
}));

vi.mock('@/components/settings/DesktopWindowControls', () => ({
  DesktopWindowControls: () => <div data-testid="desktop-window-controls" />,
}));

vi.mock('@/lib/desktopShell', () => ({
  useTauriClient: () => true,
}));

vi.mock('@/useLegacyDesignBodyClass', () => ({
  useLegacyDesignBodyClass: () => undefined,
}));

vi.mock('@/components/ui/option-menu-position', () => ({
  useOptionMenuViewportFit: () => undefined,
}));

vi.mock('@/lib/scheduleIdleWork', () => ({
  scheduleIdleWork: () => () => undefined,
}));

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginContributionCatalogSync: () => {
    mounted.pluginSync = true;
  },
}));

vi.mock('@/hooks/useProviderBindConfirmations', () => ({
  useProviderBindConfirmations: () => undefined,
}));

vi.mock('@/SettingsAppRoutes', () => ({
  SettingsAppRoutes: () => <div data-testid="settings-app-routes" />,
}));

vi.mock('@/MainAppRoutes', () => ({
  MainAppRoutes: () => <div data-testid="main-app-routes" />,
}));

vi.mock('@/contexts/ProjectContext', () => ({
  ProjectProvider: ({ children }: { children: ReactNode }) => {
    mounted.projectProvider = true;
    return <>{children}</>;
  },
}));

vi.mock('@/contexts/SearchContext', () => ({
  SearchProvider: ({ children }: { children: ReactNode }) => {
    mounted.searchProvider = true;
    return <>{children}</>;
  },
}));

vi.mock('@/features/agents/useAgentWorkbench', () => ({
  AgentWorkbenchProvider: ({ children }: { children: ReactNode }) => {
    mounted.agentWorkbenchProvider = true;
    return <>{children}</>;
  },
}));

vi.mock('@/features/basic-guide/BasicGuideProvider', () => ({
  BasicGuideProvider: ({ children }: { children: ReactNode }) => {
    mounted.basicGuideProvider = true;
    return <>{children}</>;
  },
}));

vi.mock('@/components/layout/ProjectWindowManager', () => ({
  ProjectWindowManager: () => {
    mounted.projectWindowManager = true;
    return null;
  },
}));

vi.mock('@/components/layout/TrayBadgeSync', () => ({
  TrayBadgeSync: () => {
    mounted.trayBadgeSync = true;
    return null;
  },
}));

vi.mock('@/components/layout/FocusConversationListener', () => ({
  FocusConversationListener: () => {
    mounted.focusConversationListener = true;
    return null;
  },
}));

vi.mock('@/features/model-router/accountHostConfigs', () => ({
  AccountHostConfigSyncBridge: () => {
    mounted.accountHostConfigSyncBridge = true;
    return null;
  },
}));

describe('App lightweight settings shell', () => {
  const originalPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  beforeEach(() => {
    for (const key of Object.keys(mounted) as Array<keyof typeof mounted>) {
      mounted[key] = false;
    }
    window.history.replaceState(null, '', '/settings/general');
  });

  afterEach(() => {
    window.history.replaceState(null, '', originalPath || '/');
  });

  it('mounts only lightweight settings providers and skips main workspace bridges', async () => {
    const { default: App } = await import('./App');
    render(<App />);

    expect(
      await screen.findByTestId('settings-app-routes')
    ).toBeInTheDocument();
    expect(screen.getByTestId('app-context-menu-host')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-window-controls')).toBeInTheDocument();
    expect(screen.getByTestId('toaster')).toBeInTheDocument();

    expect(mounted.projectProvider).toBe(false);
    expect(mounted.searchProvider).toBe(false);
    expect(mounted.agentWorkbenchProvider).toBe(false);
    expect(mounted.basicGuideProvider).toBe(false);
    expect(mounted.projectWindowManager).toBe(false);
    expect(mounted.trayBadgeSync).toBe(false);
    expect(mounted.focusConversationListener).toBe(false);
    expect(mounted.accountHostConfigSyncBridge).toBe(false);
    expect(mounted.pluginSync).toBe(false);
  });

  it('eagerly runs plugin catalog sync when directly opened on a plugin settings page', async () => {
    window.history.replaceState(null, '', '/settings/plugin/demo/page');
    const { default: App } = await import('./App');
    render(<App />);

    expect(
      await screen.findByTestId('settings-app-routes')
    ).toBeInTheDocument();
    expect(mounted.pluginSync).toBe(true);
    expect(mounted.agentWorkbenchProvider).toBe(false);
    expect(mounted.projectProvider).toBe(false);
  });
});
