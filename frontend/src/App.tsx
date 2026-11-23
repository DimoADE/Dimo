import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, useLocation } from 'react-router-dom';

import { UserSystemProvider, useUserSystem } from '@/components/ConfigProvider';
import { ThemeProvider, useTheme } from '@/components/ThemeProvider';
import { Toaster } from '@/components/ui/toast';
import { DesktopWindowControls } from '@/components/settings/DesktopWindowControls';
import { ThemeMode } from 'shared/types';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { getAppRouteMode } from '@/appRouteMode';
import { useLegacyDesignBodyClass } from '@/useLegacyDesignBodyClass';
import { useOptionMenuViewportFit } from '@/components/ui/option-menu-position';
import { isSettingsSurfacePath } from '@/lib/settingsPreload';
import { scheduleIdleWork } from '@/lib/scheduleIdleWork';
import { useTauriClient } from '@/lib/desktopShell';
import { usePluginContributionCatalogSync } from '@/hooks/usePluginHostContributions';
import { AppContextMenuHost } from '@/components/context-menu';

const SettingsAppRoutes = lazy(() =>
  import('@/SettingsAppRoutes').then((module) => ({
    default: module.SettingsAppRoutes,
  }))
);
const DesktopToastApp = lazy(() =>
  import('@/DesktopToastApp').then((module) => ({
    default: module.DesktopToastApp,
  }))
);
const MainAppShell = lazy(() =>
  import('@/MainAppShell').then((module) => ({
    default: module.MainAppShell,
  }))
);

function ThemedToaster() {
  const { resolvedTheme } = useTheme();

  return <Toaster theme={resolvedTheme} />;
}

function SettingsPluginSyncRunner() {
  usePluginContributionCatalogSync();
  return null;
}

function SettingsPluginContributionBridge({ defer }: { defer: boolean }) {
  const [ready, setReady] = useState(!defer);

  useEffect(() => {
    if (!defer) {
      setReady(true);
      return;
    }
    return scheduleIdleWork(() => {
      setReady(true);
    });
  }, [defer]);

  return ready ? <SettingsPluginSyncRunner /> : null;
}

function SettingsSurfaceContent() {
  const { config } = useUserSystem();
  const location = useLocation();
  const isTauri = useTauriClient();

  useLegacyDesignBodyClass();
  useOptionMenuViewportFit();

  return (
    <ThemeProvider initialTheme={config?.theme || ThemeMode.SYSTEM}>
      <SettingsPluginContributionBridge
        defer={!location.pathname.startsWith('/settings/plugin/')}
      />
      <AppContextMenuHost>
        <ThemedToaster />
        <Suspense fallback={null}>
          <SettingsAppRoutes />
        </Suspense>
        {isTauri ? <DesktopWindowControls /> : null}
      </AppContextMenuHost>
    </ThemeProvider>
  );
}

function AppContent() {
  const location = useLocation();

  if (isSettingsSurfacePath(location.pathname)) {
    return <SettingsSurfaceContent />;
  }

  return (
    <Suspense fallback={null}>
      <MainAppShell />
    </Suspense>
  );
}

function AppShell() {
  const location = useLocation();
  if (getAppRouteMode(location.pathname) === 'desktop-toast') {
    return (
      <Suspense fallback={null}>
        <DesktopToastApp />
      </Suspense>
    );
  }

  return (
    <UserSystemProvider>
      <AppContent />
    </UserSystemProvider>
  );
}

function App() {
  return (
    <AppErrorBoundary>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </AppErrorBoundary>
  );
}

export default App;
